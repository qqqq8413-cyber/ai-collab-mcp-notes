# GEMINI M2-B REVIEW PACKET 2 — HARNESS IMPLEMENTATION

> 給 Gemini 做 Independent Research / Methodology Second Opinion 用的傳輸件。
> Gemini 沒有 repository 存取權,所以本 packet 內嵌審查所需的全部原文。

---

# PACKET SOURCE MANIFEST

```
packetVersion        : GEMINI-M2B-PACKET-2
generatedAt          : 2026-09-05T18:39:45Z
branch               : experimental/m2a-peer-challenge
HEAD                 : 2d702ba88a3ea8a39188132f72bab1c2e1ca454d

harness commit       : 2d702ba88a3ea8a39188132f72bab1c2e1ca454d
HANDOFF revision     : rev. 24
HANDOFF SHA-256      : 0bf08d9cad075ec0835b5088011f65a0ae47daf6e6b6afcd2e9945c8b5c20ff7

protocol version     : M2B-PROTOCOL-0.2
protocol commit      : a308bc8eef035b1e3f0e1a5c415d52024cf503df
protocol SHA-256     : aa617ee74ac2277e675e93799461e7b80e1ec0a30e4dbc9f06ea0b1d03562850

harness source bytes : 100919  (13 files, 全文內嵌)
```

**逐檔 SHA-256(harness,取自 commit `2d702ba`):**

```
d5bee29dd20c506b…    8050 B  experiments/m2b/README.md
381320507f910cdb…    5117 B  experiments/m2b/harness/dispatcher.mjs
30b5c034b0c27540…    9344 B  experiments/m2b/harness/arms.mjs
aef9220aca03fac0…    7337 B  experiments/m2b/harness/prompts.mjs
91d4fbda9798632b…    7209 B  experiments/m2b/harness/leakage.mjs
b31d940681c4d5f5…    3262 B  experiments/m2b/harness/invariants.mjs
05d1a747caa9bd2f…    3195 B  experiments/m2b/harness/normalizer.mjs
c63610a3d21046fb…    3093 B  experiments/m2b/harness/pairs.mjs
e8dc628d7acff7c3…    4359 B  experiments/m2b/harness/manifest.mjs
089b38fdbdc0d72a…    2776 B  experiments/m2b/harness/artifact.mjs
6035733b3b895878…    9977 B  experiments/m2b/verify.mjs
43f8c5e28872cd80…    4599 B  experiments/m2b/fixtures/synthetic/fixture.mjs
351aae11da08da82…   32601 B  experiments/m2b/test-m2b-harness.mjs
```

> ## PACKET-2 是 review transport artifact,不是 Source of Truth。
>
> 與 repository code / runtime evidence 衝突時,**以 code / runtime 為準**。
> 本 packet 的編排、Review Map 與問題敘述由 editor 撰寫,**不是 source fact**;
> 審查判斷請回到逐字原文區塊。
>
> **PACKET-1 @ `14952c7` 保持 frozen,未被覆寫。** 它內嵌的是 protocol v0.1
> (`734ad8e`)與 HANDOFF rev.22,已被 GPT Architecture Review 修訂;
> 本 packet 內嵌的是 **current v0.2**,不是 diff。

---

# 本輪審查標的(七項)

```
1. M2-B harness implementation 是否忠實實作 v0.2
2. H-01 是否真的是 evidence parity，而不是 peer leakage
3. H-02 對 protocol §14 的偏離是否合理
4. NC-2 / NC-3 實際能證明什麼、不能證明什麼
5. C − D₁ 的 causal boundary 是否仍成立在
   「Targeted Peer-Challenge Package vs Matched Self-Review」層級
6. call accounting / shared Gate 是否正確
7. verifier 是否具有真正的 independent recomputation value
```

**這不是重新審整個 M2-B protocol。** protocol v0.2 已經通過 GPT Architecture Review。

---

# ⚠️ H-01 —— 必須這樣審

實作 NC-3 時發現:peer chunk 是 Round 1 的一個**段落**,而 arm C 與 arm D₁ 的
decision synthesis prompt **都**包含完整的 Round 1 specialist block。
因此 peer chunk 必然出現在 D₁ 的 decision prompt 裡。

我的判定是:**那是 evidence parity,不是 leakage。** 據此把 NC-3 拆成兩個 stage:

```
D₁ self-review stage（middle round）
  ❌ 不得取得 peer chunk
  ❌ 不得取得 peer challenge
  ❌ 不得取得 sourceRef
  ❌ 不得取得由 selected issue 派生的 topic steering

Decision Synthesis stage
  ✅ C 與 D₁ 都取得相同的 frozen Round 1 specialist block
  ✅ 因此 Round 1 peer text 出現在 decision prompt 不自動構成 leakage
  ❌ 但 D₁ 不得取得 C-only 的 challenge / sourceRef / peer-challenge payload
```

## 請 Gemini 判斷

> **「這個 stage-specific distinction 是否真的維持 evidence parity,
> 還是它讓 D₁ 在 final synthesis 間接取得了不該有的 treatment information?」**

相關程式在 `leakage.mjs`(`allowPeerChunk` 模式)與 `arms.mjs`(`runArmD1` 的兩次呼叫),
protocol 依據在 P-03、P-04、P-06、P-09、P-10,全部在下方逐字內嵌。

---

# ⚠️ H-02 —— 必須這樣審

**不要把問題描述成「20 還是 60 哪個比較好」。**

真正的問題是:

> ## **substring heuristic 是否適合拿來定義 leakage?**

## 20-char false positive 的精確重現

protocol §14 明訂 NC-3 用 20 字元連續子字串。synthetic fixture 重現了誤判:

```
peer chunk（strategist:p3，Round 1 原文）:
  "A second site competes for the same senior editors that carry the high-margin work."

gate-authored challenge:
  "How does a separate brand avoid consuming the same senior editing capacity
   the flagship work depends on?"

共同的 20 字元連續窗:
  " the same senior edi"
```

challenge 是**針對那個 Round 1 段落寫的**,必然重用它的詞彙。
於是 decision prompt 裡合法存在的 Round 1 block 就觸發了 challenge 的 20 字元匹配 ——
**那不是洩漏**。

## 目前的實作

```
middle round     : 20 字元窗（protocol §14 原值）
                   ＋ chunkText / challengeText / sourceRef 整串精確比對
decision prompt  : 60 字元窗（allowPeerChunk 模式）
                   ＋ challengeText / sourceRef 整串精確比對
                   （chunkText 不檢，理由見 H-01）
```

## 請 Gemini 特別判斷

```
1. 60 是否只是另一個 arbitrary threshold？
2. 是否應優先使用 structural / field provenance invariant，而非字元窗？
3. substring window 應該：
     (a) 保留為 secondary heuristic
     (b) 改參數
     (c) 或從核心 correctness assertion 降級成 diagnostic
4. 哪些 leakage 無法由 lexical matching 證明不存在？
```

`leakage.mjs` 全文、其 negative tests、以及 CAN / CANNOT boundary 都在下方。

---

# REVIEW MAP(導航,不取代原文)

| 優先 | 位置 | 為什麼 |
|---|---|---|
| ★★★ | `leakage.mjs` + H-01 / H-02 | 識別假設的核心 |
| ★★★ | `arms.mjs` `runArmD1` | D₁ 實際收到什麼 |
| ★★★ | `prompts.mjs` | D₁ 的 treatment 與非 treatment 如何切分 |
| ★★★ | P-04 §4.1.1 五成分 | `C − D₁` 的 claim boundary |
| ★★ | `invariants.mjs`(NC-2) | 是否真的取代了 Replay #4 的弱代理 |
| ★★ | `verify.mjs` | 12 項 recomputation 是否真的 independent |
| ★★ | `arms.mjs` `runAllArms` + accounting 測試 | shared gate 是否引入新 confound |
| ★ | `normalizer.mjs` / `pairs.mjs` / `manifest.mjs` | 支援性機制 |

---

# Gemini 不得做的事

```
❌ 重設整個 M2-B          ❌ 新增 arm
❌ 自動提出 D_gate        ❌ 修改 production src
❌ 建議現在跑 live        ❌ 重做 Phase 1.5
❌ productionize
```

除非發現 **BLOCKER**,否則應提出**最小修正**。

---

# GEMINI OUTPUT DISCIPLINE

```
OVERALL:
  ACCEPT / ACCEPT WITH CONCERNS / REVISE / DEFER / REJECT

TOP FINDINGS:（最多 5 項）
  ID:
  Severity:                     SIGNAL / CONCERN / BLOCKER
  Target:                       （harness 檔案／protocol 段落）
  Source evidence:              （引用本 packet 的哪一段原文）
  Why it matters:
  Minimal correction:
  Blocks harness acceptance:    YES / NO
  Blocks live pilot:            YES / NO

最後必答八題：
  1. H-01 是否接受？為什麼？
  2. H-02 是否接受？
  3. 60-char threshold 應是 correctness invariant 還是 diagnostic heuristic？
  4. NC-3 能證明哪些 leakage 不存在？
  5. NC-3 明確不能證明哪些 leakage 不存在？
  6. C − D₁ 的 current causal claim 是否仍成立？
  7. Harness 是否足以進 GPT HARNESS REVIEW？
  8. 有沒有真正阻擋 future pilot 的 blocker？
```

角色邊界(`AI_COLLAB_WORKFLOW_RULES.md` §3.3、§8):Gemini 是
Independent Research / Methodology Second Opinion,不是 Architecture Owner,
不是工程實作者。不修改原文件,不開始 implementation。

---
---

# PART 1 — HARNESS SOURCE(逐字全文)

```
commit : 2d702ba88a3ea8a39188132f72bab1c2e1ca454d
```


## `experiments/m2b/README.md`

```
sha256 : d5bee29dd20c506b505541cc6a07c2953199d10551fb4363506e39172f7a3769
bytes  : 8050
```

<!-- BEGIN VERBATIM experiments/m2b/README.md -->

```markdown
# M2-B Experiment Harness

```
Status        IMPLEMENTED / AWAITING GPT HARNESS REVIEW / NO LIVE AUTHORIZATION
Protocol      M2B-PROTOCOL-0.2  (M2_EFFECTIVENESS_EXPERIMENT.md @ a308bc8)
Offline tests 65 passed / 0 failed
src/ diff     empty
```

> **本目錄不呼叫任何 provider。** `experiments/m2b/` 從未 import `callProvider`,
> 也從未讀取任何 API key —— dispatcher 由呼叫端注入。離線測試注入 deterministic stub。
> 這不是紀律,是**結構上做不到**:harness 沒有取得 provider 的途徑。

## 為什麼是六次呼叫,不是八次

```
B         synthesis                                    1
gate      synthesis_gate（B′ / C / D₁ 共用）            1
C         round2_worker + decision_synthesis           2
D₁        self_review   + decision_synthesis           2
                                                    ────
                                                       6
```

共用 gate 首先不是為了省錢。Protocol §5.1:gate 自己的輸出在 byte-identical fixture 上
翻轉過 headline decision(replay #3 vs #4)。三個 arm 各抽一次 gate,就是把那個變異
直接灌進 `C − D₁` —— 也就是整個研究要估的那個量。共用它把變異移除,順便省下兩次呼叫。

## 檔案

```
harness/
  dispatcher.mjs   recording dispatcher；model pin 斷言；retrieval all-off 斷言
  arms.mjs         B / B′ / C / D₁ runner；call accounting
  prompts.mjs      D₁ 的兩個 builder（harness-only）；從 production 抽取 contract
  leakage.mjs      NC-3
  invariants.mjs   NC-2
  normalizer.mjs   deterministic normalization
  pairs.mjs        blind pair builder + hidden assignment map
  manifest.mjs     manifest schema / validator / seal
  artifact.mjs     run artifact 組裝（只存原料，不存結論）
fixtures/synthetic/
  fixture.mjs      **測試用** deterministic fixture —— 不是實驗 fixture
verify.mjs         12 項 recomputation
test-m2b-harness.mjs
```

`B` / `B′` / `C` 走 production 的 `replaySynthesis`,沒有另寫一份實作 ——
fork 出去的 arm 就不再量到被測的東西。`D₁` 是 harness-only:它是**對照組,不是候選功能**,
不該進 production code path。

## 每個 NC 實際 assert 什麼

### NC-2 evidence isolation(`invariants.mjs`)

以 production `buildRunReport` 從 **frozen Round 1 重算** report,再逐欄比對每個 arm。

```
CAN   report 逐欄相同 / evidenceLabel / RunStatus / retrieval summary / banner 前綴
      任何一次呼叫的 retrievalRequested 或 retrievalResult 非 null
CANNOT 證明 production runOrchestrator 路徑（本 harness 只覆蓋 replay 路徑）
```

⚠️ 這是刻意用來**取代** Replay #4 的 `noRound2Leak`。那條是
`!Object.hasOwn(result,'workerResults')`,在 replay path 上恆真,失敗不了,
所以不是證據(HANDOFF §25 E4)。本條會失敗 —— 見下方 negative test。

### NC-3 peer-leakage guard(`leakage.mjs`)

分兩個模式,原因見下節。

```
CAN   sourceRef 精確字串
      challengeText 精確整串
      chunkText 精確整串（middle round 模式）
      連續字元窗比對（空白正規化後）
CANNOT paraphrase / topic steer / 任何 semantic leakage
```

`notChecked` 欄位在每次回傳裡明寫這三項。**本模組不宣稱能抓語意洩漏**;
protocol §19 X11 記錄該殘留風險。

## ⚠️ 兩個實作時才浮現的設計問題(送交 Harness Review)

### H-01 NC-3 不能套用在 decision prompt 的 peer chunk 上

peer chunk 是 Round 1 的一個段落,而**兩個 arm 的 decision synthesis prompt 都含
完整 Round 1 specialist block** —— arm C 的也一樣。所以 peer chunk 必然出現在那裡,
而那是 **evidence parity,不是 leakage**:兩個合成器必須看到相同的 Round 1 語料,
否則 `C − D₁` 量到的是「各自看到什麼」而不是 treatment。

處置:decision prompt 用 `allowPeerChunk: true`,只檢 challenge 與 sourceRef
(兩者在 Round 1 裡都不存在)。**這不是放寬 guard。不這樣做會禁止 D₁ 帶有與 C 相同的
specialist block,直接破壞實驗賴以成立的 parity。**

### H-02 protocol §14 的 20 字元窗在 decision prompt 上會誤判

gate 撰寫的 challenge 是**針對某個 Round 1 段落寫的**,必然重用該段落的詞彙。
於是共存的 Round 1 block 會觸發 20 字元匹配,而那不是洩漏。
synthetic fixture 可重現:`" the same senior edi"` 同時出現在 challenge 與 strategist 的答案裡。

處置:decision prompt 模式改用 60 字元窗,**外加 challenge 整串的精確比對** ——
後者才是真正要抓的失效(harness bug 把 `selected.challenge` 整條傳進 D₁)。

**這是對 protocol §14 明訂數字的偏離,列出而非默默套用。** 請 Harness Review 裁決。

## 每個 negative test 如何證明 invariant 真的會失敗

每條 guard 都有一個「故意破壞後真的 fail」的測試,且斷言**錯誤型別**而不只是「有丟例外」:

| Invariant | 破壞方式 | 期望型別 |
|---|---|---|
| model pin | stub 回傳不同 model | `ModelPinViolation` |
| model pin | 拿掉某 stage 的 pin | `Error`(manifest 不完整) |
| retrieval all-off | stub 在某 stage 附上 retrieval | `RetrievalPolicyViolation` |
| NC-2 | 竄改 evidenceLabel / RunStatus / banner / call 的 retrieval | `EvidenceInvariantViolation` |
| NC-3 | 把 peer chunk / challenge / sourceRef 塞進 prompt | `PeerLeakageDetected` |
| NC-3 | 整串 challenge 移植(兩種模式都測) | `PeerLeakageDetected` |
| normalization | 移除一句 caveat 後宣稱是 normalized 結果 | `deterministic === false` |
| normalization | 用錯誤 banner 呼叫 | `NormalizationError` |
| blind pairs | pair 上掛 arm / resolvedModel | `PairLeakageDetected` |
| manifest | **15 個 mandatory field 逐一移除** | `ManifestInvalid`,且錯誤訊息點名該欄位 |
| manifest | pin 缺 requestedModel | `ManifestInvalid` |
| manifest | 竄改 manifestSha256 對應內容 | `ManifestInvalid` |
| verifier | 竄改 call 數 / pin / retrieval / provisional / normalized / label / D₁ prompt / pair / manifest / snapshot hash / neutrality guard / selectedIssue | 對應那一項 `FAIL` |

另有一條**行為性**的:D₁ 的 prompt 被汙染時,`runArmD1` 在**發出任何 provider 呼叫之前**
就丟出例外 —— 測試比對 stub 的呼叫數不變。花錢之後才記一條 warning 不算 control。

## verify.mjs 可重算的 12 項

```
manifest integrity                    重新 canonicalize + 重算 sha256
snapshot hash                         重算
arm call accounting                   由 raw call log 重數，斷言 6 且 gate 只計費一次
model pins                            逐呼叫 resolvedModel === requestedModel
retrieval all-off                     逐呼叫 requested/result 皆 null
C 與 D₁ 共用同一 provisional            比對 provisional 與 gate prompt sha
gate parsing                          以 production parseGateOutput / validateIssues /
                                      selectIssue / resolveSourceRef 重推
NC-2 evidence invariance              以 production buildRunReport 從 frozen Round 1 重算
NC-3 D₁ leakage                       重跑兩個模式的 leakage guard
C / D₁ non-treatment parity           specialist block 與 neutrality guard 兩邊都在
normalization determinism             重跑 normalizer 比對 committed 文字與 sha
pair / assignment integrity           結構盲化 + pairId 唯一 + assignments 完全覆蓋
```

**verifier 不讀 artifact 裡任何自報的 PASS 欄位。**

## 本輪明確沒做

```
未選定最終 4 個 experiment fixtures      未 freeze gold issues / conflict labels
未跑 temperature probe                   未呼叫任何 provider API
未跑 120-call pilot                      未做 evaluator live call
未做 D_gate / source-masked C / Phase 1.5
未動 src/ / Gate / chunker / planner / retrieval / Step 8
未動 Replay #4 封印                      未 merge main
```

```

<!-- END VERBATIM experiments/m2b/README.md -->

---

## `experiments/m2b/harness/dispatcher.mjs`

```
sha256 : 381320507f910cdb88fe26fa186b382f30735163cc6ebbecbff0bc5811cae6b9
bytes  : 5117
```

<!-- BEGIN VERBATIM experiments/m2b/harness/dispatcher.mjs -->

