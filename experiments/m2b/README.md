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
