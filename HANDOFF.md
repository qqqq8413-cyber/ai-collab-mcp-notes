# ai-collab-mcp — Progress Report (2026-09-06, rev. 30)

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
> | **M2-B Harness** | **ACCEPTED(GPT Final Harness Review)—— H-01…H-05 + D-01 全部 ACCEPT** |
> | **M2-B Fixture Freeze(synthetic)** | **SUPERSEDED —— GPT Fixture Review 判定 FIXTURE PROVENANCE BLOCKER;`fx-01…04` 改列 PRE-FLIGHT SYNTHETIC CANDIDATE MATERIAL,檔案原封保留於 `02cbb5f`** |
> | **M2-B Real Round1 Capture** | **BOUNDARY IMPLEMENTED / AWAITING GPT BOUNDARY REVIEW / NO LIVE AUTHORIZATION —— `runRound1Stage()` 已抽出,offline parity byte-identical,零 live call** |
> | **Claude Code handoff** | **EXECUTED —— deliverable 已產出,等 architecture review** |
> | **目前離線測試** | **212 項全過 = rev.19 的 208 + Gate semantics 新增 4** |
> | **Step 8 Scope Analysis** | **DONE —— runtime usage / pricing / cost / reporting 已分層,詳見第十七節** |
> | **Step 8 Implementation** | **DEFERRED —— Milestone 2 驗證後再回來** |
> | 未完成的程式修改 | **無** |
>
> **Experimental Milestone 2-A 已完成本輪限定工程,現在 STOPPED / AWAITING ARCHITECTURE REVIEW,default OFF。** 使用者批准 Gate eligibility 由 post-synthesis unresolved conflict 改成 pre-synthesis material disagreement;唯一一次 Replay #4 使用與 #3 byte-identical 的 fixture,自然跑通 valid issue、sourceRef、Targeted R2 與 Decision Synthesis。212 項離線測試通過,既有 assertions 未放寬,16 組修改前/後 control capture byte-identical。這是機制驗證,尚未執行品質比較或 live A/B/C/D。
>
> **Milestone 2 scope analysis(rev.14)。** `MILESTONE2_SCOPE_ANALYSIS.md` 依實際 code 回答全部 18 題,並修正兩處 rev.13 邊界:DEEP logical call ceiling 應寫成 `N + 4`(在 `SPECIALIST_CAP.deep` 下是 8,不是約 7),且 synthesizer 目前完全收不到 retrieval metadata —— 被要求判斷 `needs_evidence` 的 gate 會是在對它看不到的證據做推論。核心設計建議是**不要把交付物押在 parse 上**:自由文字答案在前、選擇性 JSON 區塊在後、best-effort 解析,任何解析失敗都退回今日行為。7 個 `[OPEN]` 問題待 architecture review 拍板,未經批准不進入 implementation。

## rev. 30 改了什麼(Pre-Synthesis Round1 Boundary Refactor —— offline only,零 live call)

**⚠️ 本輪首次修改 production。唯一變動檔案:`src/modes/orchestrator.ts`(+61 / −3)。**
**零 live provider call。** production 212 全過(未增未減),
harness 110 + fixtures 44 + **新增 boundary 15** = 169 項 M2-B 離線測試,0 失敗。

### 1. 抽出 `runRound1Stage()`,`runOrchestrator()` 委派給它

```
runOrchestrator()
    ↓ 委派
runRound1Stage()
    ├─ planning        ├─ parse / validate / enforce plan
    ├─ Round1 workers  ├─ buildRunReport
    └─ deriveExecutionPolicy
    ↓
if !policy.synthesize  → 既有 direct/failed 回傳語意（未改）
else                   → runSynthesisStage()
```

**舊的 inline 實作已刪除,不是複製。** planning／worker 只有一份實作。
未加 `stopAfterRound1` 之類的 production flag —— 那會為了實驗需求擴大 orchestrator 的
公開行為面。這是與既有 `runSynthesisStage()` 對稱的 stage primitive。

### 2. Offline parity:byte-identical,含 timings

改 code **之前**先在 `5cd2254` 抓 8 個 case 的 baseline,改完重跑:

```
before  sha256 c76f4c53eea90dcf88cd22a7a22b8c6712a159ae3b0274fcefc2519b718b11ab
after   sha256 c76f4c53eea90dcf88cd22a7a22b8c6712a159ae3b0274fcefc2519b718b11ab   ← 相同
```

涵蓋 SIMPLE direct delivery、NORMAL synthesis、DEEP collaboration omitted／disabled／enabled、
DEGRADED worker failure、all-workers-failed、malformed planning。
比對範圍含 stage 序列、prompt、options、plan、planningAdjustments、workerResults、
report、policy、finalOutput、collaboration 物件與 **timings**。

`[FACT]` timings 能逐位元組相同,是因為抽取**沒有多讀一次時鐘**:
`workersEnd` 取樣一次,同時供 `workersMs` 與 `round1Ms` 使用,而不是取樣兩次。
有一條測試專門斷言 `runRound1Stage` 恰好讀 5 次 `Date.now()` —— 多一次就會讓
stepped clock 下的所有 timing 漂移,靜默破壞 before/after 可比性。

### 3. ⚠️ Replay #4 verifier 現在會失敗 —— 這是 fingerprint 正常運作

```
sealed 檔案是否被動        未動（git clean，hashes.json 目錄封印 INTACT）
artifact 內部 fingerprint  before == after，INTACT
16 組 disabled/omitted control  f50a7b2e… ← 與歷史值逐位元組相同，未漂移
runtime fingerprint pin    FAIL ← dist/modes/orchestrator.js 的 hash 已變
```

verifier 在 `verify.mjs:31` 斷言**工作區**仍與產生 Replay #4 的 runtime 同 hash。
production 被授權修改後,這個 pin 必然斷 —— **那正是 fingerprint 該做的事,不是回歸。**

**未重新產生、未重新封印任何 sealed artifact。** 依 §20,被改變的歷史 control 是回歸的
證據,不是可以覆寫的東西。改為新增 `capture/control-recheck.mjs`:把 sealed control harness
逐字複製到暫存目錄、只改 dist 的相對路徑後執行,回答 fingerprint 停在之前的那個問題 ——
**行為有沒有移動?沒有。** 該檢查已納入 boundary 測試套件。

`[OPEN]` Replay #4 的 runtime-fingerprint pin 之後永遠會對這個分支失敗。
是否要在未來的 harness 記錄一個「已知且已批准的 runtime 變更」清單,交 GPT 決定。

### 4. Claim boundary(必須維持)

```
✅ boundary 已實作，offline parity byte-identical
✅ production 212 未變，控制組未漂移
✅ toRound1Snapshot 直接接受 production 物件，無實驗端重組
❌ 未執行 Real Round1 capture       ❌ 零 live provider call
❌ 未取得新 ground truth            ❌ 無任何 effectiveness 證據
```

**不得寫成 ROUND1 CAPTURED。** synthetic fixtures 仍為 archival / pre-flight only。

---

## rev. 29 改了什麼(Real Round1 Capture 被 blocker 擋下 —— 零 live call,僅文件修正)

**本輪未執行任何 live provider call。`src/` diff 為空,production 212 全過,Replay #4 VERIFIED。**
harness 110 + fixtures 44 = 154 項離線測試,0 失敗。

### 1. GPT Fixture Review 判定 FIXTURE PROVENANCE BLOCKER —— 我接受

`fx-01…fx-04` 的 Round 1 是**我人工撰寫後才掛上 provider/model metadata**,
`complexity` 也是 hard-coded `"deep"`。兩者都不是實際 provider execution 的產物,
因此不得作為 Phase 1 的 frozen `Round1Snapshot`。這是真的問題,不是形式問題 ——
用它跑出來的 provider/model provenance 全部是假的。

處置:改列 **PRE-FLIGHT SYNTHETIC CANDIDATE MATERIAL**。
檔案、conflict labels、gold issues、raw annotator responses、freeze manifest
**全部原封保留於 `02cbb5f`,未修改任何一個 byte**。
仍可用於 candidate task design / fixture infrastructure tests / clean-room pipeline tests;
**不得用於 pilot input、Gate precision ground truth 或 `C − D₁` effectiveness data。**

上一輪兩份 clean-room 標註同樣**不得沿用** —— 它們標註的是 synthetic Round 1,封存即可。

### 2. ⚠️ ARCHITECTURE BLOCKER:production 未提供 pre-synthesis capture boundary

依 GPT §26.1,執行 live 之前必須先檢查此邊界是否存在。**結論是不存在。**

`runOrchestrator`(`src/modes/orchestrator.ts:434`)把 planning → workers → synthesis
綁在同一函式。它只有兩個 pre-synthesis 早退出口,而兩個都正好是取消資格的情況:

```
policy.synthesize === false
  ├─ 'no_successful_workers'                    → RunStatus FAILED   → 不合 F3
  └─ 'simple_single_specialist_direct_delivery' → complexity SIMPLE  → 不合 F1
```

**沒有任何 DEEP / SUCCESS / N≥2 的執行會在 synthesis 之前回傳。**

三條替代路徑都已評估並排除:

| 路徑 | 為什麼不行 |
|---|---|
| 注入 `call`,在 `stage === 'synthesis'` 丟例外 | `runSynthesisStage` 外無 try/catch,例外會連同 `plan` / `workerResults` / `report` 一起丟棄;只能從自己的 call log 重組,而那不是 production 的 `Round1Snapshot`(§15 要求它就是)。且這正是 §4 禁止的「跑完整 orchestrator 再丟掉 synthesis」的變體 |
| 在 `experiments/` 自行組裝 planner | `buildPlanningPrompt` 與 `CHIEF_SYSTEM_PROMPT` 有 export,但 `planSchema`、`extractJsonObject`、`enforceConstraints` **都沒有**。缺的正好是「把模型回應變成受約束計畫」那段,含 `SPECIALIST_CAP.deep`;重寫即 §4 禁止的 fake planner |
| 人工 roster 取代 planner | §4 明文禁止 |

依 §4 與 §26.2:**STOP,不做 live,不自行修改 `src/`。**

`[OPEN]` **最小修正提案(僅提案,未實作)** —— 把 `runOrchestrator` 的 planning + workers
抽成一個匯出的 `runRound1Stage()`,讓 `runOrchestrator` 呼叫它,零邏輯重複。
這與既有的 `runSynthesisStage()` 完全對稱 —— 那一個正是為了讓 replay 重用 production
而抽出來的,先例已在。**需要 GPT 明確批准 scope 才能動 `src/`。**

### 3. 兩項文件修正(GPT §21、§22)

- **§21** —— 原稱 per-fixture 檔案是 raw 的「byte-identical / 逐字分割」,**不精確**。
  實作是 `JSON.parse` → `JSON.stringify(entry, null, 2)`,bytes 已重新序列化。
  正確說法:**raw 響應逐字保存;per-fixture 是 semantic / object-preserving partition**,
  測試以 `deepEqual` 比對**解析後的物件**。程式註解與測試名稱都已改。
  這是 documentation correction,不是 runtime defect。
- **§22** —— `M2_EFFECTIVENESS_EXPERIMENT.md` §13.4「重用 Replay #3/#4 作 fixture #1」
  加上 **SUPERSEDED / DEPRECATED FOR PHASE 1** 醒目註記,**原文保留不刪**,
  並記錄 Phase 1 現在要求真實 Round 1 provenance。

### 4. Claim boundary(必須維持)

```
✅ blocker 已依規定於 live 之前檢出並回報
✅ 舊 synthetic fixture 原封未動        ✅ 文件修正完成
❌ 零 real Round1 capture               ❌ 零 live provider call
❌ 未產生新的 clean-room packet          ❌ 未取得新 ground truth
❌ 無任何 effectiveness 證據
```

---

## rev. 28 改了什麼(M2-B Fixture Freeze 完成 —— ground truth 已由 clean-room 取得並凍結)

**`src/` diff 為空。production 212 全過,Replay #4 封印 VERIFIED,兩份 GEMINI packet 未動。**
harness 110 + fixtures 44 = **154 項離線測試,0 失敗**。
**零 provider 呼叫、零 Gate 執行、零 arm 執行、未跑 temperature probe。**

### 1. 雙 clean-room ground truth 已取得

| | 標註者 | 看到什麼 | raw sha256 |
|---|---|---|---|
| Conflict labels | clean-room Gemini session **A** | 只有 `packet-conflict.md` | `96ba88667d29c4b2…` |
| Gold issues | clean-room Gemini session **B** | 只有 `packet-gold.md`,**未看過 session A 的輸出** | `e9f83a30af2fa5b4…` |

兩個 session 都是全新對話,未重用 methodology review 的 context,也未重用 PACKET-1／PACKET-2。
**這是 ground-truth authoring,不是 runtime experiment** —— 未呼叫 Chief／M2 harness,
不計入 pilot calls。此區分已寫入 freeze manifest 的 `activityClass`。

### 2. Negative control 獨立驗證通過

```
fx-01  intended=positive  observed=true    AGREES
fx-02  intended=positive  observed=true    AGREES
fx-03  intended=positive  observed=true    AGREES
fx-04  intended=NEGATIVE  observed=false   AGREES
```

四份全部相符,**無需更換任何候選**。若曾不符,依 protocol §13 是換 fixture 重跑 clean-room,
**不得編輯標註** —— 該行為由測試強制(把 `fx-04` 翻成 true 時,intent check 必須回報 disagree)。

### 3. 「逐字提交」是可驗證的,不是口頭承諾

raw 標註輸出原文保存於 `evaluation/cleanroom/raw-*.md`(含 JSON 與人類可讀說明),
per-fixture 檔案是它的**純分割**。測試把分割重新接起來,必須與 raw 物件 `deepEqual` ——
任何正規化、修正或補全都會在這裡現形。**Claude 未觸碰任何語意判斷。**

### 4. Freeze manifest

`experiments/m2b/manifests/fixture-freeze-manifest.json` 綁定:
四個 fixture 的 fixture/snapshot/roster/manifest hash、雙份 ground truth hash、
兩份 packet hash、兩份 raw 標註 hash、runtimeCommit、chunkerVersion、
以及 `status=FROZEN_PRE_ARM` / `armExecution=NONE` / `liveProviderCalls=0`。
測試逐項從檔案重算比對。**一經 commit 不覆寫**;要改就是新的 freeze commit。

### 5. Claim boundary(必須維持)

```
✅ 4 個 fixture 已凍結並 hash        ✅ 雙 clean-room ground truth 已凍結
✅ negative control 獨立驗證通過      ✅ 路徑隔離結構性測試通過
✅ Option 3′ 分配已凍結（未執行）
❌ 尚未 GPT Fixture Review           ❌ 零 Gate / arm / provider 執行
❌ 未跑 temperature probe            ❌ 無任何 effectiveness 證據
```

**不得寫成 PILOT READY / EFFECTIVENESS VALIDATED / GATE VALIDATED / PRODUCTION READY。**

---

## rev. 27 改了什麼(M2-B Fixture Freeze —— runtime side 完成,ground truth 待標註)

**`src/` diff 為空。production 212 全過,Replay #4 封印仍 VERIFIED,兩份 GEMINI packet 未動。**
harness 測試 110、新增 fixture 測試 34,合計 **144 項離線測試,0 失敗**。
**本輪零 provider 呼叫、零 Gate 執行、零 arm 執行。**

### 1. Contamination 裁決已執行

GPT 裁定 **Replay #3/#4 fixture 移出 Phase 1 fixture set** ——
它已暴露於 Gate 輸出、`selectedIssue`、challenge、R2、Decision Synthesis 與歷史觸發行為,
無法滿足 clean pre-arm 邊界。**不嘗試改派標註者搶救。**
它仍是 M2-A 的歷史證據,sealed artifacts 未刪未改。
新增測試逐項斷言四個 fixture 都不重用 replay 的 specialist id、任務內容或 snapshot hash。

### 2. 四個全新 fixture(runtime side 已凍結)

| id | archetype | specialists | Option 3′ target |
|---|---|---|---|
| `fx-01` | STRATEGY_CONFLICT | market_positioning / delivery_operations | openai / gpt-5 |
| `fx-02` | EXECUTION_CONSTRAINT_CONFLICT | clinical_staffing / growth_planning | claude / claude-sonnet-5 |
| `fx-03` | EVIDENCE_INTERPRETATION_CONFLICT | demand_research / retention_analysis | gemini / gemini-3.1-pro-preview |
| `fx-04` | NEGATIVE_CONTROL | team_workflow / client_delivery | openai / gpt-5 |

每個 fixture 有 `fixture-manifest.json`,含 F1–F7 逐項 eligibility 理由。
**理由只引用原始任務與 Round 1 文本**;測試斷言其中不出現
`triggered` / `Gate selected` / `Replay` / `selectedIssue` 等字樣 —— 依 §7,那類推理會使候選失格。

### 3. Clean-room packet 已產出並凍結

```
packet-conflict.md   sha256 4af963eed0dce280…   25,376 bytes
packet-gold.md       sha256 463e117b17d2ef77…   25,198 bytes
```

只含:標註指示、原始任務、角色與 mission、完整 Round 1、確定性 passage id。
洩漏掃描涵蓋 40 個禁用詞(Gate 行為、實驗結構、fixture 身分三類),**掃描不過就不產出 packet**。
⚠️ 掃描是 **lexical diagnostic,不是語意保證**。
packet 呈現順序為 `fx-03, fx-01, fx-04, fx-02` —— 刻意不讓 negative control 落在最後。

### 4. GI-5 runtime / evaluation 路徑隔離

`fixtures.mjs` 只讀 `experiments/m2b/fixtures/`,且全部是具名檔案讀取、無遞迴走訪。
四條測試:loader 開啟的路徑全在 fixtures/ 底下、runtime fixture 目錄不含 ground-truth 檔、
載入後的 fixture 物件不含 `goldIssues` / `materialConflict`、`loadFixture` 函式本體無通往
evaluation 的程式路徑。

### 5. Option 3′ 分配已凍結(未執行)

三個 positive fixture 的 target provider 輪換 openai / claude / gemini。
**同一 fixture 內兩位 specialist 指派同一 provider** —— 因為在 frozen Round-1 replay 中
只有被挑戰的 specialist 會發出呼叫,非 target 的 provider 永不執行,
所以這樣做零成本、且讓 target provider 覆蓋變成**確定的**而非取決於 Gate 挑誰。
Decision synthesizer 全程固定 openai / gpt-5。
**只建立 execution coverage,不宣稱 cross-provider generalization。**

### 6. ⚠️ 本階段尚未完成 —— 缺 ground truth

依 GPT §1,**Claude 不得撰寫 `conflict-labels.json` 與 `gold-issues.json` 的內容**。
兩者必須由**兩個各自全新的 clean-room Gemini session** 產出
(conflict labelling 一個、gold issues 另一個,且 gold 標註者不得看到 conflict 標註結果)。

因此 acceptance criteria 第 5、6、7 項尚未滿足。
測試已寫好並在標註缺席時自動 skip;標註送回後會自動生效,包含
**negative control 獨立驗證**:若 `fx-04` 被獨立標為 `materialConflict=true`,測試會 FAIL ——
依 protocol **不得編輯標註,必須更換候選**。

### 7. Claim boundary(必須維持)

```
✅ runtime-side fixture 已凍結並 hash    ✅ clean-room packet 已凍結
✅ 路徑隔離已結構性測試                  ✅ Option 3′ 分配已凍結
❌ 尚未取得 clean-room 標註              ❌ 尚未 GPT Fixture Review
❌ 零 Gate / arm / provider 執行          ❌ 未跑 temperature probe
❌ 無任何 effectiveness 證據
```

**不得寫成 PILOT READY / EFFECTIVENESS VALIDATED / GATE VALIDATED / PRODUCTION READY。**

### 8. 順帶修掉已核准的 doc debt

`arms.mjs` 檔頭的 `6 per fixture-repetition` 改為明確區分
**TRIGGERED = 6 / NO-TRIGGER = 2**。無功能變更,未獨立開 commit。

---

## rev. 26 改了什麼(H-05 provenance + D-01 wording —— experiments/ only,src/ zero-change)

**`src/` diff 為空。production 離線測試仍 212 全過,Replay #4 封印仍 VERIFIED。**
harness 離線測試 94 → **110**,0 失敗。兩份 GEMINI packet 均未修改。

| ID | 結果 | 內容 |
|---|---|---|
| **H-05** | **FIXED** | execution timestamp provenance。`startedAt` 加入 manifest MANDATORY_FIELDS(UTC ISO-8601,`Z` 結尾,拒收 offset);每次真實 provider call 在**送出請求之前**取得 `startedAt`,不由完成時間倒推;**replayed gate 記 `startedAt: null` / `ms: null`,不得偽造 provider execution timestamp**,原始錄製時間另存為獨立的 `recordedProviderStartedAt` provenance 欄位。 |
| **D-01** | **DOCUMENTATION CORRECTION** | §20.1 殘留的 `4 fixtures × 5 reps × 6 calls = 120` 與 amendment 矛盾,已改為 maximum / actual 兩行;§5.1 的 6-call topology 明標為 **TRIGGERED repetition**,並註明 NO-TRIGGER = 2 billable calls。 |

1. **verifier 由 14 項擴為 15 項** —— 新增 `execution timestamp provenance`。
2. **時鐘可注入** —— `createDispatcher({ now })`,時間行為完全離線可測,不碰任何 provider。
3. ⚠️ **`H-05 FIXED` 只代表 offline harness provenance contract 已修正。**
   **不代表 model drift 已 live validated。** 這些是 client-observed execution provenance,
   **不是 server timestamp guarantee** —— verifier 只驗形狀與順序合理性,不建立假的 server 保證。
4. **Claim boundary(必須維持)** ——

   ```
   ✅ harness revised            ✅ offline structural checks pass
   ✅ production tests unchanged
   ❌ no live validation         ❌ no pilot
   ❌ no effectiveness evidence  ❌ no model drift validation
   ❌ no productionization
   ```

5. **未動** —— `src/`、production prompts、provider adapters、planner、Gate semantics、
   chunker、retrieval、Step 8、Replay #4 sealed artifacts、既有 production tests 的 assert 語意、
   `GEMINI_M2B_REVIEW_PACKET.md`、`GEMINI_M2B_REVIEW_PACKET_2.md`。
   未 merge main,未執行任何 live call。

---

## rev. 25 改了什麼(M2-B Harness Narrow Correction —— experiments/ only,src/ zero-change)

**`src/` diff 為空(對照 `7acb4d4`)。production 離線測試仍 212 全過,Replay #4 封印仍 VERIFIED。**
harness 離線測試 65 → **94**,0 失敗。**沒有為了通過而 skip / xfail / 放寬 / 刪除任何測試。**

GPT Harness Review verdict:**REVISE — NARROW HARNESS CORRECTIONS ONLY**。
四臂、causal design、Phase 1 架構均未重開。

| ID | 結果 | 內容 |
|---|---|---|
| **H-01** | **ACCEPTED** | evidence parity。peer chunk 出現在**兩個 arm 的** decision prompt 不是 leakage;NC-3 維持 stage-specific。未回退。 |
| **H-02** | **ACCEPTED** | substring window 重新分類為 **Secondary Diagnostic Heuristic**。20/60 行為保留,但不得再稱 correctness invariant / structural guarantee / proof of no leakage。 |
| **H-03** | **FIXED** | no-trigger path 成為**一等公民的合法形狀**。未觸發時 `C = B′`、`D₁ = SKIPPED`、該 repetition 只花 **2** 次呼叫(而非 6)。verifier 以 production 重推 trigger state,不讀 artifact 自報。 |
| **H-04** | **FIXED** | manifest ↔ runtime binding。`manifestSha256` 改為 mandatory;逐呼叫綁 provider / requestedModel / resolvedModel;manifest ↔ artifact identity;cross-arm pin;target agentId。 |

1. **verifier 由 12 項擴為 14 項 recomputation**,全部從 committed raw data 重算。
   artifact 只新增 **raw fact**(`selfReview.agentId` 等),**未新增任何自報結論欄位**
   (無 `targetMatched` / `modelPinMatched` / `triggered`)。
2. **protocol 維持 `M2B-PROTOCOL-0.2`,未升版。** 新增
   「Harness Review Clarification」amendment 記錄 H-01…H-04,
   並把 `120 live calls` 一律改寫為 **upper bound**(未觸發的 repetition 只花 2 次;
   未觸發不是 invalid run,不得剔除)。pilot design(4 fixtures × 5 repetitions)不變。
3. **測試命名修正** —— `D1 ships the production Decision contract verbatim` 名稱過寬
   (extraction 後有 treatment-specific `.replace()`,並非 byte-identical),
   改為 `D1 preserves the required non-treatment Decision contract invariants`。
   這是 **Documentation / Test Naming Correction,不是 runtime defect**。
4. **Claim boundary(必須維持)** —— `FIXED` 只表示 deterministic harness implementation
   與離線測試已修正:

   ```
   ✅ harness revised
   ✅ offline structural checks pass
   ✅ production tests unchanged
   ❌ no live validation      ❌ no pilot
   ❌ no effectiveness evidence ❌ no productionization
   ```

5. **未動** —— `src/`、production prompts、provider adapters、planner、Gate semantics、
   chunker、retrieval、Step 8、Replay #4 sealed artifacts、既有 production tests 的 assert 語意。
   `GEMINI_M2B_REVIEW_PACKET.md` 與 `GEMINI_M2B_REVIEW_PACKET_2.md` 均未修改,維持 immutable。
   未 merge main,未執行任何 live call。

---

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

1. **M2-B Protocol 通過 Architecture Review** —— GPT 裁決 `ACCEPT WITH ARCHITECTURE CORRECTIONS`。
   依 13 項決策修訂後的 `M2_EFFECTIVENESS_EXPERIMENT.md` v0.2 已提交於 `a308bc8`。
   主要修正:`C − D₁` 的估計對象由「pure peer information」收窄為
   **Targeted Peer-Challenge Package**;Claims Ladder 的 L2 拆成 L2-P(`C > B`)與 L2-M(`C > B′`);
   流程在 harness 與 live 之間插入一道 **GPT Harness Review**。設計細節不抄進本檔(規則 §46)。