```javascript
/**
 * Recording dispatcher for the M2-B harness.
 *
 * One live Gate response is expensive and, per protocol §5.1, its sampling variance is
 * large enough to flip a headline decision. So B-prime, C and D-1 must all be built on the
 * *same* gate response rather than three independent samples of it. This dispatcher is how
 * that happens without forking the production replay path: `replaySynthesis` already
 * accepts an injected `call`, and every orchestrator call already declares its own
 * `stage`, so a dispatcher can answer `synthesis_gate` from a recording and forward
 * everything else.
 *
 * It also carries the two assertions that a run cannot be trusted without: the resolved
 * model must equal the pinned one, and retrieval must be absent everywhere.
 */
import { createHash } from 'node:crypto';

export class ModelPinViolation extends Error {
  constructor(stage, requested, resolved) {
    super(
      `model pin violated at stage "${stage}": manifest requested "${requested}", ` +
        `provider resolved "${resolved}". This run is INVALID.`
    );
    this.name = 'ModelPinViolation';
    this.stage = stage;
    this.requestedModel = requested;
    this.resolvedModel = resolved;
  }
}

export class RetrievalPolicyViolation extends Error {
  constructor(stage) {
    super(`retrievalPolicy is all-off but stage "${stage}" carried retrieval. This run is INVALID.`);
    this.name = 'RetrievalPolicyViolation';
    this.stage = stage;
  }
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/**
 * @param {object} input
 * @param {(provider: string, prompt: string, options: object) => Promise<{provider,model,text,retrieval?}>} input.call
 *   The underlying dispatcher. Offline tests pass a deterministic stub; a live run would
 *   pass the real `callProvider`. The harness itself never chooses one.
 * @param {Record<string,{provider:string,requestedModel:string}>} input.pins
 *   Stage -> pin. A stage with no pin is a manifest error, not a default.
 * @param {number|'unsupported'} input.temperature
 *   Plumbed through to the underlying call when numeric. `'unsupported'` records the fact
 *   and sends nothing — the protocol forbids working around it in provider runtime.
 * @param {{stage:string, provider:string, model:string, text:string}|null} [input.replay]
 *   A previously recorded response. Only `synthesis_gate` is replayable in Phase 1.
 */
export function createDispatcher({ call, pins, temperature, replay = null }) {
  const calls = [];
  let recordedGate = replay;

  const dispatcher = async (provider, prompt, options) => {
    const stage = options.stage;
    if (!stage) throw new Error('dispatcher received a call with no stage; cannot pin or account for it');

    const pin = pins[stage];
    if (!pin) throw new Error(`no model pin for stage "${stage}"; manifest is incomplete`);
    if (pin.provider !== provider) {
      throw new ModelPinViolation(stage, `${pin.provider}/${pin.requestedModel}`, `${provider}/?`);
    }

    // A replayed gate is not a provider call. It is recorded as such so call accounting
    // reflects what was actually spent, not what the code path looks like.
    if (stage === 'synthesis_gate' && recordedGate) {
      calls.push({
        seq: calls.length + 1,
        stage,
        provider,
        requestedModel: pin.requestedModel,
        resolvedModel: recordedGate.model,
        promptSha256: sha256(prompt),
        promptChars: prompt.length,
        responseChars: recordedGate.text.length,
        retrievalRequested: null,
        retrievalResult: null,
        replayed: true,
        ms: 0,
      });
      return { provider, model: recordedGate.model, text: recordedGate.text };
    }

    const startedAt = Date.now();
    const result = await call(provider, prompt, {
      ...options,
      model: pin.requestedModel,
      ...(typeof temperature === 'number' ? { temperature } : {}),
    });
    const ms = Date.now() - startedAt;

    if (result.model !== pin.requestedModel) {
      throw new ModelPinViolation(stage, pin.requestedModel, result.model);
    }
    if (options.retrieval || result.retrieval) throw new RetrievalPolicyViolation(stage);

    calls.push({
      seq: calls.length + 1,
      stage,
      provider,
      requestedModel: pin.requestedModel,
      resolvedModel: result.model,
      promptSha256: sha256(prompt),
      promptChars: prompt.length,
      responseChars: result.text.length,
      retrievalRequested: options.retrieval ?? null,
      retrievalResult: result.retrieval ?? null,
      replayed: false,
      ms,
    });

    if (stage === 'synthesis_gate' && !recordedGate) {
      recordedGate = { stage, provider, model: result.model, text: result.text };
    }
    return result;
  };

  return {
    dispatcher,
    calls,
    /** The gate response this dispatcher recorded or replayed, for handing to the next arm. */
    get gateRecording() {
      return recordedGate;
    },
    /** Calls that actually cost a provider request. A replayed gate is not one. */
    billableCalls: () => calls.filter((c) => !c.replayed),
  };
}

```

<!-- END VERBATIM experiments/m2b/harness/dispatcher.mjs -->

---

## `experiments/m2b/harness/arms.mjs`

```
sha256 : 30b5c034b0c27540701fd18f9735c9e90b102eaf297bf4dff666d4ed47aaf8db
bytes  : 9344
```

<!-- BEGIN VERBATIM experiments/m2b/harness/arms.mjs -->

```javascript
/**
 * The four Phase 1 arm runners (protocol v0.2 §3.1).
 *
 *   B        synthesis only                                        1 billable call
 *   B'       shared synthesis_gate provisional, no Round 2         1 billable call (the shared gate)
 *   C        shared gate -> round2_worker -> decision_synthesis    2 billable calls
 *   D1       shared gate -> self_review   -> decision_synthesis    2 billable calls
 *                                                                  ----------------
 *                                                                  6 per fixture-repetition
 *
 * B', C and D1 are built on ONE gate response, not three samples of it. That is not a cost
 * optimization first — protocol §5.1: the gate's own output flipped a headline decision
 * between replay #3 and #4 on a byte-identical fixture, so three independent samples would
 * put that variance straight into `C - D1`, the estimate the study exists to make. Sharing
 * it removes the variance and happens to save two calls.
 *
 * B, B' and C run through the production `replaySynthesis`. They are not reimplemented
 * here: an arm that forked production would stop measuring the thing under test.
 * D1 is harness-only, because a self-review path is a control and does not belong in
 * production code.
 */
import { createHash } from 'node:crypto';
import { replaySynthesis, buildRunReport, buildOutputBanner } from '../../../dist/modes/orchestrator.js';
import { createDispatcher } from './dispatcher.mjs';
import { buildSelfReviewPrompt, buildSelfReviewDecisionPrompt } from './prompts.mjs';
import { assertNoPeerLeakage } from './leakage.mjs';

const sha256 = (v) => createHash('sha256').update(v).digest('hex');

/**
 * Rebuilds the specialist block exactly as `runSynthesisStage` does.
 *
 * D1's decision prompt needs it and production does not export it. The duplication is
 * checked rather than trusted: `verify.mjs` asserts this string appears verbatim inside
 * C's captured decision_synthesis prompt, so a change in production's format fails a test
 * instead of silently making C and D1 incomparable.
 */
export function buildSpecialistBlock(snapshot) {
  return snapshot.workerResults
    .filter((r) => r.output !== undefined)
    .map((r) => `### ${r.agentId}\nMission: ${r.mission}\nResult: ${r.output}`)
    .join('\n\n');
}

/** Arm B — the existing orchestrator. No gate appendix at all. */
export async function runArmB({ snapshot, call, pins, temperature }) {
  const d = createDispatcher({ call, pins, temperature });
  const result = await replaySynthesis(snapshot, {
    synthesizer: { provider: pins.synthesis.provider, model: pins.synthesis.requestedModel },
    call: d.dispatcher,
  });
  return { arm: 'B', result, calls: d.calls, billable: d.billableCalls().length, gateRecording: null };
}

/**
 * Arm B-prime — the gate appendix, Round 2 disabled.
 *
 * This is also the run that *records* the shared gate response. `disableRound2` keeps
 * `selectedIssue`, which is what lets C and D1 route to the same target specialist later.
 */
export async function runArmBPrime({ snapshot, call, pins, temperature }) {
  const d = createDispatcher({ call, pins, temperature });
  const result = await replaySynthesis(snapshot, {
    synthesizer: { provider: pins.synthesis_gate.provider, model: pins.synthesis_gate.requestedModel },
    collaboration: { enabled: true, disableRound2: true },
    call: d.dispatcher,
  });
  return {
    arm: 'B_prime',
    result,
    calls: d.calls,
    billable: d.billableCalls().length,
    gateRecording: d.gateRecording,
  };
}

/** Arm C — the full targeted peer challenge, replaying B-prime's gate response. */
export async function runArmC({ snapshot, call, pins, temperature, gateRecording }) {
  if (!gateRecording) throw new Error('runArmC requires the gate recording from arm B-prime');
  const d = createDispatcher({ call, pins, temperature, replay: gateRecording });
  const result = await replaySynthesis(snapshot, {
    synthesizer: { provider: pins.synthesis_gate.provider, model: pins.synthesis_gate.requestedModel },
    collaboration: { enabled: true },
    call: d.dispatcher,
  });
  return { arm: 'C', result, calls: d.calls, billable: d.billableCalls().length };
}

/**
 * Arm D-1 — matched self-review, harness-only.
 *
 * Takes its provisional answer and its target specialist from the same gate response C
 * used. Inheriting the target is the matching requirement (protocol §3.3), not leakage:
 * C and D1 must challenge the same specialist or they are not comparable. Inheriting the
 * *topic* would be leakage, and NC-3 runs on the constructed prompt before the call to
 * make that failure loud.
 */
export async function runArmD1({ snapshot, call, pins, temperature, bPrime, peer }) {
  const collab = bPrime.result.collaboration;
  const selected = collab?.selectedIssue;
  if (!selected) {
    return { arm: 'D1', skipped: true, reason: 'no_selected_issue', calls: [], billable: 0 };
  }

  const targetResult = snapshot.workerResults.find((r) => r.agentId === selected.targetAgentId);
  const targetWorker = snapshot.workers.find((w) => w.id === selected.targetAgentId);
  if (!targetResult?.output || !targetWorker) {
    throw new Error(`arm D1: cannot resolve target specialist "${selected.targetAgentId}" in the frozen snapshot`);
  }

  const d = createDispatcher({ call, pins, temperature });

  const selfReviewPrompt = buildSelfReviewPrompt({
    task: snapshot.task,
    mission: targetResult.mission,
    previousOutput: targetResult.output,
  });
  // NC-3 before the call, not after: a contaminated D1 answer is unusable, and a warning
  // logged next to a spent call is not a control.
  const leakageCheck = assertNoPeerLeakage(selfReviewPrompt, peer);

  const reviewed = await d.dispatcher(targetWorker.provider, selfReviewPrompt, {
    model: targetWorker.model,
    system: targetWorker.role,
    stage: 'self_review',
  });

  const decisionPrompt = buildSelfReviewDecisionPrompt({
    task: snapshot.task,
    specialistBlock: buildSpecialistBlock(snapshot),
    degradedNote: '',
    targetAgentId: selected.targetAgentId,
    selfObjection: 'stated by the specialist in its own second-round answer below',
    revisedOutput: reviewed.text,
  });
  // The decision prompt legitimately carries the whole Round 1 specialist block — arm C's
  // does too — so the peer passage is present there in both arms by design. The
  // gate-authored challenge and the sourceRef exist nowhere in Round 1, so those still
  // must not appear. See leakage.mjs for why this is parity, not a weakened guard.
  const decisionLeakageCheck = assertNoPeerLeakage(decisionPrompt, peer, { allowPeerChunk: true });

  const decided = await d.dispatcher(pins.decision_synthesis.provider, decisionPrompt, {
    model: pins.decision_synthesis.requestedModel,
    stage: 'decision_synthesis',
  });

  const report = buildRunReport(snapshot.complexity, snapshot.workers, snapshot.workerResults);
  const banner = buildOutputBanner(report);

  return {
    arm: 'D1',
    skipped: false,
    result: {
      report,
      finalOutput: banner + decided.text,
      selfReview: {
        agentId: targetWorker.id,
        provider: targetWorker.provider,
        promptSha256: sha256(selfReviewPrompt),
        output: reviewed.text,
      },
    },
    calls: d.calls,
    billable: d.billableCalls().length,
    leakageCheck,
    decisionLeakageCheck,
  };
}

/**
 * Runs one fixture-repetition across all four arms and returns the accounting.
 *
 * The order matters: B-prime must run first because it produces the gate recording C and
 * D1 replay.
 */
export async function runAllArms({ snapshot, call, pins, temperature }) {
  const bPrime = await runArmBPrime({ snapshot, call, pins, temperature });
  const b = await runArmB({ snapshot, call, pins, temperature });

  const selected = bPrime.result.collaboration?.selectedIssue;
  const peerExcerpt = bPrime.result.collaboration?.round2?.peerExcerpt;
  const peer = {
    chunkText: peerExcerpt?.text ?? resolvePeerText(snapshot, selected) ?? '',
    challengeText: selected?.challenge ?? '',
    sourceRef: selected?.sourceRef ?? '',
  };

  const c = await runArmC({ snapshot, call, pins, temperature, gateRecording: bPrime.gateRecording });
  const d1 = await runArmD1({ snapshot, call, pins, temperature, bPrime, peer });

  const billable = bPrime.billable + b.billable + c.billable + d1.billable;
  return {
    arms: { B: b, B_prime: bPrime, C: c, D1: d1 },
    peer,
    accounting: {
      B: b.billable,
      sharedGate: bPrime.billable,
      C: c.billable,
      D1: d1.billable,
      totalBillable: billable,
      naiveWithoutSharedGate: b.billable + bPrime.billable + (c.billable + 1) + (d1.billable + 1),
    },
  };
}

/** The peer passage arm C was given, resolved from the frozen snapshot with production code. */
function resolvePeerText(snapshot, selected) {
  if (!selected) return null;
  const [agentId, chunkId] = selected.sourceRef.split(':');
  const source = snapshot.workerResults.find((r) => r.agentId === agentId);
  if (!source?.output) return null;
  const paragraphs = source.output.split(/\r?\n[ \t]*\r?\n/).map((p) => p.trim()).filter(Boolean);
  const index = Number(String(chunkId ?? '').replace('p', '')) - 1;
  return paragraphs[index] ?? null;
}

```

<!-- END VERBATIM experiments/m2b/harness/arms.mjs -->

---

## `experiments/m2b/harness/prompts.mjs`

```
sha256 : aef9220aca03fac0256afd04b578bd64cfa454982258f4fcd8bf856f0d81a0c3
bytes  : 7337
```

<!-- BEGIN VERBATIM experiments/m2b/harness/prompts.mjs -->

```javascript
/**
 * Arm D-1 prompt builders. Harness-only: arm D is a control, not a candidate feature, so
 * it must not enter the production code path (protocol §23.2, GPT authorization item 9).
 *
 * The hard part is not writing them. It is keeping the parts that are *not* the treatment
 * byte-identical to arm C while the parts that *are* the treatment differ. Protocol v0.2
 * §4.1.1 lists the treatment components; everything else — above all the Decision
 * contract and its neutrality guard — has to match, or `C - D1` measures the synthesizer's
 * preferences instead of the peer-challenge package.
 *
 * So the contract is not copied. It is extracted from the production builder at run time,
 * which means it cannot silently drift out of sync: if production changes its contract,
 * D's prompt changes with it and the drift test says so.
 */
import { buildDecisionSynthesisPrompt, buildRound2Prompt } from '../../../dist/agents/collaboration.js';

const DECISION_CONTRACT_MARKER = 'Decision contract:';
const ROUND2_CONTRACT_MARKER = 'Round 2 contract:';

/** A throwaway issue used only to make the production builder emit its contract text. */
const PROBE_ISSUE = {
  targetAgentId: '__probe_target__',
  sourceRef: '__probe_source__:p1',
  challenge: '__probe_challenge__',
  decisionSensitive: true,
  action: 'peer_challenge',
};

/**
 * Reads the Decision contract verbatim out of the production decision-synthesis prompt.
 *
 * Returns the text from `Decision contract:` to the end, so arm D ships exactly the rules
 * arm C ships — including `Revision, recency, or agreement between specialists is not
 * evidence`, which is what stops the synthesizer from treating a revision as proof.
 */
export function extractDecisionContract() {
  const produced = buildDecisionSynthesisPrompt({
    task: '__probe_task__',
    specialistBlock: '__probe_block__',
    degradedNote: '',
    issue: PROBE_ISSUE,
    revisedOutput: '__probe_revised__',
  });
  const index = produced.indexOf(DECISION_CONTRACT_MARKER);
  if (index === -1) {
    throw new Error(
      'production buildDecisionSynthesisPrompt no longer contains "Decision contract:". ' +
        'Arm D cannot match arm C on the non-treatment parts until this is re-derived.'
    );
  }
  return produced.slice(index);
}

/** Same idea for the Round 2 contract, so D-1's middle round carries C's rules of engagement. */
export function extractRound2Contract() {
  const produced = buildRound2Prompt({
    task: '__probe_task__',
    mission: '__probe_mission__',
    previousOutput: '__probe_previous__',
    excerpt: { agentId: 'a', chunkId: 'p1', text: '__probe_excerpt__', truncated: false, charLimit: 1000 },
    challenge: '__probe_challenge__',
  });
  const index = produced.indexOf(ROUND2_CONTRACT_MARKER);
  if (index === -1) {
    throw new Error('production buildRound2Prompt no longer contains "Round 2 contract:".');
  }
  return produced.slice(index);
}

/**
 * Arm D-1's middle round: self-targeted challenge.
 *
 * D-1 rather than a generic "think again" (protocol §3.2): if the control merely
 * reconsiders, then C and D differ in two things at once — who wrote the objection *and*
 * whether there is a specific target at all — and a targeting effect would be read as a
 * peer effect.
 *
 * Takes no peer input of any kind, by signature. There is no parameter through which a
 * peer chunk, a challenge or a sourceRef could arrive, which is a stronger guarantee than
 * a leakage check after the fact — though NC-3 still runs, because the task, mission and
 * previous output could in principle carry peer text themselves.
 */
export function buildSelfReviewPrompt({ task, mission, previousOutput }) {
  if (arguments.length > 1) throw new Error('buildSelfReviewPrompt takes exactly one argument object');
  for (const [name, value] of Object.entries({ task, mission, previousOutput })) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`buildSelfReviewPrompt: "${name}" must be a non-empty string`);
    }
  }

  return `Original task:
${task}

Your assigned mission (unchanged):
${mission}

Your previous answer:
${previousOutput}

The strongest objection to your own answer:
Identify the single strongest objection to your own argument above — the one whose
resolution would most change, strengthen, falsify or materially qualify the decision you
recommended. State that objection in your own words, then answer it.

${extractRound2Contract().replace(ROUND2_CONTRACT_MARKER, 'Second round contract:').replace(
    '- Address only this challenge. Do not restate or expand the rest of your answer beyond what the challenge affects.',
    '- Address only the objection you identified. Do not restate or expand the rest of your answer beyond what it affects.'
  ).replace(
    '- If the challenge is wrong, say so plainly and explain why. Do not concede in order to agree.',
    '- If the objection does not hold, say so plainly and explain why. Do not concede in order to appear balanced.'
  ).replace(
    '- If it is right, correct your answer and state what changed.',
    '- If it holds, correct your answer and state what changed.'
  )}`;
}

/**
 * Arm D-1's decision synthesis.
 *
 * Structurally parallel to `buildDecisionSynthesisPrompt`: same task, same specialist
 * block, same degraded note, same revised output, and the identical Decision contract.
 * What differs is only the framing of where the revision came from — and per protocol
 * v0.2 §4.1.1 that framing is a declared treatment component, not an accident.
 *
 * Phase 1 does no source masking (GPT authorization item 6). C is not rewritten into a
 * generic objection to make D look more like it.
 */
export function buildSelfReviewDecisionPrompt({ task, specialistBlock, degradedNote, targetAgentId, selfObjection, revisedOutput }) {
  for (const [name, value] of Object.entries({ task, specialistBlock, targetAgentId, selfObjection, revisedOutput })) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`buildSelfReviewDecisionPrompt: "${name}" must be a non-empty string`);
    }
  }

  return `Original task:
${task}

Results from each specialist:
${specialistBlock}
${degradedNote ?? ''}
${targetAgentId} reconsidered its own answer in a second round:
- Reconsidering specialist: ${targetAgentId}
- The objection it raised against itself: ${selfObjection}
- ${targetAgentId}'s revised answer after that reconsideration:
${revisedOutput}

${extractDecisionContract()
  .replace(
    '- Where the challenge changed the conclusion, use the revised position.',
    '- Where the reconsideration changed the conclusion, use the revised position.'
  )
  .replace(
    '- Where it did not, keep the original position and say briefly why the challenge did not change it.',
    '- Where it did not, keep the original position and say briefly why the reconsideration did not change it.'
  )
  .replace(
    '- Treat the Round 2 response as a challenge response, not as inherently more correct because it is newer or revised.',
    '- Treat the Round 2 response as a reconsideration, not as inherently more correct because it is newer or revised.'
  )
  .replace('the original reasoning, the peer challenge, and the task constraints', 'the original reasoning, the objection, and the task constraints')}`;
}

```

<!-- END VERBATIM experiments/m2b/harness/prompts.mjs -->

---

## `experiments/m2b/harness/leakage.mjs`

```
sha256 : 91d4fbda9798632b81cd1a1a5c8735ef579565dc1d40f4a30b2ab24a73341491
bytes  : 7209
```

<!-- BEGIN VERBATIM experiments/m2b/harness/leakage.mjs -->

```javascript
/**
 * NC-3 — the leakage guard on arm D-1.
 *
 * This protects the experiment's central identifying assumption. If D-1 sees the peer's
 * argument, `C - D1` collapses toward zero and the study concludes "peer information adds
 * nothing" — a wrong answer, in a known direction, that nothing downstream would catch.
 * So the check runs before every D-1 call and throws rather than warns.
 *
 * What it can prove and what it cannot:
 *
 *   CAN   — that the peer chunk text, the challenge text and the sourceRef string do not
 *           appear in the prompt, verbatim or in any contiguous window of `windowChars`.
 *   CANNOT — that the prompt is free of *semantic* or *topic* leakage. A paraphrase of the
 *           peer's point, or a hint that steers D-1 toward the contested subject, passes
 *           this check. Protocol §19 X11 records that residual risk; this module does not
 *           claim to close it.
 *
 * Naming it after what it actually asserts is deliberate — HANDOFF §25 E4 is the
 * cautionary case, where an invariant named for a property it could not fail on was read
 * as evidence for that property.
 */

export class PeerLeakageDetected extends Error {
  constructor(kind, fragment) {
    super(
      `NC-3: arm D prompt contains ${kind} content that must never reach it — ` +
        `matched fragment ${JSON.stringify(fragment)}. This run is INVALID.`
    );
    this.name = 'PeerLeakageDetected';
    this.kind = kind;
    this.fragment = fragment;
  }
}

/**
 * Contiguous windows of this many characters are compared. Protocol §14 NC-3 specifies 20.
 *
 * 20 is right for the middle round, where none of the peer's text is legitimately present,
 * so any 20-character coincidence is worth stopping for.
 */
export const DEFAULT_WINDOW_CHARS = 20;

