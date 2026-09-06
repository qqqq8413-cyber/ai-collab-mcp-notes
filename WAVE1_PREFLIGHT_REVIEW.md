# WAVE 1 PREFLIGHT REVIEW

> **這是 static repository / protocol readiness review,不是 Wave 1 execution。**
> 本輪 **零 provider call**,未執行 S1 / E1 / I1,未修改 `src/**`。
> `LIVE = NONE`,`EXECUTION AUTHORIZATION: NOT GRANTED`。

---

## 1. HEAD reviewed

```
repository  qqqq8413-cyber/ai-collab-mcp-notes
branch      experimental/m2a-peer-challenge
HEAD        e6150f01eb587353b2b67f12e3b38d714cb4921b   （fetch 後與 remote 相同，working tree clean）
production  src/** @ d01043b（accepted pre-synthesis boundary）
```

## 2. Protocol version

```
M2B-PROTOCOL-0.3   ACCEPTED @ 1354863
amendment          Option 3′-H — Heterogeneous Round1
```

## 3. Files / artifacts inspected

```
CURRENT_STATE.md
experiments/m2b/protocol/amendment-0-3.mjs
experiments/m2b/candidates-0-3/{candidate-set-manifest.json, freeze-provenance.json, S1|E1|I1/task.txt}
experiments/m2b/capture/{runner,recorder,session,capture-verify,run-live,verify-capture-cli}.mjs
experiments/m2b/harness/{cleanroom,fixtures}.mjs
experiments/m2b/test-m2b-{candidate-pool,capture,protocol-0-3}.mjs
src/agents/{chief,registry}.ts、src/models/capabilities.ts、src/modes/orchestrator.ts（唯讀）
```

`M2_EFFECTIVENESS_EXPERIMENT.md` 與 `HANDOFF.md` 只精準查閱,未全文重讀。

---

## 4. Candidate freeze status —— ✅ PASS

| 檢查 | 結果 |
|---|---|
| S1 / E1 / I1 定義完整 | ✅ 三份 `task.txt` 存在,hash 與 manifest、provenance 三方一致 |
| order 已 preregistered / frozen | ✅ `waveOrder = [[S1,E1,I1],[S2,E2,I2],[S3,E3,I3]]`,與 `amendment-0-3.mjs` 的 `WAVES` 逐項相符 |
| freeze 早於任何 live call | ✅ `candidateFreezeCommit = ab893c1`,`liveCallsAtFreeze = 0` |
| 不會重新排序 | ✅ wave order 由常數與 manifest 雙方固定,測試斷言兩者相等 |
| 不會新增 candidate | ✅ 測試斷言目錄恰為九個、無多無少 |
| 不允許事後 retry / task rewrite | ✅ manifest `oneAttemptRule` 明載;hash 綁定使任何改寫立即可偵測 |

`test-m2b-candidate-pool.mjs` 27 項全過。

---

## 5. Round 1 boundary status —— ⚠️ 設計正確,但對本 pool 無法執行

| 檢查 | 結果 |
|---|---|
| 使用 `runRound1Stage()` 而非 `runOrchestrator()` | ✅ `runner.mjs` 只 import 並呼叫 `runRound1Stage`;測試斷言原始碼中不出現 `runOrchestrator(` |
| 只可能產生 `planning` / `round1_worker` | ✅ recorder 的 stage allowlist 在**發出請求之前**檢查,不在清單即 `SCOPE_VIOLATION_POST_ROUND1_CALL` 且不呼叫 provider |
| `synthesis` / `synthesis_gate` / `round2_worker` / `decision_synthesis` | ✅ 逐一有 offline 測試證明被拒且 provider 未被觸及 |
| **能否對 S1 / E1 / I1 執行** | ❌ **不能** —— 見 BLOCKER B-01 |

---

## 6. Provider routing status —— ❌ FAIL

harness 目前實作的是**已被取代的 Option 3′**(每個 fixture 內所有 specialist 綁同一 provider),
不是 ACCEPTED 的 **Option 3′-H**(role → provider,全局固定)。

