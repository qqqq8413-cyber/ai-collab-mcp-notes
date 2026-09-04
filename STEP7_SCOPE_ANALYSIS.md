# §23 Step 7 — Complexity Router:範圍分析

> **STATUS: NOT IMPLEMENTED — BLOCKED BY STEP 6.1**
>
> 分析文件,**未修改任何程式碼**。
> 依據:`src/modes/orchestrator.ts` 現況 call graph、`src/agents/chief.ts`、5 次 deep orchestrator 實測、1 次獨立 planning 實測、1 次 simple 任務 baseline 實測(第 9 節)。

## ⚠️ 本文第 3、6 節的 V1 提案已被實測推翻

原提案 `assignments.length === 1 → synthesize: false`,現狀態:

```
REJECTED AS UNCONDITIONALLY SAFE
```

原因不是 synthesis 有價值,而是它目前正在**補救一個上游缺陷**:Worker 在 delegation boundary 看不到 Original User Task。在那個缺陷修好之前,拿掉 synthesis 等於拿掉一層 correctness recovery。

第 3、6 節保留原文以便對照;修正見第 9、10 節。

## 閱讀本文時的分類

| 標記 | 意義 |
|---|---|
| **已完成** | 程式碼中已存在並有測試 |
| **實測 observation** | 有數據支持,但樣本數已標明 |
| **architecture decision** | 已決定,不再辯論 |
| **hypothesis** | 尚未驗證,不得當成事實引用 |

---

## 摘要

| 問題 | 結論 |
|---|---|
| Planning V1 已完成 Step 7 的哪些部分 | **分類與資源上限全部完成**;執行拓撲**完全沒做** |
| 三個級距的 execution path 是否相同 | **完全相同**,逐行相同,沒有任何分支 |
| 可安全跳過的呼叫 | **只有一個**:單一專家時的 synthesis |
| SIMPLE fast path 的 latency 下限 | **17.1–33.1s**(planning 一次 model turn),只要保留 planning 就下不去 |
| V1 建議 | **保守方案**。融合式單次呼叫先不做,但要先量測 simple 任務 |
| 阻擋 Direct Path 的東西 | `planSchema` 的 `.min(1)` —— **目前 0 specialist 在型別上不可能** |

---

## 1. Step 7 的哪些能力已經由 Planning V1 完成?

| Step 7 應有的能力 | 現況 | 位置 |
|---|---|---|
| 任務分類為 simple / normal / deep | ✅ 完成 | `chief.ts` 常設簡報 + `planSchema` 第一欄位 |
| 各級距的專家數上限 | ✅ 完成 | `SPECIALIST_CAP` = 1 / 3 / 4 |
| 上限的**強制執行**(不只寫在 prompt) | ✅ 完成 | `enforceConstraints()` 依 priority 砍到 cap |
| mission 數量上限 | ✅ 完成 | 同上(一人一 mission + cap) |
| mission 長度上限 | ✅ 完成 | `MISSION_CHAR_LIMIT = 600` |
| 每次約束介入都可稽核 | ✅ 完成 | `planningAdjustments` |
| 外部預算覆寫上限 | ✅ 完成 | `budget.maxSpecialists`,取 `min(cap, budget)` |
| **依複雜度決定執行拓撲** | ❌ **完全沒做** | — |
| **依複雜度決定要不要 synthesis** | ❌ **完全沒做** | — |
| **依複雜度決定要不要 planning** | ❌ **完全沒做** | — |

**所以 Step 7 不應重做 classifier。** 剩下的範圍只有一件事:**讓 complexity 影響「跑幾個階段」,而不只是「允許幾個人」。**

---

## 2. SIMPLE / NORMAL / DEEP 現在走的路徑是否相同?

**完全相同。** `runOrchestrator()` 的結構是無條件的三段式:

```
callProvider(planning)                    ← 1 次,無條件
  ↓
Promise.all(assignments.map(callProvider)) ← N 次,平行
  ↓
callProvider(synthesis)                   ← 1 次,唯一的例外是 status === FAILED
```

`complexity` 在整個 codebase 裡只被讀取兩次:

| 位置 | 用途 | 影響執行嗎 |
|---|---|---|
| `orchestrator.ts:218` `SPECIALIST_CAP[plan.complexity]` | 決定砍到幾個人 | ❌ 只影響 N 的大小,不影響階段數 |
| `orchestrator.ts:317` `if (complexity !== 'deep')` | 決定 evidence label | ❌ 純報告,不影響執行 |

