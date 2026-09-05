// M2-A first diagnostic live run.
//
// The runtime is used exactly as committed. The injected dispatcher is a pass-through
// recorder: it forwards every argument to the real callProvider unchanged and stores the
// constructed prompt, so section 7's "captured prompt, not inferred from code" can be
// answered from an artifact rather than from reading the source.
import { writeFileSync } from 'node:fs';
import { runOrchestrator, buildRunReport, buildOutputBanner } from '/private/tmp/claude-501/-Users-Dawn-Desktop-Project-AI-Agent/60b5a0c1-eb58-41d7-9cb8-3e6a7d0f7f87/scratchpad/m2/dist/modes/orchestrator.js';
import { callProvider } from '/private/tmp/claude-501/-Users-Dawn-Desktop-Project-AI-Agent/60b5a0c1-eb58-41d7-9cb8-3e6a7d0f7f87/scratchpad/m2/dist/providers/index.js';
import { resolveRoster } from '/private/tmp/claude-501/-Users-Dawn-Desktop-Project-AI-Agent/60b5a0c1-eb58-41d7-9cb8-3e6a7d0f7f87/scratchpad/m2/dist/agents/registry.js';
import { segmentAll } from '/private/tmp/claude-501/-Users-Dawn-Desktop-Project-AI-Agent/60b5a0c1-eb58-41d7-9cb8-3e6a7d0f7f87/scratchpad/m2/dist/agents/collaboration.js';

const TASK = `我們是一家 12 人的影像製作公司,主要收入來自品牌形象影片與電商產品影片。去年營收約新台幣 4,800 萬,毛利率約 38%,手上現金約 900 萬。

現在要決定一件事:是否簽下一個五年期的自有攝影棚租約,並同時投入約 650 萬購置燈光、軌道與虛擬製作(LED 牆)設備。

背景與限制:
- 目前所有案子都租借外部棚,一年棚租與外租設備支出約 320 萬,且旺季常訂不到理想檔期。
- 五年租約年租金約 240 萬,含裝修攤提後前兩年現金流會明顯吃緊。
- 前五大客戶佔營收 61%,其中最大一家的年度合約每年重新議價。
- 團隊目前沒有專職棚務與設備維護人力,需要再聘一到兩人。
- 有兩家規模相近的同業在過去 18 個月內先後建置了自有棚。
- 虛擬製作的實際市場需求我們沒有數據,只有業務端零星反饋。

請給我一個明確的決策建議(簽、不簽,或有條件地簽),並包含:
1. 這個決定成立的關鍵前提是什麼,以及哪些前提目前沒有證據支撐
2. 最主要的三個風險,以及各自的早期預警指標
3. 如果決定不簽,替代方案是什麼
4. 如果決定簽,前 12 個月必須達成什麼才算走在正軌

請用繁體中文回答。`;

const calls = [];
const record = async (provider, prompt, options = {}) => {
  const started = Date.now();
  const entry = {
    seq: calls.length + 1,
    stage: options.stage ?? null,
    provider,
    model: options.model ?? null,
    system: options.system ?? null,
    retrievalRequested: options.retrieval ?? null,
    promptChars: prompt.length,
    prompt,
  };
  calls.push(entry);
  try {
    const result = await callProvider(provider, prompt, options);
    entry.ms = Date.now() - started;
    entry.responseModel = result.model;
    entry.responseChars = result.text.length;
    entry.responseText = result.text;
    entry.retrievalResult = result.retrieval ?? null;
    return result;
  } catch (err) {
    entry.ms = Date.now() - started;
    entry.error = String(err);
    throw err;
  }
};

const roster = resolveRoster(['business_strategist', 'market_researcher', 'brand_creative']);
console.log('roster warnings:', roster.warnings.length ? roster.warnings : 'none');
console.log('starting DEEP diagnostic run...');

const startedAt = new Date().toISOString();
const result = await runOrchestrator({
  task: TASK,
  orchestrator: { provider: 'openai', model: 'gpt-5' },
  workers: roster.workers,
  synthesizer: { provider: 'openai', model: 'gpt-5' },
  call: record,
  experimental: { collaboration: { enabled: true } },
});

// Independent recomputation of the report from the returned Round 1 results only.
// If Round 2 had leaked into the evidence path, this would disagree with result.report.
const recomputed = buildRunReport(result.plan.complexity, roster.workers, result.workerResults);

const artifact = {
  startedAt,
  finishedAt: new Date().toISOString(),
  task: TASK,
  roster: roster.workers.map((w) => ({ id: w.id, provider: w.provider, model: w.model ?? null, evidenceCapable: !!w.evidenceCapable })),
  plan: result.plan,
  planningAdjustments: result.planningAdjustments,
  workerResults: result.workerResults,
  report: result.report,
  recomputedReportFromRound1: {
    status: recomputed.status,
    evidenceLabel: recomputed.evidenceLabel,
    retrieval: recomputed.retrieval,
    notes: recomputed.notes,
  },
  bannerFromRound1Report: buildOutputBanner(result.report),
  collaboration: result.collaboration ?? null,
  chunkMapRecomputed: segmentAll(result.workerResults.filter((r) => r.output !== undefined)),
  finalOutput: result.finalOutput,
  timings: result.timings,
  calls,
};

writeFileSync('/private/tmp/claude-501/-Users-Dawn-Desktop-Project-AI-Agent/60b5a0c1-eb58-41d7-9cb8-3e6a7d0f7f87/scratchpad/diag/artifact.json', JSON.stringify(artifact, null, 2));

console.log('\n=== SUMMARY ===');
console.log('complexity      :', result.plan.complexity);
console.log('capabilities    :', result.plan.requiredCapabilities.join(', '));
console.log('assignments     :', result.plan.assignments.map((a) => a.agentId).join(', '));
console.log('logical calls   :', calls.length);
console.log('stages          :', calls.map((c) => c.stage).join(' -> '));
console.log('status/evidence :', result.report.status, '/', result.report.evidenceLabel);
console.log('collaboration   :', result.collaboration?.status, '/', result.collaboration?.reason);
console.log('answerSource    :', result.collaboration?.answerSource);
console.log('timings         :', JSON.stringify(result.timings));
console.log('collab timings  :', JSON.stringify(result.collaboration?.timings));
console.log('\nartifact written to diag/artifact.json');