```js
// experiments/m2b/capture/runner.mjs — 現況
export function buildWorkerRefs(fixtureId) {
  const pin = PROVIDER_ALLOCATION[fixtureId];        // ← per-fixture，非 per-role
  return REGISTERED_SPECIALISTS.map((id) => ({ id, provider: pin.provider, model: pin.model, ... }));
}
```

`amendment-0-3.mjs` 的 `ROLE_PROVIDER_MAP` 內容正確且有測試保護,
但**capture harness 完全沒有引用它**。protocol 與可執行路徑目前是分離的。

見 BLOCKER B-02 / B-03 / B-04 / B-05 / B-06。

---

## 7. Retrieval status —— ✅ PASS（安全邊際變窄）

兩層防護,都仍成立:

1. **結構層** —— `buildWorkerRefs` 對三位 specialist 一律設 `providesEvidence: false`,
   使 `resolveWorker` 得出 `evidenceCapable = false`;production 只對 evidence-capable 的
   specialist 附加 retrieval,因此不會有 retrieval 被附上。
2. **Recorder 層** —— 任何帶 `options.retrieval != null` 的呼叫在**發出請求之前**
   `RETRIEVAL_POLICY_VIOLATION` 中止,並 latch 停止整輪。

`[SIGNAL]` **但邊際變窄了,見 N-02。** `src/models/capabilities.ts` 中
只有 `gemini / gemini-3.1-pro-preview` 是 `grounded_retrieval: on(...)`;
claude 與 openai 都是 `offeredButNotWired`。3′-H 恰好把唯一
`providesEvidence: true` 的 role(`market_researcher`)映射到唯一真的能檢索的 provider。
在 Option 3′ 下這個組合可能根本不會出現;在 3′-H 下它是固定的。

---

## 8. Exactly-one-attempt status —— ✅ PASS（一項 foot-gun,見 N-01）

| 路徑 | 結果 |
|---|---|
| automatic retry | ✅ 不存在。provider 例外被記錄後直接向上拋,無重試迴圈 |
| hidden retry | ✅ 不存在。`dispatcherFor(fixtureId)` 第二次呼叫即 `DuplicateAttempt` |
| provider fallback | ✅ 不存在。pin 不符即 `ModelPinMismatch`,保留 raw 後判 INVALID,不換 provider |
| task rewrite retry | ✅ task hash 已凍結並三方綁定 |
| manual rerun path | ✅ `run-live.mjs` 在 realRoot 已存在時拒絕啟動;`session.mjs` 在 journal 已存在時拒絕 |
| failure 後換 provider / 重跑 planner | ✅ 無此路徑 |

---

## 9. Capture artifact completeness —— ⚠️ 內容足夠,工具鏈缺一段

A2 需要的**內容**,現有 capture 全部具備並可 deterministic 對應到實際 execution:

| A2 需要 | capture 是否產出 |
|---|---|
| task | ✅ `task.txt`,hash 綁 manifest 與來源 candidate |
| missions | ✅ `mission-<agentId>.txt`,verifier 另檢查其逐字出現在實際送出的 prompt 中 |
| actual Round1 outputs | ✅ `round1-<agentId>.md`,verifier 檢查與 raw provider text 逐位元組相等 |
| passage IDs | ⚠️ **未寫入 artifact**,但可由 production `segmentAll()` 從 Round1 文本 deterministic 導出 |
| annotation schema inputs | ✅ 欄位定義在 `amendment-0-3.mjs` 的 `F4_AUTHORITY.outputFields` |

`[FACT]` **但沒有一條 committed 且有測試的路徑,能從 real capture 產出 A2 packet。**
`buildCleanRoomPacket()` 硬綁在 `loadFixture()` 上,而後者只讀 synthetic fixture 目錄、
要求 `roster.json`、且把 `complexity` 寫死為 `'deep'`;`PACKET_ORDER` 也硬編為 `fx-03/fx-01/fx-04/fx-02`。

**這不阻擋 Wave 1 capture 本身**(capture 產物是凍結證據,packet 可事後再建),
因此列為 N-04 而非 BLOCKER。但它**必須在 A2 之前解決**。

---

## 10. A2 blind-boundary status —— ✅ 設計正確