**結論:一個 `simple` 任務今天仍然要花 1 + 1 + 1 = 3 次 model 呼叫。** complexity 從來沒有讓任何一個階段消失過。這就是 Step 7 真正要補的洞。

---

## 3. 哪些呼叫可以安全跳過?

### 可以:單一專家時的 synthesis

只有一個專家時,synthesis 的 prompt 實質上是「把這一份答案整理成一份答案」。它會:

- 多花一次完整的 model turn(**實測 64.9–98.6s**)
- 把專家的原文換成轉述,可能在過程中掉細節
- 對 `simple`(cap = 1)而言,**這永遠是多餘的**

**但要保留一個例外**:mission 有可能比原始 task 窄,synthesis 有「把 mission 產出對回 task」的功能。所以跳過的條件應該寫成「恰好一個**成功**的專家」,而不是「complexity === simple」。

### 不可以:planning

跳過 planning 就等於失去:
- structured plan(`complexity` / `requiredCapabilities` / `assignments` / `reason`)
- `planningAdjustments` 稽核軌跡
- evidence label 所依賴的 `plan.complexity`

除非改用啟發式預分類器,但那會**新增**一次呼叫或引入一個沒有稽核軌跡的判斷。V1 不建議。

### 不可以:worker 呼叫本身

除非走融合式單次呼叫(見第 4 節),否則答案總得有人生成。

### 帳面上的節省

| 情境 | 現在 | V1 之後 |
|---|---|---|
| simple(1 專家) | 3 次 | **2 次** |
| normal(2 專家) | 4 次 | 4 次(不變) |
| deep(3 專家) | 5 次 | 5 次(不變) |

**V1 只省一次呼叫,而且只在單一專家時。** 這個數字要先說清楚,免得被誤解成大幅優化。

---

## 4. 怎麼加入 Direct / Fast Path 而不破壞現有機制?

### ⚠️ 先講一個結構性事實:分階段的 Direct Path 省不到東西

| 設計 | 呼叫數 | 說明 |
|---|---|---|
| 現況 | planning + 1 worker + synthesis = **3** | |
| 跳過 synthesis | planning + 1 worker = **2** | V1 建議 |
| 「Direct」= Chief 自己回答,但仍先 planning | planning + Chief answer = **2** | **跟上面一樣,沒有比較快** |
| 融合式:一次呼叫同時 routing + 作答 | **1** | 唯一真正的 fast path |

**所以「Direct Path」若做成獨立階段,是沒有意義的** —— 它跟「跳過 synthesis」花一樣多。唯一能真正壓低延遲的是融合式單次呼叫,而那要付出代價(見第 6 節)。

### 建議的低侵入結構:從 plan 推導出執行策略

不新增 model 呼叫、不改 prompt,純函式:

```ts
export type Topology = 'single' | 'collaborative';

export interface ExecutionPolicy {
  topology: Topology;
  synthesize: boolean;
  reason: string;
}

export function deriveExecutionPolicy(plan: Plan): ExecutionPolicy
```

推導規則(確定性,可離線測試):

```
assignments.length === 1  → { topology: 'single',        synthesize: false }
assignments.length >= 2   → { topology: 'collaborative', synthesize: true  }
```

### 對現有四個機制的影響

| 機制 | 是否受影響 |
|---|---|
| **structured planning** | 不受影響。policy 從 plan 推導,plan 本身完全不變 |
| **audit** | 增強。`report.policy` 記錄選了什麼拓撲與理由;跳過 synthesis 會寫進 `notes` |
| **run status** | 不受影響。`SUCCESS`/`DEGRADED`/`FAILED` 判準不變;`FAILED` 仍然跳過 synthesis(既有邏輯優先) |
| **backward compatibility** | 呼叫端不需要改。`report` 多一個欄位;`finalOutput` 型別不變(單一專家時直接放專家原文 + banner) |

**唯一的行為改變**:單一專家的執行結果從「synthesizer 的轉述」變成「專家的原文」。這是改善(少一層失真),但確實是可觀察的差異,必須寫進 HANDOFF。

---

## 5. Step 7 與 Step 9 的責任邊界