2. **Claim boundary(必須維持)** ——

   ```
   ✅ M2-B protocol 已通過 Architecture Review（v0.2）
   ✅ harness implementation 是下一輪，但 scope 尚未下達
   ❌ 尚未 harness implementation
   ❌ 尚未 temperature probe
   ❌ 尚未 live pilot（LIVE PILOT NOT AUTHORIZED）
   ❌ 尚未有任何 effectiveness 證據
   ```

3. **補記一項既有 factual history** —— Diagnostic #1 的 arithmetic defect,見下方新增的第二十二-A 節。
   **它不是 runtime defect**,分類為 Answer-Quality Defect(協作規則 §10)。
4. **M2-A 狀態未變** —— 仍是 STOPPED / DEFAULT OFF。本輪未跑 live call、未改 Gate、
   未動 Replay #4 封印、未 merge main。`GEMINI_M2B_REVIEW_PACKET.md` @ `14952c7` 指向 v0.1,
   依 packet immutability 不回頭覆寫。

---

## rev. 22 改了什麼(只加狀態指標 —— 無 code、無設計內容)

**rev.22 = rev.21 的 code + 一列狀態指標。`src/` 一個 byte 都沒動,離線測試仍是 212 項。**

1. **本輪唯一變更** —— 交接狀態表新增一列,指向 `M2_EFFECTIVENESS_EXPERIMENT.md`
   (commit `734ad8e`,1992 行)。**M2-B 的設計內容一律不抄進 HANDOFF**;
   依協作規則 §46,實驗設計屬於該文件,HANDOFF 只記工程狀態。
2. **Claim boundary(必須維持)** ——

   ```
   ✅ M2-B protocol 已產出
   ❌ 尚未經 Gemini independent review
   ❌ 尚未經 GPT Architecture Review
   ❌ 尚未 ACCEPT
   ❌ 尚未 implementation
   ❌ 尚未 live experiment
   ```

3. **M2-A 狀態未變** —— 仍是 STOPPED / AWAITING ARCHITECTURE REVIEW / DEFAULT OFF。
   本輪未跑 live call、未改 Gate、未動 Replay #4 封印、未 merge main。

---

## rev. 21 改了什麼(rev.20 獨立審查紀錄 —— 無 production code 變更)

**rev.21 = rev.20 的 code + 一份獨立審查紀錄。`src/` 一個 byte 都沒動,離線測試仍是 212 項。**
被審對象是 `experimental/m2a-peer-challenge` @ `4e34d89d9d88e64d0bcfd641809c8ff57bf03b25`。

1. **結論** —— `ACCEPT WITH DOCUMENTATION CORRECTION`。未發現 production runtime defect。
   11 個審查面向中 10 項 PASS,1 項 CONCERN(Gate semantics —— 針對已批准規格本身的寬度,
   不是實作偏差)。詳見第二十五節。
2. **驗證方式** —— 不是讀 artifact 自報值。在 scratchpad 另開 `aedc9ef` 與 `4e34d89`
   兩個乾淨 worktree,各自從 committed source 重新 `tsc` build,重跑 control capture、
   全套離線測試、`verify.mjs`,並從 frozen snapshot 重建 live gate prompt 比對 byte。
   審查全程只讀不寫,repo 未被修改,worktree 事後清除。
3. **待處理項目** —— 3 項文件/命名落差(D1/D2/E4)與 1 項規格 concern(A1「strengthening」)。
   **本輪未實作任何修正**,原因見第二十五節「為什麼不當場修」。
4. **BENCHMARK RESET(rev.19)仍有效。** 本輪未執行任何 live call,未動 M2-A,未 productionize。

---

## rev. 20 改了什麼(Gate Eligibility Specification / Controlled Replay #4)

1. **授權與起點** —— 使用者先明確停止 M2-A 等 architecture review,其後批准本次限定 Gate semantics 修正與一次 Replay #4。實際起點為 rev.19 / `aedc9efe0ff1f4acf7d5a36d9a1b3ab87e5b9af8`,不是較舊的 rev.18。第二十三節的設計對立仍是設計 observation,未改稱 parser、chunker 或 planner bug。
2. **唯一 production diff** —— `src/agents/collaboration.ts::buildGateAppendix()` 改為先看原始 Round 1 的 material、cross-agent、decision-sensitive disagreement。Provisional 能折衷不再自動取消 issue 資格;wording/style/minor emphasis/equivalent recommendations 仍排除,max-one 與不捏造分歧保留。沒有新增 call、flag 或調整其他 runtime。
3. **離線驗證** —— `npm test` 208 → 212,0 failed。新增四項 contract/runtime tests;另以固定 offline clock 保存16組 disabled/omitted control,修改前後 payload、prompt、stage sequence、finalOutput 完全 byte-identical。LLM 判斷由 live observation 驗證,不以 mock 取代。
4. **Replay #4 FULL MECHANISM RUNTIME PASS** —— 一次 Gate → R2 → Decision Synthesis,三次皆 openai / gpt-5。parse=parsed;emitted/valid/rejected/eligible/selected=1/1/0/1/1;target=brand_creative;sourceRef=business_strategist:p5,精確引用40字元,與 challenge 直接相關。未重跑 Planning/Workers或人工插入 issue。
5. **Evidence 與 failure 邊界** —— HYPOTHESIS → HYPOTHESIS、SUCCESS → SUCCESS、banner/retrieval summary 不變,所有 live calls retrieval request/result 均 null。Provisional/R2/final 原文完整保存。成功路徑為 live evidence;R2/Decision failure fallback 與多 issue 防護本輪由 offline tests 驗證,未額外 live 注入失敗。
6. **Timing 與完整性** —— Gate 46729ms、R2 42713ms、Decision 68965ms、replay total 158408ms。五份 fixture hashes、snapshot/order/status/roster/chunks 皆與 #3 相同,詳見 `diagnostics/m2a-live/controlled-replay-4/`。Single replay observation 不作 latency distribution 或 quality comparison。
7. **提交與停止** —— Prompt/tests 獨立 commit `267ecffb2eebbb8fe4d42333469ad8d10b0362f4`;diagnostic evidence/HANDOFF 另外提交於 `experimental/m2a-peer-challenge`。本輪未確認 production runtime defect;離線 verifier 的 undefined/JSON serialization 比對修正已記錄。完成後停止,等待 Architecture Review。rev.19 BENCHMARK RESET 仍有效,未做 B vs B′、self-review、A/B/C/D、NORMAL eligibility、Finance Layer 或 productionization。

---

## rev. 19 改了什麼(去識別化與 benchmark reset)

1. **⚠️ BENCHMARK RESET** —— `benchmark-task.mjs` 裡的公司名稱原本是真實名稱,而這個檔案在 `main` 上、公開。已換成固定佔位名稱「星芒影像工作室」。**這正是已知會讓計畫從 `deep` 變成 `normal` 的那種替換**,所以 **rev.19 之前所有 BENCHMARK_TASK 的測量值都是歷史數據,與之後的執行不可比較**。要比較前必須重新建立 baseline;佔位名稱現在自己就是控制變數,不得再改。
2. **這是一個取捨,不是清理** —— 換掉的代價是既有 benchmark 數據脫鉤,留著的代價是公司名稱持續公開。使用者選擇去識別化優先。受影響的只有 `test-chief-live.mjs` 與 `test-orchestrator.mjs` 兩個 live-only 腳本,`npm test` 的 208 項離線測試不使用 BENCHMARK_TASK。
3. **README 更新** —— 公開版原本停在「Step 7 V1 / 99 項測試」,已更新為 208 項、加入 M2-A 的 default-OFF 狀態與「三次 live 後機制後半段仍未執行」的事實,並指向 `diagnostics/m2a-live/`。發佈前的英文完整版保留為本機檔案,已加入 `.gitignore`。
4. **`.gitignore` 補洞** —— 新增 `/orchestrator-run-*.txt`(原本只擋 `.json`,一份含真實公司名稱的 2,355 行執行紀錄因此暴露在 untracked 狀態)與 `*.local.md`。
5. **決定不改寫歷史** —— `eabae9e` 的兩個 harness 檔含本機使用者名稱(暫存路徑),tip 已在 `27a743c` 修掉。**不做 history rewrite**,因為每一個 commit 的作者欄位本來就是 `qqqq8413 <qqqq8413@gmail.com>` —— 移除路徑裡的名字、卻留著每個 commit 上的 email,是形式而非實質。若之後要處理身分揭露,對象應該是 commit 作者資訊,那需要改寫全部歷史並調整 git config。
6. **未修改任何 runtime** —— `src/` 與 `d1d1d28` 逐位元組相同,`npm test` 208 passed / 0 failed。

---

## rev. 18 改了什麼(Controlled Frozen Round-1 Replay)

1. **不再靠自然任務碰運氣** —— 改用 controlled frozen Round-1 replay,直接把一份合法的 `deep` / `SUCCESS` / N=2 / 帶明確 B vs C 衝突的 synthetic snapshot 送進真實 downstream path。
2. **不需要任何 bypass flag** —— 既有的 `replaySynthesis()` 就足以讓合法 snapshot 進入 `runSynthesisStage()`,也就是 live 路徑本身。沒有新增 `forceCollaborationGate` 之類的 runtime trigger,production execution semantics 未被污染。
3. **gate 第一次真正執行了** —— 附錄、40 個 deterministic reference(`business_strategist:p1…p18`、`brand_creative:p1…p22`)、max-one 規則都以 captured prompt 驗證確實送達模型。
4. **但仍是 `NOT EXERCISED`** —— `SKIPPED / no_issue_block`,`issues.emitted = 0`。
5. **⚠️ 失敗的原因與預期完全不同** —— gate **認出了**那個分歧。它的回答裡有一段標題是「專家分歧與如何處理」,精準點名 B vs C 與雙方論據,然後把 C 當作 Kill Switch 整合進 B 的方案裡。**它在答案內解決了衝突,因此依附錄自己的規則不該提報。** 這不是 recall 問題,是通道問題,兩者修法完全不同。
6. **新增一條工程原則** —— 見第十五節:同一次呼叫同時被要求「解決衝突」與「回報未解決的衝突」,做好前者就消滅了做後者的理由。
7. **未觸發路徑在真實執行中再次成立** —— provisional answer 完整交付且與 gate 回應逐字元相同、`finalOutput == banner + gate 回應`、evidence label 以凍結 Round 1 獨立重算一致、唯一一次呼叫無 retrieval。
8. **證據保存** —— `diagnostics/m2a-live/controlled-replay/`,含逐字 fixture(task、兩份 mission、兩份 synthetic Round 1)、fixture hash、harness、完整 artifact(gate prompt 與回應原文)。
9. **未修改任何程式** —— `src/` 與 `d1d1d28` 逐位元組相同,`npm test` 208 passed / 0 failed。本次 commit 只新增 diagnostics 與文件。

---

## rev. 17 改了什麼(兩次 Diagnostic Live 的結果)

1. **兩次 live 都執行了,兩次都 `NOT EXERCISED`** —— targeted peer challenge 機制到目前為止**一次也沒有被真正執行過**。這不是 runtime 缺陷:兩次都沒有出現任何 defect,但也沒有任何一次讓 gate 有機會運作。
2. **阻擋點是兩個不同的條件** —— #1 是 `single_specialist_no_peer`(Chief 只派 1 位),#2 是 `complexity_not_deep (normal)`(Chief 派了 2 位,但把任務判為 normal)。修掉其中一個不會讓另一個消失。
3. **Planning Reachability 在 #2 通過** —— 在一個同時具備商業可行性、市場需求判讀、品牌定位三種資訊的固定 fixture 上,Chief 自行派出 2 位專家(business_strategist + brand_creative),並明確排除 market_researcher,理由是 fixture 已寫明不需外部搜尋。`planningAdjustments` 為空,沒有任何 enforcement 介入。**這是 Chief 自己的判斷,不是被規則逼出來的。**
4. **兩次的 runtime 不變式都成立** —— gate 未啟動時 synthesis prompt 不含附錄(以實際 captured prompt 驗證)、`finalOutput` 逐字元等於 `banner + synthesis 原文`、evidence label 以 Round 1 結果獨立重算一致、四次/三次呼叫皆無 retrieval request、call ceiling respected。
5. **保存完整證據** —— `diagnostics/m2a-live/` 收錄兩次執行的 artifact(含每次呼叫的 prompt 原文與回應原文)、harness 與 #2 的逐字 fixture。harness 是 pass-through recorder,參數原封轉給真正的 `callProvider`,runtime 行為未改變。
6. **未修改任何程式** —— 兩輪 diagnostic 期間 `HEAD` 始終是 `d1d1d28`,working tree 全程 clean。本次 commit 只新增文件與證據。
7. **修正審查包的一句過期敘述** —— 舊版結尾寫「一次 live 都還沒跑過」,現已改為「跑過兩次,機制仍未被執行」,以免審查者以為機制已被實測。

---

## rev. 16 改了什麼(M2-A Pre-Live Finalization)

1. **Deterministic chunk reference 取代 head slice** —— Round 1 輸出由 runtime 依空白行切成 `p1`、`p2`…,`sourceRef` 改成 `<agentId>:<chunkId>`。offset 全部由 runtime 產生並記錄,模型從不提供 offset,也沒有 fuzzy quote matching。`output.slice(0, limit)` 已移除:被挑戰的內容通常不在回答開頭,拿開頭充數會讓 Round 2 在回應一段不相關的文字。
2. **bare `<agentId>` 只在無歧義時接受** —— 該專家的回答只有一個 chunk 時可用,否則拒絕並回報可用的 passage 清單。用「取開頭」來解歧義,正是這次要修掉的東西。
3. **Gate 明示最多一個 peer challenge** —— 附錄加入「At most one … select only the one whose resolution would have the greatest effect on the final decision」。模型違規回多個時,runtime 用既有的固定排序取一個並記一條 note,**不新增 severity 評分呼叫、不建 ranking 子系統**(測試斷言違規情況下呼叫數仍是 N+4)。
4. **Decision Synthesis 中立性守則** —— 明確要求「不得因為較新或屬於修訂版就視為較正確;revision、recency、專家彼此同意都不是證據」。同時保留:未解分歧可以明示、不強迫 consensus、peer agreement 不提升 evidence status(測試斷言 prompt 中不出現任何要求達成共識的措辭)。
5. **Parser edge cases 補齊** —— 四種情境端到端驗證:結尾的一般 JSON 範例不被誤剝、合法區塊被解析且從使用者可見答案中移除、malformed 區塊仍交付 provisional 且報告記下 parse failure、只有區塊沒有答案時 graceful fallback。四種都斷言 `RunStatus` 不受影響。
6. **frozen Round-1 replay** —— 新增 `replaySynthesis()` 與 `toRound1Snapshot()`。凍結同一份 Round 1,只重跑 synthesis,即可比較 B(既有 prompt)與 B′(gate prompt + Round 2 關閉)。它呼叫 live path 同一個 `runSynthesisStage()`,不是第二份實作 —— 否則 replay 量到的是另一個系統。
7. **`disableRound2` 成為正式 config** —— 這就是 arm B′,live 與 replay 都能用。
8. **provisionalAnswer 保存在每一次 gate 有跑的執行** —— 讓 `C_provisional` vs `C_final` 成為**同一個任務內**的配對比較。`chunkMap` 也一併保存,讓被拒絕的 sourceRef 可以事後稽核。
9. **⚠️ 推翻我 rev.15 寫的識別策略** —— 用 SKIPPED vs COMPLETED 估計 peer interaction 效果有 selection bias,已停用。詳見第二十一節。
10. **測試** —— 175 → 208(本輪新增 33)。0 failed。未跑 live。
11. **未改動** —— `policy.ts`、`chief.ts`、`registry.ts`、`capabilities.ts`、`debate.ts`、`pipeline.ts` 與三個 provider adapter 全部 byte-identical;`RunStatus`、`EvidenceLabel`、retrieval、Step 7 的判定與快速路徑均未觸碰(以 `git diff` 驗證)。

---

## rev. 15 改了什麼(Experimental Milestone 2-A Prototype)

1. **實作 targeted peer challenge,default OFF** —— `Chief → Round 1 → Synthesis Gate →(有 decision-sensitive peer challenge 才)Round 2(最多 1 位)→ Decision Synthesis`。開關是 `experimental.collaboration.enabled`,不給就完全走舊路徑:stage 序列、`finalOutput`、回傳物件的 key 全部與 rev.14 相同,測試逐項比對過。
2. **先換掉會壞掉的測試基礎設施** —— `CallStage` 成為 `CallOptions` 的顯式欄位(`planning` / `round1_worker` / `synthesis` / `synthesis_gate` / `round2_worker` / `decision_synthesis`)。舊 harness 用「沒有 system prompt」判定 synthesis,M2 加入第二個 synthesis 等級呼叫後必然誤判。三個 provider adapter 都不 spread `CallOptions`,所以這個標籤不可能流進任何廠商 API。
3. **交付物不押在 parse 上** —— gate 先寫完整答案,再選擇性附一個 fenced JSON 區塊。區塊不存在、JSON 壞掉、schema 不符、agent 不存在、issue 不合格,五種情況全部退回 provisional answer 加一條註記,run 不會 FAILED。只有結尾、且內容含 `collaborationIssues` 的區塊才會被當成 metadata —— 答案裡真正的 JSON 範例不會被吞掉。
4. **`sourceRef` 必須是不同的 agent** —— 自己引用自己會被擋下並記為 `self-review, not a peer challenge`。這不是潔癖:允許它就等於讓 arm C 混進 arm D 的行為,實驗會用錯誤的方式回答自己的問題。
5. **deterministic selection** —— 多個合格 issue 時依「被挑戰者在 assignment order 的位置 → 挑戰來源的位置 → gate 產出順序」固定排序取一個。不隨機、不再問模型、不全部執行。同一份 gate 輸出永遠選到同一個 issue。
6. **selective peer context** —— Round 2 只收到 original task、自己的 mission、自己的 Round 1 輸出、**一段** peer excerpt 與**一條** challenge。測試明確斷言第三位專家的輸出**不在** prompt 裡。沒有重用 `run_debate` 的 full-broadcast。
7. **excerpt 是 runtime 擷取的,不是模型給的 offset** —— 由 runtime 從 `sourceRef` 的 Round 1 輸出取前 N 字元,記錄 `startChar` / `endChar` / `truncated` / `charLimit`。`peerExcerptChars` 是 configurable experimental parameter,預設值沒有任何實測支持,每次執行都把實際用值寫進報告。
8. **Round 2 不做 retrieval** —— 即使被挑戰的專家是 `evidenceCapable` 也不掛。`needs_evidence` 只記錄不執行。理由是隔離變因:同時加入 peer interaction 與新的外部檢索,之後就無法分辨改善來自哪一個。
9. **Evidence 不變式由結構保證** —— Round 2 的輸出不進 `workerResults`、不進 `summarizeRetrieval`、不進 `deriveEvidenceLabel`。banner 一律由 Round 1 的 report 產生。測試斷言 label 與 banner 在開關兩種狀態下完全相同,且沒有任何路徑能產生 `EVIDENCE_BACKED`。
10. **失敗一律回退到 provisional answer** —— Round 2 失敗或 Decision Synthesis 失敗,`answerSource` 保持 `round1_provisional`,`RunStatus` 保持 Round 1 語意。Round 1 已經付過錢,M2 的任何失敗都不該讓使用者失去那份工作。
11. **獨立 `CollaborationReport`** —— `NOT_TRIGGERED` / `SKIPPED` / `COMPLETED` / `FAILED` 四態、reason、selected issue、round2 agent、`answerSource`、peer excerpt metadata 與獨立 timings 區塊。既有 `planningMs` / `workersMs` / `synthesisMs` / `totalMs` 語意與形狀未動。
12. **修正 rev.14 的一條原則** —— 使用者指令第 14 條推翻了我寫的「觸發率就是 kill criterion」。低觸發率同樣可能代表 gate 精準。觸發率降為 diagnostic,真正要量的是 triggered usefulness。詳見第十五節。
13. **控制組被證明沒有漂移** —— 為了做出 gate 版本,synthesis prompt 被抽成變數。arm B 是實驗的控制組,這種重構正是會靜靜搬動一個換行的地方,而漂移過的控制組比沒有控制組更糟 —— 之後每一個 C 對 B 的差異都會有一部分是這次編輯造成的。因此加了測試,用 M2 之前的寫法重建 prompt 並逐位元組比對(SUCCESS 與 DEGRADED 兩種情況),並斷言 gate 版本是「控制組 prompt + 附錄」,沒有刪去任何東西。
14. **測試** —— 99 → 175(新增 76 項)。0 failed。未跑任何 live benchmark。

---

## rev. 14 改了什麼(Milestone 2 Scope Analysis)

1. **產出 `MILESTONE2_SCOPE_ANALYSIS.md`** —— 依 `CLAUDE_CODE_HANDOFF.md` 的 deliverable 逐條回答 18 個問題,每個主張標記 `[FACT]` / `[DESIGN]` / `[SIGNAL]` / `[DECISION]` / `[OPEN]`,把「code 讀出來的事實」與「還沒有證據的設計選擇」分開,不讓提案借用觀測的可信度。
2. **修正 call ceiling 的寫法** —— rev.13 的「deep logical call ceiling 候選約 7」只對三專家計畫成立。Planning 是 bounded-not-deterministic(同一 DEEP task 實測出現過 2 與 3 個 mission),上限必須寫成 `N + 4`;在 `SPECIALIST_CAP.deep = 4` 下是 8。否則一次合法的四專家執行會被誤讀成違規。
3. **確認 synthesizer 看不到 retrieval metadata** —— synthesis prompt 只拿到 original task 與每個成功 worker 的 `agentId` / `mission` / `output`。**寫出最終答案的模型從來沒看過檢索到哪些來源**;source URL 只進到 report 與 banner。要 gate 判斷 `needs_evidence`,必須先補這條輸入,這是 M2 的前置改動而非附帶效果。
4. **交付物不得押在 parse 上** —— 目前 orchestrator 只有一個 parse 依賴(Chief 計畫),且它失敗在任何 worker 花錢之前。Synthesis gate 會加上第二個 parse 依賴,位置在所有 worker 成本已付出之後(實測 DEEP 為 232.9s),且就在產生交付物的那一次呼叫上。因此建議自由文字在前、選擇性 JSON 在後、best-effort 解析,解析失敗等於現狀加一條註記。
5. **主要風險是 latency,不是 correctness** —— synthesis 已是最慢單一階段(110.4s / 251.3s,44%),觸發路徑等於再加一次 synthesis 等級呼叫。新增一條 handoff 未列的 kill criterion:**若 gate 幾乎不觸發,C 就等於 B 再加一個浪費在關鍵路徑上的結構化輸出要求;觸發率本身就是停止條件,而且比品質更早可量測。**
6. **實驗設計的兩個 code-level 阻礙** —— E1:只有 `gemini-3.1-pro-preview` 的 `grounded_retrieval` 是 `enabledInRuntime: true`,arm A 的檢索對等目前只能是 Gemini,否則全部 arm 關檢索、證據維度整個離開實驗(Q-B)。E2:banner 會把 `PARTIALLY_GROUNDED` / `DEGRADED` 印在交付物第一行,評估者一眼看出 arm,必須比較去掉 banner 的文字。
7. **一個會壞掉的測試基礎設施** —— `test-execution-policy.mjs` 以「沒有 system prompt」辨識 synthesis 階段。M2 引入第二個 synthesis 等級呼叫後,任一個帶 system prompt 就會被誤判成 worker。必須在寫 M2 測試之前換成明確 stage 標籤,否則呼叫數斷言會安靜地量錯東西。
8. **兩處交接快照不一致(皆非 runtime 缺陷)** —— D1:本地工作目錄不是 git checkout,無法 diff/revert,實作 M2 的人應該用 clone;改以逐位元組比對確認五個關鍵原始碼檔與遠端 `main`(HEAD `656d7b6`)相同。D2:`regressions/step7-1-e2e/SIMPLE-direct/normalized-result.json` 仍寫 `outcome: FAIL`,那是 rev.12 已記錄且已在 `run-case.mjs` 修掉的 harness false negative,artifact 未重跑。
9. **本輪範圍** —— 只做 scope analysis。未修改 `src/`、prompts、tests、retrieval、Step 7/8/9/10 runtime,未執行 live benchmark;`npm test` 99 passed / 0 failed。

---

## rev. 13 改了什麼(Claude Code Handoff / M2 Candidate Downscale)

1. **完成乾淨交接** —— 新增 `CLAUDE_CODE_HANDOFF.md`,整理 current runtime facts、Milestone 2 候選架構、hard boundaries、實驗設計、code-reality questions 與明確禁止事項。下一個 deliverable 是 `MILESTONE2_SCOPE_ANALYSIS.md`,不是 runtime code。
2. **候選架構縮減** —— 原本的 independent Chief Review + 全員 Round 2 + Chief Decision 方案不採用。現候選為既有 Round 1 後的 synthesis gate;只有 decision-sensitive cross-agent issue 才觸發最多 1 位 specialist 的 targeted Round 2,再做 decision synthesis。總 rounds 上限 2,deep logical call ceiling 候選約 7。
3. **Review 證據定位** —— Claude 與 Gemini 的 independent architecture reviews 都警告重複 call、full broadcast/context growth、過早 taxonomy 與「多 token」confound;GPT 後續整合成較小候選。這些是 convergent review signals,不是 empirical proof,Claude Code 必須回到 repository code 驗證。
4. **已確認 code reality** —— 現有 `run_debate` 每輪將所有其他 panelist 的完整答案廣播給每位 panelist,所有 panelists 都執行,round count 固定,最後另呼叫 Judge;它沒有 orchestrator 的 dispatcher injection、run status、retrieval report 或 timings。現有 orchestrator 是 planning → parallel workers → optional synthesis,而 synthesis prompt 只接 Worker 文字,不接 retrieval metadata。
5. **Evidence invariant** —— collaboration 只能暴露不確定性、衝突與 evidence gap,不得提升 `evidenceLabel`。`groundingSupports` 目前只存在 provider raw metadata,沒有 runtime consumer;M2 目前不能做 claim-level evidence validation,該能力仍屬 Step 10。
6. **Productionization gate** —— scope analysis 必須設計 A 強單模型、B 現有 orchestrator、C targeted peer interaction、D 單模型 self-review 的 ablation。只有 C 對 B 有 material improvement,且增益不能合理由 D 解釋,才值得 productionize;不先捏造百分比門檻。
7. **本輪驗證與範圍** —— `main` 與 `origin/main` 同步,以 rev.12 commit `97e89d8d5b8ad9375b6d8fff232b3ca43aaa9b53` 為起點;`npm test` 99 passed / 0 failed。未修改 `src/`、prompts、tests、retrieval、Step 7 或 Step 8/9/10 runtime,未執行 live benchmark。