| 檢查 | 結果 |
|---|---|
| intended archetype 不外洩 | ✅ 只存在於 `candidate-set-manifest.json`;測試斷言九份 task 都不含 archetype 標籤 |
| Gate output / arms / gold 不外洩 | ✅ Wave 1 根本不產生這些(stage allowlist 只有兩個) |
| A2 可見範圍受限 | ✅ `F4_AUTHORITY.maySee` / `mustNotSee` 有測試斷言兩者不重疊 |
| lexical leak scan | ✅ `assertPacketClean()` 存在 —— 但綁在 synthetic packet 路徑上(N-04) |

`[DESIGN]` leak scan 仍只是 **diagnostic**,不得宣稱為 semantic non-leakage proof。

---

## 11. Evidence integrity status —— ✅ PASS

- capture verifier 從 raw journal、frozen snapshot 與 production code **重算**每一項,不讀自報結論。
- `captureStatus` 由重算的 F1/F2/F3 推導,不是「有沒有拋例外」。
- 失敗的 attempt 一律保存,R1/R2/R3 三組都在 repo 中原封保留。
- `CURRENT_STATE.md` §12 已把措辭分級固定為
  `[FACT]` 五個雙 specialist 案例收斂 / `[SIGNAL]` 那些題含低成本 hedge /
  `[INTERPRETATION]` free-hedge 是 plausible contributor —— 未升級為因果或 effectiveness 宣稱。
- claim boundary 四項禁止宣稱有測試斷言存在於 protocol 文件。

---

## 12. BLOCKERS

### B-01 —— capture harness 不認識 0.3 candidate pool（已用執行驗證）

```
$ node -e 'import("./experiments/m2b/capture/runner.mjs").then(m=>m.sourceTaskPath("S1"))'
S1 THROWS: no candidate set defines "S1"
E1 THROWS: no candidate set defines "E1"
I1 THROWS: no candidate set defines "I1"

known sets: [ 'R1', 'R2', 'R3' ]
```

`CANDIDATE_SETS` 只有 R1/R2/R3。`run-live.mjs --set=...` 也只接受這三個。
**Wave 1 目前無法啟動。** 這不是設定問題,是缺少該 set 的定義。

### B-02 —— routing 仍是 Option 3′，不是 ACCEPTED 的 Option 3′-H

`buildWorkerRefs()` 由 `PROVIDER_ALLOCATION[fixtureId]` 取單一 pin 套用到三位 specialist。
protocol 0.3 要求 role → provider 全局固定。**若照現況執行,產出的 provenance 會違反已接受的 protocol。**

### B-03 —— recorder 無法表達 per-agent pin

```js
const pin = pins[stage];                 // 每個 stage 只有一個 pin
...
const pinMismatch = result.provider !== pin.provider || result.model !== pin.model;
```

3′-H 下三個 worker call 有三組不同的期望 provider/model。
現行結構**要嘛誤判為 mismatch、要嘛用錯誤的 pin 通過** —— 兩者都讓 model pin 檢查失效。

### B-04 —— verifier 斷言 per-fixture pin

`capture-verify.mjs` 檢查 17/18:

```js
const pin = providerAllocation[fixtureId];
worker.provider === pin.provider && raw.providerRequested === pin.provider && ...
```

**一個依 3′-H 正確路由的 capture,會被現行 verifier 判為 FAIL。**

### B-05 —— 現有測試正在保護被取代的 protocol

`test-m2b-capture.mjs`:「the runner pins every specialist of a candidate to one provider and model」
斷言三位 specialist 同 provider。**測試目前全綠,而它認證的是 Option 3′。**
不改這條,3′-H 的實作會被自家測試擋下。

### B-06 —— capture manifest schema 只記錄單一 allocation

manifest 寫 `providerAllocation: pin`(單一物件)。3′-H 下必須記錄**實際使用的 role→provider 映射**,
否則事後無法稽核每個 worker call 是否照 protocol 路由。

---

## 13. NON-BLOCKING CONCERNS

**N-01 `fresh: true` 是緊鄰一次性證據的破壞性旗標。**
`runCaptureSession({ fresh: true })` 會 `rmSync` 整個 capture root。
目前只有測試會傳,`run-live.mjs` 不暴露它 —— 但它與已提交的 capture 證據只隔一個參數。
建議:live 路徑明確拒絕 `fresh`,或把它改名為只在測試可用的形式。