| | Step 7 Complexity Router | Step 9 Model Router |
|---|---|---|
| 決定 | **形狀** —— 幾個階段、要不要 synthesis、要不要 red team、專家數天花板 | **由誰執行** —— 給定 role/capability,選哪個 provider/model |
| 輸入 | `Plan`(complexity + assignments) | agent role + required capability + model capability registry |
| 輸出 | `ExecutionPolicy` | `{ provider, model }` |
| 絕不碰 | provider、model 名稱 | 階段數、拓撲 |

### 可測試的分界不變式

> **`ExecutionPolicy` 的型別定義裡不得出現 `ProviderName`。**

這條可以寫成測試,而且會在有人把兩者混在一起時直接失敗。它跟 Step 6 已經確立的結構性事實一致 —— **Chief 收到的名單本來就看不到 provider**,所以拓撲決策在資訊上本來就不可能依賴模型身分。

---

## 6. 最小可行的 Step 7 實作

### 建議納入 V1

1. `src/agents/policy.ts` —— `ExecutionPolicy` 型別 + `deriveExecutionPolicy(plan)` 純函式
2. `runOrchestrator` 遵循 policy:`synthesize: false` 時跳過 synthesis,直接用該專家的輸出
3. `report.policy` 記錄拓撲與理由;`notes` 記一句「synthesis skipped: single specialist」
4. `timings.synthesisMs = 0` 並保留欄位(不要拿掉,會破壞既有的比較表)
5. 離線測試(見第 7 節)

### 建議**不要**納入 V1

| 項目 | 理由 |
|---|---|
| 融合式單次呼叫(routing + 作答) | 把「規劃」與「執行」壓成一個不可分割的步驟,直接違背這個專案一路在做的分離。plan 將無法在答案生成前被獨立記錄與稽核 |
| 0 specialist 的 Direct Path | `planSchema` 的 `assignments.min(1)` 讓它在型別上不可能(見下) |
| 任何 prompt 修改 | 已被否決,且會使 5 次執行的基準線失效 |
| 依 complexity 選模型 | 那是 Step 9 |

### ⚠️ 一個會擋住方向原則的既有限制

方向原則寫「NORMAL:0–3 specialists」「DEEP:0–4 specialists」。**目前 0 是做不到的:**

```ts
// orchestrator.ts:165
.min(1)                                    // schema 要求至少一個 assignment

// orchestrator.ts:222
if (capped.length === 0) throw new Error(...)  // 約束層也會擋
```

要支援 0 specialist,這兩處都得改,而且要決定「沒有專家時誰產出答案」—— 那會直接把融合式呼叫的問題拉回來。**建議 V1 維持最少 1 個專家**,把 0-specialist 留到有 simple 任務的實測數據之後再談。

---

## 7. 驗收測試:怎麼證明「真的減少了不必要的協作」

### 現有測試證明不了這件事

`test-run-status.mjs` 與 `test-registry.mjs` 證明的是「專家數不超過上限」。那是**數量**,不是**階段數**。一個 3 呼叫的 simple 任務完全可以通過所有現有測試。

### 要證明階段減少,必須數呼叫次數 —— 而這需要一個改動

`runOrchestrator` 目前直接 import `callProvider`,離線無法計數。建議:

```ts
export interface OrchestratorOptions {
  // ...
  /** Injected for tests; defaults to the real provider dispatcher. */
  call?: typeof callProvider;
}
```

加了這個之後,**下列全部可以離線驗證、零 API 成本**:

| 測試 | 斷言 |
|---|---|
| 單一專家計畫 | 恰好 **2** 次 provider 呼叫,且沒有任何一次的 prompt 含 `Synthesize these results` |
| 雙專家計畫 | 恰好 **4** 次,且 synthesis 確實發生(**防止把協作路徑一起弄壞的回歸測試**) |
| 單一專家 | `finalOutput` 含該專家的原文,不是轉述 |
| 單一專家 + banner | HYPOTHESIS banner 仍然被加在最前面(跳過 synthesis 不能連 banner 一起跳過) |
| 全員失敗 | 仍然 `FAILED`、仍然跳過 synthesis、`finalOutput === null`(既有行為不被 policy 覆蓋) |
| policy 型別 | `ExecutionPolicy` 不含任何 provider 名稱(Step 7 / Step 9 邊界) |
| 與 cap 的區隔 | 一個被 cap 砍到剩 1 人的 deep 計畫,也要走 single 拓撲 —— **證明看的是實際 assignment 數,不是 complexity 標籤** |

最後一項是關鍵:它把「上限有效」和「協作真的減少」分開驗證。

---

## 8. SIMPLE fast path 的 latency 下限(實測)

