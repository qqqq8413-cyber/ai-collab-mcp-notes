# AUTO-P1 Architect Review Packet

狀態：唯讀自動化 pilot 已可操作，READY FOR ARCHITECT REVIEW。這不是 Architect 核准，也不是 AI 自主執行已啟用。

基準 `3923d267690d291ddc77e13d6fe9b81f9439266b`；分支 `work/auto-p1-usable-automation`。main 未修改，仍為 `e7eb87b4b481c885bea8730f8498eb493dc38184`。最終 exact candidate SHA 與工作分支 CI 由本輪交付回報及 GitHub commit 識別，不把基準 SHA 冒充成新候選版。

## Human 現在可以開始用什麼

`http://127.0.0.1:4873/#/p/chief/automation`

- 已建立的 CHIEF CI WATCH：點「立即檢查」，真正讀取 GitHub Actions，保存至本機，再自動顯示結果。
- 點「啟用監測」可開啟週期讀取；可暫停、停止執行或取消待辦。試用結束時所有監測均已關閉。
- CI 狀態摘要：以同專案已保存的真實 GitHub 結果產生本機摘要，可手動執行或訂閱 CI 狀態變更；不使用模型。
- 工作、結果、執行步驟、觸發原因、時間、錯誤、證據與操作紀錄均可從頁面查看。協作室有獨立 operational 摘要及連結，不把它變成 AI 發言。

操作見 `AUTO_P1_USAGE.md`；模組盤點見 `AUTO_P1_READINESS.md`。

## 實作範圍

- `src/pilot/model.ts`：固定 CI_WATCH / CI_REPORT 類型、嚴格輸入與資料模型、有界資源。
- `src/pilot/github.ts`：既有 bot helper、固定 GitHub GET、exact repo / run / attempt / job 身分、工作系統標籤與 required macOS skip 觀察；不保留 subprocess 私人錯誤內容。
- `src/pilot/store.ts`：自有 operational 儲存、checksum、原子寫入、fsync、排他程序 lease、壞檔／symlink 拒絕。
- `src/pilot/engine.ts`：持久化任務與排程、單一執行、request / occurrence 去重、獨立 task baseline、可取消讀取、單次時間／每小時讀取／手動重試限制、程序中斷不擅自重放。
- `src/pilot/main.ts`：新的本機 composition，僅注入唯讀工作能力。原 Workspace 啟動方式不變。
- `src/workspace/automation-port.ts` 與 `server.ts`：三個窄 operational API，沿用現有 D1 session、Host、Origin、Fetch-Site、request-header 與 CSP，不增加 Workspace 的 outbound / child-process / Controller 能力。
- `workspace-ui/automation.js`、`app.js`、`live.js`、`styles.css`、`reader-source.js`：既有 Workspace 內新增自動化頁、真實狀態／結果、協作室操作摘要；Lucide 同源圖示，無新套件或 CDN。
- 測試：`test-auto-p1.mjs`，及既有 UI／reader 的固定 route / import 清單更新。沒有刪除或放寬執行／Authority guard。
- 文件、HANDOFF 與 `regressions/auto-p1/` 驗收證據。

## 真實驗收，不混用合成案例

| 驗收 | 結果與證據 |
| --- | --- |
| 建立任務、手動啟動 | 真實瀏覽器操作，固定 repo 的 5 個 Actions runs 讀回，含 exact SHA / branch / attempt / Ubuntu / macOS jobs |
| 真實結果 | #124 `39296456090`、#123 `39287763419`、#122 `39250964550`、#121 `39250209129`、#120 `39051728193`；不是本輪新程式的 CI，不能以這些舊 run 宣稱新候選 CI 已通過 |
| 真實週期讀取 | 60 秒排程自然到期後讀取完成，手動與 SCHEDULED 均保存成功 |
| 真實 CI 變更事件 | 觀察期間 0 項自然狀態變更；EVENT_DRIVEN 的真實觸發仍未觀察，不為驗收觸發 CI |
| 真實本機摘要 | FINAL UI 驗收中的本機報告直接鏈結真實 CI watch run，保留 sourceRunId / sourceObservedAt；這次是手動執行，不冒充自然事件觸發 |
| 頁面重新整理 | 同一磁碟快照仍存在，UI 可讀；非 in-memory demo |
| 真實程序重啟 | 在啟用排程時關閉自己的 preview 並重新啟動，enabled / nextDueAt 與既有結果均保留；暫停後再重啟仍保持停用 |
| 去重 | 重送已完成的相同 request ID，重啟後執行數未增加；CI IDs 無重複；每次實際輪詢本身保留為獨立工作紀錄 |
| 桌面與手機 | 1440x1000、1024x768、768x1024、390x844、320x740；內容字級 16px，沒有頁面橫向溢出或操作列越界；瀏覽器 page errors 0 |
| 原協作紀錄 | 原 3 則 Claude 公開歷史事件不變，事件庫 SHA-256 `f6baffdf34c0b46d42dd78cfd948eb0fa6ee05d9adb248d78f6044da3e807f8b`，未把 CI 寫成 Claude 回覆 |

