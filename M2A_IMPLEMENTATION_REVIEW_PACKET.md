# ai-collab-mcp — Experimental Milestone 2-A 實作審查包

基準:branch `experimental/m2a-peer-challenge` / commit `b23986b`｜日期:2026-09-05｜對象:Gemini、GPT(各自獨立作答)

---

## 0. 這份文件為什麼是自足的

**你無法讀取這個 repository。** 因此本包內嵌**實際 TypeScript 原始碼原文**,不是我對程式碼的摘要。

如果我的敘述與貼出的程式碼不一致,**以程式碼為準,並直接指出我寫錯了**。超出本包的內容請標為待查證,不要補成事實。

上一輪你審查的是 `MILESTONE2_SCOPE_ANALYSIS.md`(設計提案)。**這一輪審查的是它的實作。**

---

## 1. 這是什麼

一個 **default OFF 的實驗性 prototype**,不是 production feature。存在的唯一目的是回答:

> 不同 AI 互相挑戰,是否真的比現有 Orchestrator、甚至比同一個模型自己再想一次,更有價值?

在那個問題被實測回答之前,這裡沒有任何東西算是已驗證。**目前尚未跑過一次 live 執行。**

執行形狀:

```text
Chief Planning
→ Round 1 Specialists(平行,N 位)
→ Synthesis Gate  ── provisional answer(交付物)
                   └─ optional collaboration issue block(metadata)
      │
      ├─ 沒有 decision-sensitive peer_challenge → provisional answer = Final
      └─ 有 → Targeted Round 2(最多 1 位)→ Decision Synthesis → Final
```

呼叫上限:`1 Chief + N Workers + 1 Gate + 1 Round-2 + 1 Decision = N + 4`。`SPECIALIST_CAP.deep = 4`,故 absolute ceiling = **8**。

離線測試 99 → 175,0 failed。

---

## 2. ⚠️ 我自己發現的一個 confound,請優先評估

這是我在實作完成後才看清楚的,**指令沒有提到,我也還沒有解法**。

- **arm B**(現有 orchestrator):synthesis prompt = `P` → 答案
- **arm C**(本實驗):synthesis prompt = `P + 附錄` → provisional answer

也就是說,**即使 C 完全沒有觸發 Round 2,C 的答案也是在一個和 B 不同的 prompt 下產生的。** 附錄要求模型去尋找跨專家分歧,這件事本身就可能改變答案 —— 更防禦性的措辭、注意力被分走、或反過來因為重讀了各專家輸出而更完整。

所以 `C > B` 有可能**完全不是 peer interaction 造成的**,而是附錄造成的。

我目前的觀察是:這個 confound **可以從既有資料裡拆開,不需要新程式**。因為報告會記錄每次執行是否觸發:

```text
C 執行中 status = SKIPPED  → prompt 有附錄,但沒有 peer interaction   ← 這就是 arm B′
C 執行中 status = COMPLETED → prompt 有附錄,且有 peer interaction
```

於是:

```text
(B′ − B)      = 附錄本身的效果
(C − B′)      = peer interaction 的效果
```

**請挑戰這個拆法。** 我不確定它成立 —— 例如觸發與否本身可能與任務難度相關(難的任務才有分歧),那 B′ 與 C 就不是隨機分組,兩者的差可能只是任務難度差。如果是這樣,正確做法是什麼?

---

## 3. 實際原始碼(verbatim)

### 3.1 Gate 啟動條件

```ts
  const gateBlocked =
    !collaborationEnabled
      ? 'collaboration_disabled'
      : plan.complexity !== 'deep'
        ? `complexity_not_deep (${plan.complexity})`
        : report.status !== 'SUCCESS'
          ? `round1_status_${report.status.toLowerCase()}`
          : successfulAgentIds.length < 2
            ? 'single_specialist_no_peer'
            : undefined;
  const gateActive = collaborationEnabled && gateBlocked === undefined;
```

Gate 沒啟動時,synthesis prompt 是既有那一份,一字未改。DEGRADED 被排除是刻意的:gate 會在少了一位專家的情況下比較專家。

### 3.2 Gate 呼叫

```ts
  const synthesisStart = Date.now();
  const finalResult = await call(
    synthesizer.provider,
    gateActive ? synthesisPrompt + buildGateAppendix(successfulAgentIds) : synthesisPrompt,
    {
      model: synthesizer.model,
      stage: gateActive ? 'synthesis_gate' : 'synthesis',
    }
  );
  const synthesisMs = Date.now() - synthesisStart;

  const banner = buildOutputBanner(report);
```

### 3.3 附錄(加在 synthesis prompt 後面的全部內容)

```ts
export function buildGateAppendix(agentIds: readonly string[]): string {
  return `

Optional collaboration block
----------------------------
After the complete answer above, you may append one fenced block in exactly this form:

