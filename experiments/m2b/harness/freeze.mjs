/**
 * Freezes fixture-side artifacts and writes the clean-room packets.
 *
 * Runs offline and calls no provider. Writing a manifest is not an experiment; it records
 * what the fixture *is* before any arm has seen it, so that later nobody has to take on
 * trust that the inputs did not move.
 *
 * Files are written with `flag: 'wx'` — a freeze that can silently overwrite an earlier
 * freeze is not a freeze. Re-freezing requires deleting deliberately, which leaves a trace
 * in git.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadFixture, passagesOf, EXPERIMENT_FIXTURE_IDS, FIXTURE_ROOT } from './fixtures.mjs';
import { buildCleanRoomPacket } from './cleanroom.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const M2B = fileURLToPath(new URL('../', import.meta.url));
const sha256 = (v) => createHash('sha256').update(v).digest('hex');
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();

/**
 * Pre-Gate eligibility rationale, per protocol F1–F7.
 *
 * Every line here cites only the original task or the Round 1 text. Nothing about Gate
 * behaviour, trigger history or arm outcomes may appear — that reasoning would invalidate
 * the candidate (§7), and it would also be exactly the contamination that removed the
 * replay #3/#4 fixture from this set.
 */
const ELIGIBILITY = {
  'fx-01': {
    archetypeCode: 'STRATEGY_CONFLICT',
    f1: 'DEEP：三個互斥選項，需要跨領域取捨與 90 天驗證設計。',
    f2: '兩位成功的 Round 1 specialist：market_positioning、delivery_operations。',
    f3: '兩份 Round 1 輸出皆完整，無失敗 worker。',
    f4: '兩位專家在原始 Round 1 文本中選擇了不同選項（B vs C），且各自的理由指向不同的限制因素（通路取得 vs 講師產能）。',
    f5: '原始任務列出七項已知條件，足以判斷答案是否處理了產能、品牌錨定與漏斗上游。',
    f6: '所有事實由任務本身給定，不需要任何即時外部資料。',
    f7: '任務中無金額、無需計算；把數量描述改為定性敘述後決策仍成立。',
  },
  'fx-02': {
    archetypeCode: 'EXECUTION_CONSTRAINT_CONFLICT',
    f1: 'DEEP：時程選項加上前置條件設計，需要跨領域取捨。',
    f2: '兩位成功的 Round 1 specialist：clinical_staffing、growth_planning。',
    f3: '兩份 Round 1 輸出皆完整，無失敗 worker。',
    f4: '兩位專家在 Round 1 文本中都明確表示方向本身沒有爭議，但對「今年下半年在現有人力下是否做得到」給出相反判斷。',
    f5: '任務給定招募週期、主治獸醫人數、輪值配置與物件保留期，足以判斷可行性論證是否成立。',
    f6: '所有事實由任務本身給定。',
    f7: '任務中出現的數量（三位主治獸醫、四個月、三個月）為條件描述而非計算對象。',
  },
  'fx-03': {
    archetypeCode: 'EVIDENCE_INTERPRETATION_CONFLICT',
    f1: 'DEEP：需要判讀證據品質並決定資源投向。',
    f2: '兩位成功的 Round 1 specialist：demand_research、retention_analysis。',
    f3: '兩份 Round 1 輸出皆完整，無失敗 worker。',
    f4: '任務明示「所有人看到的是同一份事實」；兩份 Round 1 文本對同一組 Pilot 事實得出相反推論（需求已驗證 vs 樣本組成造成的假訊號）。',
    f5: '任務列出八項 Pilot 事實，足以判斷答案是否處理了樣本組成、填答率與價格未被測到。',
    f6: '所有事實由任務本身給定。',
    f7: '任務刻意不給任何數值，只給定性描述（「比例很高」「個位數」「約六成」）；決策不依賴任何計算。',
  },
  'fx-04': {
    archetypeCode: 'NEGATIVE_CONTROL',
    f1: 'DEEP：仍需處理採用門檻、失敗模式與 90 天驗證。',
    f2: '兩位成功的 Round 1 specialist：team_workflow、client_delivery。',
    f3: '兩份 Round 1 輸出皆完整，無失敗 worker。',
    f4: '兩份 Round 1 文本推薦相同選項、相同分階段方式與相同的三個月檢核點；差異僅在強調點（採用門檻 vs 回饋落點）與措辭。',
    f5: '任務列出七項已知條件，足以判斷答案是否處理了行政負擔與採用風險。',
    f6: '所有事實由任務本身給定。',
    f7: '任務中無金額、無需計算。',
  },
};