### Planning 一次呼叫的實測分佈

| 來源 | planning 耗時 |
|---|---|
| Run 1 | 33.1s |
| Run 2 | 29.1s |
| Run 3 | 17.1s |
| Run 4 | 28.4s |
| Run 5 | 31.7s |
| 獨立 planning 驗證(`test-chief-live.mjs`) | 25.1s |

**中位數約 28s,範圍 17.1–33.1s。**

### 因此

> **只要保留「先 planning、再 execution」的結構,SIMPLE fast path 的 latency 下限就是一次 `gpt-5` turn,約 17–33 秒。** 加上一次專家呼叫,真實下限大約 **35–50 秒**。

「從 200 秒降到幾秒」在保留 planning 的前提下**不可能**。這一點與方向原則「不假設可以降到幾秒」一致 —— 現在有數字了。

### 融合式單次呼叫的估算

一次 `gpt-5` turn 同時做 routing + 作答,量級上仍是**一次 turn**,約 25–35s。相對於「planning + worker」的兩次 turn(約 40–60s),大約**減半**。

**但這個估算有兩個未量測的假設**,我不打算當成結論:
1. 融合式呼叫要同時輸出 JSON 路由與正文,turn 會變長,可能不只 25–35s
2. **我們從來沒有量測過一個真正 simple 的任務**。5 次執行全部是公司年度策略(deep)。simple 任務的 worker 呼叫可能只要 5–15s,那 synthesis 的絕對節省也會小很多

### 建議的下一個量測(1 次執行,約 3 次呼叫)

在**動任何程式碼之前**,拿一個真正的 simple 任務(例如「把這三個報價換算成含稅單價並排序」)跑一次現行 orchestrator,取得:

- 現行 simple 任務的三段耗時
- Chief 是否真的判為 `simple`
- synthesis 在只有一位專家時實際花多久

有了這個數字,才知道 V1 省下的那一次呼叫值多少秒,以及融合式方案是否值得付出稽核代價。

---

---

## 9. Simple 任務 baseline 實測(n=1)

任務(§14 定義下毫無疑問的 `simple`:純計算與格式化,所有資訊都在題目裡):

```
以下三筆報價都是未稅總價，請換算成含稅（營業稅 5%）金額，並由低到高排序：
A 案 48,000 元   B 案 52,500 元   C 案 45,800 元
```

### 結果

```
complexity   : simple          ← 分類正確
assignments  : business_strategist(1 位)
API calls    : 3
status       : SUCCESS
adjustments  : none

planning     : 16.2s  (63%)
workers      :  3.4s  (13%)
synthesis    :  6.2s  (24%)
total        : 25.8s
```

### 發現 1:planning 佔了 63%,是實際工作的 5 倍

Chief 花 **16.2 秒**判斷「這是算術,交給一個人」,而真正把它算完只要 **3.4 秒**。

**真正的成本中心是 planning,不是 synthesis。** 而第 6 節的 V1 範圍明確不打算碰 planning。

### 發現 2:我在第 8 節的估算太高

第 8 節推估 simple 的真實下限「約 35–50 秒」,實測 **25.8 秒**。planning 的 16.2s 也低於先前觀察到的 17.1–33.1s 區間 —— 較短的任務讓 planning 本身也變快,這是先前六次量測(全部是 deep)看不出來的。

### 發現 3(最重要):synthesis 在這次**不是**多餘的

| | 內容 | 長度 |
|---|---|---|
| 專家產出 | **英文** markdown 表格 + 計算過程 | 460 字元 |
| synthesis 後 | **中文**,只有答案與排序 | 112 字元 |

**如果照原建議跳過 synthesis,使用者對一個中文問題會收到一份英文 markdown 表格。** 那是回歸,不是優化。

### 根因:worker 看不到原始 task

流程是:

```
中文 task
  ↓
Chief(常設簡報是英文)寫出 mission ── 這次寫成了英文
  ↓
worker 只收到 mission,從未看過原始 task → 用英文作答
  ↓
synthesizer 收到「原始 task + worker 產出」→ 修回中文
```

synthesis 的價值來自**它是唯一還看得到原始 task 的階段**。它在補一個上游丟失的資訊。

### ⚠️ 不要把問題定義成「Mission Language Drift」

語言只是**第一個被觀察到的症狀**,不是問題本身。真正的缺陷是:

> **Worker Context Loss** —— Original User Task 在 `Chief → Worker` 這個 delegation boundary 被丟失。

