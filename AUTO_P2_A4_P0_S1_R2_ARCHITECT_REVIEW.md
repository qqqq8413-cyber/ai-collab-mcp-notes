# AUTO-P2-A4-P0-S1-R2：WorkerStore 特殊檔案讀取強化

## 決策與範圍

日期：2026-10-26（Asia/Taipei）。Architect 決定 R1 ACCEPTED，指派 R2。Base `29fd0a7e65db8a7cdadd0b8608da515d1435b0cd`；同一分支 `work/auto-p2-a4-p0-s1-lease-activation-set` 上新增一個提交（fast-forward，無 force push）。

只修改 `src/limited-worker/store.ts` 的三個讀取入口：`runtime.lock`、`ledger.json`、`report.md`。Lease 演算法、Activation Set、Authority Archive、預算控制、寫入路徑、Controller、AP1、EXE 常數、A3 限制與 CI workflow 皆未改。未做 S2 簽章、未修改 main、未核發 Authority、未讀取 API key、未啟動模型；EXE／H1–H9 維持 HOLD。測試全為 OFFLINE_SYNTHETIC。

## 修改

三個讀取入口改用同一個新的私有函式 `readOwnFile(path, maxBytes, code)`：

1. 以 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` 開啟：符號連結回報 ELOOP；FIFO 與裝置的開啟不會等待。
2. 讀取任何內容之前先 `fstat`：必須是一般檔案；擁有者是目前使用者；不得有 group／other 權限位元，也不得有 setuid／setgid／sticky（`mode & 0o7077` 必須為 0）；大小不超過原有上限（lease 500 B、report 64 KB、ledger 16 MiB）。讀完後再比一次長度。
3. 只有 `open(2)` 本身回報 ENOENT（檔案不存在）才回傳「沒有檔案」；其他任何問題（socket 開檔失敗、目錄、讀取錯誤等）一律丟出該讀取點的錯誤碼（fail closed）。

| 讀取點 | 呼叫者 | 檔案不存在 | 不安全或讀取失敗 | 之後保留的原有檢查 |
| --- | --- | --- | --- | --- |
| `runtime.lock`（`#leaseRecord`） | lease 接管、release | 沒有紀錄（接管 → BUSY；release 不刪除） | `WORKER_LEASE_UNCERTAIN`：不接管、不刪除 | strict `{pid, nonce}` schema、≤ 500 B |
| `ledger.json`（`read`） | 所有 ledger 讀寫（update、create、change、reserve、recover、observe） | 全新空白 ledger（S1 前既有行為，未改，見「其他發現」） | `WORKER_STORAGE_INTEGRITY` | envelope schema、checksum、job id 唯一且等於 contract 雜湊、總預留 ≤ US$1、≤ 16 MiB |
| `report.md`（`reportIsValid`） | `resultConsistency` | `false` | `false` | 目錄 lstat、雜湊等於 `reportHash`、storageIdentity、≤ 64 KB |

「檔案不存在」與「讀取失敗」的界線變得更窄：原本 ledger 的 ENOENT 判斷包住整段讀取，任何帶 ENOENT 代碼的例外都會變成空白 ledger；現在只看 `open(2)` 本身。

**權限規則與 R1 不同，原因如下。** R1 的集合檔由發布端以 `fchmod(0600)` 明確設定，所以要求恰為 0600。store 的三個檔案由 `openSync(…, 0o600)` 建立，會受 umask 影響（umask 只會去掉位元）；若要求恰為 0600，特殊 umask（例如 0277）會讓 store 擋掉自己寫的檔案。本輪不改寫入端，所以規則是「只有擁有者位元」：0600 與 0400 接受，任何 group／other 或特殊位元拒絕。若要恰為 0600，需同時在三個寫入端加 `fchmod`，不在本輪範圍。

**硬連結數未檢查。** lease 以 `link(2)` 發布，發布者刪除暫存名稱之前 nlink 為 2，這是設計上的正常狀態；若要檢查，需比照 R1 的「發布者自己的暫存名稱」規則，屬於設計變更，本輪未做。

## 測試（`test-auto-p2-a4-s1.mjs` 新增 5 項）