/**
 * The window used for the decision prompt, where Round 1 *is* legitimately present.
 *
 * ⚠️ FINDING FOR HARNESS REVIEW. Protocol §14 fixes the window at 20 characters. Building
 * this guard showed 20 is unusable against `challengeText` in the decision prompt: a
 * gate-authored challenge is written *about* a Round 1 passage, so it reuses that
 * passage's vocabulary, and the shared Round 1 block then trips a 20-character match that
 * is not leakage. The synthetic fixture reproduces it — " the same senior edi" is common
 * to the challenge and to the strategist's answer.
 *
 * The guard therefore uses a longer window here, plus an exact full-string test that
 * catches the failure actually worth catching: a whole challenge string transplanted into
 * a D-1 prompt by a harness bug. That is a deviation from the protocol's stated number and
 * is flagged rather than applied silently.
 */
export const DECISION_WINDOW_CHARS = 60;

/**
 * Every contiguous window of `size` characters in `text`, whitespace-collapsed first so a
 * reflowed quotation still matches.
 */
function windows(text, size) {
  const flat = text.replace(/\s+/g, ' ').trim();
  const out = new Set();
  for (let i = 0; i + size <= flat.length; i++) out.add(flat.slice(i, i + size));
  return out;
}

/**
 * Throws if any peer-derived string has leaked into an arm D prompt.
 *
 * ## Why `allowPeerChunk` exists
 *
 * The peer passage is a paragraph of a Round 1 answer, and every decision-synthesis
 * prompt — arm C's and arm D-1's alike — contains the full Round 1 specialist block. So
 * the peer chunk is *necessarily* present there, in both arms, and that is evidence
 * parity rather than leakage: the two synthesizers must see the same Round 1 corpus or
 * `C - D1` measures what they were shown instead of the treatment.
 *
 * The treatment lives in the middle round. What must never reach D-1 is the peer passage
 * as a *directed* input to the target specialist, plus the gate-authored challenge and the
 * sourceRef, neither of which exists anywhere in Round 1.
 *
 * Hence two modes:
 *
 *   middle round (self_review)   full check — chunk, challenge, sourceRef
 *   decision synthesis           challenge and sourceRef only
 *
 * Turning the chunk check off for the decision prompt is not a weakening of the guard. Not
 * turning it off would forbid D-1 from carrying the same specialist block as C, which
 * would break the parity the experiment depends on.
 *
 * @param {string} prompt              the D-1 prompt about to be sent
 * @param {object} peer
 * @param {string} peer.chunkText      the exact peer passage arm C was given
 * @param {string} peer.challengeText  the gate-authored challenge arm C was given
 * @param {string} peer.sourceRef      e.g. "business_strategist:p5"
 * @param {object} [options]
 * @param {number} [options.windowChars]
 * @param {boolean} [options.allowPeerChunk]  true only for the decision-synthesis prompt
 */
export function assertNoPeerLeakage(prompt, peer, options = {}) {
  const { windowChars = DEFAULT_WINDOW_CHARS, allowPeerChunk = false } =
    typeof options === 'number' ? { windowChars: options } : options;
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new Error('assertNoPeerLeakage: prompt must be a non-empty string');
  }
  for (const key of ['chunkText', 'challengeText', 'sourceRef']) {
    if (typeof peer?.[key] !== 'string') {
      throw new Error(`assertNoPeerLeakage: peer.${key} must be a string`);
    }
  }

  // sourceRef is short and structural — an exact substring test is the right one.
  if (peer.sourceRef.length > 0 && prompt.includes(peer.sourceRef)) {
    throw new PeerLeakageDetected('sourceRef', peer.sourceRef);
  }

  // Exact whole-string containment, in both modes. This is the check that catches the
  // failure that actually threatens the experiment: a harness bug passing `excerpt.text`
  // or `selected.challenge` straight into a D-1 prompt.
  if (peer.challengeText.length > 0 && prompt.includes(peer.challengeText)) {
    throw new PeerLeakageDetected('peer challenge', peer.challengeText.slice(0, 60));
  }
  if (!allowPeerChunk && peer.chunkText.length > 0 && prompt.includes(peer.chunkText)) {
    throw new PeerLeakageDetected('peer chunk', peer.chunkText.slice(0, 60));
  }

  const effectiveWindow = allowPeerChunk ? Math.max(windowChars, DECISION_WINDOW_CHARS) : windowChars;
  const promptWindows = windows(prompt, effectiveWindow);
  const targets = allowPeerChunk
    ? [['peer challenge', peer.challengeText]]
    : [['peer chunk', peer.chunkText], ['peer challenge', peer.challengeText]];

  for (const [kind, text] of targets) {
    for (const w of windows(text, effectiveWindow)) {
      if (promptWindows.has(w)) throw new PeerLeakageDetected(kind, w);
    }
  }

  return {
    checked: allowPeerChunk ? ['sourceRef', 'peer challenge'] : ['sourceRef', 'peer chunk', 'peer challenge'],
    windowChars: effectiveWindow,
    exactStringChecked: allowPeerChunk ? ['sourceRef', 'challengeText'] : ['sourceRef', 'challengeText', 'chunkText'],
    allowPeerChunk,
    /** Stated on the record so a reader cannot mistake this for a semantic guarantee. */
    notChecked: allowPeerChunk
      ? ['peer chunk (present in Round 1 for both arms, by design)', 'paraphrase', 'topic steer', 'semantic leakage']
      : ['paraphrase', 'topic steer', 'semantic leakage'],
  };
}

```

<!-- END VERBATIM experiments/m2b/harness/leakage.mjs -->

---

## `experiments/m2b/harness/invariants.mjs`

```
sha256 : b31d940681c4d5f5918825f32499cbd9acdc73f168e04e9b20dcf095ac96e941
bytes  : 3262
```

<!-- BEGIN VERBATIM experiments/m2b/harness/invariants.mjs -->

```javascript
/**
 * NC-2 — evidence isolation, recomputed rather than asserted.
 *
 * Replay #4's `noRound2Leak` was `!Object.hasOwn(result, 'workerResults')`, which on the
 * replay path is true no matter what: `replaySynthesis` never returns that field. It
 * could not fail, so it was not evidence (HANDOFF §25 E4, and the rev.21 principle).
 *
 * This is the replacement, and it can fail: the report is recomputed from the frozen
 * Round 1 with the production `buildRunReport`, and every arm's report must equal it
 * field for field. If a second-round output ever reached the evidence derivation, the
 * recomputation would differ and this throws.
 */
import { buildRunReport, buildOutputBanner } from '../../../dist/modes/orchestrator.js';

export class EvidenceInvariantViolation extends Error {
  constructor(field, expected, actual) {
    super(
      `NC-2: ${field} changed after the second round. ` +
        `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}. This run is INVALID.`
    );
    this.name = 'EvidenceInvariantViolation';
    this.field = field;
  }
}

/** The evidence baseline of a frozen Round 1, computed with production code only. */
export function evidenceBaseline(snapshot) {
  const report = buildRunReport(snapshot.complexity, snapshot.workers, snapshot.workerResults);
  return {
    report: JSON.parse(JSON.stringify(report)),
    banner: buildOutputBanner(report),
    evidenceLabel: report.evidenceLabel,
    status: report.status,
    retrieval: report.retrieval ?? null,
  };
}

/**
 * Asserts one arm's result did not move the evidence state.
 *
 * @param {string} arm
 * @param {object} baseline            from `evidenceBaseline(snapshot)`
 * @param {object} armResult           `{ report, finalOutput }`
 * @param {Array}  calls               the dispatcher's call log, for the retrieval check
 */
export function assertEvidenceIsolation(arm, baseline, armResult, calls) {
  const actual = JSON.parse(JSON.stringify(armResult.report));

  if (JSON.stringify(actual) !== JSON.stringify(baseline.report)) {
    throw new EvidenceInvariantViolation(`${arm}: run report`, baseline.report, actual);
  }
  if (actual.evidenceLabel !== baseline.evidenceLabel) {
    throw new EvidenceInvariantViolation(`${arm}: evidenceLabel`, baseline.evidenceLabel, actual.evidenceLabel);
  }
  if (actual.status !== baseline.status) {
    throw new EvidenceInvariantViolation(`${arm}: RunStatus`, baseline.status, actual.status);
  }
  if (JSON.stringify(actual.retrieval ?? null) !== JSON.stringify(baseline.retrieval)) {
    throw new EvidenceInvariantViolation(`${arm}: retrieval summary`, baseline.retrieval, actual.retrieval ?? null);
  }
  if (!armResult.finalOutput.startsWith(baseline.banner)) {
    throw new EvidenceInvariantViolation(`${arm}: banner`, baseline.banner, armResult.finalOutput.slice(0, 80));
  }
  for (const call of calls) {
    if (call.retrievalRequested !== null || call.retrievalResult !== null) {
      throw new EvidenceInvariantViolation(`${arm}: retrieval at stage ${call.stage}`, null, {
        requested: call.retrievalRequested,
        result: call.retrievalResult,
      });
    }
  }

  return { arm, evidenceLabel: actual.evidenceLabel, status: actual.status, bannerMatched: true };
}

```

<!-- END VERBATIM experiments/m2b/harness/invariants.mjs -->

---

## `experiments/m2b/harness/normalizer.mjs`

```
sha256 : 05d1a747caa9bd2fb610dc65198498c09b546515024e80e07b50f5dc0d5d262f
bytes  : 3195
```

<!-- BEGIN VERBATIM experiments/m2b/harness/normalizer.mjs -->

```javascript
/**
 * Deterministic normalization for blind evaluation (protocol §10.1).
 *
 * The line this module has to hold: runtime metadata may be removed, content may not.
 * The test is whether the text was produced by the runtime or written by the model. The
 * banner is emitted by `buildOutputBanner`, so it goes. A sentence in which the model says
 * it cannot verify a number is the model's own words, so it stays — removing hedges would
 * change what the judge is scoring, in the direction of whichever arm hedges more.
 *
 * Everything here is a pure function of its input. The same raw answer normalizes to the
 * same bytes every time, and `verify.mjs` re-runs it to prove the committed normalized
 * answers were not hand-edited.
 */
import { createHash } from 'node:crypto';

export class NormalizationError extends Error {}

/** Removals this module is allowed to perform, stated so a reviewer can audit the list. */
export const PERMITTED_REMOVALS = Object.freeze([
  'evidence banner produced by buildOutputBanner',
  'arm label',
  'provider identity label',
  'model identity label',
  'run/experiment identifiers',
]);

/** Things it must never do. Present as documentation and asserted by the offline tests. */
export const FORBIDDEN_EDITS = Object.freeze([
  'rewriting the answer',
  'shortening or summarizing',
  'fixing grammar or tone',
  'removing caveats or uncertainty statements',
  'padding or truncating to equalize length',
  'reordering or reformatting substantive content',
]);

/**
 * @param {string} finalOutput  the arm's finalOutput, banner included
 * @param {string} banner       the banner for this run, from `buildOutputBanner`
 * @returns {{text:string, sha256:string, removedBannerChars:number}}
 */
export function normalizeAnswer(finalOutput, banner) {
  if (typeof finalOutput !== 'string' || finalOutput.length === 0) {
    throw new NormalizationError('normalizeAnswer: finalOutput must be a non-empty string');
  }
  if (typeof banner !== 'string') {
    throw new NormalizationError('normalizeAnswer: banner must be a string');
  }
  if (banner.length > 0 && !finalOutput.startsWith(banner)) {
    throw new NormalizationError(
      'normalizeAnswer: finalOutput does not start with the supplied banner; ' +
        'refusing to guess what to strip'
    );
  }

  // Exactly one operation: drop the banner prefix. Nothing is trimmed, re-wrapped or
  // re-cased, because every one of those would be a content edit under some input.
  const text = finalOutput.slice(banner.length);
  if (text.length === 0) {
    throw new NormalizationError('normalizeAnswer: nothing left after removing the banner');
  }

  return {
    text,
    sha256: createHash('sha256').update(text).digest('hex'),
    removedBannerChars: banner.length,
  };
}

/**
 * Proves a committed normalized answer is what the normalizer produces from the raw one.
 * Used by `verify.mjs`; this is what makes "deterministic" checkable rather than claimed.
 */
export function verifyNormalization(finalOutput, banner, claimedText) {
  const produced = normalizeAnswer(finalOutput, banner);
  return { deterministic: produced.text === claimedText, expectedSha256: produced.sha256 };
}

```

<!-- END VERBATIM experiments/m2b/harness/normalizer.mjs -->

---

## `experiments/m2b/harness/pairs.mjs`

```
sha256 : c63610a3d21046fbc6855eabae8fd7c3054e11d9f56d087e90b99cf5f407384c
bytes  : 3093
```

<!-- BEGIN VERBATIM experiments/m2b/harness/pairs.mjs -->

```javascript
/**
 * Blind pair builder (protocol §10.4).
 *
 * Produces what the judge sees and, separately, the map that says what it was. The two
 * must never travel together: `pairs.json` is the judge's input and carries no arm,
 * provider or model; `assignments.json` is withheld until judging is done.
 *
 * Order is counterbalanced rather than randomized for the pilot, because randomizing makes
 * order bias into noise without measuring it, and the pilot's job is to measure it
 * (protocol §20.3).
 */
import { createHash } from 'node:crypto';

export class PairLeakageDetected extends Error {}

/** Tokens that must never appear in a judge-facing pair. */
const FORBIDDEN_KEYS = ['arm', 'provider', 'model', 'requestedModel', 'resolvedModel', 'runIndex', 'ms', 'timings'];

const pairId = (fixtureId, runIndex, left, right, order) =>
  createHash('sha256').update(`${fixtureId}|${runIndex}|${left}|${right}|${order}`).digest('hex').slice(0, 16);

/**
 * @param {object} input
 * @param {string} input.fixtureId
 * @param {number} input.runIndex
 * @param {Record<string,{text:string}>} input.normalized   arm -> normalized answer
 * @param {Array<[string,string]>} input.comparisons        e.g. [['B','B_prime'],['B_prime','C'],['C','D1']]
 * @param {boolean} [input.counterbalance]                  emit both orders of each comparison
 */
export function buildBlindPairs({ fixtureId, runIndex, normalized, comparisons, counterbalance = true }) {
  const pairs = [];
  const assignments = [];

  for (const [armA, armB] of comparisons) {
    for (const [first, second] of counterbalance ? [[armA, armB], [armB, armA]] : [[armA, armB]]) {
      const left = normalized[first];
      const right = normalized[second];
      if (!left || !right) throw new Error(`buildBlindPairs: missing normalized answer for ${first} or ${second}`);

      const order = `${first}->${second}`;
      const id = pairId(fixtureId, runIndex, armA, armB, order);
      pairs.push({ pairId: id, answerX: left.text, answerY: right.text });
      assignments.push({ pairId: id, fixtureId, runIndex, comparison: `${armA} vs ${armB}`, answerX: first, answerY: second });
    }
  }

  assertPairsBlind(pairs);
  return { pairs, assignments };
}

/**
 * Fails if a judge-facing pair carries anything identifying.
 *
 * Only structural leakage is in scope. An answer whose own wording betrays its arm cannot
 * be fixed here — editing it is forbidden — so protocol §10.3 measures that separately
 * with a leakage audit instead of pretending this check covers it.
 */
export function assertPairsBlind(pairs) {
  for (const pair of pairs) {
    for (const key of Object.keys(pair)) {
      if (!['pairId', 'answerX', 'answerY'].includes(key)) {
        throw new PairLeakageDetected(`blind pair carries a non-blind field: "${key}"`);
      }
    }
    for (const key of FORBIDDEN_KEYS) {
      if (Object.hasOwn(pair, key)) throw new PairLeakageDetected(`blind pair carries "${key}"`);
    }
  }
  return { pairs: pairs.length, structuralCheckOnly: true, contentLeakageMeasuredBy: 'protocol §10.3 leakage audit' };
}

```

<!-- END VERBATIM experiments/m2b/harness/pairs.mjs -->

---

## `experiments/m2b/harness/manifest.mjs`

```
sha256 : e8dc628d7acff7c3437672486078b438fe0e469f9d9ef30f24a9b4a63fb6002e
bytes  : 4359
```

<!-- BEGIN VERBATIM experiments/m2b/harness/manifest.mjs -->

```javascript
/**
 * Experiment manifest schema and validator (protocol §18.3).
 *
 * A manifest missing a mandatory field is not a warning. The field list is exactly the
 * set of things that, if unknown, make a run uninterpretable afterwards — which model
 * answered, which fixture, which code produced the prompt. A run without them cannot
 * enter evaluation, because there would be no way to say later what it was a run *of*.
 */
import { createHash } from 'node:crypto';

export class ManifestInvalid extends Error {
  constructor(problems) {
    super(`manifest is invalid: ${problems.join('; ')}`);
    this.name = 'ManifestInvalid';
    this.problems = problems;
  }
}

/** Protocol v0.2 §18.3 "必要(缺一則該 run 無效)". */
export const MANDATORY_FIELDS = Object.freeze([
  'experimentId',
  'protocolVersion',
  'fixtureId',
  'fixtureSha256',
  'snapshotSha256',
  'arm',
  'runIndex',
  'pins',
  'temperature',
  'retrievalPolicy',
  'evidenceLabelBaseline',
  'runtimeCommit',
  'promptSourceCommit',
  'chunkerVersion',
  'peerExcerptChars',
]);

export const ARMS = Object.freeze(['B', 'B_prime', 'C', 'D1']);

/** Which stages each arm must pin. An unpinned stage would fall to an adapter default. */
export const REQUIRED_PINS = Object.freeze({
  B: ['synthesis'],
  B_prime: ['synthesis_gate'],
  C: ['synthesis_gate', 'round2_worker', 'decision_synthesis'],
  D1: ['synthesis_gate', 'self_review', 'decision_synthesis'],
});

const SHA256 = /^[0-9a-f]{64}$/;

export function canonicalize(manifest) {
  const { manifestSha256: _drop, ...rest } = manifest;
  const sortDeep = (v) =>
    Array.isArray(v)
      ? v.map(sortDeep)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]))
        : v;
  return JSON.stringify(sortDeep(rest));
}

export function sealManifest(manifest) {
  return { ...manifest, manifestSha256: createHash('sha256').update(canonicalize(manifest)).digest('hex') };
}

/** @returns the manifest when valid; throws `ManifestInvalid` listing every problem found. */
export function validateManifest(manifest) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object') throw new ManifestInvalid(['manifest is not an object']);

  for (const field of MANDATORY_FIELDS) {
    if (manifest[field] === undefined || manifest[field] === null || manifest[field] === '') {
      problems.push(`missing mandatory field "${field}"`);
    }
  }

  if (manifest.protocolVersion !== 'M2B-PROTOCOL-0.2') {
    problems.push(`protocolVersion must be "M2B-PROTOCOL-0.2", got ${JSON.stringify(manifest.protocolVersion)}`);
  }
  if (manifest.retrievalPolicy !== 'all-off') {
    problems.push(`retrievalPolicy must be "all-off", got ${JSON.stringify(manifest.retrievalPolicy)}`);
  }
  if (!ARMS.includes(manifest.arm)) {
    problems.push(`arm must be one of ${ARMS.join(', ')}, got ${JSON.stringify(manifest.arm)}`);
  }
  if (!Number.isInteger(manifest.runIndex) || manifest.runIndex < 1) {
    problems.push('runIndex must be a positive integer');
  }
  for (const field of ['fixtureSha256', 'snapshotSha256']) {
    if (manifest[field] !== undefined && !SHA256.test(String(manifest[field]))) {
      problems.push(`${field} must be a 64-character lowercase sha256`);
    }
  }
  if (!(manifest.temperature === 'unsupported' || typeof manifest.temperature === 'number')) {
    problems.push('temperature must be a number or the string "unsupported"');
  }

  const pins = manifest.pins ?? {};
  for (const stage of REQUIRED_PINS[manifest.arm] ?? []) {
    const pin = pins[stage];
    if (!pin) {
      problems.push(`arm ${manifest.arm} requires a pin for stage "${stage}"`);
      continue;
    }
    if (!pin.provider) problems.push(`pin for "${stage}" has no provider`);
    // The whole point of E2: an absent model means the adapter default decides silently.
    if (!pin.requestedModel) problems.push(`pin for "${stage}" has no requestedModel (adapter default is not a pin)`);
  }

  if (manifest.manifestSha256 !== undefined) {
    const expected = createHash('sha256').update(canonicalize(manifest)).digest('hex');
    if (manifest.manifestSha256 !== expected) {
      problems.push(`manifestSha256 does not match its contents (expected ${expected})`);
    }
  }

  if (problems.length) throw new ManifestInvalid(problems);
  return manifest;
}