完整原始驗收 metadata 見 `regressions/auto-p1/`。原 SRC-C1 自然 Claude LIVE_TAIL 仍為 UNVERIFIED，與本輪 CI 可用性分開判定。

## 離線／故障驗證

`npm run build` 通過。最終 `npm test`：**54 組，2028 passed / 0 failed / 0 skipped**，本機 macOS 隔離檢查亦實際執行。

新增 AUTO-P1 **38** 項，涵蓋建立／設定／重啟、預設不啟用、排程唯一 occurrence、漏失週期不補發暴增、去重、單一 concurrency、每小時讀取預算、暫停／停止／取消區分、逾時原因、錯誤保存、重試上限、跨專案來源拒絕、多監看任務 baseline 隔離、事件報告合併、壞資料／checksum／symlink／競爭程序拒絕、helper 身分、exact attempt / job、macOS skip、來源 URL、EXE HOLD 與 forged Authority 拒絕，以及既有 Goal Queue 的 NOT_STARTED 語義。

故障、真實狀態變更與競爭排程的可控案例使用隔離合成資料；不是自然 GitHub 或 Claude 即時事件驗收。

前期曾有一個驗收腳本等待判斷錯誤，當時真實工作仍是 QUEUED；修正為明確輪詢後重新驗證，沒有把錯誤等待結果當成產品 PASS。既有三分頁 UI 斷言也已更新為四分頁，完整重跑通過。

## 邊界與未完成

1. EXE HOLD、H1-H9 與 Human Authority 不變，模型呼叫 0。排程只處理唯讀 CI 或本機摘要，沒有 Agent 自主工作與付費模型路徑。
2. AI 目標仍使用原 Goal Queue；可保存需求但不能執行。既有 Governance / Run Admission / Driver 的回歸通過，不代表一般 pilot host 已可執行 AI。此 host 刻意不持有 Driver / Controller / Authority appender。
3. 要真正開啟 AI 工作，仍缺正式有界 grant、exact provider/model、可 enforce 的成本／token 預算、governed activation 的操作接線與真實受授權端到端驗收。不能只切換 UI 開關。建議方案見 `AUTOMATION_PILOT_PERMIT.md`，目前 DRAFT / NOT AUTHORIZED。
4. 無永久系統背景服務；關閉 preview 就停止。若需要永久運作，需另列安裝／卸載與授權。
5. 只取最近 5 個 Actions runs，最多 100 個已觀察 run、有界操作歷史；不是全庫稽核歸檔，不保證取回錯過的每一個 CI 過渡狀態。
6. 依賴稽核仍有 **5 項既有告警（3 moderate / 1 high / 1 critical）**。包括 MCP SDK、fast-uri、hono、ip-address、proxy-addr。沒有在這輪升級依賴或宣稱安全清查通過；新 pilot 的執行入口僅引用 Node、zod 與本機模組，未接入 MCP/OAuth 或公開網路 listener，但這不取代整個 repo 的依賴修復。
7. 不推 main、不修改 Ruleset、不變更管理員憑證或其他 AI 全域設定。只有 chief-ai-bot 工作分支提交／推送。

## 建議審查決策

將「可操作的唯讀 CI pilot」與「仍被 HOLD 的 AI 自主執行」分開驗收。Human 現在可以使用前者；不要因已有 CI 排程或普通 AI 訊息，就把後者視為已授權。

STOP FOR ARCHITECT REVIEW