**N-02 retrieval 安全邊際變窄。** 見第 7 節。兩層防護仍在,但
3′-H 把唯一 `providesEvidence: true` 的 role 固定映射到唯一 `grounded_retrieval: on` 的 provider。
建議:在 capture 前加一條斷言 —— resolved roster 中每位 worker 的 `evidenceCapable` 必須為 `false`。

**N-03 wave gating 未接進可執行路徑。**
`amendment-0-3.mjs` 有 `slotsForWave(waveIndex, filledArchetypes)`,但 `session.mjs` 只照傳入的
`fixtureIds` 全跑。Wave 1 三個 archetype 都未填滿,**因此不影響本次**;Wave 2 之前必須接上。

**N-04 沒有 real-capture → A2 packet 的路徑。** 見第 9 節。不阻擋 Wave 1 capture,但阻擋其後的 A2。

**N-05 call budget 未依 wave 設定。** `GLOBAL_CALL_BUDGET = 16` 是 4 candidate 的額度;
Wave 1 是 3 candidate × ≤4 = **12**。目前不會超支(planner 最多派 3 位),
但 ceiling 應該隨 wave 設定,而不是沿用 16。

---

## 14. DOCUMENTATION-ONLY

**D-01** `CURRENT_STATE.md` §10 描述 Wave 1 的執行方式(直接呼叫 `runRound1Stage()`、
retrieval all-off、每題一次)全部正確,但**未說明 capture harness 尚未支援 0.3 pool**。
讀者會合理以為只差一個授權。建議在 §10 補一行前置條件。本輪未改,因為它屬於文件而非 blocker。

---

## 15. Proposed Codex Work Packets

> 本輪**未執行**這些 packet。先交 GPT Architecture Review。

### CWP-1 —— 把 capture harness 的 routing 換成 Option 3′-H

```
Objective
  讓 capture harness 依 role → provider 路由，取代 per-fixture 同質配置，
  並讓 pin 檢查與驗證在 per-agent 層級成立。

Allowed files
  experiments/m2b/capture/runner.mjs
  experiments/m2b/capture/recorder.mjs
  experiments/m2b/capture/capture-verify.mjs
  experiments/m2b/test-m2b-capture.mjs

Forbidden files
  src/**  dist/**
  experiments/m2b/protocol/**            （ROLE_PROVIDER_MAP 是唯一真相，只可引用不可改）
  experiments/m2b/candidates-0-3/**
  experiments/m2b/fixtures*/**           （R1/R2/R3 歷史證據）
  M2_EFFECTIVENESS_EXPERIMENT.md

Required behavior
  1. buildWorkerRefs() 由 ROLE_PROVIDER_MAP 取得每位 specialist 的 provider/model，
     import 自 experiments/m2b/protocol/amendment-0-3.mjs，不得複製常數。
  2. recorder 的 round1_worker pin 改為 per-agent 解析：
     pin 由已綁定的 agentId 決定，而非由 stage 決定。
     planning 仍為單一 CHIEF_PIN。
  3. capture-verify 檢查 17/18 改用同一個 role→provider 來源重算，
     不得放寬為「只要 requested === resolved」。
  4. capture manifest 記錄實際使用的 role→provider 映射，取代單一 providerAllocation 欄位。
  5. 既有 R1/R2/R3 capture 必須仍能通過 verifier —— 它們是 Option 3′ 產物，
     驗證時需依該 capture 自身 manifest 記錄的配置，而非依現行 protocol 常數。

Non-goals
  不改 protocol 常數。不加 wave gating。不建 packet builder。
  不動任何歷史 capture 檔案。不執行任何 provider call。

Tests
  - 每位 registered specialist 解析到 ROLE_PROVIDER_MAP 指定的 provider/model
  - 同一 fixture 內三位 specialist 可以有三個不同 provider（取代 B-05 那條舊斷言）
  - 給定任一 selected target，C 與 D₁ 解析到相同 provider/model（invariant 仍成立）
  - per-agent pin mismatch 會保留 raw 並使該 worker 成為 Round1 failure
  - 以 stub 產生的異質 capture 通過 verifier
  - R1 / R2 / R3 三組既有 capture 的 verifier 結果與現況完全相同
    （R1 174/180、R2 178/180、R3 149/149，失敗項不變）

Acceptance criteria
  所有既有測試維持綠燈且無任何斷言被放寬；
  上述新測試全過；src/** 與 dist/** 零變動；零 provider call。
```