Worker 目前只拿到 `Assigned Mission`,拿不到 `Original User Task`。語言只是眾多可能經由 mission 壓縮而流失的資訊之一。同一個缺陷同樣可能吃掉:

| 可能流失的資訊 | 例子 |
|---|---|
| 輸出語言 | 本次實測 |
| 格式要求 | 「請用表格呈現」 |
| 預算約束 | 「總預算不得超過 NT$300,000」 |
| 地理範圍 | 「只考慮台灣市場」 |
| 時間範圍 | 「2027 年」 |
| 明確排除項 | 「不要用降價策略」 |
| 輸出結構 | 「先結論再理由」 |
| 原始意圖 | 為什麼要做這件事 |

**這是 correctness / context propagation 問題,不是 prompt language 問題。**

### 這是偶發,不是系統性 —— 但偶發就足以讓「跳過 synthesis」不安全

比對所有已記錄的執行(task 皆為中文),用中日韓字元比例衡量:

| 執行 | mission | worker 產出 |
|---|---|---|
| deep run 1 | 68–74% | 44–48% |
| deep run 2 | 47–71% | 44–52% |
| deep run 3 | 66–68% | 44–49% |
| **simple baseline** | **0%** | **0%** |

deep 任務的 mission 都是中文,worker 也用中文回答。只有這次 simple 任務,Chief 把 mission 寫成了純英文 —— 可能因為題目幾乎全是數字,英文的常設簡報壓過了任務語言。

**發生機率不高,但只要會發生,「單一專家就跳過 synthesis」就不能無條件成立。**

### ⚠️ 24% 這個數字要怎麼寫

**正確寫法(實測 observation,n=1):**

> 在這一次 SIMPLE baseline 中,synthesis 佔了 6.2 秒 / 總時間的 24%。

**錯誤寫法(把 n=1 當成通則,且忽略 synthesis 本次確實有功能):**

> ~~Step 7 可以讓 SIMPLE 任務快 24%。~~

目前沒有證據支持這個推論。這次的 synthesis 提供了必要功能,拿掉它不是省下 6.2 秒,而是換到一個錯誤的輸出。

### 尚未量測的(hypothesis,不得引用為事實)

- n=1。context loss 的實際發生率未知。
- 沒有量測過 `normal` 級距。
- 沒有量測過融合式單次呼叫實際要多久。
- **不知道修好 Step 6.1 之後 synthesis 還剩多少價值。**

---

## 10. Step 6.1 — Worker Context Propagation(新增的前置項目)

### Roadmap 調整

```
1–5                              ✅
5.1 Grounded Retrieval           ✅
6   Chief of Staff System Prompt ✅

6.1 Worker Context Propagation   ← NEXT,Step 7 的前置條件

7   Complexity Router            ← BLOCKED BY 6.1
8   Cost / Token / Latency Tracking
9   Model Router
10  Validation Layer
```

### 核心原則(architecture decision)

> **Original Task 與 Assigned Mission 是兩種不同的資訊,兩者都必須存在於 Worker 的執行 context。**

| | 是什麼 |
|---|---|
| **Original User Task** | immutable task context —— 使用者真正要求什麼,以及 task 層級的約束 |
| **Assigned Mission** | delegated responsibility —— 這位專家在整體任務中負責哪一部分 |

**Mission 不得取代 Original Task。**

### 必須同時滿足的兩件事

修好 context 之後會冒出一個新的失敗模式:worker 拿到完整 task 之後開始接管整件事。

```
Original Task: 制定完整公司成長策略,包含市場、財務、品牌
Assigned Mission: 分析市場競爭環境與外部證據
```

`market_researcher` **應該**知道完整 Original Task(那是 context),但**仍然只能**負責市場與證據 —— 不能自己開始做品牌策略、財務模型或最終建議。

所以 Step 6.1 要同時保證:

```
Context Preservation  +  Mission Scope Preservation
```

Original Task 決定「這整件事為什麼做、有哪些限制」;Assigned Mission 決定「這個 Worker 負責哪一段」。

### ⚠️ 不得用 prompt calibration 修

**不要**在 Chief 的常設簡報加上「mission 一律用使用者的語言撰寫」或「確保 mission 保留所有使用者需求」這類句子。

那會把一個**結構性的 context-loss 缺陷**降格成**prompt 行為校準**。已確立的原則仍然成立:

> **Structural mechanisms > prompt persuasion**

