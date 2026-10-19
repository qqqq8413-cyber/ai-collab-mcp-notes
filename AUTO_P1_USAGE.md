# AUTO-P1：可用的唯讀自動化

## 現在能用什麼

Human 可以建立「監看 CHIEF CI」工作，點擊立即檢查，或開啟週期監測，讓系統在本機自動完成 GitHub 讀取、驗證、保存與顯示。不是展示資料，也不需要呼叫 AI。

試用網址：`http://127.0.0.1:4873/#/p/chief/automation`。

1. 打開「自動化」。現有 CHIEF CI WATCH 可直接點「立即檢查」。
2. 在 GitHub CI 結果查看工作分支、exact commit SHA、run / attempt、Ubuntu `test`、macOS `r4t-macos` 與原始結果連結。最新 run 排在前面。
3. 展開「執行紀錄」與「證據與識別資訊」，查看每次觸發、步驟、時間、快照、錯誤與對應識別。
4. 週期工作按「啟用監測」才會啟用。預設關閉；本輪驗收後亦已關閉。
5. 「新增自動化工作」可選手動、週期，或「CI 狀態變更後」。事件模式僅允許本機 CI 摘要，來源必須是同專案的 CI WATCH。
6. 協作室上方可看到最近的自動化操作紀錄與連結；它不是 Claude 回覆，也不是 Human 授權。

## 三種停止不同

- 暫停排程：停止未來週期／事件觸發，不影響已排入或正在執行的工作。
- 停止執行：中止目前讀取，並停用該工作的未來監測。
- 取消待辦：只取消尚未開始的工作，不改排程設定。

失敗工作可在建立時設定的上限內手動重試（0 至 2 次），不自動重試。逾時記錄為 FAILED / READ_TIMEOUT，使用者停止為 CANCELLED / USER_STOP。程序重啟不重放未完成的 RUNNING 工作，會留下中斷原因。

「工作已完成」指該次讀取／摘要已完成，**不代表所有 CI 都成功**；CI 各項成功、失敗、取消、跳過或尚未回報仍按 GitHub 資料顯示。

## 資料與上限

- 固定 repository：`qqqq8413-cyber/ai-collab-mcp-notes`。
- 每次取最近 5 個 Actions runs，取得該 attempt 的 jobs；不是全庫完整歷史抓取。
- 資料放在既有 Workspace dataDirectory 的 `auto-p1/`。原子寫入、checksum、單一程序 lease。
- 每專案最多 20 工作，全域同時 1 個；頻率最短 60 秒；單次最多 60 秒；每資料目錄每小時最多 30 次 GitHub snapshot。
- 有界保存最近 500 次執行、500 次操作、500 次差異，以及最近觀察的 100 個 CI run。歷史基線已淘汰時重新建立基線，不把未知當成狀態變更。
- 事件報告可合併來源忙碌期間的多次差異，以最新已驗證結果產出摘要；不是每條差異都保證各呼叫一次。
- 頁面自動更新不等於每兩秒打 GitHub；畫面讀本機紀錄，外部讀取僅由手動或已啟用的排程觸發。
- 關閉本機 pilot 就不會再執行。啟用設定會保存，下一次開啟同一資料目錄會恢復。沒有安裝 launchd、全域服務或 Agent hooks。

## 仍不能做什麼

AI 工作保持 LOCKED / EXE HOLD。可沿用原 Goal Queue 建立目標，但不會因此啟動 Controller、Driver、Claude、Codex 或付費模型。新排程與 AI 訊息也不能授權執行。

Goal Governance / Run Admission / Driver 的既有整合測試仍保留。AUTO-P1 一般 pilot host 只接入唯讀工作，不假裝已接通受正式授權的 AI 工作流程；尚缺有界 Human permit、exact 模型與預算 enforce、正式 activation 接線及其驗收。見 `AUTOMATION_PILOT_PERMIT.md`。

GitHub 只使用既有 chief-ai-bot helper；不索取管理員 Token，不重跑 CI、不合併、不發布 main、不修改 Ruleset。憑證失效會顯示失敗，不改用 Owner。

## 維護者啟動

原 Workspace 啟動方式不變；未注入 pilot port 時自動化 API 回覆明確不可用。新的本機入口：

```sh
npm run workspace:pilot -- --config /absolute/path/workspace.json --port 4873
```

設定使用既有 Workspace 格式；repository 必須 exact 符合 CHIEF。預設 helper 為使用者目錄下 `.config/gh-chief-ai/bin/chief-github`。設定檔與 UI 都不含 Token。若希望永久背景運作，需另提供安裝／卸載方案並取得 Human 授權。

GitHub 唯讀介面依據：[workflow runs REST 文件](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-repository)、[workflow jobs REST 文件](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run)。本輪 adapter 僅使用 GET。

STOP FOR ARCHITECT REVIEW