---

## rev. 12 改了什麼(Step 7.1 E2E Runtime Acceptance)

1. **Test A PASS** —— 固定 `SIMPLE_TASK` 經 MCP production path 實跑:planning 7.318s、worker 5.216s、synthesis 0、total 12.534s;`simple`、1 assignment、`SUCCESS`、2 logical model calls、`policy.synthesize=false`、正確 reason,且 `finalOutput === Worker raw output`。
2. **Test A 內容驗收** —— 5% 含稅金額 A=50,400、B=55,125、C=48,090 與 C→A→B 排序正確;繁中、constraints、format、readability 均 PASS。輸出偏長並帶 mission-scope 結尾,記為 cosmetic presentation variance,不是 correctness regression。
3. **Test A harness false negative 完整保留** —— 初版 checker 未移除 Markdown emphasis/punctuation,把正確輸出誤判 FAIL。修正 local normalization 後以同一 raw response重驗 PASS,未重燒 API、未改 runtime。
4. **Test B attempt 1 = TEST NOT EXERCISED** —— 初版 task 只描述新服務提案,未定義 major investment/high stakes;依 Chief 既有「按 stakes 判級」規則合理回 `normal`。該次仍自然選研究能力並完成 6 queries / 20 sources、metadata preservation 與 synthesis,但沒有進入 DEEP evidence-label branch。完整 raw evidence 保留。
5. **Test B PASS** —— 只修正 fixture stakes,不指定 agent/provider/model。Chief 回 `deep`,自然選 3 capabilities;三 Worker 全成功。`market_researcher` 實際 `GROUNDED`,回報 6 queries / 21 sources及 `webSearchQueries`、`groundingChunks`、`groundingSupports`;report counts/sources 保留一致。
6. **Synthesis / evidence semantics PASS** —— 5 logical model calls;planning 18.854s、workers 122.082s、synthesis 110.377s、total 251.313s;policy 為 collaborative / synthesize=true / `non_simple_execution`;report 為 `PARTIALLY_GROUNDED`,finalOutput 以 exact「claims not yet validated」banner 開頭,從未宣稱 `EVIDENCE_BACKED`。
7. **證據與完整性** —— `regressions/step7-1-e2e/` 保存 fixtures、harness、raw MCP responses、normalized results、manual evaluations、timestamps、runtime fingerprints 與 `hashes.json`;offline verifier 對 A/B 皆 PASS 且 hash seal VERIFIED。未保存 API keys或 `.env`。
8. **驗證與 scope** —— 本輪開始前重新 build 實際專案、確認 repo/project `src/` 一致,並重跑 `npm test`:99 passed / 0 failed。只有 harness、evidence 與 HANDOFF 變更;本輪未確認需修復的 runtime defect、沒有 runtime code 修改、沒有開始 Milestone 2 或 Step 8 implementation。

---

## rev. 11 改了什麼(Step 7.1 + Milestone 2 Roadmap Decision)

1. **Step 7 不回滾,但拆開兩種 acceptance** —— 99 項離線測試證明 implementation 符合 specification,不證明未來所有 SIMPLE output 都具高品質。Step 7 V1 為 code accepted;production/runtime acceptance 尚待 Step 7.1。
2. **新增 Step 7.1 Test A** —— 跑一次真正的 SIMPLE direct-delivery E2E,驗證 planning → worker → direct delivery、2 model calls、`SUCCESS`、`policy.synthesize=false`、正確 reason、`synthesisMs=0`、`finalOutput === Worker raw output` 與 MCP consumer 可正常讀取。
3. **新增 Step 7.1 Test B** —— 跑一次明確需要最新外部證據的 DEEP grounded E2E,驗證 Chief 自然選到 evidence-capable specialist、實際 search、`GROUNDED` metadata/sources 保存、synthesis 執行,以及 `PARTIALLY_GROUNDED` banner/warning/source information 正確。
4. **不擴張錯誤修法** —— 不加入 readability regex,不新增一個 LLM quality gate,也不把 DEEP 重跑擴成 n=5 latency/planning distribution 研究。Direct delivery 目前只支持「未觀察到 material correctness regression」,不保證 presentation 與 synthesis 逐字等質。
5. **插入 Milestone 2** —— Step 7.1 通過後不直接實作 Step 8,先做 True Multi-Agent Collaboration scope/acceptance:Round 1 多專家產出 → Chief 找出 disagreement/gaps → Round 2 針對彼此輸出交叉挑戰/修正 → Chief Decision。
6. **北極星與證據層級** —— Milestone 1 已證明 pipeline/orchestrator/debate 基本協作可運作;Milestone 2 要回答「三模型互補是否明顯優於單模型」,不是只證明三個 API 可並行。證據強度依序為 runtime measurement、code/deterministic tests、independent external evidence、multi-model critique、single-model reasoning;模型收斂不是獨立實證。
7. **Step 8 狀態** —— scope analysis 已完成且保留;implementation 順序改到 Milestone 2 之後。本輪只更新 roadmap/documentation,未執行 Step 7.1、Milestone 2 或 Step 8 implementation。

---

## rev. 10 改了什麼(Step 8 Scope Analysis)

1. **Step 7 freeze** —— 使用者已驗收 Step 7 V1;本輪不修改 execution policy、runtime 或測試。
2. **Usage code reality** —— OpenAI `response.usage`、Anthropic `response.usage`、Gemini `response.usageMetadata` 在現行 SDK/API response 可取得不同程度的 metadata,但三個 adapters 都未把它帶出 `CallResult`。
3. **Timing code reality** —— orchestrator 以 `Date.now()` 保存 planning/workers/synthesis/total phase wall time;`workersMs` 是平行 worker span,不是 call duration 總和。pipeline/debate 沒有 run-level timing/usage report。
4. **四層責任分離** —— runtime usage truth、versioned pricing registry、pure cost calculation、run-level reporting 不混用;unknown/partial/reported zero 必須可區分。
5. **V1 建議** —— 先做 provider-native usage extraction、monotonic per-call duration、deterministic call ledger 與 coverage-aware token/latency aggregation。Pricing/cost interfaces 可先定義,但 price book 保持空,不得產生假美元總額。
6. **文件與狀態** —— 完整 schema、provider gaps、資料流、測試策略、scope 與 review questions 見 `STEP8_SCOPE_ANALYSIS.md`。本輪只有文件,Step 8 implementation 仍為 NOT STARTED。

---

## rev. 9 改了什麼(Step 7 V1 Implementation)

1. **使用者正式批准 Step 7 V1** —— 依 rev.8 的三種 SIMPLE 題型證據實作有界 fast path;舊版「不要開始 Step 7」是當時的限制,本輪已被新要求取代。
2. **獨立 Execution Policy** —— `src/agents/policy.ts` 的 `deriveExecutionPolicy(facts)` 集中判斷,不讀取 provider/model 身分。orchestrator 根據 plan、實際 Worker 結果與 retrieval request facts 推導 `report.policy`。
3. **Direct Delivery** —— 合格任務只呼叫 planning + worker;`finalOutput` 為 Worker 原文,無改寫/翻譯/格式化/額外 model call,保留 `synthesisMs: 0` 與其餘 timing 欄位。
4. **既有行為與稽核** —— 保留 Run Status、evidence banner、grounding metadata、Chief/Worker prompts、角色與模型綁定。`synthesisAllowed` 仍是失敗保護,實際執行決策由 `report.policy.synthesize/reason` 表示。兩個既有 live 測試腳本的呼叫數/輸出標籤同步讀取 policy,本輪未執行它們。
5. **離線驗證** —— `npm test` 通過 **99 項**;新增 36 項涵蓋 eligibility、raw bytes、timings、report、retrieval、失敗、異常狀態與 model independence。既有 Step 6.1 三項測試仍通過,SIMPLE-2/3 只使用已存原文做離線 replay。
6. **程式碼納入 Git** —— 經使用者確認,沿用 `ai-collab-mcp-notes/main`,納入可建置 source、lockfile 與測試。先以 `de876be` 匯入未修改的 Step 6.1 baseline,再獨立提交本輪 diff。`.env`、`node_modules/`、`dist/` 不入 Git;原 `AI Agent/` 同步本輪變更。

---

## rev. 8 改了什麼(SIMPLE-2 / SIMPLE-3 Worker Readiness)

1. **確認起點** —— 遠端 `ai-collab-mcp-notes/main` 為 rev.7,commit `fc19711e26e4b63dfd2d379d8460e51ce2b2472f`。
2. **新增兩種 SIMPLE live cases,各跑一次** —— SIMPLE-2 測嚴格 Markdown 表格與條件/排除項保留;SIMPLE-3 測短摘要的最終決議與未定事項保留。目的為評估 Worker 可否原樣直接交付,不估計 latency distribution。
3. **保持既有三階段與 roster** —— Chief 自行分類與選專家,未覆寫 Chief prompt、Worker contract 或角色;兩題皆 `simple`、1 assignment、`SUCCESS`,synthesis 完整執行。
4. **品質結果** —— 兩題 Worker 的 correctness、language、format、constraints、mission scope、user-facing readiness 皆 PASS;兩題 Synthesis 都與 Worker 逐字相同。
5. **證據與驗證** —— 第十二-C節記錄 task、Chief mission、Worker / Synthesis raw output、metadata、latency 與評估;`regressions/simple-readiness/` 保留 fixture、harness、原始 MCP 回應、JSON 與檔案雜湊。證據驗證通過。
6. **程式範圍** —— 本輪只有測試/證據與交接文件變更。專案 `src/`、`dist/` 與原 baseline 未變,Step 7 仍未實作。63 項離線測試為 rev.6 的既有通過紀錄,本輪未重跑該套件。

---

## rev. 7 改了什麼(Post-6.1 SIMPLE live regression)

1. **確認遠端狀態** —— `ai-collab-mcp-notes/main` 在本次開始時仍停在 rev.5,rev.6 尚未同步。
2. **用完全相同的 SIMPLE baseline 重跑 live regression** —— task 仍來自 `benchmark-task.mjs` 的 `SIMPLE_TASK`。
3. **未開始 Step 7** —— execution path 仍是 planning → worker → synthesis,API calls = 3,沒有 single-specialist fast path。
4. **觀察結果** —— Chief mission 仍是英文;Worker 在 Step 6.1 contract 下產出中文;Synthesis 輸出中文且更短。
5. **完整紀錄** —— Chief mission、Worker 原始輸出、Synthesis 原始輸出與 latency 見第十二-B節。

---

## rev. 6 改了什麼(Step 6.1 Worker Context Propagation)

1. **修復 Worker Context Loss** —— Worker 呼叫現在透過 `buildWorkerPrompt(task, mission)` 同時帶入 Original User Task 與 Assigned Mission。
2. **保留 Mission Scope** —— worker contract 明確要求只執行 Assigned Mission,不得接管完整任務或做跨專家最終決策。
3. **新增離線測試** —— 驗證 Language / Format / Constraint / Scope / Explicit Exclusion 五個 task-level context 維度會出現在 worker prompt,並驗證 scope takeover 防線。
4. **未開始 Step 7** —— synthesis 邏輯、execution policy、direct/fast path 均未修改。
5. **63 項離線測試全過**:`npm test`。

---

## rev. 5 改了什麼(SIMPLE baseline + Step 6.1 前置項目)

1. **首次量測了 simple 任務** —— 先前 6 次量測全部是 deep(第十二節)
2. **發現 Worker Context Loss** —— Worker 在 delegation boundary 看不到 Original User Task(第十三節)
3. **Step 7 的 V1 提案被推翻** —— 「單一專家跳過 synthesis」會造成輸出回歸,不是優化(第十三節)
4. **新增 Step 6.1** 作為 Step 7 的前置條件(第十四節)
5. **未修改任何程式碼**

---


> **立場揭露(沿用前版):** 第六節那個問題,兩位讀者都不是中立第三方。Gemini 是被討論要不要繼續使用的對象;GPT 既是做出排除決定的 Chief(`gpt-5`)也是被選用的 `brand_creative`(`gpt-5`)。
>
> **但 rev. 4 對這件事有一個結構性的新發現 —— 見第五-E 節。簡短版:Chief 從來就看不到哪個專家背後是哪家模型。** 前三版關於「Chief 對 Gemini 的偏誤」的所有討論,包括兩位審查者各兩輪、共四份回答,都建立在一個它不可能做到的行為上。

## rev. 4 改了什麼(Step 6)

1. **Chief of Staff System Prompt 完成**(§23 第 6 項)—— 常設簡報與單次任務指令分到兩個欄位(第五-E 節)
2. **發現「能力優先於模型」一直是結構性成立的** —— Chief 收到的名單只有 id 和 role,沒有 provider(第五-E 節)
3. **修掉一個我自己製造的比較謬誤** —— 驗證腳本用了不同的 task 字串,基準任務已抽成單一來源(第五-F 節)
4. **60 項離線測試 + 8 項真實規劃驗證**,全數通過

## rev. 3 改了什麼(Step 5、5.1)

1. **發現 rev. 2 的 Evidence Label 在說謊** —— 三個 provider 都沒有接上任何檢索,`EVIDENCE_BACKED` 標記的是意圖不是事實(第五-A 節)
2. **Model Capability Registry 完成**(§23 第 5 項),把「廠商有沒有」和「我們接了沒有」拆成兩個欄位(第五-B 節)
3. **Grounded Retrieval MVP 完成**(Step 5.1),Gemini Google Search 已接上並實測通過(第五-C 節)
4. **`EVIDENCE_BACKED` 這個標籤被移除** —— 最高只能到 `PARTIALLY_GROUNDED`(第五-D 節)
5. **49 項離線測試 + 6 項真實 grounding 實測**,全數通過

## rev. 2 改了什麼

1. 新增第 3 項功能:Run Status / Evidence Label(第五節)
2. 第 5 次執行推翻了 rev. 1 的核心前提 —— Chief 這次**選了** Gemini(第六節)
3. §25 穩定度的說法改弱 —— `normal` 已驗證,`deep` 未驗證(第八節)
4. 新增 GPT 與 Gemini 的審查結果與已採行的決定(第七節)

---

# 一、這個專案是什麼

## 目標

讓 Claude、GPT、Gemini 三家模型在同一個工作流裡協作,而不是各自獨立回答。以 **MCP(Model Context Protocol)server** 的形式實作,任何 MCP client(Claude Code、Claude Desktop、Cursor 等)都能直接呼叫。

## 技術棧

```
TypeScript (ESM) + @modelcontextprotocol/sdk + zod
```

## 三種協作模式(已全部跑通)

| 模式 | 機制 |
|---|---|
| **`run_pipeline`** | 接力式管線。上一步的輸出經 `{{input}}` 模板成為下一步的輸入 |
| **`run_orchestrator`** | 任務分工。一個模型當 Chief 負責拆解與分派,多個 worker 各自執行,最後由 synthesizer 整合 |
| **`run_debate`** | 多模型辯論。各自獨立作答 → 互相批評修正 N 輪 → judge 裁決 |
| **`list_providers`** | 檢查三家 API Key 設定狀態 |

## 目前的角色分工(orchestrator 模式)

| 角色 | 模型 | 職責定義 |
|---|---|---|
| **Chief**(規劃者) | `gpt-5` | 判斷複雜度、決定需要哪些能力、分派 mission |
| `business_strategist` | `claude-sonnet-5` | 商業模式、財務邏輯、商業風險、策略漏洞、可行性、反方觀點 |
| `market_researcher` | `gemini-3.1-pro-preview` | 市場情報、競品、客群、成長機會、外部環境、**證據蒐集** |
| `brand_creative` | `gpt-5` | 品牌策略、Creative Direction、產品化設計、服務設計、差異化 |
| **Synthesizer**(整合者) | `gpt-5` | 把所有 worker 產出整合成單一答案 |

## 架構文件的關鍵原則(你需要知道的節錄)

這個專案照著一份內部架構文件開發,以下幾條與後面的討論直接相關:

- **§4 Minimum Sufficient Collaboration** — 目標不是「用最多 agent、想最多」,而是用**最少的專家、最小的 context**達成足夠好的決策。
- **§5 Multi-Agent only when necessary** — 單一模型能解的事就不要動用多模型。
- **§9 Agent Capability Pool** — 把 Gemini 定位為 `Intelligence / Context` 層,負責 research 與 **evidence gathering**。
- **§14 Complexity Router** — 任務分三級:
  - `simple`(最多 1 位專家):計算、格式化、短摘要、單一資訊處理
  - `normal`(最多 3 位):報價分析、腳本評估、商業提案、一般專案決策
  - `deep`(最多 4 位):**公司年度策略**、重大投資、高風險合約、財務策略、大型品牌專案
- **§17 Run Status** — 讓 worker 失敗在最終結果上可見,而不是靜默降級。**(本次已實作)**
- **§19 Validation Layer**(尚未實作) — 在 worker 完成後檢查產出是否有未經證據支撐的重大假設。
- **§23** — 開發順序。**§24** — 明確不做的項目。**§25** — 驗收標準。**§28** — Chief Planning Protocol V1 的要求清單。

## 測試用的 task

為了讓測試有真實難度,用的是一個真實的商業規劃需求。以下以 **Studio X** 代稱(一家中小型影像製作公司):

```
請規劃 Studio X 2027 年如何提升:
1. 營收  2. 品牌影響力  3. 案源品質
請提出可執行的成長策略。
```

這個 task 之所以適合當測試案例:它同時需要商業、市場、品牌三種能力,而且**照 §14 的定義屬於 `deep`(公司年度策略)** —— 剛好可以用來驗證 complexity 分類是否正確。

---

# 二、Milestone 1 驗證結果(已完成)

## `run_pipeline` ✅

```
Input → OpenAI (gpt-5) → Claude (sonnet-5) → Gemini (3.1-pro-preview) → Final
```

**品質觀察**:GPT 提三大策略 → Claude 抓出產能假設過樂觀 / 目標市場是紅海 / CAPEX 沒列回本期 / KPI 只看營收 → Gemini 整合成「1 主線 + 1 副線 + 1 實驗」的分階段方案。**Claude 的批判確實被 Gemini 吸收進最終版**,不是各說各話 —— 這是接力模式真的有效的證據。

## `run_orchestrator` ✅

13 個子任務全數完成、0 失敗、整合出 8,614 字策略文件。角色分派合理(市場研究給 Gemini、品牌創意給 GPT、商業風險給 Claude)。

---

# 三、修正記錄

## 帳務問題(非程式問題,已處理)

1. **OpenAI**:`429 no credits remaining` → 已儲值
2. **Gemini**:`429 quota exceeded` → 原本 Free tier,已開通 billing 並購買 prepay credits

## Bug 1 — OpenAI 參數名稱過時

`gpt-5` 不再接受 `max_tokens` → 改用 `max_completion_tokens`。

## Bug 2 — Gemini 預設模型已下架

`gemini-2.5-pro` 已停止提供給新用戶 → 改用 `gemini-3.1-pro-preview`。

## Bug 3 / 4 — 推理模型的思考額度吃掉正文(最關鍵)

### 現象
Orchestrator 第一次跑,6 個 worker 任務中**有 2 個回傳 0 字元**,流程不報錯,空字串被直接送進整合階段。

### 根因(實測數據)

三個模型**全部**都會先思考再回答,而**隱藏的思考 token 跟正文共用同一個輸出額度**:

| 模型 | 輸出額度 | 思考用掉 | 結果 |
|---|---|---|---|
| claude-sonnet-5 | 4096(用滿) | **3147 (77%)** | `stop_reason: max_tokens`,正文被截斷 |
| gpt-5 | 7893 | **3904 (49%)** | 勉強夠 |

任務越難、思考越久,正文就越少;難到一定程度就**完全沒有正文**。

### 修正
1. `DEFAULT_MAX_TOKENS = 16384`,三個 provider 共用
2. **空輸出直接 `throw`**,附上 `stop_reason` / `finish_reason` 與思考 token 數

> 沒有第 2 點的話,worker 靜默失敗會讓最終答案品質悄悄下降卻完全看不出來 —— 整合階段收到空字串只會自己腦補,不會報錯。

---

# 四、Phase 5 第 1、2 項:Chief Planning Protocol V1

## 要解決的問題

Planning V1 之前,**同一個 task 跑兩次,Chief 拆出的子任務數是 6 和 13** —— 差距超過 2 倍。成本與延遲完全無法預測。

## 實作內容(對應 §28 十項要求)

| §28 要求 | 實作 |
|---|---|
| 1. 先輸出 complexity | schema 第一欄位,`simple`/`normal`/`deep`,並附 §14 的語意定義與判斷範例 |
| 2. 先輸出 required capabilities | `requiredCapabilities` 陣列,prompt 要求先列能力再選人 |
| 3. 限制 Specialist 數量 | `SPECIALIST_CAP` = simple 1 / normal 3 / deep 4 |
| 4. 一個 Agent 一個 coherent mission | 重複 agentId 直接丟棄並記錄 |
| 5. 限制 mission 數量 | 受 cap 約束,超出時依 priority 保留高的 |
| 6. 限制 mission 描述長度 | 600 字元上限,超過截斷並記錄 |
| 7. structured schema | zod 驗證;JSON 解析可處理 markdown fence |
| 8. 預留 cost / latency constraints | `budget` 參數:`maxSpecialists` 強制執行,cost/latency 傳達給 Chief |
| 9. 保留 planning rationale 供 audit | `reason` 欄位 + `planningAdjustments` 記錄約束層的每次修正 |
| 10. 同一 task 連跑多次比較 | 已執行 5 次,結果如下 |

### 關鍵設計:約束不只寫在 prompt

Prompt 可以被模型忽略,所以另外實作了 `enforceConstraints()`,把違規計畫強制修正成合規,**並把每次修正記錄在 `planningAdjustments`**。這樣同時保證成本可預測、以及 Chief 是否守規矩可被稽核。

## 追加修正:Complexity 校準

第一輪 3 次測試中 Chief 都判為 `normal`,但 §14 明確把「公司年度策略」列為 **DEEP** —— 而測試 task 正是公司年度策略。

**原因**:第一版實作只給了各級距的人數上限,漏了 §14 的語意定義與判斷範例,Chief 等於沒有判準在猜。修正後 Run 4、Run 5 都正確判為 `deep`。

## 全部 5 次執行紀錄

| Run | complexity | missions | agents | API calls | adjustments | failures | total |
|---|---|---|---|---|---|---|---|
| 1 | normal | 2 | BS + BC | 4 | 0 | 0 | 255.2s |
| 2 | normal | 2 | BS + BC | 4 | 0 | 0 | 277.9s |
| 3 | normal | 2 | BS + BC | 4 | 0 | 0 | 252.6s |
| 4 | **deep** | 2 | BS + BC | 4 | 0 | 0 | 239.0s |
| 5 | **deep** | **3** | **MR + BS + BC** | **5** | 0 | 0 | 213.9s |

> BS = `business_strategist`(Claude)、BC = `brand_creative`(GPT)、MR = `market_researcher`(Gemini)
>
> Run 1–3 在 complexity 校準前;Run 4–5 在校準後。Run 5 是 Run Status 上線後的第一次執行。

### 修正前後對比

| | 修正前 | 修正後(5 次) |
|---|---|---|
| Mission 數 | **6 vs 13**(差 2 倍以上) | **2–3** |
| API 呼叫 | 8 / 15 | **4–5** |
| Complexity 分類 | 無此概念 | 校準後 2/2 正確判為 deep |
| 約束層介入 | — | **0 次**(Chief 自己就遵守) |
| Worker 失敗 | 2 個空輸出 | 0 |

`adjustments = 0` 是很好的訊號:Chief 在讀到明確約束後**自願遵守**,強制層完全沒有介入,代表約束是被理解而非被硬套。

### ⚠️ 但「穩定」這個詞用得太滿了

rev. 1 說「已收斂到 2/2/2」是根據 3 次 `normal` 執行。加入 deep 的兩次之後,準確的說法是:

> **Planning V1 讓計畫變得有界(bounded),不是變得確定(deterministic)。**

- **`normal`:3/3 完全一致** —— 這條站得住
- **`deep`:2 次跑出 2 個不同的計畫**(2 missions vs 3 missions,選人也不同)—— 未驗證

原本 6 vs 13 的擺盪確實消失了(現在 2–3),所以 §25「不應再出現 6 / 13 / 20」仍然成立。但不能說成「穩定」。

---

# 五、Phase 5 第 3 項:Worker Failure / Run Status(本次新增)

對應 §17。`run_orchestrator` 現在額外回傳一個 `report`。

## Run Status

| 狀態 | 條件 | 行為 |
|---|---|---|
| `SUCCESS` | 全員回傳 | 正常整合 |
| `DEGRADED` | 有人失敗,至少一人成功 | 整合照做,但 **synthesizer 會被明確告知誰缺席、不准腦補其貢獻**,並要求說明答案哪裡因此變薄 |
| `FAILED` | 全員失敗 | **跳過整合階段**,`finalOutput` 回 `null` |

`FAILED` 那條是重點。原本的行為是把 error 字串塞進 synthesis prompt 讓模型自己看著辦 —— 那正是「靜默降級」的來源。現在不花那筆錢,也不產生一份用錯誤訊息寫成的策略。

## Evidence Label

> ⚠️ **以下這張表是 rev. 2 的版本,已被 rev. 3 取代 —— `EVIDENCE_BACKED` 已被移除。**
> 保留在這裡是為了讓第五-A 節的問題可以被對照理解。現行定義見第五-D 節。