每個讀取點分別驗證；「格式正確的內容」表示檔案內容本身完全有效，只有檔案本身有問題。

| 情況 | `runtime.lock` | `ledger.json` | `report.md` |
| --- | --- | --- | --- |
| 正常一般檔 0600、0400 | 過期 lease 正常接管；新 lease 為 0600 | 讀出同一份 job | 有效 |
| FIFO（空） | UNCERTAIN；release 不刪除 | INTEGRITY | `false` |
| FIFO（裝有格式正確的內容） | UNCERTAIN；release 不刪除 | INTEGRITY；update 不會換成新 ledger | `false` |
| 符號連結（指向格式正確的檔案） | UNCERTAIN | INTEGRITY | `false` |
| 目錄 | UNCERTAIN；release 不刪除 | INTEGRITY | `false` |
| socket | UNCERTAIN；release 不刪除 | INTEGRITY | `false` |
| 裝置（`/dev/null`） | UNCERTAIN；release 不刪除 | INTEGRITY | `false` |
| 權限 0644、0640、0604、0660、0606、0666、4600 | UNCERTAIN；0644 的自身 lease 副本 release 不刪除 | INTEGRITY | `false` |
| 超過大小上限 | > 500 B | 16 MiB + 1 | 64 KB + 1 |

每個 lease 拒絕案例都比對目錄內容不變（沒有接管、沒有殘留 token 或暫存檔）。每個 ledger 拒絕案例都確認 `read`、`update`、`create` 三者都拒絕、`write.lock` 不殘留、`ledger.json` 名稱沒有被改寫成新 ledger。

結果層：

- **lease 不安全**：`execute` 與 `activate` 都在任何 ledger 變更與送出之前拒絕；ledger 位元組不變、job 仍為 PREPARED；移除後同一個 job 執行一次。
- **ledger 不安全**（權限 0644、目錄）：`execute` 拒絕、零送出；沒有被讀成空白 ledger、沒有建立新 job；還原後同一個 job 執行一次，job 數仍為 1。只有真正不存在的 ledger（全新目錄）才是空白。
- **report 不安全**：`reportIsValid` 與 `resultConsistency` 皆為 `false`；再次 `execute` 不送出、job 保持 COMPLETED；還原後恢復有效。

測試方法（不誇大）：

- **FIFO**：每一個都在獨立子程序中執行，時限 15 秒；子程序被殺即判定失敗，所以讀取卡住只會變成測試失敗，不會讓整套測試掛住。裝有內容的 FIFO 由子程序先保留一個讀取端、寫入後關閉寫入端，讓內容留在管道中。
- **裝置**：非 root 無法建立裝置節點，所以在測試程序內以測試用 fs 包裝把該路徑的 `open` 改指 `/dev/null`（真實字元裝置、相同旗標）。沒有在 store 目錄放真實裝置節點。
- **socket**：以 `python3` bind 一個 AF_UNIX socket 建立。開檔即失敗（macOS 實測錯誤碼 -102），失敗即拒絕。
- **擁有者不符**：需要 root 才能 chown，本輪不以特權執行，只有程式檢查、沒有實測（同 R1）。

## 實際差異

| 檔案 | 修改 |
| --- | --- |
| `src/limited-worker/store.ts` | 新增 `readOwnFile`；`#leaseRecord`、`reportIsValid`、`read` 改用它 |
| `test-auto-p2-a4-s1.mjs` | 新增 5 項 S1-R2 測試與輔助函式（FIFO 子程序、裝置改指、socket） |
| `regressions/auto-p2-a4-p0-s1/mutate.py` | 新增 6 項注入錯誤（M19–M24） |
| `regressions/auto-p2-a4-p0-s1-r2/` | R2 證據 |
| `AUTO_P2_A4_P0_S1_R2_ARCHITECT_REVIEW.md` | 本檔 |

## 驗證證據

本機 macOS（Darwin 25.6.0，Node 24.15.0）；原文見 `regressions/auto-p2-a4-p0-s1-r2/`。