```

<!-- END VERBATIM experiments/m2b/harness/manifest.mjs -->

---

## `experiments/m2b/harness/artifact.mjs`

```
sha256 : 089b38fdbdc0d72a570f1e3ed82f71f99518b03b726208aeb8e4a9941cb92c29
bytes  : 2776
```

<!-- BEGIN VERBATIM experiments/m2b/harness/artifact.mjs -->

```javascript
/**
 * Assembles the run artifact that `verify.mjs` recomputes from.
 *
 * The artifact stores raw material, not conclusions: prompts, responses, call metadata and
 * the frozen snapshot. Every derived claim — call counts, pins, evidence invariance,
 * leakage, normalization — is left for the verifier to recompute, so no reader has to take
 * this module's word for anything.
 */
import { createHash } from 'node:crypto';
import { evidenceBaseline } from './invariants.mjs';
import { normalizeAnswer } from './normalizer.mjs';
import { buildBlindPairs } from './pairs.mjs';

const sha256 = (v) => createHash('sha256').update(v).digest('hex');

/** Pulls the prompt a given stage was actually sent, out of the stub/live call log. */
const promptFor = (seen, stage, nth = 0) => seen.filter((s) => s.stage === stage)[nth]?.prompt ?? null;

export function buildRunArtifact({ experimentId, fixtureId, runIndex, snapshot, run, seen, manifests, gateResponseText }) {
  const baseline = evidenceBaseline(snapshot);
  const { arms, peer, accounting } = run;

  const normalized = {};
  for (const [arm, r] of Object.entries(arms)) {
    if (r.skipped || !r.result?.finalOutput) continue;
    normalized[arm] = normalizeAnswer(r.result.finalOutput, baseline.banner);
  }

  const comparisons = [['B', 'B_prime'], ['B_prime', 'C'], ['C', 'D1']].filter(
    ([a, b]) => normalized[a] && normalized[b]
  );
  const blindPairs = comparisons.length
    ? buildBlindPairs({ fixtureId, runIndex, normalized, comparisons })
    : null;

  return {
    experimentId,
    fixtureId,
    runIndex,
    generatedAt: new Date().toISOString(),
    snapshot,
    snapshotSha256: sha256(JSON.stringify(snapshot)),
    manifests,
    gateResponseText,
    selectedIssue: arms.B_prime.result.collaboration?.selectedIssue ?? null,
    peer,
    accounting,
    arms: {
      B: armRecord(arms.B, normalized.B, null, null),
      B_prime: armRecord(arms.B_prime, normalized.B_prime, null, null),
      C: armRecord(arms.C, normalized.C, null, promptFor(seen, 'decision_synthesis', 0)),
      D1: arms.D1.skipped
        ? { skipped: true, reason: arms.D1.reason, calls: [] }
        : armRecord(arms.D1, normalized.D1, promptFor(seen, 'self_review'), promptFor(seen, 'decision_synthesis', 1)),
    },
    blindPairs,
  };
}

function armRecord(armRun, normalizedAnswer, selfReviewPrompt, decisionPrompt) {
  return {
    skipped: false,
    calls: armRun.calls,
    report: armRun.result.report,
    finalOutput: armRun.result.finalOutput,
    provisionalAnswer: armRun.result.collaboration?.provisionalAnswer ?? null,
    ...(normalizedAnswer ? { normalized: normalizedAnswer } : {}),
    ...(selfReviewPrompt ? { selfReviewPrompt } : {}),
    ...(decisionPrompt ? { decisionPrompt } : {}),
  };
}

```

<!-- END VERBATIM experiments/m2b/harness/artifact.mjs -->

---

## `experiments/m2b/verify.mjs`

```
sha256 : 6035733b3b89587830f66b950c98f0935e9d39d9dfd6251cfce5603b7d1298e2
bytes  : 9977
```

<!-- BEGIN VERBATIM experiments/m2b/verify.mjs -->

```javascript
/**
 * M2-B artifact verifier.
 *
 * The rule it exists to enforce: a claim in an artifact is worth nothing unless it can be
 * recomputed from the raw data next to it. So this never reads a `PASS` field. It rebuilds
 * every claim from `raw-calls/` using production code where production code produced the
 * thing, and fails loudly when a recomputation disagrees.
 *
 * Offline only. It calls no provider, and cannot: it works from committed artifacts.
 *
 * Usage:  node experiments/m2b/verify.mjs <run-artifact.json> [...]
 *         node experiments/m2b/verify.mjs --self-test
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildRunReport, buildOutputBanner } from '../../dist/modes/orchestrator.js';
import { parseGateOutput, validateIssues, selectIssue, segmentAll, resolveSourceRef } from '../../dist/agents/collaboration.js';
import { validateManifest, canonicalize } from './harness/manifest.mjs';
import { evidenceBaseline } from './harness/invariants.mjs';
import { verifyNormalization } from './harness/normalizer.mjs';
import { assertPairsBlind } from './harness/pairs.mjs';
import { assertNoPeerLeakage } from './harness/leakage.mjs';
import { buildSpecialistBlock } from './harness/arms.mjs';

const sha256 = (v) => createHash('sha256').update(v).digest('hex');

/** Each entry recomputes one claim. `name` is what the report prints; failures throw. */
const CHECKS = [
  ['manifest integrity', (a) => {
    for (const m of Object.values(a.manifests)) {
      validateManifest(m);
      assert.equal(m.manifestSha256, sha256(canonicalize(m)), 'manifestSha256 does not match its own contents');
    }
    return `${Object.keys(a.manifests).length} manifests validated and re-hashed`;
  }],

  ['snapshot hash', (a) => {
    const recomputed = sha256(JSON.stringify(a.snapshot));
    assert.equal(recomputed, a.snapshotSha256, 'snapshot hash does not match the recorded one');
    return recomputed;
  }],

  ['arm call accounting', (a) => {
    const billable = (arm) => a.arms[arm].calls.filter((c) => !c.replayed).length;
    assert.equal(billable('B'), 1, 'arm B must cost exactly one call');
    assert.equal(billable('B_prime'), 1, 'the shared gate must cost exactly one call');
    assert.equal(billable('C'), 2, 'arm C must add exactly two calls on top of the shared gate');
    assert.equal(billable('D1'), 2, 'arm D1 must add exactly two calls on top of the shared gate');
    const total = ['B', 'B_prime', 'C', 'D1'].reduce((n, arm) => n + billable(arm), 0);
    assert.equal(total, 6, 'a fixture-repetition must cost six billable calls, not eight');
    const gateHits = Object.values(a.arms).flatMap((r) => r.calls).filter((c) => c.stage === 'synthesis_gate' && !c.replayed);
    assert.equal(gateHits.length, 1, 'the gate must reach a provider exactly once per repetition');
    return `6 billable calls; gate charged once, replayed ${
      Object.values(a.arms).flatMap((r) => r.calls).filter((c) => c.replayed).length} times`;
  }],

  ['model pins', (a) => {
    for (const [arm, r] of Object.entries(a.arms)) {
      for (const call of r.calls) {
        assert.ok(call.requestedModel, `${arm}/${call.stage}: no requestedModel recorded`);
        assert.equal(call.resolvedModel, call.requestedModel,
          `${arm}/${call.stage}: resolved "${call.resolvedModel}" but pinned "${call.requestedModel}"`);
      }
    }
    return 'every call resolved to the model its manifest pinned';
  }],

  ['retrieval all-off', (a) => {
    for (const [arm, r] of Object.entries(a.arms)) {
      for (const call of r.calls) {
        assert.equal(call.retrievalRequested, null, `${arm}/${call.stage} requested retrieval`);
        assert.equal(call.retrievalResult, null, `${arm}/${call.stage} received retrieval`);
      }
    }
    return 'no retrieval requested or received on any call';
  }],

  ['C and D1 share one provisional', (a) => {
    const bp = a.arms.B_prime.provisionalAnswer;
    assert.ok(bp, 'B-prime recorded no provisional answer');
    assert.equal(a.arms.C.provisionalAnswer, bp, 'C was built on a different gate sample than B-prime');
    const gateShas = new Set(
      Object.values(a.arms).flatMap((r) => r.calls).filter((c) => c.stage === 'synthesis_gate').map((c) => c.promptSha256)
    );
    assert.equal(gateShas.size, 1, 'the shared gate prompt differed between arms');
    return `provisional shared; one gate prompt sha ${[...gateShas][0].slice(0, 12)}`;
  }],

  ['gate parsing re-derived from the recorded response', (a) => {
    const parsed = parseGateOutput(a.gateResponseText);
    assert.equal(parsed.answer, a.arms.B_prime.provisionalAnswer, 'production parser disagrees with the recorded provisional');
    const chunks = segmentAll(a.snapshot.workerResults);
    const { valid } = validateIssues(parsed.rawIssues, { successfulAgentIds: a.snapshot.agentOrder, chunksByAgent: chunks });
    const selected = selectIssue(valid, a.snapshot.agentOrder) ?? null;
    assert.deepEqual(selected, a.selectedIssue ?? null, 'production selection disagrees with the recorded selectedIssue');
    if (selected) {
      const resolved = resolveSourceRef(selected.sourceRef, chunks);
      assert.equal(resolved.ok, true, 'recorded sourceRef does not resolve against the frozen Round 1');
      assert.notEqual(resolved.agentId, selected.targetAgentId, 'sourceRef and target are the same specialist');
    }
    return `parse=${parsed.status}, issues=${parsed.rawIssues.length}, selected=${selected ? 1 : 0}`;
  }],

  ['NC-2 evidence invariance', (a) => {
    const baseline = evidenceBaseline(a.snapshot);
    const report = buildRunReport(a.snapshot.complexity, a.snapshot.workers, a.snapshot.workerResults);
    assert.equal(buildOutputBanner(report), baseline.banner);
    for (const [arm, r] of Object.entries(a.arms)) {
      assert.deepEqual(JSON.parse(JSON.stringify(r.report)), baseline.report, `${arm}: report moved off the Round 1 baseline`);
      assert.ok(r.finalOutput.startsWith(baseline.banner), `${arm}: banner missing or altered`);
    }
    return `evidenceLabel ${baseline.evidenceLabel} / status ${baseline.status}, identical across all four arms`;
  }],

  ['NC-3 D1 peer-leakage assertions', (a) => {
    if (a.arms.D1.skipped) return 'D1 skipped (no selected issue); nothing to check';
    const peer = a.peer;
    assertNoPeerLeakage(a.arms.D1.selfReviewPrompt, peer);
    assertNoPeerLeakage(a.arms.D1.decisionPrompt, peer, { allowPeerChunk: true });
    assert.ok(!a.arms.D1.selfReviewPrompt.includes(peer.chunkText), 'peer chunk reached the D1 middle round');
    assert.ok(!a.arms.D1.decisionPrompt.includes(peer.challengeText), 'gate-authored challenge reached D1');
    return 'D1 prompts re-checked against the peer chunk, challenge and sourceRef';
  }],

  ['C and D1 non-treatment parity', (a) => {
    if (a.arms.D1.skipped) return 'D1 skipped; parity not applicable';
    const block = buildSpecialistBlock(a.snapshot);
    assert.ok(a.arms.C.decisionPrompt.includes(block), 'arm C decision prompt lost the specialist block');
    assert.ok(a.arms.D1.decisionPrompt.includes(block), 'arm D1 decision prompt lost the specialist block');
    const CONTRACT = 'Revision, recency, or agreement between specialists is not evidence.';
    assert.ok(a.arms.C.decisionPrompt.includes(CONTRACT), 'arm C lost the neutrality guard');
    assert.ok(a.arms.D1.decisionPrompt.includes(CONTRACT), 'arm D1 lost the neutrality guard');
    return 'same specialist block and same neutrality guard in both arms';
  }],

  ['normalization determinism', (a) => {
    const baseline = evidenceBaseline(a.snapshot);
    for (const [arm, r] of Object.entries(a.arms)) {
      if (!r.normalized) continue;
      const out = verifyNormalization(r.finalOutput, baseline.banner, r.normalized.text);
      assert.ok(out.deterministic, `${arm}: committed normalized answer is not what the normalizer produces`);
      assert.equal(out.expectedSha256, r.normalized.sha256, `${arm}: normalized sha256 mismatch`);
    }
    return 'every committed normalized answer regenerated byte for byte';
  }],

  ['pair and assignment integrity', (a) => {
    if (!a.blindPairs) return 'no blind pairs in this artifact';
    assertPairsBlind(a.blindPairs.pairs);
    const ids = new Set(a.blindPairs.pairs.map((p) => p.pairId));
    assert.equal(ids.size, a.blindPairs.pairs.length, 'duplicate pairIds');
    assert.deepEqual(new Set(a.blindPairs.assignments.map((x) => x.pairId)), ids, 'assignments do not cover the pairs exactly');
    const armNames = ['"B"', '"B_prime"', '"C"', '"D1"'];
    const serialized = JSON.stringify(a.blindPairs.pairs);
    for (const name of armNames) assert.ok(!serialized.includes(name), `judge-facing pairs mention ${name}`);
    return `${a.blindPairs.pairs.length} pairs, assignments held separately`;
  }],
];

export function verifyArtifact(artifact) {
  const results = [];
  for (const [name, fn] of CHECKS) {
    try {
      results.push({ name, status: 'PASS', detail: fn(artifact) });
    } catch (error) {
      results.push({ name, status: 'FAIL', detail: error.message });
    }
  }
  return { results, ok: results.every((r) => r.status === 'PASS') };
}

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (files.length) {
  let allOk = true;
  for (const file of files) {
    const artifact = JSON.parse(readFileSync(file, 'utf8'));
    const { results, ok } = verifyArtifact(artifact);
    console.log(`\n${file}`);
    for (const r of results) console.log(`  ${r.status === 'PASS' ? 'PASS' : 'FAIL'} ${r.name}: ${r.detail}`);
    allOk = allOk && ok;
  }
  process.exit(allOk ? 0 : 1);
} else if (process.argv.includes('--self-test')) {
  console.log('verify.mjs exposes these recomputations:');
  for (const [name] of CHECKS) console.log(`  - ${name}`);
} else {
  console.log('usage: node experiments/m2b/verify.mjs <run-artifact.json> [...]  |  --self-test');
}

```

<!-- END VERBATIM experiments/m2b/verify.mjs -->

---

## `experiments/m2b/fixtures/synthetic/fixture.mjs`

```
sha256 : 43f8c5e28872cd80dbbcd4d0059c28b3cd7685387d5031b27862a1be1ae02446
bytes  : 4599
```

<!-- BEGIN VERBATIM experiments/m2b/fixtures/synthetic/fixture.mjs -->

```javascript
/**
 * Deterministic synthetic fixture for the offline harness tests.
 *
 * NOT an experiment fixture. The four Phase 1 fixtures are frozen only after the harness
 * review (GPT authorization section C), and choosing them now would be choosing them
 * before the tool that runs them has been reviewed.
 *
 * Everything here is invented so the tests have a stable oracle. Live model output is
 * never used as a test oracle: it would make the suite non-deterministic and would smuggle
 * a model's judgment into a check that is supposed to be structural.
 */
export const SNAPSHOT = Object.freeze({
  task: 'Decide whether to open a second production studio next year.',
  complexity: 'deep',
  agentOrder: ['strategist', 'brand'],
  workers: [
    { id: 'strategist', provider: 'openai', model: 'stub-strategist-1', role: 'Business strategy', evidenceCapable: false },
    { id: 'brand', provider: 'openai', model: 'stub-brand-1', role: 'Brand and creative', evidenceCapable: false },
  ],
  workerResults: [
    {
      agentId: 'strategist',
      mission: 'Assess capacity, payback and downside risk.',
      output: [
        '## Recommendation: do not open the second studio yet',
        'The scarcest resource is not demand but delivery capacity.',
        'A second site competes for the same senior editors that carry the high-margin work.',
        'Under the current headcount there is no way to staff both without borrowing from the core team.',
      ].join('\n\n'),
    },
    {
      agentId: 'brand',
      mission: 'Assess positioning, price anchoring and brand dilution.',
      output: [
        '## Recommendation: open it under a separate brand',
        'A separate brand isolates the price anchor of the flagship work.',
        'Capacity can be bounded by capping the client count and refusing rush work.',
      ].join('\n\n'),
    },
  ],
});

export const PEER_CHUNK_TEXT =
  'A second site competes for the same senior editors that carry the high-margin work.';
export const CHALLENGE_TEXT =
  'How does a separate brand avoid consuming the same senior editing capacity the flagship work depends on?';
export const SOURCE_REF = 'strategist:p3';

const ISSUE = {
  targetAgentId: 'brand',
  sourceRef: SOURCE_REF,
  challenge: CHALLENGE_TEXT,
  decisionSensitive: true,
  action: 'peer_challenge',
};

export const PROVISIONAL = 'PROVISIONAL: open the second studio under a separate brand, with a capacity cap.';
export const GATE_TEXT = PROVISIONAL + '\n\n```json\n' + JSON.stringify({ collaborationIssues: [ISSUE] }) + '\n```';
export const PLAIN_SYNTHESIS = 'PLAIN-SYNTHESIS: open the second studio under a separate brand.';
export const ROUND2_TEXT = 'REVISED: only if the separate brand can run on outsourced capacity with a hard no-cross rule.';
export const SELF_REVIEW_TEXT = 'SELF-REVIEWED: my strongest objection is that the capacity cap is unenforceable in practice.';
export const DECISION_TEXT = 'DECISION: defer, and validate the outsourced-capacity assumption within 90 days.';

export const PINS = Object.freeze({
  synthesis: { provider: 'openai', requestedModel: 'stub-synth-1' },
  synthesis_gate: { provider: 'openai', requestedModel: 'stub-synth-1' },
  round2_worker: { provider: 'openai', requestedModel: 'stub-brand-1' },
  self_review: { provider: 'openai', requestedModel: 'stub-brand-1' },
  decision_synthesis: { provider: 'openai', requestedModel: 'stub-synth-1' },
});

/**
 * Deterministic stub dispatcher. Answers by stage and echoes back the model it was asked
 * for, which is what makes the pin assertion meaningful in the passing case — and what the
 * mismatch test overrides.
 */
export function makeStub(overrides = {}) {
  const seen = [];
  const call = async (provider, prompt, options) => {
    seen.push({ stage: options.stage, provider, prompt, options });
    if (overrides.throwAt === options.stage) throw new Error(`stub failure at ${options.stage}`);
    const model = overrides.resolvedModel?.[options.stage] ?? options.model;
    const text =
      options.stage === 'synthesis' ? PLAIN_SYNTHESIS
      : options.stage === 'synthesis_gate' ? (overrides.gateText ?? GATE_TEXT)
      : options.stage === 'round2_worker' ? ROUND2_TEXT
      : options.stage === 'self_review' ? SELF_REVIEW_TEXT
      : options.stage === 'decision_synthesis' ? DECISION_TEXT
      : `stub-${options.stage}`;
    const result = { provider, model, text };
    if (overrides.retrievalAt === options.stage) result.retrieval = { status: 'GROUNDED', queries: [], sources: [], sourcesFound: 0 };
    return result;
  };
  return { call, seen };
}

```

<!-- END VERBATIM experiments/m2b/fixtures/synthetic/fixture.mjs -->

---

## `experiments/m2b/test-m2b-harness.mjs`

```
sha256 : 351aae11da08da82375138b319d9f45c6a5d690d60c1b8e290342d3764f7106f
bytes  : 32601
```

<!-- BEGIN VERBATIM experiments/m2b/test-m2b-harness.mjs -->

```javascript
/**
 * Offline tests for the M2-B experiment harness.
 *
 * No provider is called. Every oracle is a synthetic fixture, never live model output:
 * a live oracle would make the suite non-deterministic and would put a model's judgment
 * inside a check meant to be structural.
 *
 * Every invariant here has a matching negative test that breaks it on purpose. An
 * assertion that has never been observed to fail is not evidence that it can (HANDOFF
 * §25 E4, and the rev.21 principle) — so each guard is proven failable before it is
 * relied on.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildRunReport, buildOutputBanner } from '../../dist/modes/orchestrator.js';
import { createDispatcher, ModelPinViolation, RetrievalPolicyViolation } from './harness/dispatcher.mjs';
import { runArmB, runArmBPrime, runArmC, runArmD1, runAllArms, buildSpecialistBlock } from './harness/arms.mjs';
import { buildSelfReviewPrompt, buildSelfReviewDecisionPrompt, extractDecisionContract } from './harness/prompts.mjs';
import { assertNoPeerLeakage, PeerLeakageDetected } from './harness/leakage.mjs';
import { evidenceBaseline, assertEvidenceIsolation, EvidenceInvariantViolation } from './harness/invariants.mjs';
import { normalizeAnswer, verifyNormalization, NormalizationError } from './harness/normalizer.mjs';
import { buildBlindPairs, assertPairsBlind, PairLeakageDetected } from './harness/pairs.mjs';
import { validateManifest, sealManifest, ManifestInvalid, MANDATORY_FIELDS } from './harness/manifest.mjs';
import { buildRunArtifact } from './harness/artifact.mjs';
import { verifyArtifact } from './verify.mjs';
import * as F from './fixtures/synthetic/fixture.mjs';

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL ${name}\n      ${error.stack}`);
    failed++;
  }
}
/** Asserts `fn` throws, and that the error is the specific type the guard promises. */
async function mustThrow(fn, type, hint) {
  let thrown = null;
  try { await fn(); } catch (e) { thrown = e; }
  assert.ok(thrown, `expected a throw (${hint}) but nothing was thrown`);
  assert.ok(thrown instanceof type, `expected ${type.name} but got ${thrown.constructor.name}: ${thrown.message}`);
  return thrown;
}