### CWP-2 —— 註冊 0.3 candidate pool 並接上 wave gating

```
Objective
  讓 capture harness 能對 S1–S3 / E1–E3 / I1–I3 執行，並使後續 wave 只跑仍未填滿的 archetype。
  （依賴 CWP-1 先完成。）

Allowed files
  experiments/m2b/capture/runner.mjs
  experiments/m2b/capture/session.mjs
  experiments/m2b/capture/run-live.mjs
  experiments/m2b/capture/verify-capture-cli.mjs
  experiments/m2b/test-m2b-capture.mjs

Forbidden files
  src/**  dist/**
  experiments/m2b/protocol/**
  experiments/m2b/candidates-0-3/**       （凍結的題目與 manifest 一律唯讀）
  experiments/m2b/fixtures*/**
  M2_EFFECTIVENESS_EXPERIMENT.md

Required behavior
  1. 新增 candidate set（建議 setId "P03"），來源 experiments/m2b/candidates-0-3/，
     輸出根目錄與 R1/R2/R3 分離，fixtureIds 為九個 slot id。
  2. 依 waveOrder 支援 --wave=1|2|3；wave 的可執行 slot 由 slotsForWave() 決定，
     不得在 runner 內另寫第二套 wave 邏輯。
  3. call budget 依該 wave 實際 slot 數計算（Wave 1 = 3 × 4 = 12），不沿用 16。
  4. run-live 在 live 路徑明確拒絕 fresh，且 realRoot 已存在時拒絕啟動（維持現行語意）。
  5. 每個 slot 仍 exactly one attempt；跨 wave 不得重跑已嘗試過的 slot。

Non-goals
  不修改凍結題目。不重排 wave。不新增第十題。不建 A2 packet builder。
  不執行任何 provider call。

Tests
  - sourceTaskPath("S1"/"E1"/"I1") 解析到 candidates-0-3 對應目錄且不觸及任何 R1/R2/R3 路徑
  - 九個 slot 的 task hash 與凍結 manifest 相符
  - Wave 2 在 STRATEGY 已填滿時只回傳 E2 / I2
  - 已填滿的 archetype 不會出現在後續 wave
  - 跨 wave 重複嘗試同一 slot 被拒
  - wave 的 budget guard 在超出時於 provider call 之前中止
  - stub 全流程產出的 P03 capture 通過 verifier

Acceptance criteria
  既有測試全綠且無放寬；新測試全過；
  凍結的 candidates-0-3/** 零變動；src/** 與 dist/** 零變動；零 provider call。
```

`[OPEN]` **N-04(real-capture → A2 packet builder)刻意未寫成 packet。**
它需要決定 packet 的呈現順序、要不要沿用 `PACKET_ORDER` 的「不按 id 排序」原則、
以及負控 `fxr-08` 如何與新 positive candidates 混排 —— 這些是 architecture decision,不是實作細節。
請 GPT 先裁定,我再依裁定寫 packet。

---

## 16. Final engineering readiness assessment

```
NOT READY — BLOCKERS PRESENT
```

**核心問題只有一個,但它有六個落點:已接受的 Option 3′-H 存在於 protocol 常數與其測試中,
卻完全沒有進入 capture harness 的可執行路徑。** harness 仍實作、驗證並以測試保護
已被取代的 Option 3′;而 0.3 candidate pool 對 harness 而言根本不存在
(`sourceTaskPath("S1")` 直接拋錯,已用執行驗證)。

candidate freeze、Round 1 boundary、retrieval 防護、exactly-one-attempt 語意、
evidence integrity 五項本身都成立。缺的是把它們接到 0.3 的那一段。

修復建議切成 **CWP-1(routing)** 與 **CWP-2(pool + wave)** 兩個 bounded packet,
CWP-2 依賴 CWP-1。本輪未執行任何 packet。

```
LIVE = NONE
EXECUTION AUTHORIZATION: NOT GRANTED
provider calls = 0
```

等待 GPT Architecture / Decision Owner 的下一次 Architecture Review。