/** Option 3′ target-provider allocation. Frozen here, executed nowhere. */
export const OPTION_3_PRIME = Object.freeze({
  rationale:
    'In a frozen Round-1 replay only the challenged specialist issues a call, so the ' +
    'non-target specialist\'s provider never executes. Assigning both specialists in a ' +
    'fixture the same provider therefore costs nothing and makes target-provider coverage ' +
    'deterministic rather than dependent on which specialist the Gate happens to pick.',
  decisionSynthesizer: { provider: 'openai', requestedModel: 'gpt-5' },
  byFixture: {
    'fx-01': { targetProvider: 'openai', targetModel: 'gpt-5' },
    'fx-02': { targetProvider: 'claude', targetModel: 'claude-sonnet-5' },
    'fx-03': { targetProvider: 'gemini', targetModel: 'gemini-3.1-pro-preview' },
    'fx-04': { targetProvider: 'openai', targetModel: 'gpt-5' },
  },
  claimBoundary:
    'Execution coverage only. One fixture per provider does not support any ' +
    'cross-provider generalization claim.',
});

function writeNew(path, content) {
  if (existsSync(path)) throw new Error(`refusing to overwrite frozen artifact: ${path}`);
  writeFileSync(path, content, { flag: 'wx' });
  return sha256(content);
}

export function freezeAll({ frozenAt } = {}) {
  const runtimeCommit = git('rev-parse', 'HEAD');
  const chunkerVersion = sha256(git('show', `${runtimeCommit}:src/agents/collaboration.ts`));
  const at = frozenAt ?? new Date().toISOString();
  const written = [];

  for (const fixtureId of EXPERIMENT_FIXTURE_IDS) {
    const fx = loadFixture(fixtureId);
    const passages = passagesOf(fx);
    const manifest = {
      fixtureId,
      archetypeCode: ELIGIBILITY[fixtureId].archetypeCode,
      status: 'FROZEN_PRE_ARM',
      protocolVersion: 'M2B-PROTOCOL-0.2',
      fixtureSha256: fx.fixtureSha256,
      snapshotSha256: fx.snapshotSha256,
      rosterSha256: sha256(JSON.stringify(fx.roster)),
      fileHashes: fx.fileHashes,
      passageCounts: Object.fromEntries(Object.entries(passages).map(([k, v]) => [k, v.length])),
      passageIds: Object.fromEntries(Object.entries(passages).map(([k, v]) => [k, v.map((p) => p.passageId)])),
      eligibility: ELIGIBILITY[fixtureId],
      option3Prime: OPTION_3_PRIME.byFixture[fixtureId],
      runtimeCommit,
      chunkerVersion,
      createdAt: at,
      frozenAt: at,
      // Stated on the record: no arm has run against this fixture at freeze time.
      armExecution: 'NONE',
    };
    const path = join(FIXTURE_ROOT, fixtureId, 'fixture-manifest.json');
    written.push({ path, sha256: writeNew(path, JSON.stringify(manifest, null, 2) + '\n') });
  }

  mkdirSync(join(M2B, 'evaluation', 'cleanroom'), { recursive: true });
  for (const kind of ['conflict', 'gold']) {
    const packet = buildCleanRoomPacket(kind);
    const path = join(M2B, 'evaluation', 'cleanroom', `packet-${kind}.md`);
    written.push({ path, sha256: writeNew(path, packet.text) });
  }

  mkdirSync(join(M2B, 'manifests'), { recursive: true });
  const allocPath = join(M2B, 'manifests', 'option3prime-allocation.json');
  written.push({ path: allocPath, sha256: writeNew(allocPath, JSON.stringify(OPTION_3_PRIME, null, 2) + '\n') });

  return { runtimeCommit, chunkerVersion, frozenAt: at, written };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = freezeAll();
  for (const w of out.written) console.log(`${w.sha256.slice(0, 16)}  ${w.path.replace(ROOT, '')}`);
  console.log(`\nruntimeCommit ${out.runtimeCommit}\nchunkerVersion ${out.chunkerVersion.slice(0, 16)}…\nfrozenAt ${out.frozenAt}`);
}

