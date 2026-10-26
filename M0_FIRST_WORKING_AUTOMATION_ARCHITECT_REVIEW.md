# CHIEF M0：第一個可用的端到端自動化

## 結論

- **可以操作的端到端路徑（OFFLINE_SYNTHETIC）**：在 CHIEF 介面輸入一次任務、選 Agent、批准費用上限，Host 就會自動派工、在隔離工作區執行、保存結果，並在同一個介面顯示。過程中沒有任何手動複製貼上；重新整理或重啟 Host 後紀錄都在，不會自動重送。
- **這是離線演練，不是 AI 成果**：Claude Code 由一個固定版本的離線合成執行檔代替，README 審查使用合成回覆；沒有呼叫任何模型、沒有金鑰、沒有付費。所有成果和紀錄都標示 OFFLINE_SYNTHETIC。
- **真實 Provider 端到端：未執行**。正式 Host 的兩個 Agent 都停在 EXE HOLD；介面顯示「啟動執行 · LOCKED」，並列出剩餘的授權步驟（見最後一節）。

日期：2026-10-26（Asia/Taipei）。Engineering Base `cc314859332cd4e77e23a34890845f5efdd7963d`；新分支 `work/m0-first-working-automation`。未修改 main、未核發 Authority、未讀取 API key、未呼叫模型、未解除 EXE／H1–H9；未做 R4／R5 安全修補。

## 怎麼操作

```bash
npm run build
npm run workspace:m0-rehearsal -- --data-dir /absolute/path/to/an/empty/folder
```

在乾淨、確切版本的 checkout 執行（Worker 會把目前的 Git SHA 和編譯後程式的雜湊綁進每個計畫；工作樹不乾淨時 Activation 會拒絕）。打開印出的網址 → 專案「CHIEF（OFFLINE_SYNTHETIC 演練）」→「自動化」→「交付任務」：

1. 輸入「要 AI 完成什麼」，選擇 Agent（預設 Claude Code 唯讀分析），按「建立工作與計畫」。
2. 工作卡片顯示預留上限；勾選「我批准這項工作，並同意最多預留 US$x」，再按「批准並執行」。
3. 卡片自動顯示狀態、Agent、開始與結束時間、usage、依 usage 計算的費用與報告；失敗或停止時顯示原因。

## 重用與新增

| 環節 | 重用 | M0 新增或修改 |
| --- | --- | --- |
| 任務入口 | Workspace UI、session（綁定設定檔的 Human）、Goal Store、GC1、RA1 | 面板改為「交付任務」：兩種 Agent、批准勾選、批准並執行、開始／結束時間、usage、授權步驟 |
| Host 合法性檢查 | Activation（preserver、Authority Archive、ACTIVATION_SET、AP1）、Controller、Execution Driver、Runner、Invocation Journal、送出前最後檢查、ledger 預算 | START 需要 Human 批准的金額與最壞預留完全相等；只有 OFFLINE_SYNTHETIC Host 可以 START；預算不足時在 Activation 之前拒絕 |
| Agent | LimitedReadmeWorker adapter（預留、generation claim、usage 費用、報告保存） | Claude Code 唯讀 transport（`claude-code-reader.ts`）；Seatbelt runner（LIVE，HOLD）；離線 runner 與合成執行檔 |
| 結果回傳 | 既有服務的 job 檢視、3 秒輪詢 | 開始與結束時間、Host 種類（`execution`） |
| Host | 正式 Host（`main.ts`）不變，仍為 EXE HOLD | 演練 Host（`rehearsal.ts`、`rehearsal-main.ts`、`npm run workspace:m0-rehearsal`） |

### Claude Code 唯讀分析

- 每次執行建立新的隔離工作區（0700），裡面只有固定版本 README.md（0600）；執行後刪除。
- 參數：`-p --output-format json --model claude-haiku-4-5-20251001 --max-turns 3 --max-budget-usd 0.630720 --restricted --permission-prompts none --permission-mode dontAsk --no-session-persistence --strict-mcp-config --disable-slash-commands --no-chrome --tools Read,Glob,Grep`；權限只允許 `Read(./README.md)`；禁止 Bash、Edit、Write、NotebookEdit、WebFetch、WebSearch；JSON schema 只回 `{report}`。
- 環境：關閉 CLAUDE.md、自動記憶、非必要連線、遙測、prompt cache；輸出上限 2,048 tokens。Transport 不設定任何金鑰或 proxy 變數。
- 結果驗證：必須成功結束、輪數 ≤ 3、只用指定模型、沒有 cache token、有非空報告、回報費用 ≤ 預留；否則 fail closed。
- 送出前最後檢查在啟動程序之前同步執行；檢查失敗就不啟動程序。
- 費用：每次模型請求以 200,000 輸入加 2,048 輸出 tokens 預留，3 輪合計 630,720 µUSD（US$0.630720）；README Worker 維持 210,240 µUSD。

### 正式 Host 與演練 Host 的界線

- 正式 Host：Claude Code 唯讀分析接到「尚未設定」的 LIVE transport；README Worker 仍是原生 API transport；兩者在 EXE HOLD 下都在任何程序或請求之前拒絕。START 在服務端就回 `EXE_HOLD`。`main.ts` 不載入演練模組（測試檢查原始碼與編譯產物）。
- 演練 Host：自己的資料夾與合成設定（`human:offline-synthetic-rehearsal`、`architect:offline-synthetic-rehearsal`）；兩個 Agent 都是 OFFLINE_SYNTHETIC（不同種類的 transport 不能混用）。使用者批准某個工作時，演練 Host 才為該工作寫入三份**演練紀錄**（packet 與兩份授權，30 分鐘有效，內容寫明「不是 Human 授權」），再走受信 Activation。這些紀錄不是 Authority；未簽章的 Activation Set 永遠不具 Live 資格。
- 不讓 Agent 增加權限：工具清單、權限規則與工作區內容都由 Host 決定，請求只接受任務文字、Agent 種類（兩個固定值）與批准金額；瀏覽器無法提供指令或路徑。

