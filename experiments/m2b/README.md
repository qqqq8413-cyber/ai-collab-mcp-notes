# M2-B Experiment Harness

```
Status        REVISED / AWAITING FINAL GPT HARNESS REVIEW / NO LIVE AUTHORIZATION
Protocol      M2B-PROTOCOL-0.2  (M2_EFFECTIVENESS_EXPERIMENT.md @ a308bc8)
Offline tests 110 passed / 0 failed
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

**必須分開兩種等級的宣稱**(Harness Review H-02 分類修正):

```
PRIMARY STRUCTURAL CONTROLS  ← correctness 靠這些
  1. buildSelfReviewPrompt 的函式簽章不接受 peer chunk / challenge / sourceRef
     —— 沒有任何參數可以讓它們進來
  2. sourceRef      整串精確拒絕
  3. challengeText  整串精確拒絕
  4. chunkText      整串精確拒絕（middle round）
  5. guard 在 provider call 之前執行 —— 被汙染的 D₁ 一毛錢都不花

SECONDARY DIAGNOSTIC HEURISTIC  ← 只是額外的 lexical 偵測器
  連續字元窗比對（空白正規化後）：middle round 20、decision prompt 60

RESIDUAL RISK  ← 未解決，且不宣稱已解決
  paraphrase · topic steering · semantic leakage · concept-level leakage
```

⚠️ **字元窗不是 correctness invariant,不是 structural guarantee,
也不構成「沒有洩漏」的證明。** 沒有任何窗長能關上 residual gap ——
所以窗長是 diagnostic 內部的調參,不是 correctness 所依賴的東西。
`notChecked` 欄位在每次回傳裡明寫殘留項;protocol §19 X11 記錄該風險,且**維持記錄**。

## ⚠️ 兩個實作時才浮現的設計問題(送交 Harness Review)

### H-01 NC-3 不能套用在 decision prompt 的 peer chunk 上

peer chunk 是 Round 1 的一個段落,而**兩個 arm 的 decision synthesis prompt 都含
完整 Round 1 specialist block** —— arm C 的也一樣。所以 peer chunk 必然出現在那裡,
而那是 **evidence parity,不是 leakage**:兩個合成器必須看到相同的 Round 1 語料,
否則 `C − D₁` 量到的是「各自看到什麼」而不是 treatment。

處置:decision prompt 用 `allowPeerChunk: true`,只檢 challenge 與 sourceRef
(兩者在 Round 1 裡都不存在)。**這不是放寬 guard。不這樣做會禁止 D₁ 帶有與 C 相同的
specialist block,直接破壞實驗賴以成立的 parity。**

### H-02 substring heuristic 的定位(**已由 Harness Review 裁決**)

**Verdict:ACCEPTED WITH CLASSIFICATION CORRECTION。**

發現本身:gate 撰寫的 challenge 是**針對某個 Round 1 段落寫的**,必然重用該段落詞彙。
於是合法共存的 Round 1 block 會觸發 20 字元匹配,而那不是洩漏。
synthetic fixture 可重現 —— `" the same senior edi"` 同時出現在 challenge 與 strategist 的答案裡。

**裁決不是「20 還是 60 比較好」,而是把字元窗降級。**
20/60 的行為保留,但它是 **Secondary Diagnostic Heuristic**,
不得再被描述為 correctness invariant / structural guarantee / proof of no leakage。
真正較強的控制是上一節列的五項 primary structural controls。

**本輪不再討論窗長,不改 60,不新增 semantic classifier,不新增 leakage judge model。**

## 每個 negative test 如何證明 invariant 真的會失敗

每條 guard 都有一個「故意破壞後真的 fail」的測試,且斷言**錯誤型別**而不只是「有丟例外」:

| Invariant | 破壞方式 | 期望型別 |
|---|---|---|
| model pin | stub 回傳不同 model | `ModelPinViolation` |
| model pin | 拿掉某 stage 的 pin | `Error`(manifest 不完整) |
| retrieval all-off | stub 在某 stage 附上 retrieval | `RetrievalPolicyViolation` |
| NC-2 | 竄改 evidenceLabel / RunStatus / banner / call 的 retrieval | `EvidenceInvariantViolation` |
| NC-3 primary | 整串 sourceRef / challenge / chunk 移植(兩種模式都測) | `PeerLeakageDetected` |
| NC-3 diagnostic | 字元窗命中 | `PeerLeakageDetected`(診斷性,非 correctness) |
| normalization | 移除一句 caveat 後宣稱是 normalized 結果 | `deterministic === false` |
| normalization | 用錯誤 banner 呼叫 | `NormalizationError` |
| blind pairs | pair 上掛 arm / resolvedModel | `PairLeakageDetected` |
| manifest | **15 個 mandatory field 逐一移除** | `ManifestInvalid`,且錯誤訊息點名該欄位 |
| manifest | pin 缺 requestedModel | `ManifestInvalid` |
| manifest | 竄改 manifestSha256 對應內容 | `ManifestInvalid` |
| H-05 manifest | 缺 / 格式錯 / 非 UTC offset / 不可能的時刻 / 數字 | `ManifestInvalid` |
| H-05 call | live call 缺 startedAt、格式錯、早於 run 起始、ms 為負 | 對應 verifier check FAIL |
| H-05 replay | 把 replayed gate 偽裝成 live call 時間 | 對應 verifier check FAIL |
| verifier | 竄改 call 數 / pin / retrieval / provisional / normalized / label / D₁ prompt / pair / manifest / snapshot hash / neutrality guard / selectedIssue | 對應那一項 `FAIL` |

另有一條**行為性**的:D₁ 的 prompt 被汙染時,`runArmD1` 在**發出任何 provider 呼叫之前**
就丟出例外 —— 測試比對 stub 的呼叫數不變。花錢之後才記一條 warning 不算 control。

## H-03 no-trigger path 是一等公民,不是例外

protocol 明訂:gate 未觸發**不是 invalid run,不得剔除**,它是有效 observation。
因此 harness 與 verifier 支援兩種合法形狀:

```
TRIGGERED                                  NOT TRIGGERED
  B            synthesis            1        B            synthesis        1
  shared gate  synthesis_gate       1        shared gate  synthesis_gate   1
  C            round2_worker        }        C            （replayed gate only）
               decision_synthesis   } 2      D₁           skipped
  D₁           self_review          }                     reason = no_selected_issue
               decision_synthesis   } 2      ───────────────────────────────
  ────────────────────────────────           total billable                2
  total billable                6            C.finalOutput == B′.finalOutput
                                             無 D₁ normalized answer、無 D₁ pair