/**
 * The experiment freeze manifest: one record binding fixtures, ground truth, the packets
 * the annotators actually saw, and the runtime that produced the passage ids.
 *
 * Written after annotation, so it is the point at which the Phase 1 inputs stop moving.
 */
export function buildFreezeManifest({ frozenAt } = {}) {
  const runtimeCommit = git('rev-parse', 'HEAD');
  const at = frozenAt ?? new Date().toISOString();
  const hashOf = (p) => sha256(readFileSync(p, 'utf8'));
  const evaluationRoot = join(M2B, 'evaluation');

  const fixtures = EXPERIMENT_FIXTURE_IDS.map((fixtureId) => {
    const fx = loadFixture(fixtureId);
    const manifest = JSON.parse(readFileSync(join(FIXTURE_ROOT, fixtureId, 'fixture-manifest.json'), 'utf8'));
    return {
      fixtureId,
      archetypeCode: manifest.archetypeCode,
      fixtureSha256: fx.fixtureSha256,
      snapshotSha256: fx.snapshotSha256,
      rosterSha256: manifest.rosterSha256,
      fixtureManifestSha256: hashOf(join(FIXTURE_ROOT, fixtureId, 'fixture-manifest.json')),
      conflictLabelsSha256: hashOf(join(evaluationRoot, fixtureId, 'conflict-labels.json')),
      goldIssuesSha256: hashOf(join(evaluationRoot, fixtureId, 'gold-issues.json')),
      option3Prime: OPTION_3_PRIME.byFixture[fixtureId],
    };
  });

  return {
    protocolVersion: 'M2B-PROTOCOL-0.2',
    status: 'FROZEN_PRE_ARM',
    frozenAt: at,
    runtimeCommit,
    chunkerVersion: sha256(git('show', `${runtimeCommit}:src/agents/collaboration.ts`)),
    fixtures,
    cleanRoom: {
      packetConflictSha256: hashOf(join(evaluationRoot, 'cleanroom', 'packet-conflict.md')),
      packetGoldSha256: hashOf(join(evaluationRoot, 'cleanroom', 'packet-gold.md')),
      rawConflictLabelsSha256: hashOf(join(evaluationRoot, 'cleanroom', 'raw-conflict-labels.md')),
      rawGoldIssuesSha256: hashOf(join(evaluationRoot, 'cleanroom', 'raw-gold-issues.md')),
      // Provenance, stated because it is the thing that makes the labels independent.
      conflictAnnotator: 'clean-room Gemini session A — saw only packet-conflict.md',
      goldAnnotator: 'clean-room Gemini session B — saw only packet-gold.md, never session A output',
      isolation: 'two separate fresh sessions; neither reused the methodology-review context nor PACKET-1/PACKET-2',
      activityClass: 'GROUND-TRUTH AUTHORING — not a runtime experiment; no Chief/M2 harness call, not counted as pilot calls',
    },
    armExecution: 'NONE',
    liveProviderCalls: 0,
    temperatureProbe: 'NOT RUN',
  };
}