應該修的是 **Worker Input Contract**,而不是要求 Chief 更努力地把 Original Task 壓縮進 Mission。

### 建議的 execution contract(語意描述,不是最終 prompt 文字)

Worker 執行時應同時取得兩份資訊,語意上是:

```
以 Original User Task 作為不可變更的任務 context。
只執行 Assigned Mission。
保留 Original User Task 裡所有相關的使用者約束、語言、格式要求、範圍與明確排除項。
不要承擔 Assigned Mission 以外的責任。不要取代 Chief / 決策者。
```

**這不是要求直接採用以上文字。** 它描述的是 execution contract 與資訊邊界。接手者應先檢查目前的 worker prompt 構造,再選最低侵入性的實作方式。

### 驗證方向(不要只測語言)

| 維度 | 測法 |
|---|---|
| Language | Original 中文 / Mission 英文 → worker 產出仍須符合 Original 的語言要求 |
| Format | Original 要求表格,Mission 只描述分析工作 → 與自己 mission 相關的格式要求不得遺失 |
| Constraint | Original 「預算不得超過 NT$300,000」→ worker 分析不得忽略 |
| Scope | Original 完整策略 / Mission 只研究市場 → 理解 context 但不得接管品牌、財務或最終決策 |
| Explicit Exclusion | Original 「不要用降價策略」→ 不得因 Mission 沒重複就重新提出降價 |

### ⚠️ 修好之後不要直接移除 synthesis

目前只能得到這個結論:

> **修復 Worker Context Propagation 是重新評估 single-specialist synthesis 的必要前提。**

**不能**得到:

> ~~修完之後 synthesis 就一定沒有價值。~~

synthesis 目前可能同時提供:language recovery、format normalization、task reconciliation、multi-agent synthesis、final answer compression、user-facing presentation。修好之後**必須重新量測**,才知道剩下哪些仍有實質價值。

### 修復後的驗證順序

用**完全相同**的 SIMPLE baseline task 重跑,不要換 benchmark:

| | BEFORE(已測) | AFTER(待測) |
|---|---|---|
| Planning | 16.2s | ? |
| Worker | 3.4s | ? |
| Synthesis | 6.2s | ? |
| Total | 25.8s | ? |
| Worker 輸出語言 | 英文 | ? |
| Final 輸出語言 | 中文 | ? |

然後比較 Worker Output 與 Synthesized Output,檢查 synthesis 是否仍增加 correctness / completeness / task reconciliation / formatting / compression / user-facing quality。

**只有在證據顯示 synthesis 不再提供實質價值之後**,才重新考慮 `single specialist → synthesize: false`。

---

## 11. Planning 佔 63% —— 但現在不要動它

本次:planning 16.2s vs worker 3.4s,Chief 花在「決定誰該做」的時間約是「實際做」的 **5 倍**。

這證明 SIMPLE workload 的主要 latency center 是 **planning**,不是 synthesis。

**但不要因此實作融合式 routing + answer。** 那會破壞目前這個重要的架構性質:

```
PLAN  →  可先被獨立記錄 / 稽核  →  EXECUTION
```

用這個性質換取延遲改善,是未來的 V2 架構取捨,不是現在的 bug fix。

---

## 12. 仍然成立的 Step 7 / Step 9 不變式

本次發現不影響這條 architecture decision:

```
ExecutionPolicy must not depend on ProviderName.
```

Step 7 決定 execution shape,不得因 provider / model identity 決定拓撲。Step 9 才負責 `Agent Role + Required Capability + Model Capability Registry → Provider / Model Selection`。

---

## 13. 本次產生的工程原則

新增:

> **Do not remove a stage merely because its nominal responsibility appears redundant. First verify what hidden corrective responsibilities that stage is actually performing in the current system.**

沿用 rev. 4:

> **Do not analyze why a model made a choice until you first verify exactly what the model actually saw.**

沿用:

> **Measurement overrides architecture speculation.**

補充:

> **A single measurement is evidence of a failure mode, not a universal performance law.**

---

## 交接狀態

| 項目 | 狀態 |
|---|---|
| Step 7 | **NOT IMPLEMENTED**,BLOCKED BY Step 6.1 |
| Step 6.1 | **NEXT**,尚未實作 |
| 程式碼變更 | **無** —— 本次只新增量測腳本與文件 |
| 離線測試 | 60 項全過 |

下一位接手者的第一個 implementation task 是 **Step 6.1**,不是 Step 7。
