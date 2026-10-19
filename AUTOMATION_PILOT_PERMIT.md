# AUTOMATION PILOT PERMIT 建議

狀態：DRAFT / NOT AUTHORIZED。這份文件不是 Human grant，不可匯入 Authority Archive 當授權。EXE HOLD 與 H1-H9 維持原狀。

## 本輪已可使用，不需新增 EXE 授權

- 工作類型：CI_WATCH（僅讀指定 repo 的 GitHub Actions）；CI_REPORT（僅讀同專案已保存 CI 證據）。
- Agent / 模型：無；費用上限 USD 0；模型呼叫上限 0。
- GitHub：僅 chief-ai-bot，固定 GET user、指定 repo 的最近 5 個 Actions runs 與該 attempt jobs；不重跑 CI、合併或推 main。
- 寫入：Workspace dataDirectory 的 `auto-p1/` 操作紀錄；不寫 Authority Archive / Controller / Invocation Journal。
- 排程：預設關閉，UI 明確開啟；60 至 86400 秒；無全域背景服務。
- 上限：全域同時 1 件，每專案 20 個任務，每項最多 1 個 queued / running；單次 60 秒；每個資料目錄每小時最多 30 次 GitHub snapshot，單 snapshot 最多 12 次 helper invocation（每次 helper 另做 bot 身分確認）；單 subprocess 輸出上限 2 MiB。
- 錯誤：保存 FAILED，不自動重試；手動重試上限可選 0 至 2。未完成程序重啟後標成 FAILED，不擅自重放。
- 保存：最近 500 次執行、500 次操作、500 次 CI 差異、100 個 CI run；每筆 snapshot 最多 5 個 run，原子替換與 checksum。這是有界 operational history，不是無限期合規檔案。
- 停止：暫停排程只阻止未來觸發；停止執行中止當前 reader 並停該排程；取消待辦只取消尚未開始的工作。關閉本機 pilot 亦中止當前讀取。
- 有效期間：本機 pilot 程序運作期間；已啟用設定會持久化，重新開啟同一設定會恢復。不是永久背景運作授權。

## 未來 AI Pilot 的最小申請（尚未生效）

先由 Architect 審查完整 activation packet，再由 Human 對 exact packet hash / SHA 簽發正式、有期限的 grant。不得用本表或普通 AI 訊息替代既有 Authority Archive。

| 欄位 | 建議上限 |
| --- | --- |
| 工作類型 | 只讀指定測試 repository 中 1 份明確指定文件，產出審查報告；不修改程式 |
| Agent | 單一 Agent；provider、model、CLI executable 及雜湊必須在正式 packet 中精確指定，未指定即 LOCKED |
| 工具 | 既有 governed Driver + model sandbox；僅 read-file、寫本次 output；無 shell 任意執行、無 GitHub 寫入 |
| 讀取範圍 | exact repository SHA 的 1 份 Human 選定文件；不讀其他專案、憑證或私人 Session |
| 寫入範圍 | 單次隔離 output 目錄；禁止 governance roots、main、系統設定 |
| 外部副作用 | 僅指定模型推理請求；不得 push、寄信、部署或改帳號權限 |
| 費用 | 每次 USD 1、總額 USD 1；必須先有可實際 enforce 的模型 / token / pricing 上限，否則不能啟用 |
| 執行時間 | 最多 5 分鐘 |
| 執行次數 | 1 次；不自動重試 |
| 排程 | MANUAL only；無 AI-to-AI 自動循環 |
| 失敗處理 | 停止，保存實際結果 / 錯誤，等待 Human，不換模型或擴權 |
| 緊急停止 | 既有 governed Driver 中止 + 操作面停止；須先通過真實隔離 / 中止驗證 |
| 有效期間 | 正式授權時指定 UTC 起訖，最長 1 小時；不可永久有效 |

在 runtime 預算 enforce、exact 模型選擇、治理組合與 Human grant 尚未完成前，這條 AI 路徑仍不可使用。CI 排程不持有上述 AI 執行能力。

STOP FOR ARCHITECT REVIEW