const PEER = { chunkText: F.PEER_CHUNK_TEXT, challengeText: F.CHALLENGE_TEXT, sourceRef: F.SOURCE_REF };
const base = () => ({ snapshot: F.SNAPSHOT, pins: F.PINS, temperature: 0 });

/* ============================================================== arm runners */
console.log('\nArm runners (PASS cases)');

await check('arm B runs synthesis only and spends exactly one call', async () => {
  const stub = F.makeStub();
  const b = await runArmB({ ...base(), call: stub.call });
  assert.deepEqual(b.calls.map((c) => c.stage), ['synthesis']);
  assert.equal(b.billable, 1);
  assert.ok(b.result.finalOutput.endsWith(F.PLAIN_SYNTHESIS));
  assert.equal(b.result.collaboration, undefined, 'arm B must carry no collaboration object at all');
});

await check('arm B-prime runs the gate, records it, and never reaches Round 2', async () => {
  const stub = F.makeStub();
  const bp = await runArmBPrime({ ...base(), call: stub.call });
  assert.deepEqual(bp.calls.map((c) => c.stage), ['synthesis_gate']);
  assert.equal(bp.billable, 1);
  assert.equal(bp.result.collaboration.status, 'SKIPPED');
  assert.equal(bp.result.collaboration.reason, 'round2_disabled');
  assert.ok(bp.gateRecording, 'B-prime must produce the gate recording C and D1 replay');
  assert.equal(bp.gateRecording.text, F.GATE_TEXT);
});

await check('B-prime keeps selectedIssue, which is what lets C and D1 share a target', async () => {
  const stub = F.makeStub();
  const bp = await runArmBPrime({ ...base(), call: stub.call });
  assert.equal(bp.result.collaboration.selectedIssue.targetAgentId, 'brand');
  assert.equal(bp.result.collaboration.selectedIssue.sourceRef, F.SOURCE_REF);
});

await check('arm C replays the shared gate and adds exactly two billable calls', async () => {
  const stub = F.makeStub();
  const bp = await runArmBPrime({ ...base(), call: stub.call });
  const c = await runArmC({ ...base(), call: stub.call, gateRecording: bp.gateRecording });
  assert.deepEqual(c.calls.map((x) => x.stage), ['synthesis_gate', 'round2_worker', 'decision_synthesis']);
  assert.equal(c.billable, 2, 'the replayed gate must not be billed');
  assert.equal(c.calls.find((x) => x.stage === 'synthesis_gate').replayed, true);
  assert.equal(c.result.collaboration.status, 'COMPLETED');
  assert.ok(c.result.finalOutput.endsWith(F.DECISION_TEXT));
});

await check('arm D1 runs self_review then decision_synthesis, two billable calls', async () => {
  const stub = F.makeStub();
  const bp = await runArmBPrime({ ...base(), call: stub.call });
  const d1 = await runArmD1({ ...base(), call: stub.call, bPrime: bp, peer: PEER });
  assert.equal(d1.skipped, false);
  assert.deepEqual(d1.calls.map((x) => x.stage), ['self_review', 'decision_synthesis']);
  assert.equal(d1.billable, 2);
  assert.equal(d1.result.selfReview.agentId, 'brand', 'D1 must challenge the same specialist C challenged');
  assert.ok(d1.result.finalOutput.endsWith(F.DECISION_TEXT));
});

await check('C and D1 are built on a byte-identical provisional answer', async () => {
  const stub = F.makeStub();
  const bp = await runArmBPrime({ ...base(), call: stub.call });
  const c = await runArmC({ ...base(), call: stub.call, gateRecording: bp.gateRecording });
  assert.equal(c.result.collaboration.provisionalAnswer, bp.result.collaboration.provisionalAnswer);
  assert.equal(c.result.collaboration.provisionalAnswer, F.PROVISIONAL);
});

await check('the shared gate prompt is identical for B-prime and C', async () => {
  const stub = F.makeStub();
  const bp = await runArmBPrime({ ...base(), call: stub.call });
  const c = await runArmC({ ...base(), call: stub.call, gateRecording: bp.gateRecording });
  assert.equal(
    c.calls.find((x) => x.stage === 'synthesis_gate').promptSha256,
    bp.calls.find((x) => x.stage === 'synthesis_gate').promptSha256
  );
});

/* ========================================================= call accounting */
console.log('\nCall accounting');

await check('one fixture-repetition costs exactly six billable provider calls', async () => {
  const stub = F.makeStub();
  const run = await runAllArms({ ...base(), call: stub.call });
  assert.deepEqual(run.accounting, {
    B: 1, sharedGate: 1, C: 2, D1: 2, totalBillable: 6, naiveWithoutSharedGate: 8,
  });
});

await check('the six calls carry the expected stages, gate charged once', async () => {
  const stub = F.makeStub();
  await runAllArms({ ...base(), call: stub.call });
  const stages = stub.seen.map((s) => s.stage).sort();
  assert.deepEqual(stages, ['decision_synthesis', 'decision_synthesis', 'round2_worker', 'self_review', 'synthesis', 'synthesis_gate']);
  assert.equal(stub.seen.filter((s) => s.stage === 'synthesis_gate').length, 1, 'the gate must reach the provider once');
});

/* ============================================================ model pinning */
console.log('\nModel pinning');

await check('a run whose resolved model matches the pin is accepted', async () => {
  const stub = F.makeStub();
  const b = await runArmB({ ...base(), call: stub.call });
  assert.equal(b.calls[0].requestedModel, 'stub-synth-1');
  assert.equal(b.calls[0].resolvedModel, 'stub-synth-1');
});

await check('NEGATIVE: resolvedModel != requestedModel aborts the run', async () => {
  const stub = F.makeStub({ resolvedModel: { synthesis: 'some-other-model' } });
  const err = await mustThrow(() => runArmB({ ...base(), call: stub.call }), ModelPinViolation, 'pin mismatch');
  assert.equal(err.resolvedModel, 'some-other-model');
  assert.match(err.message, /INVALID/);
});

await check('NEGATIVE: a stage with no pin is a manifest error, not an adapter default', async () => {
  const stub = F.makeStub();
  const { synthesis: _drop, ...withoutSynthesis } = F.PINS;
  await mustThrow(
    () => runArmB({ ...base(), pins: withoutSynthesis, call: stub.call }),
    Error, 'missing pin'
  );
});

/* ============================================================== NC-3 leakage */
console.log('\nNC-3 peer-leakage guard');

await check('a clean D1 self-review prompt passes NC-3', () => {
  const prompt = buildSelfReviewPrompt({
    task: F.SNAPSHOT.task,
    mission: F.SNAPSHOT.workerResults[1].mission,
    previousOutput: F.SNAPSHOT.workerResults[1].output,
  });
  const report = assertNoPeerLeakage(prompt, PEER);
  assert.deepEqual(report.checked, ['sourceRef', 'peer chunk', 'peer challenge']);
  assert.deepEqual(report.notChecked, ['paraphrase', 'topic steer', 'semantic leakage']);
});

await check('the D1 prompt builder has no parameter through which peer text could arrive', () => {
  assert.equal(buildSelfReviewPrompt.length, 1);
  const prompt = buildSelfReviewPrompt({ task: 'T', mission: 'M', previousOutput: 'P' });
  assert.ok(!prompt.includes('peer'));
  assert.ok(!prompt.includes('another specialist'));
});

await check('NEGATIVE: peer chunk text smuggled into a D prompt is caught', () => {
  const contaminated = `Original task:\nX\n\nSomeone noted: ${F.PEER_CHUNK_TEXT}\n`;
  const err = mustThrowSync(() => assertNoPeerLeakage(contaminated, PEER), PeerLeakageDetected);
  assert.equal(err.kind, 'peer chunk');
});

await check('NEGATIVE: peer challenge text smuggled into a D prompt is caught', () => {
  // A fragment unique to the gate-authored challenge: it appears nowhere in Round 1, so
  // attribution is unambiguous. (The full challenge shares a window with the chunk it was
  // written about, which is realistic — a challenge usually quotes its target.)
  const uniqueToChallenge = 'the flagship work depends on?';
  assert.ok(F.CHALLENGE_TEXT.includes(uniqueToChallenge));
  assert.ok(!F.PEER_CHUNK_TEXT.includes(uniqueToChallenge));
  const err = mustThrowSync(
    () => assertNoPeerLeakage(`Original task:\nX\n\nConsider: ${uniqueToChallenge}\n`, PEER),
    PeerLeakageDetected
  );
  assert.equal(err.kind, 'peer challenge');
});

await check('NC-3 scoping: the decision prompt may carry the peer chunk, since Round 1 does', () => {
  // Both arms' decision synthesis sees the full Round 1 block. Forbidding it here would
  // break the parity that makes C and D1 comparable at all.
  const withRound1 = `Results from each specialist:\n${F.SNAPSHOT.workerResults[0].output}`;
  mustThrowSync(() => assertNoPeerLeakage(withRound1, PEER), PeerLeakageDetected);
  const report = assertNoPeerLeakage(withRound1, PEER, { allowPeerChunk: true });
  assert.deepEqual(report.checked, ['sourceRef', 'peer challenge']);
  assert.ok(report.notChecked[0].includes('present in Round 1 for both arms'));
});

await check('NEGATIVE: even in decision-prompt mode, the gate-authored challenge is still forbidden', () => {
  const contaminated = `Results:\n${F.SNAPSHOT.workerResults[0].output}\n\n${F.CHALLENGE_TEXT}`;
  const err = mustThrowSync(
    () => assertNoPeerLeakage(contaminated, PEER, { allowPeerChunk: true }),
    PeerLeakageDetected
  );
  assert.equal(err.kind, 'peer challenge');
});

await check('NEGATIVE: even in decision-prompt mode, the sourceRef is still forbidden', () => {
  mustThrowSync(
    () => assertNoPeerLeakage(`Results:\nsee ${F.SOURCE_REF}`, PEER, { allowPeerChunk: true }),
    PeerLeakageDetected
  );
});

await check('NEGATIVE: a bare sourceRef in a D prompt is caught', () => {
  const err = mustThrowSync(() => assertNoPeerLeakage(`see ${F.SOURCE_REF} for context`, PEER), PeerLeakageDetected);
  assert.equal(err.kind, 'sourceRef');
});

await check('NC-3 catches a reflowed quotation, not only an exact one', () => {
  const reflowed = 'A second site competes for the same\nsenior editors that carry the high-margin work.';
  mustThrowSync(() => assertNoPeerLeakage(`X\n\n${reflowed}`, PEER), PeerLeakageDetected);
});

await check('NC-3 states plainly that it does not catch paraphrase', () => {
  const paraphrase = 'The new location would draw on the very same experienced staff.';
  // Passes on purpose. The guard is not claimed to cover this; §19 X11 records the gap.
  const report = assertNoPeerLeakage(`X\n\n${paraphrase}`, PEER);
  assert.ok(report.notChecked.includes('paraphrase'));
});

await check('arm D1 refuses to call the provider when its prompt is contaminated', async () => {
  const stub = F.makeStub();
  const bp = await runArmBPrime({ ...base(), call: stub.call });
  const before = stub.seen.length;
  // The peer record claims the target's own answer is peer text, so the guard must fire.
  const poisoned = { ...PEER, chunkText: F.SNAPSHOT.workerResults[1].output.slice(0, 60) };
  await mustThrow(
    () => runArmD1({ ...base(), call: stub.call, bPrime: bp, peer: poisoned }),
    PeerLeakageDetected, 'contaminated D1'
  );
  assert.equal(stub.seen.length, before, 'no provider call may be made once leakage is detected');
});

await check('NEGATIVE: a whole challenge string transplanted into a D prompt is caught in both modes', () => {
  // The failure actually worth catching: a harness bug passing selected.challenge through.
  const transplanted = `Results:\n${F.SNAPSHOT.workerResults[0].output}\n\nAddress this: ${F.CHALLENGE_TEXT}`;
  for (const opts of [{}, { allowPeerChunk: true }]) {
    const err = mustThrowSync(() => assertNoPeerLeakage(transplanted, PEER, opts), PeerLeakageDetected);
    assert.equal(err.kind, 'peer challenge');
  }
});

await check('NEGATIVE: a whole peer chunk transplanted into a middle-round prompt is caught', () => {
  const transplanted = `Your previous answer:\nX\n\nAnother specialist wrote: ${F.PEER_CHUNK_TEXT}`;
  const err = mustThrowSync(() => assertNoPeerLeakage(transplanted, PEER), PeerLeakageDetected);
  assert.equal(err.kind, 'peer chunk');
});

await check('the guard reports which checks are exact-string and which are windowed', () => {
  const clean = buildSelfReviewPrompt({ task: 'T', mission: 'M', previousOutput: 'P' });
  const mid = assertNoPeerLeakage(clean, PEER);
  assert.deepEqual(mid.exactStringChecked, ['sourceRef', 'challengeText', 'chunkText']);
  assert.equal(mid.windowChars, 20);
  const dec = assertNoPeerLeakage(clean, PEER, { allowPeerChunk: true });
  assert.deepEqual(dec.exactStringChecked, ['sourceRef', 'challengeText']);
  assert.equal(dec.windowChars, 60, 'decision mode widens the window; see leakage.mjs for why');
});

/* ========================================================= NC-2 evidence */
console.log('\nNC-2 evidence isolation');

await check('all four arms leave the evidence baseline untouched', async () => {
  const stub = F.makeStub();
  const run = await runAllArms({ ...base(), call: stub.call });
  const baseline = evidenceBaseline(F.SNAPSHOT);
  for (const [arm, r] of Object.entries(run.arms)) {
    const out = assertEvidenceIsolation(arm, baseline, r.result, r.calls);
    assert.equal(out.evidenceLabel, baseline.evidenceLabel);
  }
});

await check('NEGATIVE: an evidenceLabel changed after the second round is caught', () => {
  const baseline = evidenceBaseline(F.SNAPSHOT);
  const tampered = {
    report: { ...baseline.report, evidenceLabel: 'PARTIALLY_GROUNDED' },
    finalOutput: baseline.banner + 'x',
  };
  const err = mustThrowSync(() => assertEvidenceIsolation('C', baseline, tampered, []), EvidenceInvariantViolation);
  assert.match(err.message, /INVALID/);
});

await check('NEGATIVE: a RunStatus changed after the second round is caught', () => {
  const baseline = evidenceBaseline(F.SNAPSHOT);
  const tampered = { report: { ...baseline.report, status: 'DEGRADED' }, finalOutput: baseline.banner + 'x' };
  mustThrowSync(() => assertEvidenceIsolation('C', baseline, tampered, []), EvidenceInvariantViolation);
});

await check('NEGATIVE: a missing banner is caught', () => {
  const baseline = evidenceBaseline(F.SNAPSHOT);
  mustThrowSync(
    () => assertEvidenceIsolation('C', baseline, { report: baseline.report, finalOutput: 'no banner here' }, []),
    EvidenceInvariantViolation
  );
});

await check('NEGATIVE: retrieval on any call violates the all-off policy', async () => {
  const stub = F.makeStub({ retrievalAt: 'synthesis' });
  await mustThrow(() => runArmB({ ...base(), call: stub.call }), RetrievalPolicyViolation, 'retrieval present');
});

await check('NEGATIVE: a retrieval result recorded in the call log is caught by NC-2 too', () => {
  const baseline = evidenceBaseline(F.SNAPSHOT);
  const calls = [{ stage: 'round2_worker', retrievalRequested: null, retrievalResult: { status: 'GROUNDED' } }];
  mustThrowSync(
    () => assertEvidenceIsolation('C', baseline, { report: baseline.report, finalOutput: baseline.banner + 'x' }, calls),
    EvidenceInvariantViolation
  );
});

/* ========================================================== normalization */
console.log('\nNormalization');

await check('normalization removes the banner and nothing else', () => {
  const report = buildRunReport(F.SNAPSHOT.complexity, F.SNAPSHOT.workers, F.SNAPSHOT.workerResults);
  const banner = buildOutputBanner(report);
  const raw = banner + 'Body with a caveat: I could not verify this number.';
  const out = normalizeAnswer(raw, banner);
  assert.equal(out.text, 'Body with a caveat: I could not verify this number.');
  assert.ok(out.text.includes('could not verify'), 'caveats are content and must survive');
});

await check('normalization is deterministic across repeated runs', () => {
  const report = buildRunReport(F.SNAPSHOT.complexity, F.SNAPSHOT.workers, F.SNAPSHOT.workerResults);
  const banner = buildOutputBanner(report);
  const raw = banner + F.DECISION_TEXT;
  const a = normalizeAnswer(raw, banner);
  const b = normalizeAnswer(raw, banner);
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.sha256, createHash('sha256').update(F.DECISION_TEXT).digest('hex'));
});

await check('NEGATIVE: a substantively edited normalized answer fails verification', () => {
  const report = buildRunReport(F.SNAPSHOT.complexity, F.SNAPSHOT.workers, F.SNAPSHOT.workerResults);
  const banner = buildOutputBanner(report);
  const raw = banner + 'Defer the decision. This estimate is unverified.';
  const edited = 'Defer the decision.'; // a caveat removed — exactly the forbidden edit
  const out = verifyNormalization(raw, banner, edited);
  assert.equal(out.deterministic, false);
});

await check('NEGATIVE: normalizing with the wrong banner refuses rather than guesses', () => {
  mustThrowSync(() => normalizeAnswer('some answer', '> NOT THE BANNER\n\n'), NormalizationError);
});

/* ============================================================ blind pairs */
console.log('\nBlind pairs');

await check('pairs carry only a pairId and two answers', () => {
  const normalized = { B: { text: 'b' }, B_prime: { text: 'bp' }, C: { text: 'c' }, D1: { text: 'd' } };
  const { pairs, assignments } = buildBlindPairs({
    fixtureId: 'synthetic-1', runIndex: 1, normalized,
    comparisons: [['B', 'B_prime'], ['B_prime', 'C'], ['C', 'D1']],
  });
  assert.equal(pairs.length, 6, 'three comparisons, counterbalanced');
  for (const p of pairs) assert.deepEqual(Object.keys(p).sort(), ['answerX', 'answerY', 'pairId']);
  assert.equal(assignments.length, 6);
  assert.ok(assignments.every((a) => a.answerX && a.answerY));
});

await check('counterbalancing emits both orders of every comparison', () => {
  const normalized = { C: { text: 'c' }, D1: { text: 'd' } };
  const { assignments } = buildBlindPairs({ fixtureId: 'f', runIndex: 1, normalized, comparisons: [['C', 'D1']] });
  assert.deepEqual(assignments.map((a) => `${a.answerX}->${a.answerY}`), ['C->D1', 'D1->C']);
});

await check('the hidden assignment map is separate from what the judge sees', () => {
  const normalized = { C: { text: 'c' }, D1: { text: 'd' } };
  const { pairs, assignments } = buildBlindPairs({ fixtureId: 'f', runIndex: 1, normalized, comparisons: [['C', 'D1']] });
  assert.ok(!JSON.stringify(pairs).includes('"C"'));
  assert.ok(JSON.stringify(assignments).includes('"C"'));
});

await check('NEGATIVE: a pair carrying arm metadata is rejected', () => {
  mustThrowSync(() => assertPairsBlind([{ pairId: 'x', answerX: 'a', answerY: 'b', arm: 'C' }]), PairLeakageDetected);
});

await check('NEGATIVE: a pair carrying provider or model metadata is rejected', () => {
  mustThrowSync(() => assertPairsBlind([{ pairId: 'x', answerX: 'a', answerY: 'b', resolvedModel: 'gpt-5' }]), PairLeakageDetected);
});

/* =============================================================== manifest */
console.log('\nExperiment manifest');

const goodManifest = () => sealManifest({
  experimentId: 'm2b-offline-selftest',
  protocolVersion: 'M2B-PROTOCOL-0.2',
  fixtureId: 'synthetic-1',
  fixtureSha256: 'a'.repeat(64),
  snapshotSha256: 'b'.repeat(64),
  arm: 'C',
  runIndex: 1,
  pins: F.PINS,
  temperature: 0,
  retrievalPolicy: 'all-off',
  evidenceLabelBaseline: 'HYPOTHESIS',
  runtimeCommit: 'c'.repeat(40),
  promptSourceCommit: 'd'.repeat(40),
  chunkerVersion: 'e'.repeat(64),
  peerExcerptChars: 1000,
});