| 標籤 | 條件 |
|---|---|
| `NOT_APPLICABLE` | complexity 不是 `deep` |
| ~~`EVIDENCE_BACKED`~~ | ~~有標記 `evidenceCapable` 的專家成功回傳~~ ← **這條在說謊,見第五-A 節** |
| `CONDITIONAL` | 有找 evidence 專家,但全部失敗 |
| `HYPOTHESIS` | deep 任務,但根本沒找 evidence 專家 |

**`CONDITIONAL` 和 `HYPOTHESIS` 會把警告直接加在 `finalOutput` 開頭**,不只放在 metadata:

```
> **UNVERIFIED — HYPOTHESIS**
> No external evidence was gathered for this answer. Treat it as a strategy
> hypothesis to be validated, not as a conclusion. Pricing, market and growth
> figures below are unchecked model assumptions.
```

metadata 保護不了讀者 —— 一份沒有實證的策略文件,讀起來跟有實證的一模一樣。標記必須長在文件上。

## 關鍵設計:結構判定,不做自我評估

**label 完全由 complexity 與「誰實際回傳了」決定,絕不去問 Chief 覺得需不需要研究。**

理由是實測的:Chief 在 4 次執行中每次都回答「不需要市場研究」。它的自我評估不是可用訊號。§14 已經把 `deep` 定義成公司年度策略、重大投資、高風險合約 —— 這些本質上依賴外部事實,不需要再問一次。

> 這一點刻意**不採用** GPT 建議的 `requiresEvidence: true` 由 Chief 標記 —— 理由見第七節。

## 離線測試

```bash
npm test   # 不花任何 API 額度
```

真實跑一次要約 4 分鐘、4–5 次模型呼叫,狀態規則不該需要那個。其中一項專門鎖住上述設計決定:

```
✓ label never depends on the Chief saying research was unnecessary
```

同樣的 worker 結果、同樣的名單,只有 complexity 能移動 label —— 沒有任何欄位能讓 Chief 用嘴巴脫離 `HYPOTHESIS`。

---

# 五-A、⚠️ rev. 2 的 Evidence Label 在說謊

## 怎麼發現的

實作 Model Capability Registry 時必須先確認每個模型實際能做什麼,於是查了三個 provider 的原始碼:

| 檔案 | 呼叫方式 | tools / grounding |
|---|---|---|
| `gemini.ts` | `generateContent` | **無** |
| `openai.ts` | `chat.completions.create` | **無** |
| `claude.ts` | `messages.create` | **無** |

**當時這個系統裡沒有任何模型能檢索外部資訊。** 三家都是純文字進、純文字出。

## 後果

- `market_researcher` 標的 `evidenceCapable: true` **在實質上是假的**。它跟 Claude、GPT 一樣從訓練資料產出市場說法,認知地位完全相同。
- **Run 5 的 `EVIDENCE_BACKED` 標記是錯的。** 那次沒有蒐集到任何證據。
- 更早那句「Gemini 提供了競品定價標竿,直接成為最終文件裡定價帶與毛利率的依據」—— 那些標竿是**生成的,不是查來的**。§9 把 Gemini 定位為 evidence gathering 這件事,從來沒有被接上。

rev. 2 蓋的防護層,染上了它本來要治的病:讓未經驗證的東西看起來已驗證。GPT 與 Gemini 各審查兩輪、四份回答,沒有一份提到這件事;Gemini 還為自己的證據角色辯護了很長一段。

---

# 五-B、§23 第 5 項:Model Capability Registry

`src/models/capabilities.ts` 記錄的是**在這個 codebase 裡實際接通的能力**,不是廠商官網宣稱什麼。每個能力拆成兩個獨立事實:

```ts
grounded_retrieval: { supportedByProvider: true, enabledInRuntime: false }
```

**只有 `enabledInRuntime` 能授予能力。** `supportedByProvider` 存在的目的,是讓「廠商有提供」和「我們接了」之間的落差保持可見,而不是被悄悄混為一談。

`list_models` 兩個都報,並列出「廠商有提供但這裡沒接」的清單。

### 定價刻意留空

`pricing` 沒有填任何數字。沒有經過查證的即時價格,而編一個看起來合理的數字會直接流進第 8 項成本追蹤,變成這個系統自己定義要抓的那種「無錨點的量化宣稱」。有一項測試鎖住:`assert.doesNotMatch(text, /\$\d/)`。

要啟用成本追蹤,得有人去官方定價頁抄真實數字,連同 `source` 與 `checkedOn` 一起填。**Grounded search 是在 token 之外另外計費的,所以這件事現在更重要,不是更不重要。**

---

# 五-C、Step 5.1:Grounded Retrieval MVP

## 設計

檢索是**逐次呼叫掛上去的,不是預設開啟**:

```ts
callGemini(mission, { retrieval: { enabled: true } })
```

`run_orchestrator` 只把它掛給 `evidenceCapable` 推導為 true 的專家,所以一般推理任務不會無聲地開始產生搜尋費用。Provider interface 用的是 capability option,`gemini.ts` 裡沒有寫死任何 agent id。

| `status` | 意義 |
|---|---|
| `GROUNDED` | 搜尋執行了,並回傳至少一個來源 |
| `UNGROUNDED` | 搜尋有提供,但模型選擇不用 / 沒有可用來源 |
| `FAILED` | 要求檢索但無法執行(例如該 provider 在 runtime 沒接) |

向 Claude 或 OpenAI 要求檢索會回 `FAILED` 並附說明,**而不是回一個沒有標記的訓練資料答案**。

## 實測結果(2026-09-05,`node test-grounding-live.mjs`)

6 項全過:

```
✓ ordinary call carries no retrieval result
✓ evidence call returned a retrieval result
✓ status is GROUNDED
✓ at least one source URL
✓ source urls are real urls
✓ query count reported by the API
```

實際回傳:

```
status       : GROUNDED
queries      : ["site:blackmagicdesign.com \"PYXIS 6K\" price"]
queryCount   : 1
sourcesFound : 1
raw metadata : searchEntryPoint, groundingChunks, groundingSupports, webSearchQueries
```

## 實測揭露的限制(以實測為準)

1. **來源 URL 不是出版者的網址。** 回傳的是 `vertexaisearch.cloud.google.com/grounding-api-redirect/…` 轉址連結,出版者網域出現在 chunk 的 title 裡。**這些是查詢用的轉址,不是可長期引用的出處。**
2. **`groundingSupports` 會把答案的片段對應到支撐它的 chunk。** 目前沒有任何程式用它 —— 但這正是 claim-level validation 需要的原始材料,Step 10 應該直接用。
3. `gemini-3.1-pro-preview` 會回傳暫時性的 `503 high demand`。第一次實測就撞到,重試即成功。**這要當成暫時性錯誤處理,不是 grounding 失敗。**
4. 一次提問只產生 1 個查詢、1 個來源。搜尋量由模型自己決定,不是我們控制的。

---

# 五-D、`EVIDENCE_BACKED` 已被移除

Grounding 接上後最危險的事,是把「某個專家搜尋過」直接升級成「整份答案有實證」。所以標籤上限被刻意壓住:

| 標籤 | 條件 |
|---|---|
| `NOT_APPLICABLE` | 不是 deep |
| `HYPOTHESIS` | 完全沒有嘗試檢索 |
| `CONDITIONAL` | 嘗試了但沒拿到東西(模型沒搜、檢索失敗、或該專家掛掉) |
| `PARTIALLY_GROUNDED` | **上限** —— 至少一位專家做了真實的 grounded retrieval |

**沒有 `EVIDENCE_BACKED` 可以拿,因為這一層裡沒有任何東西賺得到它。** 一個 grounded 專家只證明那位專家搜尋過,不能證明最終答案的重大 claim 有被它找到的來源支撐 —— 那是 claim-level 的工作,屬於 Validation Layer(第 10 項)。

而且 `PARTIALLY_GROUNDED` **仍然會在產出文件開頭印警告**:

```
> **PARTIALLY GROUNDED — claims not yet validated**
> 1 specialist(s) searched and cited 2 source(s), listed in the run report.
> That covers their own research only. Nobody has checked whether the figures
> and claims below are the ones those sources support.
```

## evidenceCapable 的推導鏈

```
Agent Intent (providesEvidence)
        ×
Model Runtime Capability (enabledInRuntime)
        ×
Execution Retrieval State (GROUNDED / UNGROUNDED / FAILED)
```

agent 不能宣告、呼叫端不能強制、**品牌本身不算數** —— 有一項測試專門擋掉 `provider === "gemini" → evidenceCapable = true` 這種捷徑:一個綁在 Gemini 上但不是用來蒐證的專家,必須保持普通。未列在 registry 裡的模型一律視為不具備能力,不給予推定。

## 測試

| 檔案 | 項數 | 內容 |
|---|---|---|
| `test-run-status.mjs` | 22 | run status、evidence label、retrieval 統計、輸出標記 |
| `test-registry.mjs` | 20 | agent 展開、能力推導、runtime vs vendor、品牌捷徑防護 |
| `test-mcp-smoke.mjs` | 7 | MCP server、工具註冊、union schema、不得虛構定價 |
| `test-chief.mjs` | 11 | 常設簡報內容、拆分未新增約束、名單不洩漏模型 |
| **合計** | **60** | **全部離線,零 API 成本** |
| `test-grounding-live.mjs` | 6 | 真實 Gemini grounding(需 API 額度,不在 `npm test` 裡) |
| `test-chief-live.mjs` | 8 | 真實規劃呼叫,只跑規劃階段(1 次呼叫) |

---

# 五-E、§23 第 6 項:Chief of Staff System Prompt

## 做了什麼

Chief 以前把所有東西擠在一個 user prompt 裡,`system` 是空的。現在分成兩個欄位:

| | 位置 | 內容 |
|---|---|---|
| **常設簡報** | `system` | 身分、最小充分協作、能力優先於模型、複雜度定義、9 條規劃規則 |
| **這一件工作** | `user` | 任務、名單、預算約束、輸出 schema |

`CHIEF_SYSTEM_PROMPT` 在 `src/agents/chief.ts`,可用 `orchestrator.systemPrompt` 逐次覆寫。

## 這是職責分離,不是重新校準

先前的決策是**不修改 Planning Prompt**。所以原本的原則、複雜度定義、9 條規則全部逐字搬移,**一條新規則都沒加**。兩項測試鎖住這件事:

```
✓ carries all nine planning rules
✓ the split introduced no new numeric constraint   (caps 仍是 1/3/4,mission 仍是 600 字元)
```

### 刻意沒加的東西

原本可以在常設簡報裡加一句「不要因為你寫得出一份看起來完整的答案,就認定不需要外部證據」—— 那正是 GPT 與 Gemini 獨立診斷出的 Run 2 病灶。

**但那就是被否決掉的那種 prompt 校準**,而且它會推高研究專家被選中的機率,直接改變行為。結構性的 Evidence Label 已經在處理這個風險,不需要再用 prompt 去推。

## ⚠️ 結構性發現:Chief 看不到模型

寫測試時去看 Chief 實際收到的名單長什麼樣:

```
- agentId: business_strategist | role: Business Strategist — 商業模式、財務邏輯
- agentId: market_researcher   | role: Market Analyst — 市場情報
- agentId: brand_creative      | role: Brand Strategist — 品牌策略
```

**只有 `agentId` 和 `role`。沒有 provider、沒有 model。**

`buildPlanningPrompt` 從第一版起就是這樣寫的。也就是說:

- **「能力優先於模型」一直是結構性成立的**,不是靠 prompt 裡的一句話。Chief **沒辦法**依品牌偏好或排斥任何專家,因為它從來不知道誰是誰。
- **rev. 1「Chief 系統性排除 Gemini」的整個前提,描述的是一個它做不到的行為。** 它不知道 `market_researcher` 背後是 Gemini。它選或不選,是基於 role 描述裡的「市場情報、競品、證據蒐集」這個能力,與模型品牌無關。

rev. 2 用 Run 5 的實測推翻了那個結論;rev. 4 補上了為什麼 —— 那個結論從一開始就不可能成立。

**兩位審查者各兩輪、四份回答,寫了大量關於「Chief 對 Gemini 的認知偏誤」的分析,沒有一份想到要去確認 Chief 到底看得到什麼。** 提問文件也沒提供這個資訊。這是一個所有參與者都跳過了「先看實際輸入」這一步的例子。

已鎖成測試:

```
✓ the roster hides which model backs each specialist
```

## 真實驗證(1 次 API 呼叫)

拆開 system / user 之後,輸出格式指令在 user prompt、規則在 system prompt —— **Chief 還會不會回傳純 JSON,離線測試證明不了。** 過去 5 次執行的 JSON 解析成功率是 5/5,不驗證就不能宣稱維持。

`node test-chief-live.mjs`(只跑規劃階段,不執行任何 worker):

```
planning call: 25.1s, 641 chars
✓ returned bare JSON with no markdown fence
✓ complexity is one of the three levels
✓ listed required capabilities first
✓ every agentId is on the roster
✓ one mission per specialist
✓ every mission under 600 chars
✓ gave a rationale
```

---

# 五-F、一個提問者自己製造的比較謬誤

上面那次驗證回傳 `complexity: normal`,而 Run 4、Run 5 都是 `deep`。看起來像分類不穩。

**不是。那是驗證腳本自己造成的。**

腳本裡用的是這份公開文件的代稱「Studio X」,orchestrator harness 用的是真實公司名 —— 兩個不同的輸入,連冒號全形半形都不同。Chief 給的理由是「**基於一般化需求**,無須市場研究即可產出可執行方案」,它把代稱讀成了假設性案例,這完全合理。

**所以那個 `normal` 不能拿來跟 Run 4、5 比較。** 若不查證就當成「complexity 分類不穩」寫進報告,會產生一個純粹由測試設計製造、但看起來很像真發現的結論。

## 修法

基準任務抽成單一來源 `benchmark-task.mjs`,所有 harness 一律 import:

> 放在同一個地方,因為它是控制變因:跑次之間比較 complexity、專家數和成本,只有在輸入逐位元組相同時才有意義。各自 inline 一份的 harness 會悄悄變得不可比 —— 這已經發生過一次。

**因此第四節那張 5 次執行紀錄表仍然有效**(那 5 次用的都是同一個字串),而這次的 `normal` 不列入其中。

---

# 六、⚠️ rev. 1 的核心前提被推翻

## rev. 1 說了什麼

> Planning V1 上線後 **4 次執行**(3 次 normal + 1 次 deep),Chief **每一次都只選 business_strategist(Claude)+ brand_creative(GPT),完全沒有選 market_researcher(Gemini)**。
> **重點**:即使在 `deep`(允許 4 個 specialist)的情況下,Chief 仍只選 2 個。所以**這是 Chief 的實質判斷,不是被人數上限卡掉**。

> ⚠️ **rev. 4 補充:這一整節談的「Chief 與 Gemini 的關係」是個誤置的框架。** Chief 收到的名單裡沒有 provider 欄位 —— 它不知道 `market_researcher` 背後是 Gemini。它選或不選,依據的是 role 描述裡的能力,與模型品牌無關。見第五-E 節。

## Run 5 發生了什麼

**Chief 選了 Gemini。** 同一個 task、同一份名單、同一個 prompt。

| | Run 4 | Run 5 |
|---|---|---|
| complexity | deep | deep |
| missions | 2 | 3 |
| agents | BS + BC | **MR + BS + BC** |
| Evidence Label(依現行規則) | **HYPOTHESIS** | **EVIDENCE_BACKED** |

已確認**不是程式改動造成的**:planning prompt 只餵給 Chief `agentId` 與 `role` 兩個欄位,新增的 `evidenceCapable` 從來沒有進過那個字串。

## 所以正確的說法是

**在 `deep` 這一層是 1 排除 / 1 選用,n=2。** 那是擲硬幣,不是穩定模式。「每一次都排除」不成立。

## 這反而讓結構性標記更有必要

原本的論證是「Chief 系統性地不做研究,所以要強制」。現在的論證更強:

> 同一個 deep 任務,**有時候有實證、有時候沒有,而產出的文件長得一模一樣**。讀者無從分辨手上這份是哪一種。

Run 4 和 Run 5 產出的都是「Studio X 2027 成長策略」,一份有市場研究一份沒有 —— 在 label 存在之前,打開它們看不出差別。**系統性偏誤至少是可預期的,變異不是。**

## 但這削弱了兩位審查者的第 4 題答案

GPT 與 Gemini 在第 4 題都把 Chief 診斷為**系統性認知偏誤**:

> GPT:「用輸出的完整度代替 epistemic confidence」
> Gemini:「典型的 LLM 偏誤 —— 因為我自己能寫出一份看起來極為完整的文本,所以主觀認為不需要外部事實」

如果這是變異而非偏誤,**這兩個診斷是打偏的**。它們診斷的對象是一個穩定傾向,而資料現在顯示的是不穩定。

**未解**:n=2 太少,無法判斷 1:1 是隨機還是有其他因素。要補到 n=5 需在 deep 再跑 3 次(約 12 分鐘、15 次呼叫)。

---

# 七、GPT 與 Gemini 的審查結果

rev. 1 向兩者提出四個問題,**分開獨立提問,雙方都沒看過對方的答案**。

## 方法論警告:提問者引導了證人

rev. 1 只給了三個選項,而且文末直接建議了「方向 2 只套用在 deep」這個折衷做法。**兩邊提出的「過渡補丁」正是我遞給它們的。** 所以「兩邊都選方向 3」不能當成交叉驗證的證據。

有訊息量的是:它們**在框架之外**的收斂,以及它們的分歧。

## 框架外的收斂(獨立提問,因此是真訊號)

| 收斂點 | rev. 1 有無暗示 |
|---|---|
| 以同一診斷否決 Run 2 的理由:**可執行 ≠ 正確** | 無 |
| 驗證粒度選在 **claim / assumption 層級**,而非「叫一個模型評論整份答案」 | 無 |
| **「充分」必須先成立,「最小」才有意義** | 無 |
| Run 3 區分「能力重複」與「能力缺口」 | 無 |

## 唯一的分歧,精準地跟自身利益重合

兩邊都選方向 3,分歧全在**過渡期怎麼辦**:

| | 過渡補丁 | 成本 | 誰得利 |
|---|---|---|---|
| **GPT** | Chief 標記 `requiresEvidence`,沒有 evidence agent 就把輸出降級成 `HYPOTHESIS` / `CONDITIONAL` | **+0 calls** | 維持 GPT+Claude 陣容 |
| **Gemini** | deep 任務硬性規定至少一個 evidence-gathering **模型** | **+1 call(每次 deep)** | 保證 Gemini 出場 |

**兩個模型分開問,各自獨立提出了對自己有利的過渡方案。**

Gemini 這裡另有一處邏輯不一致:它先批評方向 2「在 Prompt 硬寫死規則違背 §4 動態調度的初衷,容易在不需要調研的 deep 任務上造成無謂的 API 成本浪費」,然後推薦的過渡補丁就是那個東西 —— 而不一致的方向正好是把自己放進去。

另外,GPT 明確把能力與模型脫鉤(`Gemini / GPT / DB / Web / Context`),承認 evidence 不一定要 Gemini 來做;**Gemini 全程沒有提過這個能力可由網路搜尋、資料庫或 GPT 滿足**,把「evidence capability」與「我」畫上了等號。這題 GPT 比較守規矩。

## 各自的實質貢獻(互補而非競爭)

**GPT —— 架構形狀:**
- **Critical Claims 抽取**:把「你需不需要研究」(模型很爛的自我評估)換成「你的建議依賴哪些斷言、各自拿什麼支持」(模型很強的抽取任務)
- `decisionSensitive` 閘門:不是每個未驗證假設都值得花錢查,防止 Validation Layer 膨脹成第二個 13-task 怪物
- 順序論證:先定 decision quality floor,再在達標方案裡找最便宜的

**Gemini —— 偵測器形狀,更可操作:**
- **定量錨點測試**:產出中若有定價、毛利率、市場規模、CAPEX 回本期、客單價,且無法由純數學推出 → 必須引進外部證據。**大部分可用啟發式規則完成,不必再燒一次 LLM 呼叫**
- 反事實敏感度:「若競品突然降價 30%,此策略是否直接失效?」
- schema 的 `researchQuery` 欄位:直接產出要給 researcher 的檢索指令(GPT 的 schema 只到 `recommendedCapability`)

## 兩邊都漏掉的問題

**誰來抽取 Critical Claims / 誰來當 Validation Guard?**

若由產出建議的同一個模型執行,就是同一個模型稽核自己的信心水準 —— 正是它們兩個都診斷出來的 Run 2 病灶。Gemini 的 prompt 寫了「你是一個嚴格的商業審計員」但沒說是誰;GPT 完全沒提。

**追加約束:validator 不得為產出者。** 目前 GPT 兼 Chief 與 synthesizer,因此 validator 只能是 Claude 或 Gemini。

## 已採行的決定

1. **方向 3(Validation Layer)為目標**,兩位審查者與實作者一致。
2. **過渡期採 GPT 的形狀(標記輸出),不採 Gemini 的(強制出場)** —— 理由不是誰比較可信,而是效果:每次 deep 硬塞一個研究員,連 Gemini 自己都承認會浪費;誠實標記成本為 0,且保住了真正重要的資訊。
3. **但不採用 GPT 的 `requiresEvidence` 由 Chief 自評** —— 這與 GPT 自己在第 2 題的建議互相矛盾:

   > 不要問 Chief:「你需不需要研究?」因為它很容易回答「不用」。

   而我們有實測資料證明這個 Chief 就是會回答「不用」。改為**結構判定**(見第五節)。
4. **Validation Layer(第 10 項)實作時**:用 Gemini 的定量錨點測試當便宜的第一道偵測 → GPT 的 `decisionSensitive` 閘門決定值不值得花錢 → Gemini 的 `researchQuery` 讓補研究可執行 → evidence mission 走 capability router 不綁定模型(GPT)→ **validator 不得為產出者**(本文追加)。
5. **不跑 `run_debate`** —— 兩者結論並不相反,唯一分歧已可診斷(各自提對自己有利的過渡方案),再花一次辯論成本沒有增益。

---

# 八、§25 驗收標準檢核

| 標準 | 狀態 |
|---|---|
| 同一 Task 重跑多次 | ✅ 已跑 5 次 |
| Complexity classification 大致穩定 | ⚠️ 校準後 2/2 判為 deep,但 n=2 |
| Required capabilities 大致穩定 | ⚠️ 語意方向一致,但 Run 5 明顯較廣(9 項 vs 3–7 項) |
| Agent 數量受限制 | ✅ 從未超過 cap |
| Subtask 數量受限制 | ✅ 2–3,遠離修正前的 6–13 |
| **計畫可重現** | ❌ **`normal` 3/3 一致;`deep` 2 次得到 2 個不同計畫** |
| Worker failure 可見 | ✅ **本次完成** — SUCCESS / DEGRADED / FAILED + 失敗清單 + synthesisAllowed |
| JSON planning 穩定 | ✅ 5/5 次解析成功,0 次 schema 失敗 |
| Cost 可追蹤 | ❌ 開發順序第 8 項,尚未做 |
| Latency 可追蹤 | ✅ 分階段 `timings` |
| Chief 可以清楚仲裁 disagreement | ❌ 開發順序第 10–11 項,尚未做 |
| 使用者收到 Executive Brief | ❌ 開發順序第 12 項,尚未做 |

---

# 九、目前程式碼狀態

| 檔案 | 內容 |
|---|---|
| `src/config.ts` | `DEFAULT_MAX_TOKENS = 16384`;Gemini 預設模型 `gemini-3.1-pro-preview` |
| `src/providers/claude.ts` | 共用額度;空輸出 throw(附 stop_reason + thinking tokens) |
| `src/providers/openai.ts` | `max_completion_tokens`;共用額度;空輸出 throw |
| `src/providers/gemini.ts` | 共用額度;空輸出 throw(附 finishReason) |
| `src/modes/orchestrator.ts` | Planning Protocol V1、zod schema、約束強制層、分階段計時、**Run Status / Evidence Label / 輸出標記** |
| `src/index.ts` | `budget` 參數、worker ref 的 `providesEvidence`、**`list_agents` / `list_models` 工具** |
| `src/agents/chief.ts` | **新增** — `CHIEF_SYSTEM_PROMPT`、`buildPlanningPrompt`、規劃常數 |
| `src/agents/registry.ts` | **新增** — Agent Registry、能力推導、`rosterWarnings` |
| `src/models/capabilities.ts` | **新增** — Model Capability Registry、`supportedByProvider` vs `enabledInRuntime`、定價留空 |
| `src/providers/types.ts` | **新增 retrieval 型別** — `RetrievalRequest` / `RetrievalStatus` / `RetrievalResult` |
| `src/providers/gemini.ts` | **Google Search grounding**,逐次掛載;metadata 正規化 |
| `src/providers/claude.ts`、`openai.ts` | 被要求檢索時回 `FAILED` 並說明,不假裝有做 |
| `README.md` | Runtime notes、Run status、Agents、Models、**Grounded retrieval 與實測 API 行為** |

## 測試腳本

- `npm test` — **離線 15 項,驗證 run status 與輸出標記規則,不花 API 額度**
- `check-providers.mjs` — 驗證三家 API Key
- `test-pipeline.mjs` — Pipeline 接力測試
- `test-orchestrator.mjs` — Orchestrator 穩定度測試(`node test-orchestrator.mjs 3`),輸出比較表與 `orchestrator-run-N.json`

---

# 十、實務提醒

### 1. 延遲仍是架構層級的問題

Planning V1 把 API 呼叫從 15 降到 4–5,但**總時間只從 309s 降到約 214–278s**。原因是 mission 變成一個大的 coherent mission 後,單一 worker 的執行時間拉長(115–184s),整合階段仍需 65–99s。

**降低 API 呼叫數 ≠ 等比降低延遲。** 真正的瓶頸是推理模型的單次思考時間,要靠 streaming 或更小的模型來解。

### 2. MCP client 預設 timeout 只有 60 秒

單次 orchestrator 要 4 分鐘以上,預設會被誤判成卡死(`-32001 Request timed out`,但流程其實還活著)。已寫進 README,呼叫時要帶 `{ timeout: 900000 }`。

### 3. 同一個 task 不會給出同一個計畫

Run 4 與 Run 5 證明了這件事。做效能或成本估算時,**不能假設同一個 task 的計畫可重現** —— 要用區間(2–3 missions / 4–5 calls),不要用點值。