```

**verifier 不讀 artifact 自報的 trigger 狀態。** 它用 production 的
`parseGateOutput` / `validateIssues` / `selectIssue` 從 committed 的 gate response
重推 selectedIssue,再決定該有的 call topology。

no-trigger 時 D₁ 沒有 report/finalOutput —— 那不是 evidence failure。
verifier 改為**斷言它什麼都沒產生**(無 call、無 finalOutput、無 normalized、無 report、
reason 正確),而不是找不到就放過。

不為了湊固定 pair 數建立 placeholder D₁ answer。

## H-04 manifest ↔ runtime binding

`requestedModel === resolvedModel` 只證明 adapter 自洽,**不證明那次呼叫真的是 manifest
宣稱的 model**。因此 verifier 現在把 manifest 綁到 raw runtime record:

```
manifestSha256                 改為 mandatory；缺少或內容被改 → run INVALID
每次 call ↔ manifest pin        provider / requestedModel / resolvedModel 三者都比
manifest ↔ artifact identity    experimentId / fixtureId / runIndex / arm /
                                snapshotSha256 / protocolVersion /
                                evidenceLabelBaseline（由 frozen Round 1 重算）
cross-arm pin                   B′ gate == C gate；C round2 == D₁ self_review；
                                C decision == D₁ decision（provider + model）
target identity                 D₁.selfReview.agentId == 重算出的 selectedIssue.targetAgentId
```

⚠️ artifact 只存 **raw fact**(`agentId` / `provider` / `requestedModel` / `resolvedModel`),
**不存 `targetMatched: true` 這種自報結論**。比對由 verifier 自己做。

## H-05 execution timestamp provenance

`startedAt` 在**送出請求之前**取得,不由完成時間倒推。

```
真實 provider call     startedAt: UTC ISO-8601（"Z" 結尾，不接受 offset）
                       ms:        非負數
replayed gate          startedAt: null      ← replay 不是 provider execution
                       ms:        null
                       recordedProviderStartedAt: 原始錄製時間（獨立 provenance 欄位）
manifest               startedAt: mandatory，UTC ISO-8601
```

⚠️ **這些是 client-observed execution provenance,不是 server timestamp guarantee。**
它記錄的是「本 harness 何時送出請求」,對 server 端執行時間不作任何宣稱。
verifier 只驗形狀與順序合理性(呼叫不得早於自己的 run 開始),**不建立假的 server 保證**。

時鐘可注入(`createDispatcher({ now })`),所以時間行為完全離線可測,不碰任何 provider。

## verify.mjs 可重算的 15 項

```
manifest integrity                    重新 canonicalize + 重算 sha256（manifestSha256 mandatory）
manifest / artifact identity binding  manifest 六個欄位對回 artifact + 重算 evidence baseline
snapshot hash                         重算
trigger state and call accounting     以 production 重推 selectedIssue，再依 triggered/not
                                      決定應有 topology（6 或 2），gate 只計費一次
call / manifest pin binding           逐呼叫比 provider + requestedModel + resolvedModel
cross-arm pin and target matching     B′/C gate、C/D₁ target、C/D₁ synthesizer、target agentId
execution timestamp provenance        manifest 與每次 live call 的 UTC ISO；replayed 不得
                                      宣稱 execution timestamp；ms 非負；呼叫不早於 run 起始
retrieval all-off                     逐呼叫 requested/result 皆 null
C 與 B′ 共用同一 gate sample           比對 provisional 與 gate prompt sha；
                                      no-trigger 時另斷言 C.finalOutput == B′.finalOutput
gate parsing                          以 production parseGateOutput / validateIssues /
                                      selectIssue / resolveSourceRef 重推
NC-2 evidence invariance              以 production buildRunReport 從 frozen Round 1 重算
NC-3 D₁ leakage diagnostic            重跑兩個模式；exact rejection 為主，字元窗為診斷
C / D₁ non-treatment parity           specialist block 與 neutrality guard 兩邊都在
normalization determinism             重跑 normalizer 比對 committed 文字與 sha
pair / assignment integrity           結構盲化 + pairId 唯一 + assignments 完全覆蓋；
                                      no-trigger 時斷言不存在 D₁ pair
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