await check('a complete manifest validates and seals', () => {
  const m = goodManifest();
  assert.equal(validateManifest(m), m);
  assert.match(m.manifestSha256, /^[0-9a-f]{64}$/);
});

await check('NEGATIVE: every mandatory field, removed one at a time, invalidates the manifest', () => {
  for (const field of MANDATORY_FIELDS) {
    const m = goodManifest();
    delete m[field];
    const err = mustThrowSync(() => validateManifest(m), ManifestInvalid);
    assert.ok(
      err.problems.some((p) => p.includes(field)),
      `removing "${field}" must be reported by name, got: ${err.problems.join('; ')}`
    );
  }
});

await check('NEGATIVE: a pin without requestedModel is rejected (adapter default is not a pin)', () => {
  const m = goodManifest();
  m.pins = { ...m.pins, round2_worker: { provider: 'openai' } };
  const err = mustThrowSync(() => validateManifest(m), ManifestInvalid);
  assert.ok(err.problems.some((p) => p.includes('adapter default is not a pin')));
});

await check('NEGATIVE: retrievalPolicy other than all-off is rejected', () => {
  const m = goodManifest();
  m.retrievalPolicy = 'gemini-only';
  mustThrowSync(() => validateManifest(m), ManifestInvalid);
});

await check('NEGATIVE: a tampered manifestSha256 is rejected', () => {
  const m = goodManifest();
  m.peerExcerptChars = 2000;
  mustThrowSync(() => validateManifest(m), ManifestInvalid);
});

/* ======================================== C / D1 non-treatment parity */
console.log('\nC and D1 parity on non-treatment parts');

await check('D1 ships the production Decision contract verbatim', () => {
  const prompt = buildSelfReviewDecisionPrompt({
    task: 'T', specialistBlock: 'S', degradedNote: '',
    targetAgentId: 'brand', selfObjection: 'O', revisedOutput: 'R',
  });
  assert.ok(prompt.includes('Revision, recency, or agreement between specialists is not evidence.'));
  assert.ok(prompt.includes('- Produce the final answer to the original task.'));
  assert.ok(prompt.includes('- If the disagreement is unresolved, state it plainly.'));
  assert.ok(prompt.includes('The second round gathered no new external evidence.'));
});

await check('the Decision contract is derived from production, so it cannot silently drift', () => {
  const contract = extractDecisionContract();
  assert.ok(contract.startsWith('Decision contract:'));
  assert.ok(contract.includes('is not evidence'));
});

await check('the reconstructed specialist block matches what production sends arm C', async () => {
  const stub = F.makeStub();
  const bp = await runArmBPrime({ ...base(), call: stub.call });
  await runArmC({ ...base(), call: stub.call, gateRecording: bp.gateRecording });
  const decisionPrompt = stub.seen.find((s) => s.stage === 'decision_synthesis').prompt;
  assert.ok(
    decisionPrompt.includes(buildSpecialistBlock(F.SNAPSHOT)),
    'harness reconstruction of the specialist block has drifted from production'
  );
});

await check('D1 declares its treatment difference and nothing more', async () => {
  const stub = F.makeStub();
  const bp = await runArmBPrime({ ...base(), call: stub.call });
  await runArmC({ ...base(), call: stub.call, gateRecording: bp.gateRecording });
  await runArmD1({ ...base(), call: stub.call, bPrime: bp, peer: PEER });
  const cPrompt = stub.seen.filter((s) => s.stage === 'decision_synthesis')[0].prompt;
  const dPrompt = stub.seen.filter((s) => s.stage === 'decision_synthesis')[1].prompt;
  assert.ok(cPrompt.includes('A cross-specialist challenge was raised'), 'C keeps its framing; Phase 1 does no source masking');
  assert.ok(dPrompt.includes('reconsidered its own answer'));
  assert.ok(!dPrompt.includes('A cross-specialist challenge was raised'));
  assert.ok(!dPrompt.includes(F.CHALLENGE_TEXT), 'the gate-authored challenge must not reach D1 at all');
  assert.ok(!dPrompt.includes(F.SOURCE_REF), 'the sourceRef must not reach D1 at all');
  const block = buildSpecialistBlock(F.SNAPSHOT);
  assert.ok(cPrompt.includes(block) && dPrompt.includes(block), 'both arms must see the same Round 1 block');
  // Non-treatment parity: the same contract text in both.
  const contract = extractDecisionContract().split('\n').slice(1, 3).join('\n');
  assert.ok(cPrompt.includes(contract.split('\n')[0]));
  assert.ok(dPrompt.includes(contract.split('\n')[0]));
});

/* ================================================= skip and failure paths */
console.log('\nSkip and failure paths');

await check('D1 skips cleanly when the gate emitted no issue', async () => {
  const stub = F.makeStub({ gateText: F.PROVISIONAL });
  const bp = await runArmBPrime({ ...base(), call: stub.call });
  const d1 = await runArmD1({ ...base(), call: stub.call, bPrime: bp, peer: { chunkText: '', challengeText: '', sourceRef: '' } });
  assert.equal(d1.skipped, true);
  assert.equal(d1.reason, 'no_selected_issue');
  assert.equal(d1.billable, 0);
});

await check('a gate that emits no issue leaves C equal to B-prime, and that is data not an error', async () => {
  const stub = F.makeStub({ gateText: F.PROVISIONAL });
  const bp = await runArmBPrime({ ...base(), call: stub.call });
  const c = await runArmC({ ...base(), call: stub.call, gateRecording: bp.gateRecording });
  assert.equal(c.result.collaboration.reason, 'no_issue_block');
  assert.equal(c.result.finalOutput, bp.result.finalOutput);
  assert.equal(c.billable, 0, 'no Round 2, no decision synthesis, nothing spent');
});

/* ================================================================ verifier */
console.log('\nArtifact verifier');

async function syntheticArtifact() {
  const stub = F.makeStub();
  const run = await runAllArms({ ...base(), call: stub.call });
  const manifest = (arm) => sealManifest({
    experimentId: 'm2b-offline-selftest', protocolVersion: 'M2B-PROTOCOL-0.2',
    fixtureId: 'synthetic-1', fixtureSha256: 'a'.repeat(64),
    snapshotSha256: createHash('sha256').update(JSON.stringify(F.SNAPSHOT)).digest('hex'),
    arm, runIndex: 1, pins: F.PINS, temperature: 0, retrievalPolicy: 'all-off',
    evidenceLabelBaseline: 'HYPOTHESIS', runtimeCommit: 'c'.repeat(40), promptSourceCommit: 'd'.repeat(40),
    chunkerVersion: 'e'.repeat(64), peerExcerptChars: 1000,
  });
  return buildRunArtifact({
    experimentId: 'm2b-offline-selftest', fixtureId: 'synthetic-1', runIndex: 1,
    snapshot: F.SNAPSHOT, run, seen: stub.seen, gateResponseText: F.GATE_TEXT,
    manifests: { B: manifest('B'), B_prime: manifest('B_prime'), C: manifest('C'), D1: manifest('D1') },
  });
}

await check('the verifier passes every recomputation on a clean artifact', async () => {
  const { results, ok } = verifyArtifact(await syntheticArtifact());
  const failures = results.filter((r) => r.status === 'FAIL').map((r) => `${r.name}: ${r.detail}`);
  assert.deepEqual(failures, []);
  assert.equal(ok, true);
  assert.equal(results.length, 12, 'all twelve recomputations must run');
});

await check('NEGATIVE: the verifier catches a tampered call count', async () => {
  const a = await syntheticArtifact();
  a.arms.C.calls = a.arms.C.calls.filter((c) => c.stage !== 'round2_worker');
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'arm call accounting').status, 'FAIL');
});

await check('NEGATIVE: the verifier catches a resolvedModel that drifted off its pin', async () => {
  const a = await syntheticArtifact();
  a.arms.B.calls[0].resolvedModel = 'gpt-5';
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'model pins').status, 'FAIL');
});

await check('NEGATIVE: the verifier catches retrieval appearing on a call', async () => {
  const a = await syntheticArtifact();
  a.arms.C.calls[1].retrievalResult = { status: 'GROUNDED' };
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'retrieval all-off').status, 'FAIL');
});

await check('NEGATIVE: the verifier catches C and B-prime built on different gate samples', async () => {
  const a = await syntheticArtifact();
  a.arms.C.provisionalAnswer = 'a different provisional';
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'C and D1 share one provisional').status, 'FAIL');
});

await check('NEGATIVE: the verifier catches a hand-edited normalized answer', async () => {
  const a = await syntheticArtifact();
  a.arms.C.normalized.text = a.arms.C.normalized.text.replace('DECISION', 'CONCLUSION');
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'normalization determinism').status, 'FAIL');
});

await check('NEGATIVE: the verifier catches an evidence label that moved', async () => {
  const a = await syntheticArtifact();
  a.arms.D1.report = { ...a.arms.D1.report, evidenceLabel: 'PARTIALLY_GROUNDED' };
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'NC-2 evidence invariance').status, 'FAIL');
});

await check('NEGATIVE: the verifier catches peer content that reached a D1 prompt', async () => {
  const a = await syntheticArtifact();
  a.arms.D1.selfReviewPrompt += `\n\n${F.PEER_CHUNK_TEXT}`;
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'NC-3 D1 peer-leakage assertions').status, 'FAIL');
});

await check('NEGATIVE: the verifier catches an arm label leaking into judge-facing pairs', async () => {
  const a = await syntheticArtifact();
  a.blindPairs.pairs[0].arm = 'C';
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'pair and assignment integrity').status, 'FAIL');
});

await check('NEGATIVE: the verifier catches a manifest whose hash no longer matches', async () => {
  const a = await syntheticArtifact();
  a.manifests.C.peerExcerptChars = 2000;
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'manifest integrity').status, 'FAIL');
});

await check('NEGATIVE: the verifier catches a snapshot that no longer hashes to its record', async () => {
  const a = await syntheticArtifact();
  a.snapshotSha256 = 'f'.repeat(64);
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'snapshot hash').status, 'FAIL');
});

await check('NEGATIVE: the verifier catches a lost neutrality guard in either arm', async () => {
  const a = await syntheticArtifact();
  a.arms.D1.decisionPrompt = a.arms.D1.decisionPrompt.replace(
    'Revision, recency, or agreement between specialists is not evidence.', 'Prefer the revised answer.'
  );
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'C and D1 non-treatment parity').status, 'FAIL');
});

await check('NEGATIVE: the verifier catches a selectedIssue that production would not have selected', async () => {
  const a = await syntheticArtifact();
  a.selectedIssue = { ...a.selectedIssue, targetAgentId: 'strategist' };
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'gate parsing re-derived from the recorded response').status, 'FAIL');
});