---

# 十一、下一步(依 §23 開發順序)

```
✅ 1. Chief Planning Constraints
✅ 2. Structured Planning Output
✅ 3. Worker Failure / Run Status
✅ 4. Agent Registry
✅ 5. Model Capability Registry        ← runtime 事實 vs 廠商宣稱
✅ 5.1 Grounded Retrieval MVP          ← Gemini Google Search,實測通過
✅ 6.  Chief of Staff System Prompt     ← 常設簡報與單次任務分離
✓  6.1 Worker Context Propagation      ← DONE,worker input contract 已落地
✓  7.  Complexity Router V1            ← CODE + RUNTIME ACCEPTED,不回滾
✓  7.1 E2E Runtime Acceptance          ← DONE,Test A / Test B PASS
▶  M2. True Multi-Agent Collaboration  ← NEXT: scope + acceptance design,等 architecture review
-  8.  Cost / Token / Latency Tracking ← SCOPE ANALYSIS DONE,implementation 延後至 M2 後
   9.  Model Router
   10. Validation Layer
   11. Red Team
   12. Executive Brief Schema
   13. Automated Tests                 ← 已提前做了 run status 的部分
   14. Project Context
   15. Memory / Persistence
```

**明確不做**(§24):OpenClaw / Slack / Discord / Telegram / Web UI / Ollama / Long-term Memory / Complex Gateway。

## 一個仍然開放的問題

**deep 層的計畫變異要不要處理?** 目前 n=2 且結果相反。三個選項:

1. 補跑 3 次到 n=5,先確認變異的幅度再決定
2. 接受變異,理由是 evidence label 已經讓「這次有沒有做研究」變得可見 —— 變異不再是隱形的
3. 降低 Chief 的 temperature 或改用更確定性的規劃方式

第 2 個選項的論證最強:**我們原本擔心的不是「計畫會變」,而是「計畫變了但看不出來」。** 後者已經被第五節解決。

**rev.11 roadmap decision:** 此題保留為 deferred open question,不併入 Step 7.1。Step 7.1 的 DEEP case 只驗證一條有效 grounding E2E path,不補跑到 n=5 或估計 planning variance。

---

# 十二、SIMPLE Baseline 實測(n=1)

**這是第一次量測 simple 任務。** 先前 6 次量測全部是 deep 級的公司年度策略。

任務(§14 定義下毫無疑問的 `simple`:純計算與格式化,所有資訊都在題目裡):

```
以下三筆報價都是未稅總價，請換算成含稅（營業稅 5%）金額，並由低到高排序：
A 案 48,000 元   B 案 52,500 元   C 案 45,800 元
```

## 結果(實測 observation)

```
complexity   : simple          ← 分類正確
assignments  : 1 specialist
API calls    : 3
status       : SUCCESS
adjustments  : none

planning     : 16.2s  (63%)
worker       :  3.4s  (13%)
synthesis    :  6.2s  (24%)
total        : 25.8s
```

---

# 十二-B、Post-6.1 SIMPLE Live Regression(n=1)

**目的:** 驗證 Step 6.1 Worker Context Propagation 修好後,同一個 SIMPLE baseline 的 worker 是否仍需要 synthesis 做 correctness recovery。

**執行限制:** 本輪**沒有實作 Step 7**,也**沒有跳過 synthesis**。實際路徑仍是:

```
planning → worker → synthesis
```

任務與第十二節完全相同:

```
以下三筆報價都是未稅總價，請換算成含稅（營業稅 5%）金額，並由低到高排序：
A 案 48,000 元
B 案 52,500 元
C 案 45,800 元
```

## 結果(實測 observation)

```
complexity   : simple
assignments  : 1 specialist (business_strategist)
API calls    : 3
status       : SUCCESS
evidence     : NOT_APPLICABLE
adjustments  : none

planning     :  7.9s  (35%)
worker       :  4.1s  (19%)
synthesis    : 10.2s  (46%)
total        : 22.2s
```

## Chief mission(原文)

```
Compute 5% VAT-inclusive totals for A=48,000; B=52,500; C=45,800, then sort offers from lowest to highest. Return the inclusive amounts and the sorted ranking.
```

## Worker 原始輸出(原文,318 chars)

```markdown
# 含稅金額計算與排序結果

## 換算明細（未稅 × 1.05 = 含稅）

| 方案 | 未稅金額 | 含稅金額（5% 營業稅） |
|------|---------|---------------------|
| A 案 | 48,000 元 | **50,400 元** |
| B 案 | 52,500 元 | **55,125 元** |
| C 案 | 45,800 元 | **48,090 元** |

## 由低到高排序

1. **C 案：48,090 元**
2. **A 案：50,400 元**
3. **B 案：55,125 元**

---
以上為含稅金額計算與排序結果，僅涵蓋本任務指定之運算範圍。
```

## Synthesis 原始輸出(原文,118 chars)

```text
含稅金額（未稅 × 1.05）：
- A 案：50,400 元
- B 案：55,125 元
- C 案：48,090 元

由低到高排序：
1) C 案：48,090 元
2) A 案：50,400 元
3) B 案：55,125 元
```

## 觀察

| | Step 6.1 前 baseline | Step 6.1 後 regression |
|---|---|---|
| Chief mission | 英文 | 英文 |
| Worker 原始輸出 | 英文 | **中文** |
| Synthesis 原始輸出 | 中文 | 中文 |
| Worker chars | 460 | 318 |
| Synthesis chars | 112 | 118 |
| Total latency | 25.8s | 22.2s |

**結論:** Step 6.1 修掉了本次已知的 language/context recovery 缺陷:即使 Chief mission 仍是英文,worker 也能依 Original Task 的語言與範圍輸出中文。這支持「Worker Context Propagation 是必要前置修復」。

**但這仍不等於 Step 7 可以直接跳過 synthesis。** 本次 synthesis 仍做了可觀察的 user-facing compression / presentation normalization,只是它不再補救語言錯誤。是否足以移除,需要把「輸出品質差異」納入 Step 7 決策,而不是只看 latency。

## 第一次 baseline 的價值不是延遲分佈,而是推翻了一個架構假設

原本的假設:

```
1 specialist
→ synthesis 只是把一份答案重新整理成一份答案
→ 可以安全跳過
```

**實測證明這個假設目前不成立。**

## 第一次 baseline 中 Planning 佔 63%,是實際工作的 5 倍

Chief 花 **16.2 秒**判斷「這是算術,交給一個人」,真正算完只要 **3.4 秒**。

在第一次 baseline 中,SIMPLE workload 的主要 latency center 是 **planning**,不是 synthesis。Post-6.1 regression 的分佈已改變(見第十二-B節),所以不要把這個百分比當成通則。

> ⚠️ **但現在不要實作融合式 routing + answer。** 那會破壞 `PLAN → 可先被獨立稽核 → EXECUTION` 這個架構性質。是否值得用它換延遲,是 V2 的架構取捨,不是現在的 bug fix。

---

# 十二-C、SIMPLE-2 / SIMPLE-3 Worker Readiness Live Regression

> 本節為 rev.8 的歷史三階段測試紀錄。其當時的 `NOT IMPLEMENTED` 狀態與原始輸出保留不改;現行 Step 7 V1 implementation 見第十六節。

## 目的與方法

**問題:** 在 single-specialist SIMPLE 任務中,Worker Output 是否已能原樣作為 user-facing final answer? Synthesis 是否補上必要的正確性,或只改變長度/呈現?

本輪於 2026-09-05(Asia/Taipei)執行兩種新題型,**各 n=1,不重抽、不估計 latency distribution**。沿用 `BENCHMARK_ROSTER`: `business_strategist`、`market_researcher`、`brand_creative`;Chief 與 Synthesizer 皆 `openai / gpt-5`。未強制 complexity 或 assignment,未改角色、budget、prompt 或 execution policy。每題均透過既有 MCP `run_orchestrator` 完成:

```
planning → worker → synthesis
```

驗收條件在呼叫前固定於 [cases.json](regressions/simple-readiness/cases.json),未將參考答案或驗收說明額外送給模型。六項品質評估逐項檢視 Worker 原文;`SUCCESS` 僅表示 Worker 呼叫成功,**不是品質通過的替代指標**。user-facing readiness 的 PASS 要求無需刪除標題、內部交接語或補寫內容,即可把原文送給使用者。

**原文定義:** 保留現有 provider adapter 回傳的文字。`workerResults[].output` 為 Worker 原文;這兩題的 `SUCCESS + NOT_APPLICABLE` 不會產生 output banner,因此 `finalOutput` 就是 Synthesis 原文。現有 API 不公開 Chief 整份 raw planning response;下列 Chief mission 是 `plan.assignments[].mission`,兩題均無 planning adjustments。完整 MCP 回應另存,沒有截短、翻譯或潤飾。

## 執行結果與 Latency

| 欄位 | SIMPLE-2 | SIMPLE-3 |
|---|---|---|
| 題型 | 明確格式與 constraint preservation | 短摘要 |
| 開始時間(Asia/Taipei) | 2026-09-05 01:38:47.929 | 2026-09-05 01:39:09.360 |
| complexity | `simple` | `simple` |
| assignments | 1: `business_strategist` (high) | 1: `brand_creative` (high) |
| Worker provider / configured model | `claude / claude-sonnet-5` | `openai / gpt-5` |
| status | `SUCCESS` (1 成功 / 0 失敗) | `SUCCESS` (1 成功 / 0 失敗) |
| evidenceLabel | `NOT_APPLICABLE` | `NOT_APPLICABLE` |
| requiresRedTeam | `false` | `false` |
| planningAdjustments / rosterWarnings | 無 / 無 | 無 / 無 |
| synthesisAllowed / 已執行 | `true` / 是 | `true` / 是 |
| 邏輯模型呼叫數 | 3: planning + worker + synthesis | 3: planning + worker + synthesis |
| planning latency | 12,894 ms (12.894 s) | 10,071 ms (10.071 s) |
| worker latency | 2,565 ms (2.565 s) | 10,703 ms (10.703 s) |
| synthesis latency | 5,966 ms (5.966 s) | 8,428 ms (8.428 s) |
| total latency | 21,425 ms (21.425 s) | 29,202 ms (29.202 s) |

Latency 取自 orchestrator 的 `timings`,不包含 MCP 啟動/傳輸時間。這裡不計平均、百分位、加速比例或預測值;3 次是 code path 的邏輯模型呼叫數,不宣稱量測到 SDK 底層 HTTP 重試次數。

## SIMPLE-2: 明確格式與 Constraint Preservation

### Original Task

```text
請只依下列資料篩選工作坊場地。條件：位於臺北市、9 月 18 日可預訂、費用不超過 15,000 元；即使符合其他條件，也必須排除河畔館。
請以繁體中文回答，只輸出一個 Markdown 表格，不要標題、前言、結論、推薦或排除原因。欄位名稱與順序固定為「場地」「費用（元）」，費用只填整數，不加千分位或單位。只列符合全部條件的場地，按費用由低到高排序，不要加入未提供的場地或資料。

場地資料：
松山館｜臺北市｜9 月 18 日可預訂｜12,000 元
板橋館｜新北市｜9 月 18 日可預訂｜9,000 元
中山館｜臺北市｜9 月 18 日可預訂｜15,000 元
信義館｜臺北市｜9 月 18 日已額滿｜11,000 元
大安館｜臺北市｜9 月 18 日可預訂｜15,001 元
河畔館｜臺北市｜9 月 18 日可預訂｜8,000 元
```

### Chief Mission(原文)

```text
依提供的場地資料，篩選符合：位於臺北市、9 月 18 日可預訂、費用不超過 15000 元；即使符合也要排除「河畔館」。輸出僅一個 Markdown 表格（無標題/前言/結論），欄位依序為「場地」「費用（元）」，費用填整數不加千分位或單位。只列完全符合者，並依費用由低到高排序，不加入未提供的場地或資料。語言使用繁體中文。
```

### Worker Raw Output(原文,56 字元含空白/換行)

```markdown
| 場地 | 費用（元） |
|---|---|
| 松山館 | 12000 |
| 中山館 | 15000 |
```

### Synthesis Raw Output(原文,56 字元含空白/換行)

```markdown
| 場地 | 費用（元） |
|---|---|
| 松山館 | 12000 |
| 中山館 | 15000 |
```

### Worker 評估

| 維度 | 結果 | 依據 |
|---|---|---|
| correctness | PASS | 只有松山館 12000、中山館 15000,數值正確且升冪排序。 |
| language | PASS | 場地與欄名皆為要求的繁體中文。 |
| format | PASS | 僅一個 Markdown 表格;指定兩欄、兩筆資料;費用為純整數,無單位、千分位或額外說明。 |
| constraints | PASS | 保留剛好 15000 的中山館;排除新北市板橋館、已額滿信義館、超額 1 元的大安館及明確排除的河畔館;無新增資料。 |
| mission scope | PASS | 僅篩選、排序與格式化,未加推薦、排除原因或延伸分析。 |
| user-facing readiness | PASS | 可原樣交付,不需清除 wrapper、內部交接語或補正內容。 |

**Synthesis 增量:** 與 Worker 逐字相同,包含空白與換行。未觀察到 material correctness value,也沒有 compression / presentation 變更。這只描述輸出差異,不推測模型內部有無檢查。

## SIMPLE-3: 短摘要

### Original Task

```text
請用繁體中文將以下會議紀錄摘要成一段、最多兩句、總長不超過 100 個字（含標點，不含空白）。保留最終交付期限、負責人、交付項目及數量，並說明尚未確定的事項。只輸出摘要，不要標題、條列或建議；不要把被否決的提案寫成決議，也不要推測未定資訊。

會議紀錄：
原本提議 9 月 12 日交付五支 30 秒影片，但已否決。最終決議由林宜庭在 9 月 18 日前交付三支 15 秒直式短片，供秋季活動使用。投放平台與廣告預算尚未確定，下次會議再討論。
```

### Chief Mission(原文)

```text
將會議紀錄濃縮為繁體中文一段、最多兩句、總長不超過100字（含標點、不含空白），保留最終交付期限、負責人、交付項目與數量，並清楚說明未定事項；勿把被否決提案寫成決議，勿推測未定資訊；只輸出摘要，不要標題、條列或建議。
```

### Worker Raw Output(原文,54 字,含標點/不含空白)

```text
最終由林宜庭於9月18日前交付三支15秒直式短片，供秋季活動使用；投放平台與廣告預算未定，將於下次會議討論。
```

### Synthesis Raw Output(原文,54 字,含標點/不含空白)

```text
最終由林宜庭於9月18日前交付三支15秒直式短片，供秋季活動使用；投放平台與廣告預算未定，將於下次會議討論。
```

### Worker 評估

| 維度 | 結果 | 依據 |
|---|---|---|
| correctness | PASS | 正確保留林宜庭、9 月 18 日前、三支 15 秒直式短片、秋季活動用途,以及平台/廣告預算未定與下次討論。 |
| language | PASS | 全文為繁體中文,無語言修復需求。 |
| format | PASS | 一段、一句、54 字(Unicode code points,含標點/不含空白),符合最多兩句與 100 字上限;無標題或條列。 |
| constraints | PASS | 未把 9 月 12 日、五支 30 秒影片的被否決提案當成決議;未杜撰平台、預算、額外建議或來源外資訊。 |
| mission scope | PASS | 僅摘要既有決議與未定事項,未替會議做新決定。 |
| user-facing readiness | PASS | 已是可直接交付的短摘要,無內部交接語或多餘解說。 |

**Synthesis 增量:** 與 Worker 逐字相同,未新增、修正或壓縮任何內容。未觀察到 material correctness value,也沒有 compression / presentation 變更。Chief mission 未重述人名、日期或影片數量,Worker 仍從 Original Task 保留正確事實;這是 context 傳遞下的成功觀察,並非未做 ablation 即可宣稱的因果證明。

## 綜合判讀與限制

| 題型 | Worker 可否原樣交付 | Synthesis 可觀察增量 |
|---|---|---|
| SIMPLE-1: rev.7 原 baseline 計算/排序 | 數值、排序與中文已正確;帶有額外呈現與任務範圍說明 | compression / presentation,無已知 correctness recovery |
| SIMPLE-2: 本輪格式/條件篩選 | 是,六項評估皆 PASS | 無,逐字相同 |
| SIMPLE-3: 本輪短摘要 | 是,六項評估皆 PASS | 無,逐字相同 |

**目前支持的結論:** Step 6.1 後,本次兩個 single-specialist SIMPLE Worker Output 已可原樣作為 user-facing final answer;既有 synthesis 在這兩次未帶來可觀察的 correctness、compression 或 presentation 增量。相較 rev.7,這補上了嚴格格式/排除項與短摘要的品質證據。

**尚不能推出的結論:** 不能把三種不同題型各一次的觀察當成成功率或 latency distribution,也不能據此把 `assignments.length === 1` 視為充足的省略條件。本輪只涵蓋兩位專家/兩個 provider,未涵蓋檢索、失敗/空輸出、normal/deep 或其他語言。本輪 Chief mission 皆中文,未重新測試英文 mission 的 language drift;該例的既有觀察在第十二-B節。

這兩題的 mission 覆蓋整個小任務,因此 scope PASS 僅表示未超出本題責任,**不能證明多專家、部分委派任務下不會接管完整任務**。本輪是比較既有三階段的原始輸出,沒有執行或驗證尚未實作的 direct path。Step 7 仍為 **NOT IMPLEMENTED**;後續決策應把實際輸出是否符合原始 task 與可觀察的 synthesis 價值納入,而非只看 specialist 數量或 latency。

## 證據檔與驗證

- [固定題目與事前驗收條件](regressions/simple-readiness/cases.json)
- [Live harness](regressions/simple-readiness/run.mjs): 沿用 MCP 入口,每題一次,保留完整回應;拒絕覆寫既有證據目錄。
- [SIMPLE-2 結果](regressions/simple-readiness/2026-09-05/SIMPLE-2.json)、[原始 MCP 回應](regressions/simple-readiness/2026-09-05/SIMPLE-2-mcp.json)
- [SIMPLE-3 結果](regressions/simple-readiness/2026-09-05/SIMPLE-3.json)、[原始 MCP 回應](regressions/simple-readiness/2026-09-05/SIMPLE-3-mcp.json)
- [執行設定與事前雜湊](regressions/simple-readiness/2026-09-05/manifest.json)、[事後一致性紀錄](regressions/simple-readiness/2026-09-05/integrity.json): `src/`、`dist/`、原 `benchmark-task.mjs`、package files 均未變更;未記錄任何 API key。
- [離線證據驗證](regressions/simple-readiness/verify.mjs): fixture 雜湊、原始 MCP 與結果一致、三階段/單專家/狀態、表格資料與結構、摘要長度與關鍵事實、Worker/Synthesis 逐字一致皆 PASS。語意、語言及交付品質另外逐項人工檢視如上;不是產品的通用 Validation Layer。

已執行:

```sh
node regressions/simple-readiness/verify.mjs regressions/simple-readiness/2026-09-05
```

結果: SIMPLE-2 PASS; SIMPLE-3 PASS。測試結果與本文件會一起提交至 notes repo;產品 runtime 未修改。

---

# 十三、發現的正確性缺陷:Worker Context Loss

## 這次 synthesis 做了什麼

| | 內容 | 長度 |
|---|---|---|
| 專家產出 | **英文** markdown 表格 + 計算過程 | 460 字元 |
| synthesis 後 | **中文**,只有答案與排序 | 112 字元 |

原始 task 是中文。實際的執行鏈是:

```
Original User Task（中文）
        ↓
      Chief
        ↓
Assigned Mission（這次寫成純英文）
        ↓
      Worker  ← 只拿到 Mission,從未看過 Original Task
        ↓
Worker Output（英文）
        ↓
   Synthesizer  ← 重新取得 Original User Task
        ↓
Final Output（中文）
```

**synthesis 並非單純重複轉述。它補救了上游的 context loss** —— user language recovery、output formatting、original task reconciliation。

若照原提案直接實作 `assignments.length === 1 → synthesize: false`,這個中文任務最後會得到**英文的 Worker Output**。那是 output regression,不是 optimization。

## ⚠️ 不要把問題定義成「Mission Language Drift」

語言只是第一個被觀察到的**症狀**。真正的架構問題是:

> **Worker Context Loss** —— Original User Task 在 `Chief → Worker` 這個 delegation boundary 被丟失。

同一個缺陷未來同樣可能吃掉:輸出語言、格式要求、預算約束、地理範圍、時間範圍、明確排除項、要求的輸出結構、使用者特定需求、task 層級約束、原始意圖。

**這是 correctness / context propagation 問題,不是 prompt language 問題。**

## 發生率(實測 observation,樣本已標明)

比對所有已記錄的執行(task 皆為中文),用中日韓字元比例衡量:

| 執行 | mission | worker 產出 |
|---|---|---|
| deep run 1 | 68–74% | 44–48% |
| deep run 2 | 47–71% | 44–52% |
| deep run 3 | 66–68% | 44–49% |
| **simple baseline** | **0%** | **0%** |

deep 任務的 mission 都是中文,worker 也用中文回答。**只有這次 simple 任務,Chief 把 mission 寫成純英文。**

**偶發,不是系統性 —— 但偶發就足以讓「單一專家跳過 synthesis」不能無條件成立。**

## ⚠️ 24% 這個數字的正確寫法

**正確(實測 observation,n=1):**

> 在這一次 SIMPLE baseline 中,synthesis 佔了 6.2 秒 / 總時間的 24%。

**錯誤(把 n=1 當通則,且忽略 synthesis 本次確實有功能):**

> ~~Step 7 可以讓 SIMPLE 任務快 24%。~~

目前沒有證據支持這個推論。

---

# 十四、Step 6.1 — Worker Context Propagation(DONE)

## 核心原則(architecture decision)

> **Original Task 與 Assigned Mission 是兩種不同的資訊,兩者都必須存在於 Worker 的執行 context。**

| | 是什麼 |
|---|---|
| **Original User Task** | immutable task context —— 使用者真正要求什麼,以及 task 層級的約束 |
| **Assigned Mission** | delegated responsibility —— 這位專家負責哪一部分 |

**Mission 不得取代 Original Task。**

## 必須同時保證兩件事

修好 context 之後會冒出新的失敗模式:worker 拿到完整 task 後開始接管整件事。

```
Original Task: 制定完整公司成長策略,包含市場、財務、品牌
Assigned Mission: 分析市場競爭環境與外部證據
```

`market_researcher` **應該**知道完整 Original Task(那是 context),但**仍然只能**負責市場與證據,不能自己開始做品牌策略、財務模型或最終建議。

```
Context Preservation  +  Mission Scope Preservation
```

## ⚠️ 不得用 prompt calibration 修

**不要**在 Chief 常設簡報加「mission 一律用使用者的語言撰寫」這類句子。那會把**結構性的 context-loss 缺陷**降格成**prompt 行為校準**。

> **Structural mechanisms > prompt persuasion**

應該修的是 **Worker Input Contract**,而不是要求 Chief 更努力把 Original Task 壓縮進 Mission。

## 驗證方向(不要只測語言)

Language / Format / Constraint / Scope / Explicit Exclusion —— 五個維度的細節見 `STEP7_SCOPE_ANALYSIS.md` 第 10 節。

## ⚠️ 修好之後不要直接移除 synthesis

目前只能得到:

> **修復 Worker Context Propagation 是重新評估 single-specialist synthesis 的必要前提。**

**不能**得到:

> ~~修完之後 synthesis 就一定沒有價值。~~

synthesis 目前可能同時提供 language recovery、format normalization、task reconciliation、multi-agent synthesis、final answer compression、user-facing presentation。Step 6.1 後的原 SIMPLE baseline(第十二-B節)顯示 language recovery 缺陷已改善,synthesis 仍提供壓縮與呈現整理。rev.8 新增的兩題(第十二-C節)則皆已可原樣交付,Synthesis 與 Worker 逐字相同。這些品質證據應納入後續決策,但仍不能直接把 `single specialist → synthesize: false` 當成已普遍證明安全。

## 仍然成立的 Step 7 / Step 9 不變式

本次發現不影響:

```
ExecutionPolicy must not depend on ProviderName.
```

---

# 十五、本專案累積的工程原則

rev. 21 新增:

> **An invariant that cannot fail in the path it runs in is not evidence, even when the property it names is true.**

這條來自 rev.20 審查的 E4。`noRound2Leak: !Object.hasOwn(result,'workerResults')` 在 replay path 上**恆真** —— `replaySynthesis` 本來就不回傳該欄位,所以即使 production path 真的洩漏,它也照樣 PASS。該性質確實成立,但撐住它的是另外三條 invariant 加上結構論證,不是這條掛著它名字的檢查。**證據的標籤必須等於它實際檢查的東西**;不然日後有人會拿一條恆真式當保證。

> **A faithful implementation of an approved specification does not make the specification right.**

rev.20 的 Gate eligibility 文字與指令書的 contract 逐字對應 —— 實作零偏差。但判準裡的 `strengthening` 讓「改變 ∪ 強化」蓋住了 binary 的兩支,接近恆真。**審查要能分開問兩個問題:code 有沒有照規格做,以及規格本身合不合理。** 把第二個問題摺進第一個,規格的缺陷就永遠不會被發現。

rev. 18 新增:

> **A call asked both to resolve a conflict and to report unresolved conflicts will resolve it. Doing the first job well destroys the reason to do the second.**

這條是實測換來的。Controlled replay 給 gate 一組明確的 B vs C 跨專家衝突,gate **認出來了** —— 回答裡有一段標題就叫「專家分歧與如何處理」—— 然後把它整合進答案,因此依附錄自己的規則(「只在解決它會改變答案裡的決策時才提報」)正確地省略了區塊。模型沒有失誤,是兩個責任互相抵消。

rev. 15 新增:

> **A rate is not an outcome. How often a mechanism fires says nothing about whether the times it fired were worth it.**

⚠️ **這條取代了 rev.14 我寫的「觸發率就是停止條件」。** 那個寫法是錯的:低觸發率同樣可以代表 gate 很精準 —— 只在真正有跨專家分歧時才啟動。把稀有當成無用,會把一個有鑑別力的機制當成失敗砍掉。觸發率降級為 **diagnostic metric**;真正要量的是 *triggered usefulness* —— Round 2 有沒有修正 material problem 或改變重要決策。

