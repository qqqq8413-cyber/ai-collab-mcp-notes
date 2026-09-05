# ai-collab-mcp — Experimental M2-A 實作審查包(rev. 2,Pre-Live Finalized)

基準:branch `experimental/m2a-peer-challenge`｜日期:2026-09-05｜對象:Gemini、GPT(各自獨立作答)

---

## 0. 這份文件為什麼是自足的

**你無法讀取這個 repository。** 因此本包內嵌**實際 TypeScript 原始碼原文**,不是我對程式碼的摘要。

如果我的敘述與貼出的程式碼不一致,**以程式碼為準,並直接指出我寫錯了**。超出本包的內容請標為待查證。

**這是第 2 版。** 上一版之後有四項修正落地,其中一項是**推翻我自己上一版提出的實驗識別策略**。第 1 節說明改了什麼。

---

## 0.1 ⚠️ 三次 diagnostic live 的結果:機制後半段仍未被執行

程式碼未變(仍是本包所述的版本),但已經跑過兩次真實執行,**兩次都沒有讓 gate 運作**:

| | 性質 | complexity | N | 阻擋點 | live calls |
|---|---|---|---|---|---|
| #1 | 自然任務 | `deep` | 1 | `single_specialist_no_peer` | 3 |
| #2 | 自然任務 | **`normal`** | 2 | `complexity_not_deep` | 4 |
| #3 | **controlled frozen replay** | `deep` | 2 | **`no_issue_block`(gate 已執行)** | 1 |

前兩次卡在 gate 之前,第三次卡在 gate 之內。**每次阻擋點都不同,修掉任何一個都不會讓其他兩個消失。**

**#3 最重要:** gate 第一次真正執行(附錄、40 個 deterministic reference、max-one 規則都以 captured prompt 驗證送達),但沒有輸出區塊 —— 而它的回答裡有一段標題叫「專家分歧與如何處理」,**精準認出了 fixture 設計的 B vs C 衝突,然後在答案內解決掉了**。依附錄自己的規則(「只在解決它會改變答案裡的決策時才提報」),省略區塊是正確的。

**這不是 recall 問題,是通道問題:** 同一次呼叫同時被要求「產出完整答案」(必須解決衝突)與「回報未解決的衝突」(需要衝突還在),做好前者就消滅了做後者的理由。

兩次都沒有 runtime defect:gate 未啟動時 synthesis prompt 不含附錄(以 captured prompt 驗證)、`finalOutput` 逐字元等於 `banner + synthesis 原文`、evidence label 以 Round 1 獨立重算一致、所有呼叫皆無 retrieval、call ceiling 皆為 `1 + N + 1`。

#2 特別值得注意:兩位專家都選同一個選項,但論證基礎不同(一位從下檔風險與證據強度,一位從定價錨點與客群區隔)。**材料本來是夠的,gate 從來沒有機會看到。**

這對你的審查有兩個影響:

1. **本包第 5 節的九個挑戰點仍然全部有效**,因為沒有任何一項被實測推翻或證實。
2. **多了一個新問題**:#3 已證明用既有 `replaySynthesis()` 就能讓合法 snapshot 進入真實 downstream path,不需要任何 bypass flag —— 所以「怎麼觸發 gate」已經解決。**真正待解的是第 5 節第 2 題的加強版:附錄要如何寫,才能讓一個已經認出分歧的 synthesizer 有理由用機器可讀通道回報,而不是直接在答案裡解決掉?** 或者這兩個責任根本不該放在同一次呼叫?請一併回答。

---

## 1. 這一版相對上一版改了什麼

| # | 改動 | 原因 |
|---|---|---|
| 1 | `output.slice(0, limit)` → **deterministic chunk reference** | 被挑戰的內容通常不在回答開頭,拿開頭充數會讓 Round 2 回應一段不相關的文字 |
| 2 | Gate 明示**最多一個** peer challenge | 減少 gate 一次丟一堆分歧、由 runtime 硬選的情況 |
| 3 | Decision Synthesis 加入**中立性守則** | 防止「較新 / 修訂版 = 較正確」的隱性偏袒 |
| 4 | Parser edge cases 端到端補齊 | 交付物路徑必須被證明,不是被相信 |
| 5 | 新增 `replaySynthesis()` 與 `disableRound2` | 見下方 §2 |

