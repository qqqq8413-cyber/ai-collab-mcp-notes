# ai-collab-mcp — Progress Report & Review Request (2026-09-04)

> **這份文件同時給 GPT 與 Gemini 閱讀。** 內容是自足的,不需要額外附上架構文件也能讀懂。
>
> **先講立場問題(重要)**:第五節那個待決策的問題,內容正是「這個系統要不要繼續使用 Gemini」。**兩位讀者在這題上都不是中立第三方**:
>
> - **Gemini** 是被討論要不要繼續使用的對象。
> - **GPT** 既是做出排除決定的 Chief(`gpt-5`),也是實際被選用的 `brand_creative`(`gpt-5`)—— 等於在評價自己的判斷。
>
> 我不打算因此不問你們。剛好相反,你們各自的觀點正是這題缺的。但請在回答時**明確區分「哪些是可驗證的論證」與「哪些是你作為當事方的偏好」**。

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
- **§17 Run Status**(尚未實作) — 讓 worker 失敗在最終結果上可見,而不是靜默降級。
- **§19 Validation Layer**(尚未實作) — 在 worker 完成後檢查產出是否有未經證據支撐的重大假設。
- **§23** — 開發順序。**§24** — 明確不做的項目。**§25** — 驗收標準。**§28** — 本次開發的具體要求清單(Chief Planning Protocol V1)。

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

# 四、Phase 5:Chief Planning Protocol V1(本次完成)

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
| 10. 同一 task 連跑 3 次比較 | 已執行,結果如下 |

### 關鍵設計:約束不只寫在 prompt

Prompt 可以被模型忽略,所以另外實作了 `enforceConstraints()`,把違規計畫強制修正成合規,**並把每次修正記錄在 `planningAdjustments`**。這樣同時保證成本可預測、以及 Chief 是否守規矩可被稽核。

## 測試結果:同一 task 連跑 3 次

| Run | complexity | missions | API calls | agents | adjustments | failures | total |
|---|---|---|---|---|---|---|---|
| 1 | normal | 2 | 4 | business_strategist + brand_creative | 0 | 0 | 255.2s |
| 2 | normal | 2 | 4 | business_strategist + brand_creative | 0 | 0 | 277.9s |
| 3 | normal | 2 | 4 | business_strategist + brand_creative | 0 | 0 | 252.6s |

### 修正前後對比

| | 修正前 | 修正後 |
|---|---|---|
| Mission 數 | **6 vs 13**(差 2 倍以上) | **2 / 2 / 2** |
| API 呼叫 | 8 / 15 | **4 / 4 / 4** |
| Complexity 分類 | 無此概念 | 穩定 |
| 約束層介入 | — | **0 次**(Chief 自己就遵守) |
| Worker 失敗 | 2 個空輸出 | 0 |
| 最終輸出 | 8,614 字 | 3,662–4,406 字 |

`adjustments = 0` 是很好的訊號:Chief 在讀到明確約束後**自願遵守**,強制層完全沒有介入,代表約束是被理解而非被硬套。

## 追加修正:Complexity 校準

第一輪 3 次測試中 Chief 都判為 `normal`,但 §14 明確把「公司年度策略」列為 **DEEP** —— 而測試 task 正是公司年度策略。

**原因**:第一版實作只給了各級距的人數上限,漏了 §14 的語意定義與判斷範例,Chief 等於沒有判準在猜。

**修正後單次驗證**:

```
complexity : deep    ← 已符合 §14 定義
missions   : 2
API calls  : 4
adjustments: 0
failures   : 0
total      : 239.0s
```

> ⚠️ 此修正後只跑了 1 次(為節省 API 成本),**complexity 分類在修正後的穩定度尚未用 3 次驗證**。

---

# 五、需要架構決策的問題:Gemini 完全未被選用

## 現象

Planning V1 上線後 **4 次執行**(3 次 normal + 1 次 deep),Chief **每一次都只選 business_strategist(Claude)+ brand_creative(GPT),完全沒有選 market_researcher(Gemini)**。

而且是明確寫理由排除的:

> Run 1:「不需另啟市場研究即可先行制定策略與試點,日後可用營運數據校準」
> Run 2:「無需額外市場研究即可提出可執行方案」
> Run 3:「不需額外市場研究即可產出可執行策略與 KPI,避免冗餘協作」

**重點**:即使在 `deep`(允許 4 個 specialist)的情況下,Chief 仍只選 2 個。所以**這是 Chief 的實質判斷,不是被人數上限卡掉**。

## 這是架構文件內部兩條原則的衝突

這不是實作 bug,是**架構文件自己的兩條原則指向相反方向**:

- **§4 / §5** → Chief 現在的行為完全正確,少即是好,成本降 73%。
- **§9** 把 Gemini 定位為 evidence gathering → 若這個能力池永遠不會被觸發,它在架構圖上就是死的。

換句話說:**「最小充分」的判準到底是「答案看起來完整」還是「答案有證據支撐」?** 現在 Chief 用的是前者。

## 具體的品質損失(可驗證的部分)

對比修正前的 13 子任務版本:Gemini 當時提供了競品定價標竿,**直接成為最終文件裡定價帶與毛利率的依據**。現在的 3,707 字策略沒有這層實證支撐 —— 這是一份公司年度成長策略,目前建立在模型的既有認知之上。

## 三個可能方向

| 方向 | 做法 | 成本影響 | 風險 |
|---|---|---|---|
| 1. 維持現況 | 相信 Chief 判斷,策略以既有認知為基礎 | 最低(4 calls) | 重大決策建立在未驗證假設上 |
| 2. prompt 加硬規則 | 「deep 任務必須包含至少一個 evidence-gathering capability」 | +1 call(deep 時) | 把判斷寫死,可能在不需要研究的 deep 任務上浪費 |
| 3. 交給 Validation Layer(§19) | Chief 自由規劃,worker 完成後檢查「是否有未經證據支撐的重大假設」,必要時才補研究 | 動態(多數情況 0,必要時 +1~2) | 最貼近 §19 原始設計,但要等開發順序第 10 項才做得到 |