function mustThrowSync(fn, type) {
  let thrown = null;
  try { fn(); } catch (e) { thrown = e; }
  assert.ok(thrown, 'expected a throw but nothing was thrown');
  assert.ok(thrown instanceof type, `expected ${type.name} but got ${thrown?.constructor?.name}: ${thrown?.message}`);
  return thrown;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

```

<!-- END VERBATIM experiments/m2b/test-m2b-harness.mjs -->

---

---

# PART 2 — PROTOCOL v0.2 CURRENT SOURCE(逐字節錄)

```
commit  : a308bc8eef035b1e3f0e1a5c415d52024cf503df
version : M2B-PROTOCOL-0.2
sha256  : aa617ee74ac2277e675e93799461e7b80e1ec0a30e4dbc9f06ea0b1d03562850
```

> **這些是 current v0.2 原文,不是 v0.1 → v0.2 的 diff。**
> Gemini 不應被要求從舊版重建 current truth。
> 變更脈絡另附於 P-02(v0.2 變更摘要),但它只是 provenance,不取代下列原文。
>
> **Included:** 與本輪 review 直接相關的段落 —— D₁ 定義、五成分、Phase 1.5 boundary、
> C/D₁ matching、Decision Synthesis 規則、NC 定義、X16/X17、Claims Ladder、
> src ZERO-CHANGE、HARNESS REVIEW gate、live not authorized。
>
> **Excluded:** 與本輪無直接關係的 §6–§9、§11–§13、§15–§18、§20–§21、§26–§27。
> 這是 deliberate context reduction,**不是宣稱本 packet 等同完整 v0.2**
> (完整檔案 2184 行 / 101862 bytes)。

---

## P-01 — 檔頭 —— protocol version / architecture status / live authorization

```
M2_EFFECTIVENESS_EXPERIMENT.md @ a308bc8  lines 1–16  （逐字）
```

<!-- BEGIN VERBATIM P-01 -->

# M2-B EFFECTIVENESS EXPERIMENT DESIGN

> **本文件只設計實驗,不實作。** 未修改 `src/`、prompts、tests、runtime,未執行任何 live call,
> 未跑 B/B′/C/D₁、未跑 temperature probe、未開始 harness implementation、未 merge main。
>
> | | |
> |---|---|
> | Protocol version | `M2B-PROTOCOL-0.2` |
> | Architecture status | **ACCEPTED WITH CORRECTIONS**(GPT Architecture Review of v0.1) |
> | Live authorization | **NOT GRANTED** —— pilot 需先通過 GPT Harness Review |
> | 撰寫依據 | `HANDOFF.md` rev.22 @ `339d700201ee493f592b6a9a56b3e96248bd6f8d` |
> | 治理依據 | `AI_COLLAB_WORKFLOW_RULES.md`(rev.21 基準版) |
> | 角色 | Claude — Experiment Design Mode(規則 §3.2) |
> | Runtime 依據 | `experimental/m2a-peer-challenge` @ `4e34d89`(rev.20 production code) |
> | 狀態 | **PROTOCOL v0.2 / HARNESS IMPLEMENTATION NEXT / LIVE PILOT NOT AUTHORIZED** |


<!-- END VERBATIM P-01 -->

---

## P-02 — v0.2 變更摘要(GPT 13 項決策的落點)

```
M2_EFFECTIVENESS_EXPERIMENT.md @ a308bc8  lines 17–44  （逐字）
```

<!-- BEGIN VERBATIM P-02 -->

## v0.2 變更摘要(依 GPT Architecture Review)

`[DECISION]` GPT Architecture Review 對 v0.1 的裁決是 **ACCEPT WITH ARCHITECTURE CORRECTIONS**。
本版依其 13 項決策修訂,**未新增任何未被指示的架構**。

| # | 決策 | 本版位置 |
|---|---|---|
| 1 | 保留 Phase 1 四臂 `B / B′ / C / D₁` 及全部既有設計 | §3、§5、§6、§7、§8、§9、§15 —— **未改** |
| 2 | `C − D₁` 改稱 **Targeted Peer-Challenge Package** 的增量;F-01/F-02 定為 treatment components | **§4.1.1(新增)** |
| 3 | 不在 Phase 1 新增 `D_gate`;登記為 conditional Phase 1.5 | **§4.4(新增)** |
| 4 | Claims Ladder 拆成 **L2-P / L2-M**;L3 禁止 pure-peer 宣稱 | §22 |
| 5 | Option 3′ 正式批准,附 claim boundary | §15.4 |
| 6 | temperature probe 為 mandatory preflight;不支援則記錄,不改 runtime | §7.4 |
| 7 | model drift 維持既有四項機制,不虛構 server-side version | §8.4 |
| 8 | 流程插入 **GPT Harness Review** 關卡;live 尚未授權 | §25.3 |
| 9 | harness 維持 `src/` zero-change,全部放 `experiments/m2b/` | §23.4 |
| 10 | Confound Register 新增 **X16 / X17** | §19 |
| 11 | Diagnostic #1 arithmetic defect 補進 HANDOFF factual history | 見下方說明 |
| 12 | 更新 HANDOFF status | 見下方說明 |
| 13 | protocolVersion → 0.2、commit、回報 | 本檔 |

`[FACT]` 第 11、12 項屬於 `HANDOFF.md` 的變更,不在本檔案內 ——
依協作規則 §46,工程狀態與歷史事實歸 HANDOFF,實驗設計歸本檔。
第 11 項明確**不得稱為 runtime defect**(它是 Answer-Quality Defect,見 §26.1)。

`[DECISION]` **v0.1 已凍結於 commit `734ad8e`,`GEMINI_M2B_REVIEW_PACKET.md` @ `14952c7`
仍指向 v0.1,依 packet immutability 規則不回頭覆寫。** 若日後需要對 v0.2 再做一次
外部 review,應建立 `GEMINI-M2B-PACKET-2`,而不是改舊 packet。

<!-- END VERBATIM P-02 -->

---

## P-03 — §3.2 D₁ 的設計決定 / §3.3 D 必須匹配 C 的欄位 / §3.4 D 的資訊洩漏防線

```
M2_EFFECTIVENESS_EXPERIMENT.md @ a308bc8  lines 212–300  （逐字）
```

<!-- BEGIN VERBATIM P-03 -->

## 3.2 Arm D 的設計 —— 本 protocol 最關鍵的決定

`[DECISION]` D 有兩種可能形狀,必須選一個:

| | D₀ — Generic Self-Review | **D₁ — Self-Targeted Challenge(推薦)** |
|---|---|---|
| 指令 | 「重讀你的答案,找出最弱的假設並視情況修正」 | 「找出對你自己論證**最強的一個反對意見**,然後回答它」 |
| 隔離的東西 | peer 資訊 **+ 針對性** 兩者一起 | **只隔離 peer 資訊的來源** |
| 與 C 的形狀匹配 | 較鬆 | 緊(同樣是「面對一個具體挑戰並回應」) |
| 風險 | targeting effect 會被誤算成 peer effect | 較貴一點的 prompt 設計工作 |

`[DESIGN]` **推薦 D₁ 為主要 D。**

理由:研究問題是「peer information 是否有 incremental value」。
若用 D₀,C 與 D 之間差了**兩件事**(資訊來自誰、以及有沒有具體標的)。
一旦 `C > D₀`,我們無法分辨那是「peer 的資訊有價值」還是「有一個具體標的就有價值」。
**D₁ 讓 C 與 D 只差一件事:那個具體挑戰是別人提的,還是自己提的。**

`[DESIGN]` D₀ 保留為 **Phase 2 的選配 arm**。它回答的是另一個合法但次要的產品問題:
「一個便宜的通用 self-review 是不是就夠了」。Phase 1 不跑。

`[DECISION]` ⚠️ **D₁ 不是「完美對照」,也不宣稱是。** 它與 C 之間仍有兩項刻意保留的差異
(挑戰的作者、以及「這是別人的質疑」這個框架),已登記為 **X16 / X17 treatment components**。
因此 `C − D₁` 的正確讀法見 **§4.1.1**,拆解它們的唯一途徑見 **§4.4 Phase 1.5**。

## 3.3 D 必須匹配 C 的哪些欄位

`[DESIGN]` 硬性匹配清單:

```
same frozen Round1 snapshot        （逐位元組）
same target specialist agentId     （即 C 的 selectedIssue.targetAgentId）
same provider                       （targetWorker.provider）
same exact pinned model             （targetWorker.model，明確指定，見第 8 節）
same system prompt                  （targetWorker.role）
same call count                     （3）
same stage 順序                     （provisional → 中間輪 → decision synthesis）
same decision-synthesis 合成器       （同 provider + 同 pinned model）
```

**不匹配、且必須不匹配的唯一一件事:**

```
C 的中間輪收到  → 另一位 specialist 的 exact chunk + 該 specialist 提的 challenge
D 的中間輪收到  → 無任何 peer 資訊
```

## 3.4 ⚠️ D 的資訊洩漏防線

`[DESIGN]` 這是最容易做錯的地方。D 的中間輪 prompt **絕對不得**包含:

- peer 的 chunk 文字(明顯)
- peer 提的 challenge 文字(明顯)
- **挑戰的主題**(不明顯但同樣致命)—— 若我們把 C 選中的 issue 主題翻譯成
  「請重新檢視你關於產能瓶頸的假設」,那 D 就拿到了 peer 的**判斷**,只是換了措辭。

正確作法:D 的中間輪只知道 **original task、自己的 mission、自己的 Round 1 輸出**,
以及一條與 fixture 無關的通用指令。**由 D 自己決定要挑戰什麼。**

`[DESIGN]` 這會讓 D 有時挑到與 C 不同的主題 —— **那是對的,不是缺陷**。
若強迫 D 挑同一個主題,我們就把 peer 的貢獻(「指出該看哪裡」)偷偷送給了 D,
於是 `C ≈ D` 會是設計造成的,而不是量到的。

---

# 4. Causal Identification

## 4.1 分解式

`[DESIGN]` 四個 arm 提供一組乾淨的差分:

```
B′ − B   =  Gate 附錄效果
            （要求模型去找跨專家分歧，這件事本身如何改變答案）

D₁ − B′  =  額外 reasoning 效果
            （再想一次 + 第二次 synthesis，無 peer 資訊）

C  − D₁  =  ★ Targeted Peer-Challenge Package 相對 Matched Self-Review
              的 incremental value ★
            （見 §4.1.1：這是一個「套件」的效果，不是純 peer 資訊的效果）

C  − B′  =  整個第二輪的效果（package + 額外 reasoning，合計）

C  − B   =  對「今天出貨的東西」的總產品增量 = (B′−B) + (C−B′)
```

`[DECISION]` **`C − D₁` 是本實驗的主要估計量。** 其餘四項是解釋它所需的支撐。


<!-- END VERBATIM P-03 -->

---

## P-04 — §4.1.1 主要估計量的正確名稱 —— Targeted Peer-Challenge Package 五成分

```
M2_EFFECTIVENESS_EXPERIMENT.md @ a308bc8  lines 301–358  （逐字）
```

<!-- BEGIN VERBATIM P-04 -->

## 4.1.1 ⚠️ 主要估計量的正確名稱(GPT Architecture Review 修正)

`[DECISION]` **v0.1 把 `C − D` 稱為「peer information 的 incremental value」。這個命名過寬,已被撤回。**

Gemini 的 F-01(external-challenge framing)與 F-02(challenge-author capability difference)
被接受為真實 concern。**修正方式是收窄 claim,不是新增 arm。**

`C − D₁` 估計的是一個**套件**的效果。該套件在 Phase 1 明確包含五個成分:

```
Targeted Peer-Challenge Package
  ①  peer passage                    （另一位 specialist 的 exact chunk）
  ②  Gate 的 cross-agent issue selection（挑哪一組分歧、挑誰來答）
  ③  Gate-authored challenge          （挑戰文字由 gate 模型撰寫）
  ④  external-challenge framing       （「這是別人對你的質疑」這個框架）
  ⑤  target revision                  （target 針對該挑戰所做的修正）
```

`[DECISION]` **①–⑤ 在 Phase 1 是 treatment components,不是未受控的 confound。**
它們是被刻意一起施加的處理,而 D₁ 是缺少 ①–④ 的對照。
因此 `C − D₁` 是**套件對照 matched self-review** 的差,不是任何單一成分的差。

`[DECISION]` **禁止宣稱**(即使 `C > D₁` 成立):

```
❌ pure peer information itself has incremental value
❌ 「是『另一個模型的資訊』本身造成的」
❌ 多模型優於單模型
```

`[DESIGN]` 要拆解 ①–④ 各自的貢獻,需要 §4.4 的 Phase 1.5 ablation。

## 4.2 為什麼不能只跑 B/C/D

`[FACT]` 若拿掉 B′:

```
C − B = Gate 附錄效果 + 額外 reasoning 效果 + peer 資訊效果
```

三項綁在一起。而第二十一節已經記錄附錄效果**可能為正也可能為負**
(更防禦性的措辭 / 注意力被分走 / 因重讀各專家輸出而更完整)。
沒有 B′,`C > B` 這個結果**在因果上是不可解釋的**。

`[FACT]` B′ 的成本是**一次 synthesis 呼叫** —— 與 B 相同,是四個 arm 裡最便宜的。

`[DESIGN]` **用最便宜的 arm 解決最大的 confound,是明確划算的。**
省掉 B′ 省下 1/8 的呼叫,卻讓主結果無法解釋。

## 4.3 Q1 的答案

`[DECISION]` **Q1: 第一階段跑 `B / B′ / C / D`(指令書第二十三節的 Option B)。**

- 否決 Option A(B′ 只做 diagnostic):附錄 confound 是**主要**識別障礙,不是診斷細節。
- 否決 Option C(B 做 secondary):B 是現況基準,產品問題就是「比今天出貨的好嗎」,
  它必須在主實驗裡。



<!-- END VERBATIM P-04 -->

---

## P-05 — §4.4 Phase 1.5 Conditional Ablation boundary

```
M2_EFFECTIVENESS_EXPERIMENT.md @ a308bc8  lines 359–390  （逐字）
```

<!-- BEGIN VERBATIM P-05 -->

## 4.4 Phase 1.5 Conditional Ablation(不在 Phase 1 執行)

`[DECISION]` **Phase 1 不新增 `D_gate`,也不新增 source-masked C。** 兩者登記為:

```
CONDITIONAL PHASE 1.5 ABLATION
```

| 候選 arm | 形狀 | 拆解的成分 |
|---|---|---|
| **D_gate** | gate 產出 issue → 但把 challenge 改寫成「自我質疑」交給同一 target | ④ external-challenge framing |
| **source-masked C** | 給 peer chunk 與 gate-authored challenge,但不揭示來源身分 | ④ framing,同時保留 ①②③ |

`[DECISION]` **執行條件是嚴格的:**

```
只有 Phase 1 觀察到 C > D₁ 才值得執行 Phase 1.5。
若 C ≈ D₁ → 不執行 Phase 1.5。
```

`[DESIGN]` 理由:若套件整體都沒有超過 matched self-review,
拆解套件內部成分是沒有意義的 —— 沒有效果可以歸因。
先確認有東西可分,再去分它。

`[DECISION]` Phase 1.5 是**唯一**有資格評估
「pure peer information / gate diagnostic quality / source-framing effect 各自貢獻」的階段。
在它執行並產出結果之前,這三者的任何歸因都被禁止。

---

# 5. Arm Matching


<!-- END VERBATIM P-05 -->

---

## P-06 — §5.1 共享 Gate 呼叫 / §5.2 Decision Synthesis 的匹配 / §5.3 Q2

```
M2_EFFECTIVENESS_EXPERIMENT.md @ a308bc8  lines 391–470  （逐字）
```

<!-- BEGIN VERBATIM P-06 -->

## 5.1 共享 Gate 呼叫 —— 消除 C vs D 的最大變異來源

`[DESIGN]` 這是本 protocol 的核心技巧。

`§25-E1` 證明 gate 呼叫本身會產出不同的 headline decision。
若 C 與 D 各自跑一次 gate,`C − D` 就包含了兩次 gate 抽樣的差異 —— 而那個差異
**已被證實大到足以翻轉 headline**(#3=B / #4=C)。

`[FACT]` `replaySynthesis` 接受 `options.call`(型別 `typeof callProvider`)。
因此 harness 可以注入一個 dispatcher:

```
stage === 'synthesis_gate'  →  回傳「本 repetition 已錄下的 gate 回應」，不發 API
其他 stage                   →  轉發給真實 callProvider
```

`[FACT]` 這正是 diagnostics 已在用的 pass-through recording dispatcher 模式。
**因此 C 與 D 共用同一次 gate 呼叫,不需要任何 `src/` 變更。**

效果:

```
C 與 D 的 provisional answer      逐位元組相同
C 與 D 的 selectedIssue           相同（D 不使用它，只記錄）
C − D 只剩下：中間輪 + decision synthesis 的差異
```

`[DESIGN]` 每個 repetition 跑一次真實 gate,B′ 也共用它 —— B′ 就是「這次 gate 的 provisional」。

於是每個 fixture-repetition 的實際 live call 數:

```
B    : 1  （獨立的 synthesis 呼叫，prompt 不同，不能共用）
gate : 1  （B′ / C / D 三者共用)
C    : 2  （round2_worker + decision_synthesis）
D    : 2  （self_review + decision_synthesis）
────────────────────────────
合計 : 6  （而非 naive 的 1+1+3+3 = 8）
```

`[DESIGN]` 這同時省了 25% 的成本**並且**提高了統計效力。兩者不衝突。

## 5.2 Decision Synthesis 的匹配

`[DESIGN]` C 與 D 的第三段必須用**結構等價**的 prompt。

`[FACT]` C 用的是 `buildDecisionSynthesisPrompt`,其 peer-specific 段落為:

```
A cross-specialist challenge was raised and answered in a second round:
- Challenged specialist: <targetAgentId>
- Challenge raised from: <sourceRef>
- The challenge: <challenge>
- <targetAgentId>'s revised answer after the challenge: <revisedOutput>
```

`[DESIGN]` D 的對應段落應為:

```
<targetAgentId> reconsidered its own answer in a second round:
- Reconsidering specialist: <targetAgentId>
- The objection it raised against itself: <selfObjection>
- <targetAgentId>'s revised answer after that reconsideration: <revisedOutput>
```

其後的 **Decision contract 五條必須逐字相同**,包括 neutrality guard
(`Revision, recency, or agreement between specialists is not evidence`)。
`[DESIGN]` 這條在 D 裡同樣需要 —— 否則 D 的合成器會比 C 更容易採納修正版,
`C − D` 就混進了合成器偏好的差異。

## 5.3 Q2 的答案

`[DECISION]` **Q2: D 透過三件事匹配 C 並避免 extra-reasoning confound:**

1. **共用同一次 gate 呼叫** → provisional 逐位元組相同,gate 抽樣變異歸零
2. **同 target / provider / pinned model / system prompt / call count / stage 形狀**
3. **D₁ 的中間輪同樣是「回應一個具體挑戰」**,只是挑戰由自己提出 → 只剩來源不同

殘留未匹配項(必須誠實記錄,見第 19 節):C 的挑戰由 gate(合成器模型)撰寫,
D 的挑戰由 target specialist 自己撰寫。兩者的**作者不同**。這是無法消除的,

<!-- END VERBATIM P-06 -->

---

## P-07 — §10.1–§10.3 Normalization 規則與一個 stripping 解決不了的洩漏

```
M2_EFFECTIVENESS_EXPERIMENT.md @ a308bc8  lines 798–845  （逐字）
```

<!-- BEGIN VERBATIM P-07 -->

## 10.1 Normalization —— 只移除 runtime metadata

`[FACT]` `§20-E2` 已指出 banner 會洩漏 arm。
`[FACT]` 且第二十一節已記錄並測試:`finalOutput = banner + text`,
`buildOutputBanner` 是純函式,`finalOutput.slice(banner.length)` **可精確還原無標籤答案**。

`[DESIGN]` **允許移除**(全部是 runtime metadata,不是內容):

```
evidence banner        （由 buildOutputBanner 產生的前綴，逐字切除，不改動後續文字）
collaboration metadata （本來就在獨立欄位，不在 finalOutput 裡）
arm 名稱 / provider / model 名稱
runtime timing / call count / token count
檔名、路徑、run id
```

`[DESIGN]` **明令禁止**(這些會改變被評估的內容):

```
❌ 改寫答案            ❌ 縮短答案
❌ 修正文法            ❌ 移除 caveat / 不確定性敘述
❌ 統一格式或標題      ❌ 「正規化」推理
❌ 截斷到相同字數
```

`[DESIGN]` 分界線的判準:**移除的東西是否由 runtime 產生而非由模型寫出?**
banner 是 runtime 產生的 → 可移。答案裡「我無法驗證這個數字」是模型寫的 → **不可移**。

## 10.2 Normalization 必須是 deterministic 且可重算

`[DESIGN]` normalization 是純函式,輸入 raw artifact,輸出 normalized answer,
兩者都 commit,`verify.mjs` 能重跑並比對 hash。
**任何需要人為判斷的「清理」都不允許進入這一層。**

## 10.3 ⚠️ 一個 stripping 解決不了的洩漏

`[SIGNAL]` 我在 Replay #4 的 artifact 上做了實測掃描,結果與直覺相反:

| 文本 | 含 arm 辨識語句(挑戰/專家/第二輪/另一位…) |
|---|---|
| arm C 的 **final answer**(decision synthesis 產出) | **0 處** |
| arm B′ 的 **provisional**(gate 產出) | **2 處**(「驗證品牌方的核心主張」「一旦數據證實品牌方主張」) |

`[SIGNAL]` 也就是說:**洩漏風險不是單向的,而且不在我們預期的那一邊。**
gate 的 provisional 反而更常提到「品牌方」「營運方」這類角色詞。

`[DESIGN]` 這類洩漏**在答案內容裡**,依第 10.1 節不得編輯。
因此正確處置是**量測它,而不是修掉它**:

<!-- END VERBATIM P-07 -->

---

## P-08 — §11.4 Gold Issues 的隔離

```
M2_EFFECTIVENESS_EXPERIMENT.md @ a308bc8  lines 978–1010  （逐字）
```

<!-- BEGIN VERBATIM P-08 -->

## 11.4 Gold Issues 的隔離

`[DECISION]` **採用 Gold Issues,但必須嚴格隔離。**

`[DESIGN]` 隔離規則:

```
GI-1  gold-issues.json 在**任何 arm 執行之前**寫定並 hash。
GI-2  它**絕不**進入任何 runtime prompt。Gate 看不到、R2 看不到、
      self-review 看不到、decision synthesis 看不到。
GI-3  它由「只讀 Round 1 輸出與原題」的人／模型撰寫，
      撰寫者**不得**看過任何 arm 的答案。
GI-4  撰寫完成後 commit + hash；事後新增 gold issue 一律無效。
GI-5  gold issues 只交給 evaluator，不交給 runtime harness。
      建議在檔案系統層分離：fixtures/ 進 runtime，
      gold-issues 另放 evaluation/ 並由不同的載入路徑讀取。
```

`[DESIGN]` GI-5 不只是紀律,是**結構性**防護:若 gold issues 與 snapshot 放在同一個
被 runtime 載入的目錄,總有一天會有人把整個目錄塞進 prompt。

## 11.5 Q7 的答案

`[DECISION]` **Q7: 最少需要「四個評分維度 + 一個全局偏好 + 一層客觀的 Gold Issue Coverage」。**
四維為 contradiction handling、critical assumption & falsifier、unsupported-claim control、
checkable commitment quality。剔除 decision correctness(無 ground truth)、
calibration(judge 不可靠)、internal consistency(無鑑別力),
其餘併入以避免相關維度重複計分。

---

# 12. Decision-Structure Metrics


<!-- END VERBATIM P-08 -->

---

## P-09 — §14 Negative Controls —— NC-1 / NC-2 / NC-3 的 protocol 定義

```
M2_EFFECTIVENESS_EXPERIMENT.md @ a308bc8  lines 1174–1190  （逐字）
```

<!-- BEGIN VERBATIM P-09 -->

# 14. Negative Controls

`[DESIGN]` 除 13.5 的 negative-control fixture 外,protocol 還需要三個 sanity control:

| Control | 內容 | 預期 | 失敗的意義 |
|---|---|---|---|
| **NC-1 Disabled parity** | 每次 pilot 執行前跑一次既有的 16 組 control capture | `sha256 f50a7b2e…` | runtime 漂移,實驗全部作廢 |
| **NC-2 Snapshot 不變** | 每個 repetition 後重算 snapshot hash | 與 manifest 相同 | harness 汙染了 frozen 輸入 |
| **NC-3 Self-review 洩漏檢查** | 掃描 D 的 self_review prompt | 不含 peer chunk / challenge / sourceRef | D 被汙染成 C,`C − D` 歸零且無法察覺 |

`[DESIGN]` **NC-3 是自動化的、逐次執行的斷言,不是人工審閱。**
它保護的是本實驗最核心的識別假設,不能靠自律。
建議實作成 harness 的硬性 assert:D 的 prompt 必須不包含 peer chunk 文字的任何
連續 20 字元子字串,也不包含 challenge 文字的任何連續 20 字元子字串。

---


<!-- END VERBATIM P-09 -->

---

## P-10 — §19 Bias / Confound Register —— 含 X11 / X16 / X17

```
M2_EFFECTIVENESS_EXPERIMENT.md @ a308bc8  lines 1494–1525  （逐字）
```

<!-- BEGIN VERBATIM P-10 -->

# 19. Bias / Confound Register

`[DESIGN]` 所有已知威脅集中列管。**未列入此表的威脅視為未被考慮過**,
新發現者必須追加,不得靜默處理。

| ID | 威脅 | 嚴重度 | 處置 | 殘留風險 |
|---|---|---|---|---|
| **X1** | Gate 附錄 confound(`C − B` 含附錄效果) | 高 | 加入 arm B′ | 無 |
| **X2** | 第二次 synthesis confound(`C` 多一次合成) | 高 | 加入 arm D,stage 形狀匹配 | 合成器 prompt 仍有微小結構差異(5.2 節已逐字對齊 contract) |
| **X3** | 模型隨機性(`§25-E1`) | 高 | 多 repetition + 共用 gate + pin temperature | temperature 可能不被支援(7.4 節 `[OPEN]`) |
| **X4** | Trigger selection bias | 高 | 所有 arm 共用 frozen Round 1;未觸發不剔除 | 無 |
| **X5** | Fixture cherry-picking | 高 | 執行前凍結 + F4 與 gate 無關 + negative control | fixture 數少,archetype 覆蓋有限 |
| **X6** | Judge verbosity bias | 中高 | 可檢核承諾判準 + density + 長度條件化子分析 | 無法完全消除 |
| **X7** | Judge order bias | 中高 | pilot 全 counterbalance;正式研究隨機 + 20% 重複稽核 | 見 20.3 |
| **X8** | Judge model-family affinity | 中 | 兩個不同家族的 judge;主 judge 與合成器不同家族 | judge 池本身有限 |
| **X9** | Arm leakage(答案內容自曝) | 中 | Leakage Audit 量測(不得編輯內容) | **已 `[SIGNAL]` 觀察到,無法根除** |
| **X10** | Model drift / preview 通道 | 中 | 交錯執行 + 2 小時時間窗 + 逐呼叫 `resolvedModel` 斷言 | 服務端版本不可得 |
| **X11** | D 被 peer 資訊汙染 | **極高** | NC-3 自動斷言(20 字元子字串檢查) | 主題層級的間接洩漏難以自動偵測 |
| **X12** | Gold issue 洩漏進 runtime | 高 | GI-1..GI-5,檔案系統層分離 | 需人為紀律維持 |
| **X13** | Arithmetic 變異淹沒 peer 效果 | 中高 | F7 排除算術重的 fixture(第 17 節下方) | 見 X13 說明 |
| **X14** | Provider 與 fixture 共線 | 中 | Option 3′:合成器固定,provider 只在 target 輪換,且 C/D 配對內為常數 | 不足以宣稱泛化(已寫入 claims ladder) |
| **X15** | 評估者疲勞 / 前後不一致 | 低中 | 每個 judge session 的配對數設上限;重複稽核偵測漂移 | — |
| **X16** | **Decision Synthesis source framing** —— decision synthesis 知道修正來自「跨專家挑戰」,可能因此偏好採納 | — | **Phase 1 treatment component**(§4.1.1 成分 ④) | **限制 causal claim 至 peer-challenge package**;拆解需 §4.4 Phase 1.5 |
| **X17** | **Challenge-author capability difference** —— C 的挑戰由 gate 模型撰寫,D₁ 的由 target 自己撰寫,兩者能力不同 | — | **Phase 1 treatment component**(§4.1.1 成分 ②③) | **Phase 1 不控制**;若 `C > D₁` 則觸發 §4.4 conditional Phase 1.5 ablation |

`[DESIGN]` **X11 是本實驗最致命的威脅。** 若 D 拿到了 peer 的判斷,
`C − D` 會趨近於零,而報告會說「peer information 沒有價值」——
一個**由設計缺陷造成的、方向確定的錯誤結論**。
NC-3 的自動斷言不可省略,且應在每次 D 執行**之前**跑,失敗即中止該 repetition。

---


<!-- END VERBATIM P-10 -->

---

## P-11 — §22 Claims Ladder(current)

```
M2_EFFECTIVENESS_EXPERIMENT.md @ a308bc8  lines 1636–1682  （逐字）
```

<!-- BEGIN VERBATIM P-11 -->

# 22. Claims Ladder

`[DECISION]` 每一層明確規定**該層證據允許說什麼、不允許說什麼**。

| Level | 內容 | 狀態 | 允許宣稱 | **不允許宣稱** |
|---|---|---|---|---|
| **L0** | Mechanism runs | ✅ **已達成**(Replay #4) | 「完整機制在真實 provider call 下跑通一次」 | 任何品質相關的話 |
| **L1** | Triggered outputs differ | 未達成 | 「C 的輸出與 B/B′ 不同」 | 「不同 = 更好」 |
| **L2-P** | **Product Increment** `C > B` | 未達成 | 「完整 M2-A candidate 相對 Existing Orchestrator 有產品增量」 | 「增量來自第二輪」(未扣掉附錄效果) |
| **L2-M** | **Mechanism Increment** `C > B′` | 未達成 | 「第二輪 peer-challenge package 相對 Gate-only 有增量」 | 「增量來自 peer」(還沒排除 D₁) |
| **L3** | `C > D₁` | 未達成 | 「**Targeted Peer-Challenge Package** 相對 matched self-review 有 incremental value」 | ⛔ 「**pure peer information itself has incremental value**」<br>⛔ 多模型優於單模型 |
| **L3.5** | `C > D₁` 且 Gate precision 可接受 | 未達成 | 「機制在該觸發時觸發,且觸發時有用」 | 「應該預設開啟」 |
| **L4** | 跨 task type / provider 一致 | 未達成 | 「效果在多種衝突類型與 provider 上重現」 | 「對所有任務有效」 |
| **L5** | Cost / latency tradeoff 可接受 | **被 Step 8 阻擋** | 「增量成本相對增量品質是划算的」 | 任何美元數字(無 pricing registry) |
| **L6** | Productionization 決策 | 未達成 | 「應以 X 條件預設開啟」 | — |

`[DESIGN]` **目前所有公開陳述必須停在 L0。**

`[DECISION]` **L2-P 與 L2-M 不是二選一,而是兩個不同層次的問題,兩者都要報告:**

```
L2-P  C > B    產品問題：比今天出貨的好嗎？（含附錄效果，因為附錄也會一起出貨）
L2-M  C > B′   機制問題：第二輪本身有效嗎？（扣掉附錄效果）
```

`[DESIGN]` 兩者可能給出不同方向。若 `C > B` 但 `C ≈ B′`,
代表增量幾乎全部來自 gate 附錄,而不是第二輪 —— 那會指向一個
**便宜得多**的產品形狀(只加附錄,不跑第二輪)。這正是分開報告的價值。

`[DECISION]` 三個特別容易被跨越的界線:

1. **L2-M → L3 不可跳。** `C > B′` 很可能會成立(多一輪推理通常會讓答案更完整),
   但那不支持任何關於 peer 的宣稱。**這是本實驗最可能被誤讀的地方。**
2. **L3 ≠ 「多模型優於單模型」。** D₁ 用的是同一個 target model。
   後者需要 arm A,而 arm A 不在 Phase 1。
3. **⛔ L3 ≠ 「pure peer information 有增量價值」。**
   L3 支持的是**整個 Targeted Peer-Challenge Package**(§4.1.1 的 ①–⑤)的增量。
   要把 ①–④ 拆開歸因,**只有 §4.4 的 Phase 1.5 ablation 有資格**。
   在 Phase 1.5 執行前,這個宣稱一律禁止。

## 22.1 Q16 的答案

`[DECISION]` **Q16: 見上表。核心規則是
「L2 的證據不得用來說 L3 的話」與「L3 不等於多模型優越性」。**

---


<!-- END VERBATIM P-11 -->

---

## P-12 — §23 Minimal Required Code Changes —— src ZERO-CHANGE boundary

```
M2_EFFECTIVENESS_EXPERIMENT.md @ a308bc8  lines 1683–1767  （逐字）
```

<!-- BEGIN VERBATIM P-12 -->

# 23. Minimal Required Code Changes

## 23.1 令人意外的結論:核心不需要改 `src/`

`[FACT]` 我逐項查證後的結果:

| 需求 | 是否需要改 `src/` | 依據 |
|---|---|---|
| arm B | ❌ 不需要 | `replaySynthesis(snapshot, { synthesizer })`,`collaboration` 不傳 |
| arm B′ | ❌ 不需要 | `{ enabled: true, disableRound2: true }`,既有分支,保留 `selectedIssue` |
| arm C | ❌ 不需要 | `{ enabled: true }` |
| **C 與 D 共用 gate 呼叫** | ❌ **不需要** | `ReplayOptions.call` 可注入;stage 已明確標記,可依 `synthesis_gate` 回放錄音 |
| **pin 所有 model** | ❌ **不需要** | `Worker.model` 與 `synthesizer.model` 明確設定即可;`result.model` 可逐呼叫斷言 |
| **pin temperature** | ❌ **不需要** | 注入的 dispatcher 轉發 `{ ...options, temperature }`;三個 adapter 都支援 |
| Round 1 凍結 | ❌ 不需要 | `toRound1Snapshot()` 已存在 |
| 盲評去 banner | ❌ 不需要 | `finalOutput.slice(banner.length)`,已有測試保證精確還原 |
| **arm D** | ⚠️ **需要新程式,但可在 `src/` 之外** | 見 23.2 |

`[DESIGN]` 這是好消息:**`§25-E2`(model pinning)是 protocol 缺陷,不是 code 缺陷**,
不需要動 production code 就能修好。

## 23.2 arm D 需要什麼

`[DESIGN]` D 的三個 stage 中,只有中間那段沒有現成路徑。兩個選項:

| | 選項 1:改 `src/`(加 self-review 模式) | **選項 2:harness-only(推薦)** |
|---|---|---|
| 位置 | `src/agents/collaboration.ts` + orchestrator | `experiments/m2b/harness/` |
| 風險 | 動到 rev.20 已驗收的 production code;需重跑並重新宣稱 212 | 不碰 production code |
| 缺點 | 違反本輪禁令 | D 的 prompt builder 是 harness 程式,可能與 C 漂移 |
| 緩解 | — | D 的 decision synthesis 以 C 的 `buildDecisionSynthesisPrompt` 為**逐字模板**,並加自動比對測試 |

`[DECISION]` **推薦選項 2。**
arm D 是**控制組,不是候選功能** —— 它不需要、也不應該進入 production code path。
把 self-review 寫進 `src/` 等於在 runtime 裡新增一個沒人要出貨的功能。

`[DESIGN]` harness 需要的三個新函式(**本輪只提案,不實作**):

```
buildSelfReviewPrompt({ task, mission, previousOutput })
    → 與 buildRound2Prompt 相同的骨架，但沒有 peer chunk、沒有 challenge，
      改為要求 target 自行提出對自己最強的反對意見並回答