\`\`\`json
{"${BLOCK_MARKER}": [{"targetAgentId": "...", "sourceRef": "...", "challenge": "...", "decisionSensitive": true, "action": "peer_challenge"}]}
\`\`\`

If you include it:
- The answer above must already be complete and usable on its own. This block is metadata, not part of the answer.
- Raise an issue only where one specialist's work is materially challenged by another's, and where resolving it would change a decision in the answer.
- "targetAgentId" is the specialist whose work is challenged. "sourceRef" is the different specialist the challenge comes from. They must not be the same id, and both must be one of: ${agentIds.join(', ')}.
- "action" is "peer_challenge" when another specialist's work contradicts or undermines it, or "needs_evidence" when a claim needs external verification. Only "peer_challenge" is acted on in this run.
- Prefer omitting the block entirely to inventing a disagreement. A manufactured issue is worse than none.`;
}
```

### 3.4 Parser —— 交付物不押在 parse 上

```ts
export function parseGateOutput(text: string): ParsedGateOutput {
  const trimmedEnd = text.replace(/\s+$/, '');

  let body: string | undefined;
  let answer: string | undefined;

  const fenced = trimmedEnd.match(FENCED_TAIL);
  if (fenced && fenced[1].includes(BLOCK_MARKER)) {
    body = fenced[1];
    answer = trimmedEnd.slice(0, fenced.index);
  } else {
    const bare = trimmedEnd.match(BARE_TAIL);
    if (bare && bare[1].includes(BLOCK_MARKER)) {
      body = bare[1];
      answer = trimmedEnd.slice(0, bare.index);
    }
  }

  if (body === undefined || answer === undefined) {
    return { answer: text, rawIssues: [], status: 'absent' };
  }

  // A block with no answer in front of it is not a reason to deliver nothing. Keep the raw
  // response as the answer and say so, rather than handing the user an empty string.
  if (answer.trim().length === 0) {
    return {
      answer: text,
      rawIssues: [],
      status: 'schema_invalid',
      note: 'The gate returned an issue block with no answer before it; the raw response was delivered unchanged.',
    };
  }

  const cleaned = answer.replace(/\s+$/, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return {
      answer: cleaned,
      rawIssues: [],
      status: 'malformed',
      note: `Issue block was not valid JSON (${String(err)}); it was dropped and the answer delivered as written.`,
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      answer: cleaned,
      rawIssues: [],
      status: 'schema_invalid',
      note: 'Issue block was not a JSON object; it was dropped.',
    };
  }

  const issues = (parsed as Record<string, unknown>)[BLOCK_MARKER];
  if (!Array.isArray(issues)) {
    return {
      answer: cleaned,
      rawIssues: [],
      status: 'schema_invalid',
      note: `Issue block had no "${BLOCK_MARKER}" array; it was dropped.`,
    };
  }

  return { answer: cleaned, rawIssues: issues, status: 'parsed' };
}
```

### 3.5 Issue 驗證

```ts
export function validateIssues(raw: unknown[], context: ValidationContext): ValidationOutcome {
  const known = new Set(context.successfulAgentIds);
  const valid: CollaborationIssue[] = [];
  const rejected: RejectedIssue[] = [];

  raw.forEach((entry, index) => {
    const reject = (reason: string) => rejected.push({ index, reason });

    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return reject('not a JSON object');
    }
    const e = entry as Record<string, unknown>;

    if (typeof e.targetAgentId !== 'string') return reject('targetAgentId is not a string');
    if (typeof e.sourceRef !== 'string') return reject('sourceRef is not a string');
    if (typeof e.challenge !== 'string' || e.challenge.trim().length === 0) {
      return reject('challenge is missing or empty');
    }
    if (typeof e.decisionSensitive !== 'boolean') return reject('decisionSensitive is not a boolean');
    if (e.action !== 'peer_challenge' && e.action !== 'needs_evidence') {
      return reject(`action is not a known action (${JSON.stringify(e.action)})`);
    }
    if (!known.has(e.targetAgentId)) {
      return reject(`targetAgentId "${e.targetAgentId}" is not a successful Round 1 specialist`);
    }
    if (!known.has(e.sourceRef)) {
      return reject(`sourceRef "${e.sourceRef}" is not a successful Round 1 specialist`);
    }
    if (e.sourceRef === e.targetAgentId) {
      return reject('sourceRef and targetAgentId are the same specialist; that is self-review, not a peer challenge');
    }

    valid.push({
      targetAgentId: e.targetAgentId,
      sourceRef: e.sourceRef,
      challenge: e.challenge.trim(),
      decisionSensitive: e.decisionSensitive,
      action: e.action,
    });
  });

  return { valid, rejected };
}
```

### 3.6 Deterministic selection

```ts
export function selectIssue(
  issues: readonly CollaborationIssue[],
  agentOrder: readonly string[]
): CollaborationIssue | undefined {
  const rank = (id: string) => {
    const i = agentOrder.indexOf(id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };

  const eligible = issues
    .map((issue, index) => ({ issue, index }))
    .filter(({ issue }) => isRound2Eligible(issue));
  if (eligible.length === 0) return undefined;

  eligible.sort((a, b) => {
    const target = rank(a.issue.targetAgentId) - rank(b.issue.targetAgentId);
    if (target !== 0) return target;
    const source = rank(a.issue.sourceRef) - rank(b.issue.sourceRef);
    if (source !== 0) return source;
    return a.index - b.index;
  });

  return eligible[0].issue;
}
```

### 3.7 Peer excerpt

```ts
export function buildPeerExcerpt(agentId: string, output: string, charLimit: number): PeerExcerpt {
  const limit = Math.max(1, Math.floor(charLimit));
  const truncated = output.length > limit;
  const text = truncated ? output.slice(0, limit) : output;
  return {
    agentId,
    startChar: 0,
    endChar: text.length,
    truncated,
    charLimit: limit,
    text,
  };
}
```

### 3.8 Round 2 呼叫(注意沒有 retrieval)

```ts
  const round2Start = Date.now();
  let revised: string;
  try {
    // No retrieval is attached, deliberately, even when this specialist is evidenceCapable.
    const result = await input.call(
      targetWorker.provider,
      buildRound2Prompt({
        task: input.task,
        mission: targetResult.mission,
        previousOutput: targetResult.output!,
        excerpt,
        challenge: selected.challenge,
      }),
      { model: targetWorker.model, system: targetWorker.role, stage: 'round2_worker' }
    );
    revised = result.text;
  } catch (err) {
    const round2Ms = Date.now() - round2Start;
```

### 3.9 Round 2 prompt

```ts
export function buildRound2Prompt(input: {
  task: string;
  mission: string;
  previousOutput: string;
  excerpt: PeerExcerpt;
  challenge: string;
}): string {
  return `Original task:
${input.task}

Your assigned mission (unchanged):
${input.mission}

Your previous answer:
${input.previousOutput}

A passage from another specialist (${input.excerpt.agentId})${
    input.excerpt.truncated ? ', quoted from the start of their answer and truncated' : ''
  }:
${input.excerpt.text}

The challenge to your previous answer:
${input.challenge}

Round 2 contract:
- Address only this challenge. Do not restate or expand the rest of your answer beyond what the challenge affects.
- If the challenge is wrong, say so plainly and explain why. Do not concede in order to agree.
- If it is right, correct your answer and state what changed.
- You have gathered no new external evidence in this round. Do not present anything as verified; mark what you cannot check as an assumption.
- Stay inside your assigned mission, and preserve the original task's language, format and constraints.`;
}
```

### 3.10 Decision Synthesis prompt

```ts
export function buildDecisionSynthesisPrompt(input: {
  task: string;
  specialistBlock: string;
  degradedNote: string;
  issue: CollaborationIssue;
  revisedOutput: string;
}): string {
  return `Original task:
${input.task}

Results from each specialist:
${input.specialistBlock}
${input.degradedNote}
A cross-specialist challenge was raised and answered in a second round:
- Challenged specialist: ${input.issue.targetAgentId}
- Challenge raised from: ${input.issue.sourceRef}
- The challenge: ${input.issue.challenge}
- ${input.issue.targetAgentId}'s revised answer after the challenge:
${input.revisedOutput}

Decision contract:
- Produce the final answer to the original task.
- Where the challenge changed the conclusion, use the revised position.
- Where it did not, keep the original position and say briefly why the challenge did not change it.
- If the disagreement is unresolved, state it plainly. Do not hide it inside a merged sentence.
- The second round gathered no new external evidence. Do not describe anything as verified, confirmed or validated on the strength of the specialists agreeing with each other.`;
}
```

---

## 4. 失敗語意

七種情況全部交付 provisional answer,`RunStatus` 保持 Round 1 語意,run 不會 FAILED:

| 情況 | status / reason |
|---|---|
| 沒有區塊 | `SKIPPED` / `no_issue_block` |
| JSON 壞掉 | `SKIPPED` / `block_malformed` |
| 不是物件 / 沒有 issues 陣列 | `SKIPPED` / `block_schema_invalid` |
| issue 全部無效 | `SKIPPED` / `no_valid_issue` |
| 有效但不合格 | `SKIPPED` / `no_decision_sensitive_peer_challenge` |
| Round 2 失敗 | `FAILED` / `round2_worker_failed` |
| Decision Synthesis 失敗 | `FAILED` / `decision_synthesis_failed` |

---

## 5. Evidence 不變式如何被保證

**由結構,不是由 prompt。** Round 2 的輸出:

- **不進** `workerResults`
- **不進** `summarizeRetrieval`
- **不進** `deriveEvidenceLabel`

banner 一律由 Round 1 的 report 產生。Round 2 **不掛 retrieval**,即使被挑戰的專家是 `evidenceCapable`。`needs_evidence` 只記錄不執行。

3.10 的 prompt 另外明寫「不得因為專家彼此同意就把任何東西描述成已驗證」,但那只是第二道防線 —— 第一道是結構上它根本改不動 label。

測試斷言:開關兩種狀態下 `evidenceLabel` 與 banner 完全相同;任何路徑都不產生 `EVIDENCE_BACKED`。

---

## 6. 控制組沒有漂移(已證明)

為了做出 gate 版本,synthesis prompt 被抽成變數。arm B 是控制組,這種重構正是會靜靜搬動一個換行的地方。因此加了測試,用 M2 之前的寫法重建 prompt 逐位元組比對:

```js
await check('a disabled run sends the pre-M2 synthesis prompt byte for byte', async () => {
  const { calls, result } = await run({ collaboration: false });
  const actual = calls.find((c) => c.stage === 'synthesis').prompt;
  const succeeded = result.workerResults.filter((r) => r.output !== undefined);
  assert.equal(actual, preM2SynthesisPrompt(TASK, succeeded, result.report));
});
```

SUCCESS 與 DEGRADED 兩種情況各一項,加上「gate prompt = 控制組 prompt + 附錄,沒刪任何東西」一項。三項全過。

---

## 7. 請你獨立挑戰的八件事

1. **第 2 節的 confound。** 我的 B′ 拆法成立嗎?如果觸發與否和任務難度相關,正確做法是什麼?這是最重要的一題。
2. **附錄的措辭有沒有偏誤?** 我寫了「Prefer omitting the block entirely to inventing a disagreement. A manufactured issue is worse than none.」—— 這是為了對抗「被要求找問題就一定找得到」的已知失效模式。但它會不會**過度**壓抑,讓 gate 幾乎不觸發,使整個實驗量不到東西?這兩種偏誤要怎麼平衡?
3. **Parser 的擷取規則安全嗎?**(3.4)只有「位於結尾 + 內容含 `collaborationIssues`」的區塊才會被剝離。有沒有哪種真實答案會被誤剝?反過來,有沒有哪種合法的 gate 輸出會被漏掉?
4. **`sourceRef !== targetAgentId` 這條硬性限制對嗎?**(3.5)我的理由是:允許 agent 引用自己,等於讓 arm C 表現出 arm D 的行為,實驗會用錯誤的方式回答自己的問題。這條會不會擋掉合法的情況?
5. **Selection 排序的主鍵選錯了嗎?**(3.6)我用「被挑戰者在 assignment order 的位置」當第一順位,因為 assignment order 已經是 Chief 的 priority order。但這代表**永遠優先挑戰最高優先的專家**。會不會反而應該優先處理「分歧最嚴重」的?(注意:那需要模型評分,就不再 deterministic。)
6. **Head excerpt 的限制多嚴重?**(3.7)`sourceRef` 解析到 agent 而非段落,長答案只被引用開頭,被挑戰的段落可能落在窗口外。這會不會讓 Round 2 大部分時候在回應一段不相關的文字?有沒有**不需要模型產生 offset** 的更好做法?
7. **兩個刻意保留的不對稱可接受嗎?** (a) SIMPLE direct-delivery 與 FAILED 執行不回傳 `collaboration` 物件,即使開關打開;(b) direct-delivery 仍不套 banner,只加了不變式測試。兩者都是為了不動 Step 7 runtime。
8. **我漏了什麼?** 特別是:Decision Synthesis 會不會系統性偏向被挑戰後的修訂版(因為它出現在 prompt 較後段且帶著「revised」字樣)?

---

## 8. 回覆格式

請用這個結構,**不要**先讀另一個模型的答案:

```text
A. 我從貼出的程式碼中讀到、而提問者敘述有誤的地方(若無則明說「無」)
B. 對第 7 節八個挑戰點的逐項回答
C. 對第 2 節 confound 的獨立判斷:我的拆法成立/不成立,以及理由
D. 提問者漏掉的問題
E. 整體建議:可以進入 live 量測 / 先修這些再量 / 這個實驗設計本身有問題
F. 本回覆中哪些是你從程式碼推出的,哪些是你的先驗判斷
```

**F 是必填。** 本專案的證據強度排序:

```text
runtime measurement > code / deterministic tests > independent external evidence
  > multi-model critique > single-model reasoning
```

**模型收斂不是獨立實證。** 你的意見屬於倒數第二層,請據此標定自己的信心。

**特別提醒:** 這份 prototype **一次 live 都還沒跑過**。任何關於「它實際表現如何」的判斷,你和我一樣沒有證據。