rev. 14 新增:

> **Never put the deliverable behind a parse that runs after the cost is already spent.**

rev. 6 新增:

> **Do not remove a stage merely because its nominal responsibility appears redundant. First verify what hidden corrective responsibilities that stage is actually performing in the current system.**

rev. 4:

> **Do not analyze why a model made a choice until you first verify exactly what the model actually saw.**

一貫原則:

> **Measurement overrides architecture speculation.**
> **Structural mechanisms > prompt persuasion.**
> **Runtime truth > architecture assumption.**

補充:

> **A single measurement is evidence of a failure mode, not a universal performance law.**

---

# 十六、Step 7 V1 — IMPLEMENTED

## Eligibility 與邊界

現行流程保留獨立 planning 與可稽核 structured plan。完成原有 constraints enforcement 與 Worker 執行後,由純函式 `deriveExecutionPolicy(facts)` 判斷:

```text
complexity === simple
AND enforced plan has exactly one assignment
AND run status === SUCCESS and the existing synthesis failure guard allows proceeding
AND exactly one matching Worker result, with no error
AND output is a string whose trimmed length is greater than zero
AND selected execution does not request retrieval
AND Worker result carries no retrieval metadata
    -> policy.synthesize = false
    -> finalOutput = exact Worker raw output
    -> synthesisMs = 0
```

`trim()` 只用於判斷有無文字,不替換輸出。`valid` 在 V1 指型別與非空檢查,不是語意正確性、格式或 claim-level validation;本輪未新增 Validation Layer。

Retrieval requirement 取自 **enforced assignments 中被選中的 Worker** 是否實際會收到 `retrieval: { enabled: true }`,不是看 roster 裡是否存在 researcher,也不解析 Chief 的自由文字或比對 provider/model。已要求 retrieval 的執行即使回傳 `UNGROUNDED`、`FAILED` 或沒有 metadata,仍排除 fast path;意外出現的 retrieval metadata 也保守排除。

| 執行情況 | 行為 |
|---|---|
| SIMPLE + 1 成功、非空、non-retrieval Worker | planning + worker,Worker 原文直接交付 |
| NORMAL / DEEP + 1 Worker | 保留 synthesis,即使由 budget cap 限制至 1 人 |
| SIMPLE + 多 assignments 的異常 policy input | 不走 direct;以純函式測試驗證,不繞過產品原有 cap |
| SIMPLE + retrieval required / metadata present | 保留 synthesis |
| 多人成功 / 部分失敗 | 保留 synthesis,原 SUCCESS / DEGRADED 與 banner 語意不變 |
| 全員失敗(包括單 Worker 失敗) | FAILED,finalOutput = null,無 synthesis |
| 未知 complexity/status/retrieval fact、缺少/多出/不匹配的 result、result 帶 error | 保守維持 synthesis,不推定 direct eligibility |
| 非字串、空字串、只有空白的異常 adapter 輸出 | 不走 direct,維持原本的 synthesis fallback;不重定義 Run Status |

現行 provider adapters 已會對空白文字丟錯,走既有 Worker failure 流程。異常 adapter 測試刻意模擬不遵守 adapter contract 的輸出,只驗證 policy 不會把它直接交付。

## Report 與 Timing

`buildRunReport()` 的 SUCCESS / DEGRADED / FAILED 判準未改。`runOrchestrator()` 回傳時一律附加 `report.policy`;原 standalone `buildRunReport()` 沒有完整 plan,不自行推導 policy。

Direct path 範例:

```json
{
  "status": "SUCCESS",
  "synthesisAllowed": true,
  "policy": {
    "topology": "single",
    "synthesize": false,
    "reason": "simple_single_specialist_direct_delivery"
  }
}
```

`topology` 表示 assigned specialist 數量,不是 stage 數量;NORMAL + 1 Worker 也可為 `single` 且 `synthesize: true`。`synthesisAllowed` 表示 Run Status 是否允許後續整合,**不再可用它單獨推斷 synthesis 是否執行**。既有呼叫端應優先讀取 `report.policy.synthesize`;舊報告沒有 policy 時才 fallback 至 `synthesisAllowed`。

| reason | synthesize | 意義 |
|---|---|---|
| `simple_single_specialist_direct_delivery` | false | 合格的有界 fast path |
| `no_successful_workers` | false | 原有全敗 guard,finalOutput 為 null |
| `non_simple_execution` | true | NORMAL / DEEP 保留原路徑 |
| `not_single_specialist` | true | 不符合單一 assignment |
| `retrieval_not_eligible` | true | retrieval required、未知或帶 retrieval metadata |
| `invalid_worker_output` | true | 非字串/空白文字 |
| `unsupported_execution_state` | true | 其他不明或不一致的 execution facts |

所有回傳路徑保留 `planningMs / workersMs / synthesisMs / totalMs`。兩種略過 synthesis 的情況都有明確 reason 與 notes,不再只以 `synthesisMs = 0` 猜測發生了什麼。本輪沒有新增其他 disable-synthesis 選項。

## 修改範圍

- `src/agents/policy.ts`: 純函式與只含 plan/execution facts 的輸入型別;沒有 provider/model identifier 或 runtime import。
- `src/modes/orchestrator.ts`: 可注入 dispatcher `call`(預設原 `callProvider`,不暴露於 MCP schema)、附加 policy、依 policy 略過 synthesis。
- `test-execution-policy.mjs` 與 `package.json`: 36 項 mock/policy/replay 測試納入 `npm test`。
- `test-simple-baseline.mjs`、`test-orchestrator.mjs`: 修正既有 API call count 與輸出標示,讀取 policy;題目、roster 與 sampling 未變,本輪未 live 執行。
- `README.md`、`.gitignore`: repository 的建置說明與本機設定/產物忽略規則。原本未追蹤的 source/既有測試/lockfile 另外以 baseline commit 納入,不屬於 Step 7 runtime 改寫。

Chief system prompt、Worker input contract、planning schema/cap、agent registry、provider adapters、retrieval wiring、evidence summary/banner、模型選擇皆保留。Synthesis 的原 prompt 與模型呼叫參數也保留,僅合格 fast path 不呼叫它。

## 驗證結果

| Test suite | 通過 |
|---|---:|
| `test-chief.mjs` | 11 |
| `test-run-status.mjs`(含 Step 6.1 三項) | 25 |
| `test-registry.mjs` | 20 |
| `test-mcp-smoke.mjs` | 7 |
| `test-execution-policy.mjs`(新增) | 36 |
| **合計** | **99,0 failed** |

新增測試直接計數 planning/worker/synthesis 的 dispatcher 呼叫;驗證 non-retrieval SIMPLE 僅 2 次、NORMAL/DEEP 單專家仍 3 次、多人/失敗邊界、raw text 與 UTF-8 bytes 等值、timing schema、可序列化的 policy/reason、retrieval metadata/source/count/banner 保留、變更模型身分不改 policy。SIMPLE-2/3 使用 rev.8 儲存的 Worker 輸出與 mission 離線 replay,不是新的 live 品質或 latency 樣本。

`npm ci` 使用既有 lockfile 完成獨立安裝,`npm test` 全數通過。沒有新增 dependency、沒有燒 live API,也未修改 rev.7/8 原始證據或宣稱新的 latency 分佈。

**Scope deviation: 無。** 附帶的 Git baseline import 依使用者明確選擇進行,兩個既有測試腳本的調整為 policy 稽核相容性。未開始 Step 8、Model Router、retrieval/normal/deep fast path、zero-specialist、fused planning、prompt recalibration、Validation Layer 或新的 benchmark expansion。完成本輪後停止。

---

# 十七、Step 8 — SCOPE ANALYSIS COMPLETE / NOT IMPLEMENTED

完整分析見 [`STEP8_SCOPE_ANALYSIS.md`](STEP8_SCOPE_ANALYSIS.md)。本輪以 baseline commit `d80416701690fc380a6aa160723ec71aa97419d6` 查核現行 code 與 pinned SDK,結論如下：

1. 三家 provider response 都有某種 usage metadata,但欄位語意不同,且現行 adapters 全部在 `CallResult` 邊界丟棄。
2. 現行 `planningMs / workersMs / synthesisMs / totalMs` 是 orchestrator phase wall time;沒有 per-call duration。平行 `workersMs` 不可當 worker call durations 總和。
3. 現行 optional `ModelPricing` 全部留空是正確狀態;兩個 token rates 不足以表示 cache、thinking/reasoning、tier、region、context band、modality 與 tools。
4. Runtime usage truth、pricing registry、cost calculation 與 run-level reporting 必須維持四層分離。Missing 不是 0;partial subtotal 不是 total;public list estimate 不是 invoice cost。
5. 建議 V1 先接 usage + call latency + coverage-aware reporting,並只定義 pricing/cost contracts。未經另一次價格資料審查,registry 維持空白、cost 明示 unavailable。

rev.10 的分析輪未修改 `src/`、`package.json` 或測試,未執行 live API,也未開始 Step 8 implementation。Step 8 分析保留為 review-ready input。rev.12 已完成 Step 7.1 E2E acceptance;下一步先做 Milestone 2 scope/acceptance design,經 architecture review 後才 implementation,再回到 Step 8 implementation。

---

# 十八、Step 7.1 — E2E RUNTIME ACCEPTANCE(DONE / A+B PASS)

## rev.12 Live 結果

2026-09-05(Asia/Taipei)經 MCP stdio consumer 執行實際專案的 `dist/index.js`,Chief/synthesizer 使用既有 `openai / gpt-5`,沿用固定 `BENCHMARK_ROSTER`。未修改 Chief prompt、Worker contract、runtime、roster、complexity definitions 或 ExecutionPolicy。

| 項目 | Test A | Test B attempt 1 | Test B corrected fixture |
|---|---|---|---|
| 最終驗收 | **PASS** | **TEST_NOT_EXERCISED** | **PASS** |
| complexity / assignments | simple / 1 | normal / 3 | deep / 3 |
| run status | SUCCESS | SUCCESS | SUCCESS |
| logical model calls | 2 | 5 | 5 |
| policy.synthesize | false | true | true |
| evidenceLabel | NOT_APPLICABLE | NOT_APPLICABLE | PARTIALLY_GROUNDED |
| queries / sources | 不適用 | 6 / 20 | 6 / 21 |
| planningMs | 7,318 | 27,570 | 18,854 |
| workersMs | 5,216 | 139,961 | 122,082 |
| synthesisMs | 0 | 77,889 | 110,377 |
| totalMs | 12,534 | 245,420 | 251,313 |

**A:** `simple_single_specialist_direct_delivery`,Worker raw text 與 `finalOutput` 完全相等。含稅金額、C→A→B 排序、繁中、constraints、format、mission scope 與 user-facing readability 逐項檢查通過。較長的計算說明與 mission-scope 結尾屬 cosmetic variance。初版 checker 因 Markdown emphasis/punctuation 誤判,只修 local harness 並重驗同一原文,沒有重跑 API。原 `normalized-result.json` 的 FAIL 保留,由 `evaluation.json` 明確記錄 `HARNESS_FALSE_NEGATIVE` 與最終 PASS。

**B attempt 1:** 有研究與 synthesis,但初版新服務提案未明示重大投資/stakes,Chief 依既有規則判 normal,未測到目標 DEEP banner branch。Observation、初步 root cause、affected layer(test fixture / planning input)與最小修正 scope 均保存於 evaluation。僅將 task 改為董事會重大投資、40% 預算與 6 名核心人員投入、現金流風險,沒有指定 agent/provider 或修改 runtime,只補跑一次。

**B corrected:** Chief 自然選出三種 capabilities,其中 evidence-capable Worker 回傳 `GROUNDED`、6 queries、21 sources,含 `webSearchQueries`、`groundingChunks`、`groundingSupports` 原始 metadata。Worker 與 report source/count 資料一致;三個 Worker 成功後 synthesis 執行,finalOutput 以現行 exact `PARTIALLY GROUNDED — claims not yet validated` banner 開頭,沒有宣稱 `EVIDENCE_BACKED`。這是 runtime chain acceptance,不是 final answer 所有商業主張/價格的 claim-level validation。

### 證據與量測界線

- [`regressions/step7-1-e2e/README.md`](regressions/step7-1-e2e/README.md) 為證據索引與離線重驗方式;三次 attempt 均保留 task、manifest、raw MCP response、normalized result、evaluation、timestamps 與 runtime fingerprints,另有全目錄 `hashes.json`。
- Chief mission 為 MCP `plan.assignments[].mission`;Worker 原文為 `workerResults[].output`。A 沒有 synthesis output;B 的 `finalOutput` 含 runtime banner,可依 normalized observation 保存的 exact `expectedBanner` 前綴取出未改寫的 synthesis 原文。未保存 provider HTTP response envelope 或 Chief 原始 planning envelope。
- Logical model call count 依成功 plan assignments 與實際 policy/report、未變的 production branches 及離線 dispatcher tests 核對,不是獨立 live HTTP trace,不含 SDK retry 次數。
- `retrieval: { enabled: true }` 的依據是 resolved `evidenceCapable` execution fact、orchestrator 的 capability-based dispatch branch、Gemini adapter 僅在此選項啟用時掛載 search/回傳 retrieval metadata,以及實際返回的 GROUNDED metadata。沒有另行攔截並記錄 CallOptions;不以 provider/agent 名稱推定。
- Timing 為 runtime `Date.now()` phase wall time,不含 MCP 啟動/傳輸;workersMs 是平行 span,不是各 Worker latency 的總和。本輪不估計 latency distribution、token 或 cost。

本輪 `npm test`: **99 passed / 0 failed**。Runtime source/build before-after fingerprints 一致,沒有 runtime code 修改;只有 local harness/fixture 修正。Step 7 現為 code + runtime accepted,但不保證所有未來 SIMPLE 答案 presentation 等質。到此停止,下一輪才做 Milestone 2 scope analysis。

## 為什麼需要 7.1

Step 7 的 36 項新增測試證明 policy、call count、raw-output equality、timing schema 與 failure/retrieval boundary 符合 specification;它們不驗證 live model behavior 或 MCP consumer integration。rev.11 時的鏈路缺口是:Gemini grounding、orchestrator deep run 與 evidence banner 各自測過,但以下完整 production path 尚未 live E2E 成立;rev.12 已以上述 Test B 補齊：

```text
DEEP task
→ Chief selects evidence-capable specialist
→ retrieval enabled
→ live Google Search
→ GROUNDED metadata/sources
→ synthesis
→ PARTIALLY_GROUNDED final banner/report
```

Step 7.1 只補這兩個具體缺口,不是重開 benchmark expansion。

## Test A — SIMPLE Direct Delivery E2E

必須從 MCP consumer 走完整 live path並保存原始回應。Pass conditions：

```text
planning → worker → direct delivery
model calls = 2
status = SUCCESS
report.policy.synthesize = false
report.policy.reason = simple_single_specialist_direct_delivery
timings.synthesisMs = 0
finalOutput === exact Worker raw output
MCP consumer 可讀取新的 policy/report semantics
```

內容驗收至少檢查 correctness、language、requested format/constraints、mission scope 與 user-facing acceptability。Presentation normalization 可能與舊 synthesis 版不同;純 cosmetic verbosity 不自動算 correctness failure,但結果不得被描述為「保證與 synthesis 等質」。

## Test B — DEEP Grounded Orchestrator E2E

Task 必須自然、明確需要最新外部 evidence,不可用測試 harness 強制指定 market researcher 來繞過 Chief planning。Pass conditions：

```text
complexity = deep
Chief naturally selects an evidence-capable specialist
retrieval is actually requested
live grounding occurs
retrieval.status = GROUNDED
sources and grounding metadata survive the worker boundary
synthesis runs
run status/evidence summary remain coherent
final output begins with the correct PARTIALLY_GROUNDED warning/banner
source information is preserved and inspectable
```

若 Chief 未選 evidence-capable specialist,該次只能記為「未測到目標鏈路 / inconclusive」,不能算 pass。這一輪只要求一條有效的 targeted E2E observation,不從單次 latency 推估 distribution,也不順便把 deep planning variance 擴成 n=5。

## Acceptance boundary

- A 與 B 都通過後,Step 7 才標記為 production E2E accepted。
- 任一失敗時先保存 raw evidence、分類是 policy、provider、retrieval、report 還是 consumer defect;不得悄悄跳過或直接進下一 milestone。
- Step 7.1 不加入 readability regex、不新增 LLM quality gate、不回滾 Step 7。
- 除非 live test 揭露實際 defect,本階段應只有 harness/evidence/HANDOFF 變更;任何 runtime fix 另行定義 scope 並重新驗證 99 項離線測試。

---

# 十九、Milestone 2 — ROADMAP DECISION(rev.11/13 原始方向,已被第二十節依 code reality 修正)

## Roadmap decision

Milestone 1 已證明三種基本模式可運作：Pipeline 會傳遞前一模型輸出,Orchestrator 會由 Chief 分工後平行執行並 synthesis,Debate 會互評再由 Judge 決定。這完成了「三個模型能接上並參與同一工作」,但現行 Orchestrator 主要仍是 fan-out / fan-in：

```text
Chief plan
→ specialists work independently in parallel
→ one final synthesis
```

使用者的產品北極星更進一步：不同模型要能利用彼此結果、指出分歧、針對分歧修正,最後形成比單一模型更好的決策。因此 roadmap 在 Step 7.1 後插入 Milestone 2,優先於 Step 8 implementation。

## Target collaboration shape

```text
Chief planning
→ Round 1: multiple specialists produce role-specific work
→ Chief identifies disagreements, unsupported assumptions and gaps
→ Round 2: targeted cross-critique / evidence challenge / revision
→ Chief Decision: resolves or explicitly preserves remaining disagreement
→ user-facing final answer with traceable contributions
```

rev.13 將這個方向縮成待分析候選,不是 implementation specification：

```text
Chief Planning → Round 1 Specialists → Synthesis Gate
                                           │
                              no issue ─────┴──── targeted issue
                                  ↓                    ↓
                                Final      Round 2(max 1 specialist)
                                                       ↓
                                               Decision Synthesis
                                                       ↓
                                                     Final
```

候選 hard boundaries:最多 2 rounds、Round 2 最多 1 assignment、不要獨立 Chief Review/Judge/autonomous loop/planning loop/full-output broadcast,Round 2 failure 回退 provisional answer,且 collaboration 不得提升 evidence label。這些邊界需由 `MILESTONE2_SCOPE_ANALYSIS.md` 依 code reality 挑戰或確認;未經 architecture review 不實作。

研究、商業/風險與品牌/創意等角色只是示例,不能硬編碼成 provider preference。Planning/execution 仍以 role/capability facts 為依據;Milestone 2 的 live acceptance 可以刻意配置三個不同 provider-backed agents來證明跨模型協作,但不改寫「Execution Policy 不依賴 ProviderName」與 Step 9 Model Router boundary。

## Milestone 2 要回答的問題

1. 至少兩個 specialist 是否實際讀取並引用另一人的產出,而非三份獨立答案並排？
2. Chief 是否能明確找出 material disagreement 或 unsupported assumption？
3. Round 2 是否因 cross-critique / evidence 而修正、收斂或合理保留分歧？
4. Final decision 是否能追溯哪些結論來自何種角色/evidence,且不把未解分歧藏掉？
5. 相對單一模型 baseline 是否有可觀察品質增量？此項需在測試前先定義 rubric 與 comparison protocol,不能只靠另一個模型說「比較好」。
6. 額外 rounds 的 latency/cost 是否值得品質增量？在 Step 8 尚未 implementation 前只能保存 call count 與現有 timing observations,不能填假 token/cost。

## Scope gate

Milestone 2 目前是 **roadmap decision,不是 implementation specification**。Step 7.1 通過後先做 code-reality scope analysis、state machine/data flow、停止條件、failure semantics 與 acceptance design,經 architecture review 才能開始 runtime implementation。

新的主線順序：

```text
Step 7.1 E2E Runtime Acceptance
→ Milestone 2 scope + architecture review
→ True Multi-Agent Collaboration implementation + real-work acceptance
→ Step 8 Cost / Token / Latency implementation
→ Step 9 Model Router
→ Step 10 Validation Layer
```

Step 8 並未取消;rev.10 的 usage/pricing/cost/reporting 分層仍是有效設計輸入,只是優先順序讓位給核心產品價值驗證。Claude Code 的完整下一棒說明見 [`CLAUDE_CODE_HANDOFF.md`](CLAUDE_CODE_HANDOFF.md)。

---

# 二十、Milestone 2 — SCOPE ANALYSIS COMPLETE / NOT IMPLEMENTED

完整文件:[`MILESTONE2_SCOPE_ANALYSIS.md`](MILESTONE2_SCOPE_ANALYSIS.md)(582 行,18 題全數回答)。本節只保留會影響決策的部分。

## 交接快照的兩處不一致(皆非 runtime 缺陷)

| 代號 | 內容 | 處置 |
|---|---|---|
| D1 | 本地工作目錄不是 git checkout,`git rev-parse` 直接 fatal | 改以逐位元組比對驗證,五個關鍵原始碼檔與遠端 `main`(HEAD `656d7b6`)相同。**本地修改不受版控,無法 diff 也無法 revert —— 實作 M2 的人應該用 clone,不要用這個目錄。** |
| D2 | `regressions/step7-1-e2e/SIMPLE-direct/normalized-result.json` 仍寫 `outcome: FAIL`,唯一 false 的是 `expectedArithmeticAndOrder` | rev.12 `evaluation.md` 已記錄為 harness false negative(checker 未移除 Markdown emphasis,把標籤與金額之間的強調符號當成不相鄰),`run-case.mjs` 已修但 artifact 未重跑。**不是 runtime 缺陷。** |

## 對 rev.13 候選邊界的兩處修正

**1. DEEP logical call ceiling 是 `N + 4`,不是「約 7」。**

`N` 是 Round 1 assignment 數。7 只對三專家計畫成立;`SPECIALIST_CAP.deep = 4`,所以上限是 8。Planning 是 bounded-not-deterministic —— 同一 DEEP task 實測出現過 2 與 3 個 mission。上限寫死成 7 會讓一次合法的四專家執行看起來像違規。

```text
1 planning + N workers + 1 gate/synthesis + (0 or 1) Round 2 + (0 or 1) decision synthesis
```

**2. synthesizer 目前收不到任何 retrieval metadata。**

synthesis prompt 只包含 original task,以及每個成功 worker 的 `agentId` / `mission` / `output`(加上 DEGRADED 註記)。**寫出最終答案的模型從來沒看過檢索到哪些來源。** source URL 只進到 `report` 與給人看的 banner。

因此:一個被要求判斷 `needs_evidence` 的 gate,會是在對它看不到的證據做推論。要 gate 這個維度,必須先把 retrieval status / query / source 摘要餵進 synthesis input —— 這是 M2 的**前置改動**,不是實作 gate 的附帶效果。

## 核心設計建議:不要把交付物押在 parse 上

目前 orchestrator 只有**一個** parse 依賴(Chief 的計畫 JSON),而它失敗在**任何 worker 花錢之前**,失敗成本是一次 planning 呼叫。

Synthesis gate 會加上**第二個** parse 依賴,位置在**所有 worker 成本都已付出之後**(實測 DEEP 為 232.9s),而且就在產生交付物的那一次呼叫上。

建議形狀:

```text
自由文字的 provisional answer(交付物本身)
[--- optional machine-readable block ---]
{ "issues": [ ... ] }   ← best-effort 解析,可以缺席
```

任何解析失敗都退回今天的行為(直接交付 synthesis 文字並記一條 note)。**最差情況等於現狀加一條註記,而不是交付物損毀。**

## 主要風險是 latency,不是 correctness

synthesis 已是最慢的單一階段:110.4s / 251.3s(44%)。觸發 Round 2 等於再加一次 synthesis 等級呼叫,DEEP 總時長可能從約 251s 推到 400s 以上。

新增一條 handoff 未列的停止條件:

> **若 gate 幾乎不觸發,C 就等於 B 再加一個浪費在關鍵路徑上的結構化輸出要求。觸發率本身就是 kill criterion,而且它比品質更早、更便宜就能量測。**

先量觸發率,不要先量品質。

## 實驗設計上的兩個 code-level 阻礙

| 代號 | 阻礙 | 影響 |
|---|---|---|
| E1 | 只有 `gemini-3.1-pro-preview` 的 `grounded_retrieval` 是 `enabledInRuntime: true` | arm A(強單模型)要與 B/C 檢索對等,目前**只能是 Gemini**;否則所有 arm 都得關掉檢索,證據維度整個離開實驗。見 Q-B。 |
| E2 | `buildOutputBanner` 會把 `PARTIALLY_GROUNDED` / `DEGRADED` 印在交付物第一行 | 評估者一眼就知道是哪個 arm,盲測失效。**必須比較去掉 banner 的文字。** |

## 一個會壞掉的測試基礎設施

`test-execution-policy.mjs:38`:

```js
const stage = calls.length === 0 ? 'planning' : options.system ? 'worker' : 'synthesis';
```

**synthesis 是靠「沒有 system prompt」辨識的。** M2 會引入第二個 synthesis 等級呼叫,任一個帶上 system prompt 就會被誤判成 worker。必須在寫 M2 測試**之前**換成明確的 stage 標籤,否則呼叫數斷言會安靜地量錯東西。

## 不變式:collaboration 不得提升 evidence label

今天這條由結構保證 —— evidence label 由 retrieval status 推導,collaboration 不觸碰該推導鏈。M2 必須維持:Round 2 只能**暴露**不確定性、衝突與 evidence gap,不能把 `UNGROUNDED` 升成 `PARTIALLY_GROUNDED`。claim-level evidence validation 仍屬 Step 10。

## 尚待 architecture review 拍板的問題