### ⚠️ §2 我上一版提的實驗識別策略是錯的

上一版我提議:用 C 執行中 `SKIPPED` 的那些當天然的 arm B′,和 `COMPLETED` 的那些相比,以此拆開「附錄效果」與「peer interaction 效果」。

**這個做法有 selection bias,已停用。** 觸發與否不是隨機分派,而是與任務本身相關 —— 有跨專家分歧的任務才會觸發。拿兩群不同的任務相減,量到的是任務差異,不是 peer interaction。

我當時已經標注「可能不成立」,卻仍把它寫成主要方案。**正確的處理是:一個自己知道可能不成立的識別策略,不應該被寫成方案,應該被寫成待解問題。**

現在採用的是兩個 **paired** 比較,都不需要跨任務相減:

```text
附錄效果         凍結同一份 Round 1,只重跑 synthesis
                 B  = 既有 prompt
                 B′ = gate prompt + Round 2 強制關閉

peer interaction 同一次執行內
                 C_provisional  vs  C_final
```

**請獨立判斷這兩個 paired 設計是否真的解決了問題,還是只是把 bias 移到別處。**

---

## 3. 實際原始碼(verbatim)

### 3.1 Deterministic segmentation

```ts
export function segmentOutput(output: string): OutputChunk[] {
  const chunks: OutputChunk[] = [];
  let cursor = 0;

  const push = (rawStart: number, rawEnd: number) => {
    const raw = output.slice(rawStart, rawEnd);
    const leading = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text.length === 0) return;
    const startChar = rawStart + leading;
    chunks.push({
      id: `p${chunks.length + 1}`,
      index: chunks.length,
      startChar,
      endChar: startChar + text.length,
      text,
    });
  };

  CHUNK_SEPARATOR.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CHUNK_SEPARATOR.exec(output)) !== null) {
    push(cursor, match.index);
    cursor = match.index + match[0].length;
  }
  push(cursor, output.length);

  return chunks;
}
```

### 3.2 sourceRef 解析

```ts
export function resolveSourceRef(
  ref: string,
  chunksByAgent: Readonly<Record<string, OutputChunk[]>>
): SourceRefResolution {
  const separator = ref.indexOf(':');
  const agentId = separator === -1 ? ref : ref.slice(0, separator);
  const chunkId = separator === -1 ? undefined : ref.slice(separator + 1);

  const chunks = chunksByAgent[agentId];
  if (!chunks) {
    return { ok: false, reason: `sourceRef "${ref}" does not name a successful Round 1 specialist` };
  }
  if (chunks.length === 0) {
    return { ok: false, reason: `sourceRef "${ref}" names a specialist whose answer has no citable passage` };
  }

  if (chunkId === undefined) {
    if (chunks.length === 1) return { ok: true, agentId, chunk: chunks[0] };
    return {
      ok: false,
      reason:
        `sourceRef "${ref}" names a specialist but no passage; ${agentId} has ` +
        `${chunks.length} passages (${chunks.map((c) => c.id).join(', ')})`,
    };
  }

  const chunk = chunks.find((c) => c.id === chunkId);
  if (!chunk) {
    return {
      ok: false,
      reason:
        `sourceRef "${ref}" names no passage of ${agentId}; available: ` +
        `${chunks.map((c) => c.id).join(', ')}`,
    };
  }
  return { ok: true, agentId, chunk };
}
```

### 3.3 Bounded chunk extraction(audit trail)

```ts
export function buildPeerExcerpt(agentId: string, chunk: OutputChunk, charLimit: number): PeerExcerpt {
  const limit = Math.max(1, Math.floor(charLimit));
  const truncated = chunk.text.length > limit;
  const text = truncated ? chunk.text.slice(0, limit) : chunk.text;
  return {
    agentId,
    chunkId: chunk.id,
    chunkIndex: chunk.index,
    startChar: chunk.startChar,
    endChar: chunk.startChar + text.length,
    truncated,
    charLimit: limit,
    text,
  };
}
```

### 3.4 Gate 附錄(全文,含 chunk map 與 max-one 規則)