| 項目 | 結果 |
| --- | --- |
| TypeScript `tsc --noEmit` | 0 錯誤 |
| `test-auto-p2-a4-s1.mjs` | 43／43（S1 31 項＋R1 7 項＋R2 5 項）；連續 3 次皆 43／0（每次約 60 秒） |
| 完整 `npm test` | 60 個套件、2,318 項通過、0 失敗、0 SKIP（R1 為 2,313；新增 5 項），約 253 秒 |
| 修正前對照 | 以 R1 的 `store.ts`（`29fd0a7`）搭配本輪測試：38 項通過、R2 的 5 項全部失敗。每項最先失敗在「不安全權限被接受」或「沒有拒絕」，測試在該處中止，沒有跑到 FIFO 案例；FIFO 會讓舊程式卡住，由下列 M19–M21 單獨證明 |
| 注入錯誤（`regressions/auto-p2-a4-p0-s1/mutate.py`） | 24／24 被抓到（約 24 分鐘）。M1–M18 照舊。R2 新增：M19、M20、M21 分別**只**拿掉 `runtime.lock`、`ledger.json`、`report.md` 的 `O_NONBLOCK`，各自的 FIFO 子程序被殺、測試失敗；M22 不檢查檔案型別（裝有正確內容的 FIFO 被接受）；M23 不檢查權限；M24 ledger 讀取失敗當成空白 ledger |

GitHub CI（Ubuntu `test`、macOS `r4t-macos` Seatbelt）須以本提交的 exact SHA 執行；結果記錄在提交後的回報與 HANDOFF，不寫回本檔，以避免自引用。

## 同類讀取點盤點（未修改，請 Architect 決定）

只以搜尋開檔方式盤點 `src/`，未逐一確認每個呼叫者的前置條件。

**A. 已用 `O_NOFOLLOW`、缺 `O_NONBLOCK`：FIFO 會讓開檔卡住**

- `src/automation/authority/file-archive.ts:69`：Authority Archive 讀取（read model 與 Activation Set 驗證都會經過）
- `src/automation/read-model/source-snapshot.ts:75`
- `src/automation/change-registry.ts:89`
- `src/limited-worker/config.ts:9`：限定 Worker 的 Host 設定
- `src/pilot/store.ts:31`
- `src/ai-pilot/plans.ts:38`
- `src/event-source/claude-transcript.ts:23`

**B. 先 lstat 檢查、再以路徑開啟或讀取：檢查與開啟之間若被換成 FIFO，仍會卡住**

- `src/workspace/collaboration-store.ts:77`（開啟後另核對 dev／ino）
- `src/pilot/store.ts:69`（pilot lease 的 pid）

**C. 直接以路徑 `readFileSync`：跟隨符號連結、FIFO 會卡住、讀取前無型別檢查**

- `src/automation/durable-store.ts:95、149、285`：Controller 存放區
- `src/automation/file-invocation-journal.ts:49`、`src/automation/file-egress-journal.ts:45`：呼叫與 egress journal（前面只有 `existsSync`）
- `src/workspace/goal-store.ts:176`（前面只有 `existsSync`）
- `src/workspace/config.ts:58`、`src/intake/workspace-host-config.ts:51`：設定檔
- `src/limited-worker/main.ts:51`：Worker 程式碼雜湊
- `src/automation/live/codex-architect-review.ts:182`、`src/automation/live/claude-code-implementation.ts:209、608`
- `src/workspace/server.ts:142`：UI 靜態檔（啟動時）

建議優先順序：送出前必經的 Controller 存放區、invocation journal 與 Authority Archive。

## 其他發現（未修改）

`ledger.json` 不存在時讀成全新空白 ledger，這是 S1 之前就有的行為，Workspace 第一次啟動需要它，本輪保留。代價是：同帳號程序刪掉 `ledger.json`，已有的預留就會歸零（屬 D1 同帳號威脅類）。若要區分「從未建立」與「被刪除」，需要另外的持久標記或由 Controller 端核對，屬設計變更，請 Architect 決定是否另案處理。

**STOP FOR GPT-6 ARCHITECT REVIEW。不得因本輪測試通過而解除 Live HOLD、核發 Authority 或啟動付費 Pilot。**
