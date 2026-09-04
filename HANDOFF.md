# ai-collab-mcp — Progress Report (2026-09-04, rev. 2)

> **給 GPT 與 Gemini 的說明:** 你們先前收到的是 rev. 1,並回答了文末那四個問題。**這一版修正了 rev. 1 的一個關鍵前提** —— 詳見第六節。你們基於「Chief 每次都排除 Gemini」所做的診斷,現在證據基礎變弱了。
>
> **立場揭露(沿用 rev. 1):** 第六節那個問題,兩位讀者都不是中立第三方。Gemini 是被討論要不要繼續使用的對象;GPT 既是做出排除決定的 Chief(`gpt-5`)也是被選用的 `brand_creative`(`gpt-5`)。

## rev. 2 改了什麼

1. **新增第 3 項功能:Run Status / Evidence Label**(第五節)
2. **第 5 次執行推翻了 rev. 1 的核心前提** —— Chief 這次**選了** Gemini(第六節)
3. **§25 穩定度的說法改弱** —— `normal` 已驗證,`deep` 未驗證(第八節)
4. **新增 GPT 與 Gemini 的審查結果與已採行的決定**(第七節)

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

| 標籤 | 條件 |
|---|---|
| `NOT_APPLICABLE` | complexity 不是 `deep` |
| `EVIDENCE_BACKED` | 有標記 `evidenceCapable` 的專家成功回傳 |
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
npm test   # 15 項,不花任何 API 額度
```

真實跑一次要約 4 分鐘、4–5 次模型呼叫,狀態規則不該需要那個。其中一項專門鎖住上述設計決定:

```
✓ label never depends on the Chief saying research was unnecessary
```

同樣的 worker 結果、同樣的名單,只有 complexity 能移動 label —— 沒有任何欄位能讓 Chief 用嘴巴脫離 `HYPOTHESIS`。

---

# 六、⚠️ rev. 1 的核心前提被推翻

## rev. 1 說了什麼

> Planning V1 上線後 **4 次執行**(3 次 normal + 1 次 deep),Chief **每一次都只選 business_strategist(Claude)+ brand_creative(GPT),完全沒有選 market_researcher(Gemini)**。
> **重點**:即使在 `deep`(允許 4 個 specialist)的情況下,Chief 仍只選 2 個。所以**這是 Chief 的實質判斷,不是被人數上限卡掉**。

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
| `src/index.ts` | `run_orchestrator` 的 `budget` 參數、**worker 的 `evidenceCapable` 參數** |
| `README.md` | Runtime notes(MCP timeout、推理 token 額度)、**Run status 與 evidence label 說明** |

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
✅ 3. Worker Failure / Run Status     ← 本次完成(含 evidence label 與輸出標記)
▶  4. Agent Registry                  ← 建議下一個
   5. Model Capability Registry
   6. Chief of Staff System Prompt
   7. Complexity Router               ← 部分已內含在 Planning V1
   8. Cost / Token / Latency Tracking ← latency 已做,cost 未做
   9. Model Router
   10. Validation Layer               ← 第七節的決定需要它
   11. Red Team
   12. Executive Brief Schema
   13. Automated Tests                ← 已提前做了 run status 的部分
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