## 守門測試調整（請審查）

`test-governed-execution-driver.mjs` 鎖定「哪些檔案可以使用 `governed-execution.js`」，原本只有 `ai-pilot/preparation.ts` 與 `limited-worker/composition.ts`。演練 Host 透過 `createGovernedLimitedWorker` 組裝受信的 Worker（沒有直接開 preserver，另一條守門測試仍成立），所以白名單加上 `src/limited-worker/rehearsal.ts`。

## 驗證證據

本機 macOS（Darwin 25.6.0，Node 24.15.0）；原文見 `regressions/m0/`。

| 項目 | 結果 |
| --- | --- |
| TypeScript `tsc --noEmit` | 0 錯誤 |
| `test-m0-first-automation.mjs` | 10／10 |
| 完整 `npm test` | 61 個套件（新增 1 個）、2,339 項通過、0 失敗、0 SKIP（R3 為 2,329；新增 10 項） |
| 端到端（HTTP，兩種 Agent） | 經 Workspace 提交 → 未批准拒絕（`APPROVAL_REQUIRED`）→ 金額不符拒絕 → 批准後完成：Controller `IMPLEMENTATION_COMPLETE`、Journal 只有 1 筆且為 `APPLIED`、結果通過完整一致性核對；再按執行拒絕（`WORK_ALREADY_STARTED_OR_TERMINAL`）；重啟 Host 後狀態與報告相同，Claude Code 合成執行檔只啟動 1 次，隔離工作區已清除 |
| 預算 | 第二個 Claude Code 任務在 Activation 之前被拒絕（`TOTAL_COST_LIMIT`），沒有文件、沒有 invocation、沒有執行；README 任務（210,240）仍可執行 |
| 正式 Host | LIVE runtime 的 START 回 `EXE_HOLD`，零執行；只有離線 transport、但沒有演練 Host 明確開關時，同樣回 `EXE_HOLD`；`src` 中只有演練 Host 開啟這個開關；`main.ts` 不載入演練模組 |
| 瀏覽器 | 提交前以開發用啟動腳本操作完整流程（輸入任務 → 建立計畫 → 勾選批准 → 批准並執行 → 結果顯示 → 重新整理 → 重啟 Host），全部符合預期；提交後以正式指令在乾淨工作樹重做，結果記錄在回報 |

GitHub CI（Ubuntu `test`、macOS `r4t-macos` Seatbelt）須以本提交的 exact SHA 執行；結果記錄在提交後的回報與 HANDOFF，不寫回本檔。

## 已知限制

1. **預算**：累積上限 US$1 採保守預留，完成後不依實際用量退回。所以同一個資料夾最多跑 1 個 Claude Code 唯讀分析（或 4 個 README 審查）；之後的工作在 Activation 之前就被拒絕，介面顯示「剩餘預算不足」。要不要改成完成後依 usage 結算，需要 Human 與 Architect 決定。
2. **資料範圍**：M0 只讀固定版本的 README.md，不能指定其他檔案。
3. **同步執行**：按下「批准並執行」後，HTTP 請求會等到執行結束（離線演練不到 1 秒；真實 Claude Code 可能數十秒，最多 300 秒），沒有背景佇列。
4. **真實 CLI 未實測**：`--max-turns` 在 CLI 2.1.283 的說明中沒有列出（既有 adapter 已在使用）；只有實際以 `-p` 執行才能確認是否被接受，而那會呼叫模型。若不被接受，執行會失敗而不會送出。真實 CLI 是否會用到其他模型、每輪輸入是否在 200,000 tokens 以內，也未實測；結果驗證遇到其他模型會拒絕。
5. **程序中途當機**：演練 Host 用的是受信 governed Worker，S1 已用 SIGKILL 測過「claim 之後或送出之後被殺，重啟後不再送出」；M0 沒有另外加 SIGKILL 測試。

## 首次真實任務所需的剩餘授權步驟

1. **EXE／H1–H9**：Human 與 Architect 決定是否解除 HOLD。目前程式常數 `EXE = 'HOLD'`，必須由另一個經 Architect 接受的切片改變。
2. **D1／S2 簽章**：Human 簽章的 Authority（未簽章的 Activation Set 永遠不具 Live 資格）。
3. **正式 Host 的 Activation**：正式 Host 目前不是受信組裝，也沒有 Authority 匯入；需要一個切片讓它接收已簽章的 packet 與授權並完成 Activation。
4. **Claude Code 的正式設定**：固定版本 `claude` 執行檔與 SHA-256、Seatbelt 模型程序邊界與 egress broker、Claude 帳號或 API 金鑰（只由 Host 持有）。
5. **每個任務**：Architect 依審查封包核發 IMPLEMENTATION_PACKET；Human 核發 LIVE_PROVIDER_MODEL_CALL 與 LIMITED_README_WORKER 授權（1 小時內有效）；Human 在介面確認費用上限後按「批准並執行」。

**STOP FOR ARCHITECT REVIEW。**