buildSelfReviewDecisionPrompt({ task, specialistBlock, degradedNote, selfObjection, revisedOutput })
    → 與 buildDecisionSynthesisPrompt 結構等價
    → Decision contract 五條逐字相同（含 neutrality guard）

assertNoPeerLeakage(prompt, peerChunkText, challengeText)
    → NC-3：任何 20 字元連續子字串命中即拋錯
```

`[FACT]` `buildDecisionSynthesisPrompt` 目前的簽章是
`{ task, specialistBlock, degradedNote, issue: CollaborationIssue, revisedOutput }`。
`issue` 是 peer-specific 的,所以 D 無法直接重用它 ——
這正是需要一個平行 builder 的原因,而不是設計疏漏。

## 23.3 其他需要的 harness 程式(全部在 `src/` 之外)

`[DESIGN]`

```
recording dispatcher      錄下 gate 回應供 B′/C/D 共用；pin temperature；斷言 resolvedModel
normalizer                deterministic 去 banner / 去 metadata，可重跑
pair builder              產生去識別化的 blind pairs + 隱藏的 assignments
verify.mjs                以 production function 重推所有 artifact claim
control runner            NC-1 的 16 組 disabled control（可直接沿用既有 control.mjs）
```

## 23.4 Q17 的答案

`[DECISION]` **Q17: 真正開始 live experiment 前,`src/` 需要的變更是「零」。
唯一需要新寫的是 arm D 的兩個 prompt builder、一個洩漏斷言,以及 harness 工具 ——
全部位於 `experiments/` 之下,不進 production code path。**
`[DECISION]` ✅ **GPT Architecture Review 第 9 項已批准此結論,並定為下一輪的硬性約束:**

```
harness implementation 維持 src/ ZERO-CHANGE 原則
arm D₁ 與所有實驗工具一律放 experiments/m2b/
⛔ 不得修改 production src/
```

`[DESIGN]` **本輪不實作其中任何一項。**

---


<!-- END VERBATIM P-12 -->

---

## P-13 — §24 Explicit Non-Goals / §24.1 hygiene 處置(含 E4 封印規則)

```
M2_EFFECTIVENESS_EXPERIMENT.md @ a308bc8  lines 1768–1815  （逐字）
```

<!-- BEGIN VERBATIM P-13 -->

# 24. Explicit Non-Goals

`[DESIGN]` Phase 1 **明確不回答**以下問題。任何據此推論的宣稱都無效:

```
✗ M2-A 是否應該出貨                    （只回答「什麼證據才足以支持出貨」）
✗ 多模型是否優於單模型                  （需要 arm A，不在 Phase 1）
✗ 有外部證據時 peer challenge 是否更有價值（EP-2 全關 retrieval）
✗ NORMAL 是否應啟用 collaboration       （fixture 全為 DEEP）
✗ chunk granularity 是否最佳            （chunker 為 frozen parameter）
✗ Gate prompt 的最佳措辭                （本輪不調 prompt；只量測 precision）
✗ 跨 provider 泛化                      （每個 provider 僅 1 個 fixture）
✗ token / 美元成本                      （Step 8 未實作）
✗ latency 分布 / SLA                    （只有觀察值，不構成分布）
✗ DEGRADED 執行下的協作行為              （gate 本就排除 DEGRADED）
```

## 24.1 rev.21 三項 hygiene 的處置

`[DESIGN]` 依指令書第三十五節,本輪**只記錄,不修改**:

| ID | 內容 | 本輪處置 | 未來處置 |
|---|---|---|---|
| **D1** | 兩個測試名稱超出實際 assert 範圍 | 記錄 | 下次修改 `test-collaboration.mjs` 時順帶改名為 `…prompt states…` 形式 |
| **D2** | byte-equivalence 測試名稱實為同 build parity | 記錄 | 同上 |
| **E4** | `noRound2Leak` 在 replay path 恆真 | 記錄 | ⚠️ **絕不回頭改 Replay #4** |

`[FACT]` **E4 特別說明:`harness.mjs` 在 `controlled-replay-4/hashes.json` 的封印範圍內
(我確認過該檔的 12 個 key 包含 `harness.mjs`),`verify.mjs` 會逐檔比對。
原地改名會直接破壞封印,使 Replay #4 的既有證據失效。**

`[DESIGN]` 正確作法:**M2-B 的新 harness 從一開始就用真正可失敗的不變式**。
例如將 `noRound2Leak` 改寫成:

```
對每個 arm，以 frozen Round 1 重算 report，
斷言 result.report 與該重算值逐欄相同
→ 這在 Round 2 洩漏時「會」失敗，而不是恆真
```

`[DESIGN]` 這條已經隱含在 NC-2 裡。**新 harness 不繼承舊 harness 的弱代理。**

## 24.2 一個 HANDOFF 尚未記錄的既有發現

`[FACT]` Diagnostic #1 的 `business_strategist` 輸出含**系統性算術錯誤**,
可由 committed artifact 直接重算(`diagnostics/m2a-live/run1-not-exercised/artifact.json`,
`calls[1].responseText`):


<!-- END VERBATIM P-13 -->

---

## P-14 — §25.3 執行順序 —— GPT HARNESS REVIEW gate 與 live not authorized

```
M2_EFFECTIVENESS_EXPERIMENT.md @ a308bc8  lines 1876–1920  （逐字）
```

<!-- BEGIN VERBATIM P-14 -->

   拿掉它,`C > B` 在因果上無法解釋。
2. **D 用 D₁ 而非 D₀** —— 研究問題是「peer 資訊的增量價值」;
   用通用 self-review 當控制組,會讓「有具體標的」這件事偽裝成 peer 效果。
3. **C 與 D 共用 gate 呼叫** —— 同時**降低成本**與**提高效力**。
   `§25-E1` 證明 gate 抽樣變異大到能翻轉 headline;把它從主估計量裡消掉是免費的。

## 25.3 執行順序

`[DESIGN]`

`[DECISION]` GPT Architecture Review 第 8 項已重寫流程,
在 harness 與 live 之間**插入一道新的審查關卡**:

```
✅ ①  Architecture Review                  已完成（ACCEPT WITH CORRECTIONS）
✅ ②  Protocol v0.2                        本輪
──────────────────────────────────────────────  ↓ 以下尚未授權 ↓
   ③  Freeze fixtures / gold issues / conflict labels
          ★ 必須全部早於任何 arm 執行 ★
   ④  Implement harness only               （§23，src/ zero-change）
   ⑤  Offline + structural verification    （NC-1 / NC-2 / NC-3，零 live call）
   ⑥  ★ GPT HARNESS REVIEW ★              ← v0.2 新增的關卡
──────────────────────────────────────────────  ↓ 只有通過 ⑥ 才被授權 ↓
   ⑦  temperature 支援性 probe
   ⑧  120-call pilot
   ⑨  先評 judge 信度、leakage、變異；通過後才解讀 arm 比較
   ⑩  依觀察到的變異決定正式 N，回到 Architecture Review
```

`[DECISION]` ⚠️ **本輪(Protocol v0.2)明確不做 ③–⑩ 的任何一項。**
特別是:**不跑 temperature probe、不跑 120 calls、不呼叫任何 live API、不開始 harness implementation。**

`[DESIGN]` 第 ⑨ 步的順序是紀律性的:**先確認工具可信,再看結果。**
反過來做,就會在工具不可信時看見自己想看的東西。

`[DESIGN]` 第 ⑥ 步是 v0.2 新增的。它的價值在於:harness 一旦寫錯 ——
尤其 §19 的 **X11(D₁ 被 peer 資訊汙染)** —— pilot 會產出**方向確定的錯誤結論**,
而且事後極難察覺。**把 harness 送審一次,比事後重跑 120 次呼叫便宜得多。**

## 25.4 本輪未做的事

```
未修改 src/            未修改 Gate Prompt      未移除 strengthening
未新增 only            未修改 Planner          未開 NORMAL
未修改 Chunker         未 pin production router 未做 Step 8

<!-- END VERBATIM P-14 -->

---

---

# PART 3 — HANDOFF rev.24 節錄(逐字)

```
commit : 2d702ba88a3ea8a39188132f72bab1c2e1ca454d
sha256 : 0bf08d9cad075ec0835b5088011f65a0ae47daf6e6b6afcd2e9945c8b5c20ff7
```

> **Included:** 交接狀態表與本輪 harness 的 claim boundary。
> **Excluded:** Step 1–7 施工史與 rev.1–23 的逐版說明 —— 與本輪 harness review 無直接關係。
> 完整檔案 2792 行 / 175649 bytes。

---

## D-01 — 交接狀態表(rev.24)

```
HANDOFF.md @ 2d702ba  lines 1–27  （逐字）
```

<!-- BEGIN VERBATIM D-01 -->

# ai-collab-mcp — Progress Report (2026-09-06, rev. 24)

> ## 交接狀態
>
> | 項目 | 狀態 |
> |---|---|
> | Step 1–5、5.1、6、6.1 | ✅ 已完成,63 項離線測試全過 |
> | **Step 6.1 Worker Context Propagation** | **DONE —— worker input contract 已落地** |
> | **Post-6.1 SIMPLE live regression** | **DONE —— rev.7/8 共 3 種題型各 n=1,當時三段式皆完整執行** |
> | **Step 7 V1 Complexity Router** | **CODE + RUNTIME ACCEPTED —— 有界 SIMPLE direct delivery** |
> | **Step 7.1 E2E Runtime Acceptance** | **DONE —— Test A PASS / Test B PASS,詳見第十八節** |
> | **Milestone 2 scope analysis** | **DONE —— 見 `MILESTONE2_SCOPE_ANALYSIS.md`、第二十節** |
> | **Experimental Milestone 2-A Prototype** | **STOPPED / AWAITING ARCHITECTURE REVIEW / DEFAULT OFF —— 詳見第二十四節** |
> | **M2-A Diagnostic Live #1 / #2** | **兩次皆 NOT EXERCISED —— 被兩個不同條件擋在 gate 之前,詳見第二十二節** |
> | **M2-A Controlled Replay #3** | **NOT EXERCISED —— gate 首次真正執行,但認出分歧後選擇在答案內解決,未輸出區塊,詳見第二十三節** |
> | **M2-A Controlled Replay #4** | **FULL MECHANISM RUNTIME PASS —— 一次自然 valid issue → R2 → Decision Synthesis,不代表品質或產品價值已驗證** |
> | **rev.20 Independent Code Review** | **ACCEPT WITH DOCUMENTATION CORRECTION —— 無 runtime defect;3 項文件/命名修正 + 1 項規格 concern 待 review,詳見第二十五節** |
> | **M2-B Protocol** | **ARCHITECTURE ACCEPTED / HARNESS IMPLEMENTATION NEXT / LIVE PILOT NOT AUTHORIZED —— `M2_EFFECTIVENESS_EXPERIMENT.md` v0.2 @ `a308bc8`** |
> | **M2-B Harness** | **IMPLEMENTED / AWAITING GPT HARNESS REVIEW / NO LIVE AUTHORIZATION —— `experiments/m2b/`,65 項離線測試,`src/` diff 為空** |
> | **Claude Code handoff** | **EXECUTED —— deliverable 已產出,等 architecture review** |
> | **目前離線測試** | **212 項全過 = rev.19 的 208 + Gate semantics 新增 4** |
> | **Step 8 Scope Analysis** | **DONE —— runtime usage / pricing / cost / reporting 已分層,詳見第十七節** |
> | **Step 8 Implementation** | **DEFERRED —— Milestone 2 驗證後再回來** |
> | 未完成的程式修改 | **無** |
>
> **Experimental Milestone 2-A 已完成本輪限定工程,現在 STOPPED / AWAITING ARCHITECTURE REVIEW,default OFF。** 使用者批准 Gate eligibility 由 post-synthesis unresolved conflict 改成 pre-synthesis material disagreement;唯一一次 Replay #4 使用與 #3 byte-identical 的 fixture,自然跑通 valid issue、sourceRef、Targeted R2 與 Decision Synthesis。212 項離線測試通過,既有 assertions 未放寬,16 組修改前/後 control capture byte-identical。這是機制驗證,尚未執行品質比較或 live A/B/C/D。
>

<!-- END VERBATIM D-01 -->

---

## D-02 — rev.24 改了什麼 —— harness 的 claim boundary

```
HANDOFF.md @ 2d702ba  lines 29–68  （逐字）
```

<!-- BEGIN VERBATIM D-02 -->


## rev. 24 改了什麼(M2-B Harness —— experiments/ only,src/ zero-change)

**`src/` diff 為空。production 離線測試仍是 212 項全過,Replay #4 封印仍 VERIFIED。**

1. **新增 `experiments/m2b/`** —— B / B′ / C / D₁ 四個 arm runner、recording dispatcher、
   D₁ 的兩個 harness-only prompt builder、NC-2 / NC-3 guard、normalizer、blind pair builder、
   manifest validator、`verify.mjs`(12 項 recomputation)。**65 項離線測試,0 失敗。**
2. **結構上無法 live call** —— `experiments/m2b/` 從未 import `callProvider`,
   也從未讀取任何 API key;dispatcher 由呼叫端注入,離線測試注入 deterministic stub。
3. **call accounting = 6,不是 8** —— B 1 + 共用 gate 1 + C 2 + D₁ 2。
   共用 gate 首先是為了把 gate 抽樣變異移出 `C − D₁`,省呼叫是副作用。
4. **NC-2 取代 Replay #4 的弱代理** —— 以 production `buildRunReport` 從 frozen Round 1
   重算 report 再逐欄比對,**有 negative test 證明它會失敗**。不再使用 `noRound2Leak`。
5. **兩個實作時才浮現的設計問題已記錄,未自行拍板** —— H-01(NC-3 不能套用在 decision
   prompt 的 peer chunk 上,那是 evidence parity)與 H-02(protocol §14 的 20 字元窗在
   decision prompt 上會誤判)。**H-02 是對 protocol 明訂數字的偏離,列出送審。**
   詳見 `experiments/m2b/README.md`。
6. **Claim boundary(必須維持)** ——

   ```
   ✅ harness 已實作，離線與結構驗證通過
   ❌ 尚未經 GPT Harness Review
   ❌ 尚未 freeze 實驗 fixtures / gold issues / conflict labels
   ❌ 尚未 temperature probe
   ❌ 尚未 live pilot（NO LIVE AUTHORIZATION）
   ❌ 尚未有任何 effectiveness 證據
   ```

   **不得寫成 VALIDATED / EFFECTIVE / PILOT READY。**
7. **未動** —— `src/`、production prompts、provider adapters、planner、Gate semantics、
   chunker、retrieval、Step 8、Replay #4 sealed artifacts、既有 M2-A production tests 的語意。
   未 merge main,未跑任何 live call。

---

## rev. 23 改了什麼(M2-B Architecture Review 結果 + 一項既有事實補記 —— 無 code)

**rev.23 = rev.22 的 code + 狀態更新 + 一段 factual history。`src/` 一個 byte 都沒動,離線測試仍是 212 項。**


<!-- END VERBATIM D-02 -->

---

# PACKET END

```
packetVersion  : GEMINI-M2B-PACKET-2
HEAD           : 2d702ba88a3ea8a39188132f72bab1c2e1ca454d
harness commit : 2d702ba88a3ea8a39188132f72bab1c2e1ca454d
protocol       : a308bc8eef035b1e3f0e1a5c415d52024cf503df  (M2B-PROTOCOL-0.2)
HANDOFF        : rev. 24
```

**Packet immutability:** 本 packet 一經 commit 即為該次 Gemini review 的 frozen input。
review 完成後不回頭修改。source 若再改版,建立 `GEMINI-M2B-PACKET-3`,不覆寫。

**下一步:**

```
Gemini  → Independent Methodology Analysis（本 packet 為 frozen input）
User    → 將 packet + Gemini review 一併交回 GPT
GPT     → GPT HARNESS REVIEW

在 GPT 明確批准前：
  NO temperature probe    NO final fixture freeze
  NO provider call        NO 120-call pilot
  NO productionization    NO 下一個 milestone
```