| # | 問題 |
|---|---|
| Q-A | Round 2 的 retrieval 算不算進 `evidenceLabel`?(**分析者傾向算,但需明確決定才能實作**) |
| Q-B | Arm A 的檢索對等:Gemini-only,還是所有 arm 關檢索? |
| Q-C | gate 該不該看到失敗 worker 的錯誤訊息?目前完全看不到,但失敗本身與決策相關 |
| Q-D | `normal` 會不會被 gate,還是 `deep`-only 是永久邊界? |
| Q-E | Round 2 timings 放哪裡?擴充 `timings` 會改動既有比較依賴的形狀 |
| Q-F | direct-delivery 路徑要不要防禦性地套用 `buildOutputBanner`,讓第 1 節的 latent coupling 不會咬到未來路徑? |
| Q-G | gate 產出 issue 但 Round 2 停用時,issue 要呈現給使用者還是只記錄? |

## Scope gate(未改變)

Milestone 2 仍是 **scope analysis,不是 implementation specification**。未經 architecture review 不進入 runtime implementation。本輪未修改 `src/`、prompts、tests、retrieval、Step 7/8/9/10 runtime,未執行 live benchmark;`npm test` 99 passed / 0 failed。

---

# 二十一、Experimental Milestone 2-A — IMPLEMENTED / DEFAULT OFF / NOT PRODUCTIONIZED

這是**為了量測而做的 prototype**,不是 production feature。它存在只為回答一個問題:**不同 AI 互相挑戰,是否真的比現有 Orchestrator、甚至比同一個模型自己再想一次更有價值?** 在那個問題被實測回答之前,這裡沒有任何東西算是已驗證。

## 執行形狀

```text
Chief Planning
→ Round 1 Specialists(平行)
→ Synthesis Gate  ── provisional answer(交付物)
                   └─ optional collaboration issue block(metadata)
      │
      ├─ 沒有 decision-sensitive peer_challenge → provisional answer = Final
      └─ 有 → Targeted Round 2(最多 1 位)→ Decision Synthesis → Final
```

## Logical call ceiling

```text
1 Chief + N Round-1 Workers + 1 Synthesis Gate + 1 Round-2 Worker + 1 Decision Synthesis = N + 4
```

`SPECIALIST_CAP.deep = 4`,所以 absolute ceiling 是 **8**。測試以精確等式斷言 N=3 → 7、N=4 → 8,並斷言 `round2_worker` 與 `decision_synthesis` 各只出現一次。這是 logical application calls;SDK / HTTP retry 不計入同一個 metric。

## Gate 啟動條件

| 條件 | 不符合時 |
|---|---|
| `experimental.collaboration.enabled === true` | 完全走舊路徑,回傳物件連 `collaboration` 這個 key 都沒有 |
| `complexity === 'deep'` | `NOT_TRIGGERED` / `complexity_not_deep (...)` |
| Round 1 `status === 'SUCCESS'` | `NOT_TRIGGERED` / `round1_status_degraded` |
| 成功的專家 ≥ 2 | `NOT_TRIGGERED` / `single_specialist_no_peer` |

Gate 沒啟動時,synthesis prompt 是既有那一份,一字未改 —— 不合格的執行不會偷偷變成另一個實驗。

DEGRADED 被排除是刻意的:gate 會在少了一位專家的情況下比較專家,這時候的挑戰量到的是那次失敗,不是協作。

## 交付物不押在 parse 上

現有 orchestrator 只有一個 parse 依賴(Chief 計畫),它失敗在任何 worker 花錢**之前**。Gate 的 parse 位置在**所有 Round 1 成本已付出之後**,而且就在產生交付物的那次呼叫上。因此:

| 情況 | 結果 |
|---|---|
| 沒有區塊 | `SKIPPED` / `no_issue_block` |
| JSON 壞掉 | `SKIPPED` / `block_malformed` |
| 不是物件 / 沒有 issues 陣列 | `SKIPPED` / `block_schema_invalid` |
| issue 全部無效 | `SKIPPED` / `no_valid_issue` |
| 有效但不合格 | `SKIPPED` / `no_decision_sensitive_peer_challenge` |
| Round 2 失敗 | `FAILED` / `round2_worker_failed` |
| Decision Synthesis 失敗 | `FAILED` / `decision_synthesis_failed` |

**全部七種都交付 provisional answer,`RunStatus` 保持 Round 1 語意。** 只有結尾、且內容含 `collaborationIssues` 的區塊會被當成 metadata —— 答案裡的 JSON 範例不會被誤吞。

## Issue schema 與 selection

```ts
interface CollaborationIssue {
  targetAgentId: string;   // 必須是成功的 Round 1 專家
  sourceRef: string;       // 必須是成功的、且不同的 Round 1 專家
  challenge: string;
  decisionSensitive: boolean;
  action: 'peer_challenge' | 'needs_evidence';
}
```

Round 2 資格:`decisionSensitive === true && action === 'peer_challenge'`。`needs_evidence` 只記錄。

**`sourceRef !== targetAgentId` 是硬性的。** 自己引用自己是 self-review,正是 arm D 要隔離的東西;放行等於讓 arm C 混進 arm D 的行為,實驗會用錯誤的方式回答自己的問題。

多個合格 issue 時的固定排序:**被挑戰者在 assignment order 的位置 → 挑戰來源的位置 → gate 產出順序**。不隨機、不再叫模型決定、不全部執行。重點不是這個排序最好,而是它固定 —— 同一份 gate 輸出永遠選到同一個 issue,行為改變就不能推給執行間的變異。

## Selective peer context

Round 2 只收到:original task、自己的 mission、自己的 Round 1 輸出、**一段** peer excerpt、**一條** challenge。測試明確斷言第三位專家的輸出**不在** prompt 內,provisional answer 也不在。沒有重用 `run_debate` 的 full-broadcast。

**rev.16 起改為 deterministic chunk reference。** Round 1 輸出由 runtime 依空白行切成 `p1`、`p2`…,`sourceRef` 寫成 `<agentId>:<chunkId>`(例:`market_researcher:p2`)。gate 的附錄會列出所有可用的 reference。

Runtime 負責四件事:deterministic segmentation、sourceRef validation、bounded chunk extraction、audit trail(`agentId` / `chunkId` / `chunkIndex` / `startChar` / `endChar` / `truncated` / `charLimit`,offsets 指向該專家的**完整**輸出,所以引文永遠可以回頭比對)。

不使用:model-generated character offsets、fuzzy quote matching、full worker output broadcast。

bare `<agentId>` 只在該專家的回答**只有一個 chunk** 時接受;多 chunk 時拒絕並回報可用清單 —— 用「取開頭」解歧義正是 rev.15 的缺陷。

Round 2 同時收到 original peer chunk **與** targeted challenge,不是 challenge-only。

`peerExcerptChars` 是 **configurable experimental parameter**,預設值沒有任何實測支持,每次執行都把實際用值寫進報告。

## Evidence 不變式(由結構保證,不是由 prompt 保證)

Round 2 的輸出**不進** `workerResults`、**不進** `summarizeRetrieval`、**不進** `deriveEvidenceLabel`。banner 一律由 Round 1 的 report 產生。因此 collaboration 在結構上碰不到 evidence label。

Round 2 **不掛 retrieval**,即使被挑戰的專家是 `evidenceCapable`。理由是隔離變因:同時加入 peer interaction 與新的外部檢索,之後無法分辨改善來自哪一個。

Decision synthesis 的 prompt 另外明寫「這一輪沒有取得新的外部證據,不得因為專家彼此同意就把任何東西描述成已驗證」—— 但這只是第二道防線,第一道是結構上它根本改不動 label。

測試斷言:開關兩種狀態下 `evidenceLabel` 與 banner 完全相同;任何路徑都不產生 `EVIDENCE_BACKED`。

## CollaborationReport

```text
status:       NOT_TRIGGERED | SKIPPED | COMPLETED | FAILED
reason:       機器可讀的原因字串
answerSource: round1_provisional | round2_decision_synthesis
parse:        { status: absent | parsed | malformed | schema_invalid, note? }
issues:       { emitted, valid, eligible, recorded[], rejected[{index, reason}] }
selectedIssue / round2 { agentId, provider, peerExcerpt, output|error }
timings:      { gateMs?, round2Ms?, decisionSynthesisMs?, totalMs? }
```

`timings.totalMs` **包含 gate**。不含的話,collaboration 會看起來剛好便宜了它所增加的最貴那一次呼叫。既有 `planningMs` / `workersMs` / `synthesisMs` / `totalMs` 的語意與形狀未動;M2 啟用時 `synthesisMs` 就是 gate 那次呼叫的時間,`gateMs` 與它相等,由測試斷言。

## 兩個刻意保留的不對稱

1. **SIMPLE direct-delivery 與 FAILED 執行不回傳 `collaboration` 物件**,即使開關打開。這兩條路徑在 policy 判定後就提前 return,屬於 Step 7 runtime;指令第 10、15 條要求本輪不改它們。deep 執行永遠不會走 direct delivery(policy 回 `non_simple_execution`),所以這不影響 M2 的量測範圍。
2. **direct-delivery 仍不套 `buildOutputBanner`。** 本輪沒有順手改 runtime,改為新增不變式測試:凡是 direct-delivery 合格的 report,`buildOutputBanner(report)` 必須是空字串。未來 policy 一旦放寬到會需要 banner 的情況,測試會先炸,而不是使用者先收到沒有警示的答案。

## Trigger rate 的正確定位

⚠️ 這推翻了 rev.14 我自己寫的一條原則。

觸發率**不是** kill criterion。低觸發率同樣可以代表 gate 很精準 —— 只在真正有跨專家分歧時才啟動。真正要量的是 **triggered usefulness**:Round 2 有沒有修正 material problem、有沒有改變重要決策。

報告因此記錄 `issues.emitted` / `issues.valid` / `issues.eligible` 與是否觸發,但這些是 **diagnostic metric**,不是判決。

## 這輪沒有做的事

independent Chief Review、Judge、`run_debate()` nesting、full peer broadcast、超過 1 位 Round-2 專家、超過 2 rounds、autonomous loop、planning loop、Round-2 retrieval、claim-level validation、`groundingSupports` consumer、Step 8/9/10、pricing、大型 live benchmark、default-on。

## ⚠️ 實作後才看清的一個 confound(指令未提及,尚無解法)

- **arm B**:synthesis prompt = `P` → 答案
- **arm C**:synthesis prompt = `P + 附錄` → provisional answer

**即使 C 完全沒有觸發 Round 2,C 的答案也是在一個和 B 不同的 prompt 下產生的。** 附錄要求模型去尋找跨專家分歧,這件事本身就可能改變答案 —— 更防禦性的措辭、注意力被分走,或反過來因為重讀各專家輸出而更完整。

所以 `C > B` 有可能**完全不是 peer interaction 造成的**,而是附錄造成的。

### ⚠️ 我 rev.15 提的拆法是錯的,已被推翻

rev.15 我提議用「C 執行中 SKIPPED 的那些」當天然的 arm B′,和 COMPLETED 的那些比。**架構審查否決了這個做法,理由是 selection bias,而那個理由是對的** —— 觸發與否不是隨機分派,而是與任務本身相關(有跨專家分歧的任務才會觸發)。拿兩群不同的任務相減,量到的是任務差異,不是 peer interaction。

我當時已經標注「可能不成立」,但仍然把它寫成主要方案。**正確的處理是:一個自己知道可能不成立的識別策略,不應該被寫成方案,應該被寫成待解問題。**

**rev.16 採用的正確做法是 frozen Round-1 replay:**

```text
凍結同一份 Round 1 outputs,只重跑 synthesis:

B   = 既有 synthesis prompt
B′  = gate synthesis prompt + Round 2 強制關閉

(B′ − B) = 附錄本身的效果,同一批任務、同一份 Round 1,沒有分組問題
```

peer interaction 的效果則用**同一次執行內**的配對比較:

```text
C_provisional  vs  C_final     ← 同一個任務、同一份 Round 1、同一次 gate 輸出
```

兩者都是 paired,不需要跨任務相減。`replaySynthesis()` 與 `CollaborationConfig.disableRound2` 就是為此而生。

## 是否已具備進入 A/B/C/D 評估的條件?

**Runtime 具備了,實驗協定還沒有。**

| 項目 | 狀態 |
|---|---|
| arm B vs arm C | ✅ 同一個 MCP 工具,單一 flag 切換,payload 在關閉時逐欄相同 |
| arm A(強單模型) | ✅ 用既有 `run_pipeline` 單步即可,不需要新程式 |
| arm D(單模型 + self-review) | ✅ `run_pipeline` 兩步,第二步用 `{{input}}` 自我檢視 |
| 盲測 | ✅ `finalOutput = banner + text` 且 `buildOutputBanner` 是純函式,`finalOutput.slice(banner.length)` 可精確還原無標籤答案。已加測試 —— 沒有這個,只有 B/C 帶 banner,評分者看第一行就知道是哪個 arm |
| Frozen Evidence Packet | ✅ 架構可支援:四個 arm 全部關檢索、把凍結證據放進 task 文字,即可得到 byte-identical evidence input。**未建置**,依指令第 18 條 |
| 檢索對等(E1) | ⚠️ 未解 —— 只有 Gemini 的 `grounded_retrieval` 是 `enabledInRuntime: true`。現階段唯一乾淨作法是四個 arm 全關檢索,證據維度暫時離開實驗 |
| 附錄效果隔離(B vs B′) | ✅ `replaySynthesis()` + `disableRound2`:凍結同一份 Round 1,只換 synthesis prompt |
| Peer interaction 配對比較 | ✅ `collaboration.provisionalAnswer` 與 `finalOutput` 同時保存,`C_provisional` vs `C_final` 是同一次執行內的配對 |
| 評分 rubric 與比較協定 | ❌ 不存在,依指令第 18 條本輪不建 |
| **Gate 在真實任務上是否會產出 issue** | ❌ **完全未知 —— 從未跑過一次 live gate** |

最後一項是最便宜也最該先做的:在寫任何評分系統之前,先確認 gate 在真實 DEEP 任務上到底會不會產出合格的 peer challenge,以及它產出的 `sourceRef` 是否真的用了 `<agentId>:<chunkId>` 形式。如果從不產出,C 與 B 在行為上就是同一個東西,後面的比較全部沒有意義 —— 但依第 14 條,那是**診斷結果**,不是自動的處決理由:也可能代表這批任務本來就沒有跨專家分歧。

## 首次 Live 應該先看什麼

一次 DEEP 執行(`enabled: true`)就足以回答三個目前完全未知的問題,不需要 benchmark:

1. gate 有沒有產出區塊?區塊有沒有通過 parse?
2. `sourceRef` 是不是 `<agentId>:<chunkId>` 形式、而且指得到存在的 passage?(`chunkMap` 與 `issues.rejected` 會直接說)
3. 模型有沒有遵守「最多一個」?(`issues.eligible > 1` 會留下 note)

這三題的答案決定接下來要不要調 prompt,而它們都不需要評分系統。

已停在此處,未自行開始任何 live 執行。

---

# 二十二、M2-A Diagnostic Live #1 / #2 —— 兩次皆 NOT EXERCISED

證據:[`diagnostics/m2a-live/`](diagnostics/m2a-live/),含每次呼叫的 prompt 原文與回應原文。

兩次執行的 commit 都是 `d1d1d28`,working tree 全程 clean,**沒有修改任何程式**。方法:注入一個 pass-through recorder 當 dispatcher,參數原封不動轉給真正的 `callProvider`,額外保存構建出來的 prompt —— 因此「Round 2 prompt 實際包含什麼」這類問題可以用 artifact 回答,不是靠讀原始碼推論。

## 一句話結論

**targeted peer challenge 機制到目前為止一次也沒有被真正執行過,而且兩次被擋下的原因不同。**

| | Fixture 性質 | complexity | N | 阻擋點 | logical calls |
|---|---|---|---|---|---|
| #1 | 五年租約 + 650 萬 capex 的重大投資決策 | `deep` | 1 | `single_specialist_no_peer` | 3 |
| #2 | 月訂閱新服務,含商業/市場/品牌三種決策資訊 | **`normal`** | 2 | `complexity_not_deep (normal)` | 4 |

**修掉其中一個不會讓另一個消失。** M2-A 的 gate 需要同時滿足 `deep` **且** 至少 2 位成功專家;兩次執行各自缺了其中一個條件。

## Diagnostic #1

Chief 正確判為 `deep`,列出 5 項 required capabilities,但只派 1 位 `business_strategist`。原文理由:

> Additional market/brand specialists would add detail but **not change the core decision under current data constraints**.

Fixture 裡寫了「虛擬製作的實際市場需求我們沒有數據」—— Chief 讀成「市場研究在這裡幫不上忙」。**這一半是任務設計造成的**,不是 planner 缺陷。

`RunStatus: SUCCESS`｜`EvidenceLabel: HYPOTHESIS`(deep 且無 evidence 專家)｜banner 正確附加｜總時長 273.4s。

## Diagnostic #2 —— Planning Reachability PASS

固定 fixture(逐字使用,sha256 `e8b6493d…`)刻意同時包含商業可行性、市場需求判讀、品牌定位三種不可互相取代的資訊。

```
complexity          : normal
requiredCapabilities: business strategy and unit economics
                      brand architecture and service design
assignment count    : 2  → business_strategist(high) + brand_creative(medium)
planningAdjustments : []
```

Chief 原文理由:

> Decision hinges on unit economics/operational risk and brand cannibalization. **No external research is needed.** … **Two specialists are sufficient.**

它排除 `market_researcher` 的理由與 fixture 明寫的「不需要進行外部搜尋」一致。**依既有標準這是 PASS** —— 第 5 節的判準是「>= 2 位」,而不是「一定要 3 位」;2 位若有合理理由,同樣是正確的 Minimum Sufficient Collaboration。

但 complexity 判成 `normal`,而 M2-A 是 DEEP-only,所以 gate 仍未執行。

**這次的材料本來是夠的。** 兩位專家都選 B,但論證基礎不同 —— strategist 從下檔風險與證據強度切入,brand_creative 從定價錨點與客群區隔切入。gate 從來沒有機會看到這組材料。

## 兩次都成立的 runtime 不變式

以實際 artifact 驗證,不是靠程式碼推論:

| 檢查 | #1 | #2 |
|---|---|---|
| gate 未啟動時 synthesis prompt 不含附錄 | ✅ | ✅ |
| 無 `synthesis_gate` / `round2_worker` / `decision_synthesis` stage | ✅ | ✅ |
| `finalOutput` 逐字元 == `banner + synthesis 原文` | ✅ | ✅ |
| evidence label 以 Round 1 獨立重算一致 | ✅ HYPOTHESIS | ✅ NOT_APPLICABLE |
| 所有呼叫皆無 retrieval request 與 result | ✅ | ✅ |
| call ceiling respected | ✅ 3 = 1+N+1 | ✅ 4 = 1+N+1 |
| `collaboration` 物件四態可分辨 | ✅ NOT_TRIGGERED | ✅ NOT_TRIGGERED |

**沒有發現任何 runtime defect。**

## Chunk 壓力觀察(僅觀察,未修改 Chunker)

```
#1  business_strategist : 36 chunks
#2  business_strategist : 23 chunks
    brand_creative      : 17 chunks
    total presented     : 40
```

若 gate 有跑,#2 會面對 40 個可選 reference。

低資訊 chunk 確實存在:#2 的 `business_strategist` 有 10 個少於 40 字元的 chunk,其中 4 個是孤立的 `---` 分隔線,其餘是 Markdown 標題行;`brand_creative` 只有 2 個。

**依指示未修改 Chunker。** 只有在真實 gate 選中無意義 chunk 並造成 peer challenge 錯位時,才構成修改依據 —— 目前沒有這個證據,現在改就是在對著猜測調整。

## Latency 觀察(單次,非平均值)

```
#1  planning 29.9s  | worker      178.6s | synthesis 65.0s  | total 273.4s
#2  planning 20.1s  | workers     572.1s | synthesis 122.3s | total 714.5s
```

#2 的 `brand_creative`(openai)單次 **572.1 秒**,比 #1 的整輪總時長還久。單次觀察,不是平均值、不是 SLA、不是 production performance —— 但值得記在案。

## 本輪不得宣稱的事

多 agent 比單 agent 好、peer challenge 改善答案、M2-A 已證明有產品價值、三位專家才是正確規劃、planner 必須固定招募三人。**兩次執行都沒有讓機制運作,因此對機制的價值一無所知。**