一個中間做法:方向 2 只套用在 `deep`,`normal` 維持現況。日常任務仍是 4 calls,只有真正高風險的決策才強制拉進證據來源。

---

# 六、我具體想請你回答的

1. **上面三個方向,你選哪一個?為什麼?** 請直接給結論再給理由,不要三個都分析一輪然後不表態。
2. **「最小充分協作」應該怎麼定義才不會退化成「省成本」?** 有沒有可操作的判準,能區分「這個任務真的不需要外部證據」跟「模型只是不知道自己不知道」?
3. **如果選方向 3(Validation Layer),它該檢查什麼?** 請具體到可以寫成 prompt 或 schema 的程度 —— 例如要偵測哪幾類「未經證據支撐的重大假設」。
4. **你認為 Chief 排除市場研究的那三個理由,哪些站得住腳、哪些是合理化?**

再提醒一次:第 1 題與第 4 題你是利害關係方(理由見文件開頭),請把「論證」和「立場」分開寫。

> 這四題 GPT 與 Gemini 會分別回答,答案將並排比對。如果兩邊結論相反,就直接拿這題去跑 `run_debate`。

---

# 七、§25 驗收標準檢核

| 標準 | 狀態 |
|---|---|
| 同一 Task 重跑多次 | ✅ 已跑 4 次 |
| Complexity classification 大致穩定 | ✅ 修正前 3/3 一致;修正後僅 1 次,待補驗證 |
| Required capabilities 大致穩定 | ✅ 語意一致(商業策略/GTM/品牌設計),用字有差異 |
| Agent 數量受限制 | ✅ |
| Subtask 數量受限制 | ✅ |
| Worker failure 可見 | ⚠️ 每個 worker 的 error 有被捕捉,但**還沒有正式 Run Status**(§17,開發順序第 3 項) |
| JSON planning 穩定 | ✅ 4/4 次解析成功,0 次 schema 失敗 |
| Cost 可追蹤 | ❌ 開發順序第 8 項,尚未做 |
| Latency 可追蹤 | ✅ 已加入分階段 `timings` |
| Chief 可以清楚仲裁 disagreement | ❌ 開發順序第 10–11 項,尚未做 |
| 使用者收到 Executive Brief | ❌ 開發順序第 12 項,尚未做 |

---

# 八、目前程式碼狀態

| 檔案 | 內容 |
|---|---|
| `src/config.ts` | `DEFAULT_MAX_TOKENS = 16384`;Gemini 預設模型 `gemini-3.1-pro-preview` |
| `src/providers/claude.ts` | 共用額度;空輸出 throw(附 stop_reason + thinking tokens) |
| `src/providers/openai.ts` | `max_completion_tokens`;共用額度;空輸出 throw |
| `src/providers/gemini.ts` | 共用額度;空輸出 throw(附 finishReason) |
| `src/modes/orchestrator.ts` | **重寫**:Planning Protocol V1、zod schema、約束強制層、分階段計時 |
| `src/index.ts` | `run_orchestrator` 新增 `budget` 參數 |
| `README.md` | 新增 Runtime notes(MCP timeout、推理 token 額度) |

## 測試腳本

- `check-providers.mjs` — 驗證三家 API Key
- `test-pipeline.mjs` — Pipeline 接力測試
- `test-orchestrator.mjs` — Orchestrator 穩定度測試,可指定次數(`node test-orchestrator.mjs 3`),自動輸出比較表與 `orchestrator-run-N.json`

---

# 九、實務提醒

### 1. 延遲仍是架構層級的問題

Planning V1 把 API 呼叫從 15 降到 4,但**總時間只從 309s 降到約 240–280s**。原因是 mission 變成一個大的 coherent mission 後,單一 worker 的執行時間拉長(115–184s),整合階段仍需 65–99s。

**降低 API 呼叫數 ≠ 等比降低延遲。** 真正的瓶頸是推理模型的單次思考時間,要靠 streaming 或更小的模型來解。

### 2. MCP client 預設 timeout 只有 60 秒

單次 orchestrator 要 4 分鐘以上,預設會被誤判成卡死(`-32001 Request timed out`,但流程其實還活著)。已寫進 README,呼叫時要帶 `{ timeout: 900000 }`。

### 3. Worker 失敗仍會靜默降級

單一 worker 出錯會把 error 字串塞進 synthesis prompt 由 synthesizer 自行判斷。加上空輸出防呆後,最隱蔽的情況已被擋下,但**多個 worker 掛掉時最終答案仍會悄悄降級而不報錯**。這正是 §17 Run Status 要解決的。

---

# 十、下一步(依 §23 開發順序)

```
✅ 1. Chief Planning Constraints
✅ 2. Structured Planning Output      ← zod 驗證已做
▶  3. Worker Failure / Run Status     ← 建議下一個
   4. Agent Registry
   5. Model Capability Registry
   6. Chief of Staff System Prompt
   7. Complexity Router               ← 部分已內含在 Planning V1
   8. Cost / Token / Latency Tracking ← latency 已做,cost 未做
   9. Model Router
   10. Validation Layer               ← 第五節方向 3 需要它
   11. Red Team
   12. Executive Brief Schema
   13. Automated Tests
   14. Project Context
   15. Memory / Persistence
```

**明確不做**(§24):OpenClaw / Slack / Discord / Telegram / Web UI / Ollama / Long-term Memory / Complex Gateway。