```ts
export function buildGateAppendix(
  agentIds: readonly string[],
  chunksByAgent: Readonly<Record<string, OutputChunk[]>>
): string {
  const references = agentIds
    .map((id) => `  ${id}: ${(chunksByAgent[id] ?? []).map((c) => `${id}:${c.id}`).join(', ') || '(no citable passage)'}`)
    .join('\n');

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
- At most one "peer_challenge" may be emitted. If several disagreements exist, select only the one whose resolution would have the greatest effect on the final decision.
- "targetAgentId" is the specialist whose work is challenged, and must be one of: ${agentIds.join(', ')}.
- "sourceRef" is the passage the challenge comes from, written as "<agentId>:<passageId>". It must belong to a different specialist from "targetAgentId". Passage ids number the blank-line-separated paragraphs of each specialist's Result above, in order. The available references are:
${references}
- "action" is "peer_challenge" when another specialist's work contradicts or undermines it, or "needs_evidence" when a claim needs external verification. Only "peer_challenge" is acted on in this run.
- Prefer omitting the block entirely to inventing a disagreement. A manufactured issue is worse than none.`;
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
    const resolved = resolveSourceRef(e.sourceRef, context.chunksByAgent);
    if (!resolved.ok) return reject(resolved.reason);
    if (resolved.agentId === e.targetAgentId) {
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

### 3.6 Deterministic selection(gate 違規時的 fallback)

```ts
export function selectIssue(
  issues: readonly CollaborationIssue[],
  agentOrder: readonly string[]
): CollaborationIssue | undefined {
  const rank = (id: string) => {
    const i = agentOrder.indexOf(id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  // `sourceRef` carries a passage id; ordering is by specialist, not by the id's text.
  const peerOf = (ref: string) => (ref.includes(':') ? ref.slice(0, ref.indexOf(':')) : ref);

  const eligible = issues
    .map((issue, index) => ({ issue, index }))
    .filter(({ issue }) => isRound2Eligible(issue));
  if (eligible.length === 0) return undefined;

  eligible.sort((a, b) => {
    const target = rank(a.issue.targetAgentId) - rank(b.issue.targetAgentId);
    if (target !== 0) return target;
    const source = rank(peerOf(a.issue.sourceRef)) - rank(peerOf(b.issue.sourceRef));
    if (source !== 0) return source;
    return a.index - b.index;
  });

  return eligible[0].issue;
}
```

### 3.7 Parser

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

### 3.8 Round 2 prompt

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

The passage from another specialist that the challenge comes from (${input.excerpt.agentId}:${input.excerpt.chunkId})${
    input.excerpt.truncated ? ', truncated' : ''
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

### 3.9 Decision Synthesis prompt(含新的中立性守則)

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
- Treat the Round 2 response as a challenge response, not as inherently more correct because it is newer or revised. Revision, recency, or agreement between specialists is not evidence. Evaluate the Round 2 response against the original reasoning, the peer challenge, and the task constraints.
- The second round gathered no new external evidence. Do not describe anything as verified, confirmed or validated on the strength of the specialists agreeing with each other.`;
}
```

### 3.10 arm B′ —— gate 有跑,peer exchange 沒跑

```ts
  if (input.disableRound2) {
    notes.push(
      'Round 2 is disabled for this run. The issue that would have been acted on is recorded, ' +
        'and the answer is the gate\'s provisional one.'
    );
    return finish(provisional, 'SKIPPED', 'round2_disabled', {
      ...gated,
      parse: parseField,
      issues: issuesField,
      selectedIssue: selected,
    });
  }

  const targetResult
```

### 3.11 Frozen Round-1 replay

```ts
export async function replaySynthesis(snapshot: Round1Snapshot, options: ReplayOptions) {
  const report = buildRunReport(snapshot.complexity, snapshot.workers, snapshot.workerResults);
  const startedAt = Date.now();
  const stage = await runSynthesisStage({
    call: options.call ?? callProvider,
    task: snapshot.task,
    complexity: snapshot.complexity,
    agentOrder: snapshot.agentOrder,
    workers: snapshot.workers,
    workerResults: snapshot.workerResults,
    report,
    synthesizer: options.synthesizer,
    collaboration: options.collaboration,
  });

  return {
    report,
    finalOutput: stage.finalOutput,
    ...(stage.collaboration ? { collaboration: stage.collaboration } : {}),
    timings: { synthesisMs: stage.synthesisMs, totalMs: Date.now() - startedAt },
  };
}
```

---

## 4. 目前的邊界(未改變)

```text
default OFF｜DEEP only｜max Round2 = 1｜Round2 retrieval = OFF｜fallback = provisional answer
Logical call ceiling = N + 4,SPECIALIST_CAP.deep = 4 → absolute 8
```

Evidence 不變式仍由**結構**保證:Round 2 的輸出不進 `workerResults`、不進 `summarizeRetrieval`、不進 `deriveEvidenceLabel`,banner 一律由 Round 1 的 report 產生。

離線測試 208 項全過。**尚未跑過一次 live。**

---

## 5. 請你獨立挑戰的九件事

1. **§2 的兩個 paired 設計成立嗎?** 這是最重要的一題。`B vs B′` 用 frozen Round 1;`C_provisional vs C_final` 用同一次執行。有沒有殘留的 bias?特別是:`C_final` 一定經過兩次 synthesis 等級呼叫,`C_provisional` 只有一次 —— 這算不算另一個 confound(「多寫一次就是會比較好」)?如果算,要怎麼處理?
2. **Chunk 切法(3.1)夠嗎?** 依空白行切段。對於「一整段很長的分析」或「條列式清單」,這個切法會不會產生太粗或太細的 chunk,讓 gate 難以精準指向?
3. **bare `<agentId>` 只在單一 chunk 時接受(3.2),這個規則對嗎?** 太嚴會讓 gate 的合法意圖被拒;太寬就回到「取開頭」的老問題。
4. **max-one 規則(3.4)會不會反效果?** 要求模型自己先挑「影響最大的那一個」,等於要它做未經校準的嚴重性排序。這會不會比讓它全部回報、由 runtime 固定排序更差?
5. **中立性守則(3.9)寫得夠嗎?** 我加的是「不得因為較新或屬於修訂版就視為較正確」。但 Round 2 的內容出現在 prompt 較後段、且明確標為 revised —— 光靠一句指示能抵銷位置與標籤帶來的偏袒嗎?有沒有結構性的做法?
6. **selection 排序主鍵(3.6)** 用「被挑戰者在 assignment order 的位置」,代表永遠優先挑戰最高優先的專家。現在 gate 已經被要求自己挑最重要的一個,runtime 的排序只在違規時啟動 —— 這樣主鍵的選擇還重要嗎?
7. **Parser(3.7)的擷取規則安全嗎?** 只有「位於結尾 + 內容含 `collaborationIssues`」的區塊會被剝離。有沒有真實答案會被誤剝、或合法輸出會被漏掉?
8. **`replaySynthesis`(3.11)是否真的與 live path 同構?** 它呼叫同一個 `runSynthesisStage()`。有沒有哪個狀態是 live 有、replay 沒有,以致 replay 量到的其實不是同一個系統?
9. **我漏了什麼?** 特別是首次 live 之前還有沒有必須先修的東西。

---

## 6. 回覆格式

```text
A. 我從貼出的程式碼中讀到、而提問者敘述有誤的地方(若無則明說「無」)
B. 對第 5 節九個挑戰點的逐項回答
C. 對 §2 兩個 paired 設計的獨立判斷:成立 / 不成立 / 有殘留 bias,以及理由
D. 提問者漏掉的問題
E. 整體建議:可以跑首次 live / 先修這些再跑 / 設計本身仍有問題
F. 本回覆中哪些是你從程式碼推出的,哪些是你的先驗判斷
```

**F 是必填。** 證據強度排序:

```text
runtime measurement > code / deterministic tests > independent external evidence
  > multi-model critique > single-model reasoning
```

**模型收斂不是獨立實證。** 你的意見屬於倒數第二層。

**特別提醒:** 這份 prototype 已經跑過**兩次** diagnostic live,**兩次的協作機制都沒有被執行到**(見第 0.1 節)。所以關於「它實際表現如何」,你和我一樣仍然沒有證據 —— 差別只在於現在我們知道它為什麼還沒被執行。