這兩次回答的只有:多 specialist path 在合理任務下是否 reachable(#2:是),以及機制是否按設計運作(仍未知)。

## 給下一輪 Architecture Review 的開放問題

| # | 問題 |
|---|---|
| R-1 | DEEP-only 是否過窄?#2 是一個有真實跨專家分歧的 `normal` 任務,卻不在範圍內 |
| R-2 | 兩次不同 fixture 分別收斂到 1 位與 2 位,是否需要研究 planner policy?(第一次的原因與任務設計有關,不宜單獨當證據) |
| R-3 | 要不要接受「diagnostic 只能靠碰運氣觸發」,還是需要一個能穩定觸發 gate 的方式來驗證機制本身? |
| R-4 | Chunk 切法在 40 個 reference 的規模下是否足夠精準?(目前無證據,不宜先改) |

**R-3 是關鍵。** 目前驗證機制的唯一辦法是不斷跑真實任務、等它自然觸發,而兩次都沒中。這既慢又貴,而且無法保證下一次會中。

---

# 二十二-A、Diagnostic #1 的 arithmetic defect(補記於 rev.23)

> **分類:Answer-Quality Defect(協作規則 §10)。**
> **不是 runtime defect** —— runtime、parser、report、evidence label 全部正常運作,
> 錯的是模型自己寫出來的數字。此節只作為兩件事的 evidence,不作其他用途。

## 事實

`[FACT]` 可由 committed artifact 直接重算:
`diagnostics/m2a-live/run1-not-exercised/artifact.json` 的 `calls[1].responseText`
(`business_strategist` 的 Round 1 輸出)。

原表的三欄:

```
                    增量成本合計   減：原外租省下   淨增量（報告值）   正確值
Base      殘留 64萬      454萬          -256萬           198萬          134萬  ← 高估 64萬
Upside    殘留  0萬      390萬          -320萬            70萬           70萬  ← 正確
Downside  殘留160萬      590萬          -160萬           430萬          270萬  ← 高估 160萬
```

## 錯誤的性質

`[FACT]` 殘留外租需求**已經被計入**「增量成本合計」,但扣除項只扣了
**被取代的那一部分**外租(320萬 × 取代比例),而不是全額 320萬。

**殘留為 0 時剛好正確,這解釋了為什麼 Upside 沒錯 —— 它是系統性錯誤,不是隨機失誤。**

`[SIGNAL]` 一次觀察。不宣稱這是該模型的普遍行為,也不宣稱其他 arm 不會犯同類錯誤。

## 只作為兩件事的 evidence

1. **M2-B 的 F7 fixture 準入條件** —— Phase 1 排除「核心決策依賴大量 deterministic arithmetic」
   的 fixture。理由是單一算術錯誤足以翻轉 headline decision,而它的發生是隨機的,
   會成為與 peer information 無關的巨大變異來源。
   詳見 `M2_EFFECTIVENESS_EXPERIMENT.md` §13.1、§24.3。
2. **未來 deterministic Finance Layer 的 motivation** ——
   長期架構方向是 `raw inputs → deterministic calculation layer → locked metrics → LLM interpretation`。
   Finance Layer 尚未實作,在它完成前不應用純數學錯誤判定 Peer Challenge effectiveness。

## 明確不得用於

```
❌ 不得稱為 runtime defect
❌ 不得作為任何 arm 優劣的證據
❌ 不得作為「應該現在就做 Finance Layer」的排序依據（那是獨立的 architecture decision）
❌ 不得從一次觀察推論該 provider 的算術能力
```

`[DESIGN]` 附帶一個公平性註記:排除算術重的 fixture **對 arm C 不利,不是圖利 C** ——
算術錯誤正是 peer challenge 最有機會抓到的東西之一。排除它是保守選擇。

---

# 二十三、M2-A Controlled Frozen Round-1 Replay(#3)—— gate 首次執行,仍 NOT EXERCISED

證據:[`diagnostics/m2a-live/controlled-replay/`](diagnostics/m2a-live/controlled-replay/),含逐字 fixture、fixture hash、harness 與完整 artifact(gate prompt 與回應原文)。

## 為什麼改用 replay

#1 與 #2 都被擋在 gate 之前(`single_specialist_no_peer`、`complexity_not_deep`),共花約 16.5 分鐘與 7 次 model call,換到的只有「還是沒觸發」。繼續跑自然任務,期望值不會更好。

改用 controlled frozen Round-1 replay:凍結一份**合法**的 snapshot(`deep` / `SUCCESS` / N=2 / 兩份來源不同、帶明確 B vs C 衝突的 Round 1 輸出),只讓 synthesis 之後的路徑走真實 live 呼叫。

**Planning 與 Round 1 是 synthetic fixture,不在測試範圍內;gate 之後全部是真實 provider call。** 這不是一次自然的 production run,文件與 artifact 都明確標記。

## 架構邊界:不需要 bypass flag

沒有新增 `forceCollaborationGate` / `forceRound2` / `diagnosticMode` 之類的 runtime trigger。既有的 `replaySynthesis()` 就足夠 —— 它委派給 `runSynthesisStage()`,也就是 live orchestrator 用的同一份實作。

harness 沒有自行重寫 gate、parser、chunk resolver、Round 2 builder 或 decision synthesis;重寫了就是在測第二份實作。

## Gate 確實執行了

以 captured prompt 驗證(非推論):

| 項目 | 結果 |
|---|---|
| 附錄實際送達 | ✅ `Optional collaboration block` 在 prompt 中 |
| chunk map 送達 | ✅ 40 個 reference:`business_strategist:p1…p18`、`brand_creative:p1…p22` |
| max-one 規則送達 | ✅ `At most one "peer_challenge" may be emitted.` |
| 保守措辭送達 | ✅ `Prefer omitting the block entirely to inventing a disagreement.` |

Gate prompt 4,513 字元,openai / gpt-5,耗時 68.2 秒。

## 結果:`SKIPPED / no_issue_block`

```
issues.emitted / valid / eligible / rejected : 0 / 0 / 0 / 0
parse.status : absent
```

## ⚠️ 但「gate 沒認出分歧」這個描述是錯的

Architecture Review 預設的失敗敘述是「gate failed to identify the fixture's explicit decision-sensitive disagreement」。**實測不是這樣。**

gate 的回答裡有一段標題明確寫著「**專家分歧與如何處理**」:

> 分歧焦點:是否應「暫不推出」(C)以避免產能/毛利風險,或以「品牌隔離+容量控制」先小規模推出(B)。
> 我們的處理:採 B 的同時,把 C 當成即刻可執行的 Kill Switch。

**它精準認出了 fixture 設計的那個衝突,點名雙方論據,然後在答案裡把它解決掉了。**

而依附錄自己的規則,省略區塊是**正確**的:

> Raise an issue only where … **resolving it would change a decision in the answer**.

分歧已在答案內解決,所以那個條件不成立。**模型遵守了指示,沒有失誤。**

## 這暴露的是責任對立,不是模型缺陷

同一次呼叫被交付兩個互相拉扯的責任:

```
產出一份完整可用的答案   →  必須把衝突處理掉
回報未解決的跨專家衝突   →  需要衝突還沒被處理掉
```

**做好第一件事,就消滅了做第二件事的理由。** 一個把分歧整合進答案的 synthesizer,依定義沒有 issue 可報。

這把 R-3 的問題重新定位:**不是「gate 找不到分歧」的 recall 問題,而是「gate 找到了卻沒有理由用機器可讀通道回報」的通道問題。** 兩者修法完全不同 —— recall 問題要調偵測靈敏度,通道問題要調責任分配。

依指示未修 prompt、未重跑、未人工插入 issue。這是給 Architecture Review 的材料,不是本輪的決定。

## 真實執行中再次成立的不變式

| 檢查 | 結果 |
|---|---|
| `collaboration.provisionalAnswer` 保存 | ✅ 2,565 字元,與 gate 回應逐字元相同 |
| `finalOutput == banner + gate 回應` | ✅ 逐字元相同 |
| EvidenceLabel before / after | ✅ HYPOTHESIS / HYPOTHESIS,以凍結 Round 1 獨立重算亦相同 |
| grounding banner before / after | ✅ 完全相同 |
| retrieval | ✅ 唯一一次呼叫 requested 與 result 皆為 null |
| RunStatus | ✅ SUCCESS |
| live call 數 | ✅ 1(gate 未觸發時的預期值) |

**無 runtime defect。**

## 仍然零次真實執行的部分

```
parser 成功路徑
sourceRef 解析
chunk 擷取
max-one deterministic selection
Round 2
Decision Synthesis
```

三次 live 之後,機制的後半段**一次也沒有被執行過**。

## 三次 live 的完整圖像

| | 性質 | complexity | N | 阻擋點 | live calls |
|---|---|---|---|---|---|
| #1 | 自然任務 | `deep` | 1 | `single_specialist_no_peer` | 3 |
| #2 | 自然任務 | `normal` | 2 | `complexity_not_deep` | 4 |
| #3 | **controlled replay** | `deep` | 2 | **`no_issue_block`(gate 已執行)** | 1 |

前兩次卡在 gate 之前,第三次卡在 gate 之內。**每一次的阻擋點都不同,而且修掉任何一個都不會讓其他兩個消失。**

## 本輪不宣稱

M2-A 比 baseline 好、peer challenge 提升品質、多模型優於單模型、B 比 C 正確、gate recall 不足、NORMAL 應啟用 M2-A、應 productionize、latency/cost 值得。

**#3 只證明了一件事:當合法前置條件存在時,gate 會執行,而它在這一次選擇不提報。**

---

# 二十四、Controlled Replay #4 — FULL MECHANISM RUNTIME PASS / STOPPED

完整驗收與原始證據見 [evaluation.md](diagnostics/m2a-live/controlled-replay-4/evaluation.md)
及 [artifact.json](diagnostics/m2a-live/controlled-replay-4/artifact.json)。
本輪只執行一次 controlled frozen Round-1 replay;Planning/Workers 是原 synthetic fixture,
後三個 stage 為真實 provider calls。此處只驗證 mechanism,不判 B/C 商業正確性。

## 已批准的語義修正

由「synthesis 完後仍未解決的 conflict」改為「原始 Round 1 是否存在 material、
cross-agent、decision-sensitive disagreement,其直接回應是否可能 materially 改變/強化/
推翻/限縮 final decision」。即使 provisional 可提出折衷或 Kill Switch,仍可提報。
不滿足條件時依然可以省略區塊;max-one、sourceRef/schema/selection/runtime flags 全部未改。
這是對第二十三節設計對立的 specification decision,不是通用 force-trigger。

## Fixture 與驗收

#3/#4 的 Original Task、missions、synthetic outputs、complexity、assignment order、
status 與 chunkMap 都相同。逐檔 hash 見 preflight;聚合 snapshot hash 都為:

`cb5e9c309a8b64cac1b688d9de4ff4a9b26fc504d40d3ccb5ff412bcb4965a4b`

此 hash 定義為原 #3 snapshot 形狀的 `SHA256(JSON.stringify(snapshot))`。
Status 另由 buildRunReport 重算,仍是 SUCCESS。未使用 rev.19 reset 後的 BENCHMARK_TASK
替換此 fixture,因此不混用舊/新年度策略 benchmark 數字。

| 檢查 | 結果 |
|---|---|
| Gate Live Reachability / Disagreement Recognition | PASS / PASS |
| parse.status | parsed |
| issues.emitted / valid / rejected / eligible | 1 / 1 / 0 / 1 |
| selected issue | brand_creative ← business_strategist:p5 |
| action / decisionSensitive | peer_challenge / true |
| sourceRef / deterministic selection | PASS / PASS;selected=1;fallback used=false |
| Targeted R2 / Decision Synthesis | PASS / PASS |
| R2 actual prompt context | task、target mission/output、exact peer chunk、challenge 逐字一致 |
| R2 retrieval request/result | null / null |
| EvidenceLabel / RunStatus | HYPOTHESIS / SUCCESS,前後相同 |
| banner / retrieval summary / frozen snapshot | 前後一致 |
| provisional / R2 / final raw text | 完整保存 |
| runtime fingerprint before/after | 相同 |

Resolved chunk: `business_strategist:p5`,offset [175,215),未截短。

> 在公司沒有足夠資源同時擴編兩條產品線的條件下，我不建議現在投入新的固定服務承諾。

**Chunk relevance=YES。** Challenge 要求品牌 specialist 直接回應資源不足下的交付與毛利
前提;R2 回應該論點並條件化其建議。Actual R2 contract 允許反駁、維持立場與部分修正,
沒有強迫 consensus。Decision contract 保留 revision/recency/agreement 不等於 evidence。

## Calls、Timing 與限制

實際 live logical calls=3,皆 openai / gpt-5:

| Stage | Runtime phase |
|---|---:|
| synthesis_gate | 46729ms |
| round2_worker | 42713ms |
| decision_synthesis | 68965ms |
| replay total | 158408ms |

未重跑 Planning/Workers,不可宣稱實際花了 N+4 次。N=2 的完整 runtime ceiling 仍是6。
SDK HTTP retries、tokens/cost 未計量。這次是跨 specialist 的 mechanism replay,
不是兩個不同 provider 都 live 產出後的 end-to-end 品質測試。

Failure fallback 與模型違規產出多 issue 的分支仍有 offline tests,本次未 live exercised。
Verifier 曾因 undefined 欄位在 JSON 中省略而誤判,只修比較表示方式後通過,
未修改 live artifact 或再次執行。未確認需修復的 production runtime defect。
模型輸出中的工時/毛利/價格等假設不當作已驗證資料或 pricing registry。

**狀態:STOPPED / AWAITING ARCHITECTURE REVIEW。**
PASS 只代表 downstream mechanism 在真實 provider calls 下跑通一次。
未證明 peer challenge 的品質增益或多模型優勢,未批准 productionization 或後續實驗。

---

# 二十五、rev.20 Independent Code Review —— ACCEPT WITH DOCUMENTATION CORRECTION

由 Claude Code 執行的獨立 architecture + code review,對象是 rev.20。
本輪**未實作任何變更**:`src/` 未動、測試未動、`diagnostics/` 未動,repo 只被讀取。

```
Branch reviewed       : experimental/m2a-peer-challenge
HEAD reviewed         : 4e34d89d9d88e64d0bcfd641809c8ff57bf03b25
Parent implementation : 267ecffb2eebbb8fe4d42333469ad8d10b0362f4
Baseline              : aedc9efe0ff1f4acf7d5a36d9a1b3ab87e5b9af8 (rev.19)
Ancestry              : aedc9ef → 267ecff → 4e34d89(線性,無 rebase / force)
```

## 驗證方式(重要:以下 PASS 不是讀 artifact 自報值)

在 scratchpad 另開 `aedc9ef` 與 `4e34d89` 兩個乾淨 git worktree,各自從 committed source
重新 `tsc` build,然後:

| 動作 | 用途 |
|---|---|
| 兩個 commit 各跑一次 `control.mjs` | 獨立重算 disabled control hash |
| 兩個 commit 各跑一次完整離線套件 | 獨立確認 208 / 212 |
| 在 after worktree 跑 `verify.mjs` | 獨立確認 fixture identity、seal、runtime fingerprint |
| 從 frozen snapshot + rev.20 `buildGateAppendix()` 重建 gate prompt | 獨立確認 gate 實際看到什麼 |

worktree 事後已 `git worktree remove`,主 checkout 未受影響。

## 逐項判定

| # | 面向 | 判定 |
|---|---|---|
| 1 | Scope fidelity | **PASS** |
| 2 | Gate semantics correctness | **CONCERN** |
| 3 | Disabled control byte-equivalence | **PASS**(獨立重現) |
| 4 | Offline tests | **PASS** |
| 5 | Replay fixture identity | **PASS** |
| 6 | Valid issue parsing | **PASS** |
| 7 | SourceRef correctness | **PASS** |
| 8 | Selective R2 context | **PASS** |
| 9 | Evidence invariants | **PASS** |
| 10 | Failure semantics classification | **PASS** |
| 11 | Claims discipline | **PASS** |

**Runtime defects found:無。**

## 1. Scope fidelity —— PASS

`src/` 全樹 diff = **4 additions / 1 deletion,單檔單 hunk**,位於 `buildGateAppendix()` 內。

逐項核對宣稱的排除,全部成立:新增 provider call、force flag / detector / Judge、Planner、
Chief、DEEP-only 資格、Chunker、parser schema、sourceRef resolver、retrieval、EvidenceLabel、
Step 7 —— **一項都沒動**。`CollaborationConfig` 介面與 baseline `diff` 結果為 IDENTICAL,
default OFF(`input.collaboration?.enabled === true`)未改。

**HANDOFF 宣稱與 code reality 一致,未發現不符。**

`verify.mjs` 自己也做了一次結構性 scope 檢查(`split('buildGateAppendix')[0]` 與
`split('buildRound2Prompt')[1]` 對 baseline byte 相等),但要注意它的界線:
`buildGateAppendix` 函式**本體**不在這兩段之內。真正把範圍釘死的是 git diff。

## 2. Gate semantics correctness —— CONCERN

先講清楚:**實作對規格是逐字忠實的。** 指令書的 contract「有實質可能改變、強化、否證或
重大限定 final decision」與 code 的 `a meaningful chance of changing, strengthening,
falsifying, or materially qualifying the final decision` 一一對應。**這不是實作越權。**

三個限制與兩個 counterweight 都在(從 live gate prompt 原文確認,非從 source 推論):
`material` / `cross-agent` / `decision-sensitive`、exclusion list、`At most one`、
`Prefer omitting the block entirely`。

CONCERN 針對**規格本身的寬度**:

**(a)「strengthening」使判準接近恆真。** binary 結果只有「改變」與「不改變」兩支;
「改變 ∪ 強化」把兩支都蓋住。直接 peer response 若沒改變決策,幾乎必然「強化」它。
四個動詞裡它是唯一無法被否證的。

**(b) 三個限制中只有一個是獨立的。** `material、cross-agent、decision-sensitive` 後面接冒號,
由**同一句**定義三者 —— material 與 decision-sensitive 塌縮成同一條判準。真正獨立且有 code
強制的只有 cross-agent(`validateIssues` 拒絕 self-review)。實際 guard 是
**一條 code check + 一條 prompt 子句**,不是三條。

**(c) 限制性語氣消失。** rev.19 是 `Raise an issue **only** where…`;rev.20 的 eligibility
段落沒有 `only`,取而代之是祈使句 `If so, **emit** … even if your provisional answer offers
a compromise`。`Prefer omitting` 防的是**捏造**分歧,不防**真實但次要**的分歧被過度提報;
防後者的 exclusion list 現在正好排在那句 override 之下。

**(d) 風險有界,且是成本不是正確性。** DEEP-only + SUCCESS + N≥2 未動;`selectIssue` 在 code
層強制單一,不管模型吐幾個;ceiling 仍 N+4。過度觸發的最壞情況是每次 DEEP run 多兩次
provider call。

⚠️ **Replay #4 只有 1 個 issue,既不證明也不排除過度觸發。**

## 3. Disabled control byte-equivalence —— PASS(獨立重現)

在兩個 commit 各自 rebuild 後重跑 `control.mjs`:

```
aedc9ef → f50a7b2ee2a8b7f896dc6a6b88692d612281553011a1de685b2e39c9a567c698
4e34d89 → f50a7b2ee2a8b7f896dc6a6b88692d612281553011a1de685b2e39c9a567c698
committed control-before.json / control-after.json 亦同一 hash
```

16 組 = 3 complexity × 2 config × 3 status − 2 個不可能的 simple/DEGRADED。捕捉內容含
provider、**完整 prompt**、options(model/system/stage)與完整 result(含 `finalOutput`、
`workerResults`、`report`、`timings`),共 52 次 call;`result.collaboration` 全部 absent,
三個 collaboration stage 全部未出現。

`control.mjs` 以 `flag:'wx'` 寫檔,**無法事後覆寫 before** —— 這個細節讓證據鏈站得住。
**Control 未漂移。**

## 4. Offline tests —— PASS

獨立重跑,非引用 log:

```
aedc9ef : 11 + 25 + 20 + 11 + 36 + 105 = 208 passed / 0 failed
4e34d89 : 11 + 25 + 20 + 11 + 36 + 109 = 212 passed / 0 failed
```

**test diff 是純插入(`@@ -848,6 +848,71 @@`,零刪除行)** —— 這是「既有 assertions
未放寬」最硬的證據,比逐條讀測試更可靠。四項新測試對應四個要求,全部到位;max-one 那項
額外驗了 `calls.length === N + 4`。

## 5. Replay fixture identity —— PASS

`verify.mjs` 直接 `assert.deepEqual(a.snapshot, old.snapshot)` 對上 #3 的 artifact,
不是比對自報 hash;五份 fixture 也逐檔 SHA-256 對回 `../controlled-replay/`。我重跑通過。

```
replay3SnapshotSha256 = replay4SnapshotSha256
                      = cb5e9c309a8b64cac1b688d9de4ff4a9b26fc504d40d3ccb5ff412bcb4965a4b
task / missions / Round1 outputs / assignment order / RunStatus / roster / chunkMap(18+22)
```

額外確認一項未被宣稱的事:`runtimeFingerprint`(33 個 src/dist/config 檔的 SHA-256)在我這台
機器 clean rebuild 後**逐檔相同** —— build 是可重現的。

## 6. Valid issue parsing —— PASS

不看 artifact 自報欄位,改用 committed 的 production function 從 committed 的 gate response
重算:`parseGateOutput(calls[0].responseText)` → `deepEqual(artifact.parserReplay)` ✓。
`parse=parsed`;`emitted 1 / valid 1 / rejected 0 / eligible 1 / selected 1`。

另從 frozen snapshot + rev.20 `buildGateAppendix` 獨立重建 live gate prompt,
與 artifact 記錄 **byte-identical**:

```
sha256 a64cd320b27a61e722ff0e87701afa2469ca03b2329cd5a2d15ab0928009f8c7
新語義存在 = true      rev.19 舊語義存在 = false
max-one = true         prefer-omitting = true      exclusion list = true
deterministic references offered = 40(unique 40)
```

**Gate 確實看到了新規則,而且看到的是 40 個確定性引用。**

## 7. SourceRef correctness —— PASS(附精確度觀察)

```
sourceRef : business_strategist:p5
resolved  : ok=true, index=4, offsets [175,215), 40 chars, truncated=false
source ≠ target : business_strategist ≠ brand_creative
```

`resolveSourceRef` 是 `chunks.find(c => c.id === chunkId)` 精確比對 —— **無 fuzzy match**。
唯一的 bare-id 接受條件是該 specialist 只有一個 chunk;本次 sourceRef 帶了 chunkId,
該路徑未觸發 —— **無 answer-head fallback**。

**相關性判定成立,但要記一筆:** p5 是 business_strategist 的**結論段**;真正針對副品牌的
論證在 p7(「副品牌可以隔離部分品牌風險,但無法隔離營運資源」)與 p8(「即使叫 Content Lab,
實際執行仍然會使用同一批剪輯…資源」)。引用機制 works,但 **n=1 尚未顯示 gate 在 40 個候選中
會挑最精確的那個**。這正是 open question R-4,仍未解。

## 8. Selective R2 context —— PASS

讀 `calls[1].prompt` 原文:Original Task、Target Mission、Target Round1、**僅 p5 一段
peer chunk**、Challenge。`business_strategist` 的其餘 17 個 chunk **一個都沒進去**。
prompt 2188 字元 vs gate 5236 字元 —— **不是 full broadcast**。

精確性補充:R2 prompt 還含第六個區塊「Round 2 contract」(5 條),那是 rev.19 就有的
`buildRound2Prompt`,本次未改。該 contract 明文允許反駁(`Do not concede in order to
agree`)—— 沒有強迫 consensus。

## 9. Evidence invariants —— PASS(附 invariant 命名問題)

```
EvidenceLabel : HYPOTHESIS → HYPOTHESIS（並由 buildRunReport 從凍結 Round1 重算確認）
RunStatus     : SUCCESS → SUCCESS
banner        : before === after,且 finalOutput.startsWith(banner)
retrieval     : 三次 live call 的 request / result 全為 null
```

「Round 2 不得進 `workerResults` / `summarizeRetrieval()` / `deriveEvidenceLabel()`」
—— **性質成立**,但要點名它是**怎麼**成立的:

- 結構上:`workerResults` 在 `orchestrator.ts:459` 建立一次,之後無任何 append;
  `buildRunReport` 只在 line 491(production)與 951(replay)被呼叫,兩處都只吃 Round 1;
  `summarizeRetrieval` / `deriveEvidenceLabel` 只能從 `buildRunReport` 內部到達;
  `runCollaboration` 回傳 `{ answer, report }`,沒有通往 `workerResults` 的路徑。
- 證據上:`reportUnchanged` + `recomputedReportUnchanged` + `bannerUnchanged` 三項合起來
  就是這個性質的實證。

**但掛著這個名字的那條 invariant 不是。** 見 E4。

## 10. Failure semantics classification —— PASS

分層正確,沒有把 offline test 寫成 live failure injection。

**Live verified(真實 provider call,成功路徑):** Gate 執行 → valid issue 解析 →
sourceRef 解析 → Targeted R2 → Decision Synthesis。

**Offline-only(本次未 live 注入):** R2 failure fallback(`test-collaboration.mjs:535, 1060`)、
Decision Synthesis fallback(`:550`)、multi-issue deterministic 保護(`:189, 926`)、
malformed / schema_invalid 降級(`:224-238, 266, 302`)、validation 拒絕(`:348-381`)。

## 11. Claims discipline —— PASS

對 HANDOFF、evaluation.md、README.md 做禁語掃描(`p50 / p95 / average / 平均 / SLA /
production ready / 優於 baseline / 品質提升 / 多模型優於`),所有命中都是**否定句**或
**引用模型輸出**(`SLA` 出現在 challenge 原文裡,不是對系統的宣稱)。

evaluation.md 有兩處主動放棄有利敘事,值得記功:

1. 「#3 provisional 選 B、#4 provisional 選 C 是觀察,**不能歸因成 peer interaction 效果**」
   —— 我驗證了 #3 provisional 開頭確實是「決策:選 B」,#4 是「選 C」。自我設限正確且必要。
2. 主動記錄 verifier 曾因 `retrieval: undefined` 的 JSON 序列化而誤判,只改比較表示、
   未改 artifact、未重跑 live。

**另補一件文件沒宣稱但重要的事:headline decision 沒有翻轉。** #4 的 provisional 是 C,
final 也是 C。改變的是 C 的**條件結構** —— final 加上「封閉艙驗證 → 90 天後轉 B」的門檻,
並吸收了 brand_creative 在 R2 中從無條件 B 退到條件 B/否則 C 的修正。
**任何「peer challenge 改變了決策」的說法都是錯的**;正確說法是「改變了決策的附帶條件」,
而這是好是壞**未經證明**。

## Architecture concerns

**A1 —「strengthening」使 eligibility 判準接近恆真。** 見第 2 節。這是**已批准規格本身**的
性質,不是實作偏差。建議 architecture review **明知地**決定它是否該留。
**若日後出現過度觸發,這是第一個該懷疑的詞。**

**A2 — 三個限制中僅一個獨立且有 code 強制。** 見第 2 節 (b)。

**A3 — 限制性語氣(`only`)在 eligibility 段落消失,改為祈使的 `emit`。** 見第 2 節 (c)。
若要恢復 rev.19 的緊度,補一條明確限制句即可,不需動其他任何東西。

**A4 —(緩解)過度觸發的損害有界。** 見第 2 節 (d)。

## Experimental validity concerns

**E1 — #3 → #4 的差異是混淆的,而 artifact 自己證明了混淆非平凡。** 在 byte-identical
fixture 上,gate 自己的 provisional 從 #3 的 B 變成 #4 的 C。既然模型在該 stage 的輸出
**已被證實會變**,「#4 有 issue 而 #3 沒有」就無法在 n=1 vs n=1 下歸因於 wording change。
evaluation.md 已正確聲明這點,**不是文件缺陷**;但任何建立在「wording 修正生效了」之上的
後續決策,都需要兩種 wording 各跑多次。

**E2 — Round 2 的 model 未 pin。** `round2_worker` 以 `model: null` 派送(roster 兩位的
model 都是 null),由 adapter default 解成 gpt-5。`preflight.round2DefaultModels` 記了預期值
且吻合,但**未來 adapter default 一改,這個 hash-frozen replay 的 R2 臂會靜默改變**。
若 #4 要當日後的 comparator,建議把 R2 model 釘死。

**E3 — 單 provider。** 三次 live call 全是 openai / gpt-5。target 恰好是 brand_creative
(openai),`business_strategist`(claude)的 R2 路徑**從未執行**。跨 provider 的即時合作
未驗證。evaluation.md 已揭露。

**E4 — `noRound2Leak` 是該性質的弱代理。** `!Object.hasOwn(result,'workerResults')` 在
replay path 上**恆真**(`replaySynthesis` 本就不回傳該欄位),即使 production path 真的
洩漏也會 PASS。真正撐住該性質的是第 9 節列的三條 invariant 加結構論證。
建議改名或改基,讓證據標籤等於實際檢查。

**E5 — chunk 精確度未驗。** 見第 7 節,對應 open question R-4。

## Documentation inconsistencies

**D1 — 兩個新測試名稱超出其實際 assert 範圍。**
`a provisional compromise does not disqualify a material Round 1 conflict` 與
`equivalent recommendations and non-material differences remain excluded` 都跑在
**scripted** gate response 上,驗的是 prompt 文字 + runtime 分支,不是模型判斷。
檔案自己在上方註解已寫明(`These lock the delivered prompt contract and scripted runtime
behavior, not LLM judgment`)—— **在上下文中沒有失實**,但只掃 pass list 的讀者會誤以為
排除行為已被離線證明。建議改成 `…prompt states…` 形式。

**D2 — 第四個測試名稱的「remain byte-equivalent」是同一 build 內的 parity 測試。**
它比較 `run()`(omitted)與 `run({collaboration:false})`,**偵測不到跨 revision 漂移**。
跨 revision 的保證只來自 committed 的 control-before/after artifact。應寫明,以免日後有人
單靠離線套件來守這條線。

**D3 —(既存,非 rev.20 回歸)`result.timings.synthesisMs` = 46729 只記 gate,**
而交付答案來自 decision_synthesis(68965ms)。`collaboration.timings` 拆得正確,
`result.timings.totalMs` = 158408 也正確。這是 rev.19 就有的行為,本次 diff 未觸及 ——
僅標記以免日後有人把 `synthesisMs` 讀成「產生最終答案的成本」。

## 為什麼不當場修

1. **指令書明文禁止**:本輪只做 review,`Do not implement any follow-up changes`。
2. **D1 / D2 要動 `test-collaboration.mjs`** —— 那是 rev.20 acceptance 的一部分,
   改了就得重跑並重新宣稱 212,不該夾帶在 review 裡。
3. **E4 要動 `harness.mjs`,而它在封印裡。** `diagnostics/m2a-live/controlled-replay-4/
   hashes.json` 涵蓋該目錄下所有檔案(含 `harness.mjs`),`verify.mjs` 會逐檔比對。
   **在原地改名會直接破壞 Replay #4 的封印,使既有證據失效。**
   → 這項只能在**下一次 replay 的 harness** 修,不能回頭改。

## Final recommendation

```
ACCEPT WITH DOCUMENTATION CORRECTION
```

production diff 乾淨(單檔單 hunk),證據鏈可獨立重現。`verify.mjs` 用 **production
function** 從 committed source + committed response text 重推每個 downstream 欄位,
這讓 artifact 不是敘述而是**可重算的紀錄**。文件的 claims discipline 通過,且有兩處
主動放棄有利敘事。

需要修正的是 **D1 / D2 / E4 三處標籤與其實際證明範圍的落差** —— 都是文件與命名,不是 code。

**A1(`strengthening`)不列為 accept 的阻礙**,因為它是已批准規格的內容而非實作偏差;
但它應該在 M2-A 本來就在等的那次 architecture review 裡被**明知地**決定,而不是預設留著。

**狀態:M2-A 仍 STOPPED / AWAITING ARCHITECTURE REVIEW。本輪未實作任何 follow-up 變更。**
