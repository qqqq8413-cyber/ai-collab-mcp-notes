# AUTO-P1 Automation Readiness Matrix

基準：`3923d267690d291ddc77e13d6fe9b81f9439266b`；main `e7eb87b4b481c885bea8730f8498eb493dc38184`。以程式核對結果為準。

狀態分開解讀：IMPLEMENTED 是有程式；TESTED 是有測試；INTEGRATED 是有接通；USABLE 是 Human 可操作；AUTHORIZED 是在本輪允許範圍，並非授予未來能力。

| 模組 | 基準版狀態 | 阻礙 / AUTO-P1 整合 | 新 Human 授權 |
| --- | --- | --- | --- |
| Goal Queue | IMPLEMENTED / TESTED / INTEGRATED / USABLE | Workspace 可建立及保存非授權目標；不是 AI 執行。沿用不改語義。 | 保存目標不需要；執行另議 |
| Goal Governance / Change Mint | IMPLEMENTED / TESTED；trusted host 接通 | 一般 Workspace 未注入即 503；不得把 CI 工作當 Change 授權。 | AI activation 需要 |
| Run Admission | IMPLEMENTED / TESTED；trusted host 窄介面 | ROOT admission 到 IDLE，不代表開始執行。 | AI execution 需要 |
| Controller | IMPLEMENTED / TESTED | 狀態機與限制存在，不交給 AUTO-P1 UI 或 CI scheduler。 | EXE HOLD |
| Execution Driver / Runtime Composition | IMPLEMENTED / TESTED | 正式治理組合與 macOS 隔離存在；本輪不建立可執行的 Driver 實例。 | EXE / H1-H9 仍需核准 |
| 原 AutomationRunner | IMPLEMENTED / TESTED | 面向 governed implementation，不可當唯讀監測的旁路執行器。 | EXE HOLD |
| Invocation Journal | IMPLEMENTED / TESTED | 記錄真正外部 actor invocation；本輪無 actor invocation，因此不偽造紀錄。CI 工作有獨立 operational history。 | 不可轉成 Authority |
| Authority Archive | IMPLEMENTED / TESTED | 不開啟 appender、不寫入或採納任何新 grant。 | 只有既有正式程序 |
| GitHub repository reality | IMPLEMENTED / TESTED | 既有同步介面用於 Controller preflight；CI WATCH 另加受限、可中止的 Actions GET adapter，不修改既有 port。 | 本輪唯讀已授權 |
| Scheduler | 基準版無可用 Workspace 唯讀任務排程 | 新增單程序 lease、持久化 due slot、單一 concurrency、時間 / 次數 / 容量限制；不安裝系統背景服務。 | UI 啟用唯讀監測；永久背景服務另核准 |
| Workspace Server / UI | IMPLEMENTED / TESTED / USABLE | 以 injected operational port 加入自動化頁，沿用 D1 session、Host、Origin、request-header 隔離。 | 不擴張身份能力 |
| Collaboration Store | IMPLEMENTED / TESTED / INTEGRATED | 既有 Claude 公開歷史回覆可讀；不把 CI 結果偽裝成 AI 回覆。 | 觀察不等於授權 |
| SRC-C1 event source | IMPLEMENTED / TESTED；歷史路徑 USABLE | 自然 LIVE_TAIL 仍 UNVERIFIED；不再空等舊 Session。本輪 CI 不依賴它。 | 不新增模型呼叫 |
| CI WATCH | 基準版無 Human 可操作路徑 | AUTO-P1：UI → 受限 GET → 原子持久化 → UI，手動與 opt-in 週期讀取。 | 本輪唯讀已授權 |
| Event-driven local report | 基準版未接通 | 僅接受同專案已驗證 CI 差異；本機產出摘要，無模型或外部寫入。 | 本輪唯讀已授權 |
| AI 工作自動化 | 既有模組但不可宣稱 USABLE / AUTHORIZED | 使用原 Goal 入口保存需求；顯示 LOCKED / HOLD。既有治理測試仍須回歸；啟用方案另見 permit。 | 必須先 Architect review + 有界 Human permit |

## 不變邊界

`src/workspace` 仍沒有 outbound network、child process、Controller、模型或 authority dependency。新 `src/pilot` host 只注入 CI operational port。排程只選 CI_WATCH / CI_REPORT；輸入 AI_WORK、授權欄位或執行動作均拒絕。

本輪不發布 main、不改 Ruleset、不寫 Human Authority、不解除 EXE HOLD。讀取使用既有 bot helper，不索取新 Token 或管理員權限。
