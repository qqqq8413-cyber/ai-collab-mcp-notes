# AUTO-P2-A4-P0-S1-R3：關鍵治理讀取與 ledger 重設保護

## 決策與範圍

日期：2026-10-26（Asia/Taipei）。Architect 指派 R3。Base `359673970736c4afb07dc8031d5151b3258c8f95`；同一分支 `work/auto-p2-a4-p0-s1-lease-activation-set` 上新增一個提交（fast-forward，無 force push）。

- R3-A：`src/automation/durable-store.ts`、`src/automation/file-invocation-journal.ts`、`src/automation/authority/file-archive.ts` 的讀取改為安全、有界、不阻塞。
- R3-B：`WorkerStore.read()` 的「ledger 不存在」語意：已使用過的 store 遺失 ledger 時一律拒絕，不再讀成全新的空白預算。

未改：Controller／Journal／Authority 的 schema、checksum、版本規則、append-only 與權威分類；governed read model（含 `source-snapshot.ts`）；Lease 與 Activation Set 演算法；預算上限；CI workflow；守門測試。未做 S2、未修改 main、未核發 Authority、未讀取 API key、未啟動模型；EXE／H1–H9 維持 HOLD。測試全為 OFFLINE_SYNTHETIC。

## R3-A：關鍵治理讀取

### 共用讀取模組與模組邊界

新增 `src/automation/record-file.ts`：只 import `node:fs`、只讀、不提供任何寫入或 Archive 能力，回傳 `ABSENT`／`READ`／`UNSAFE(原因)`，由三個模組各自轉成原本的錯誤類型。守門測試鎖定的是「誰可以 import Archive、誰可以拿到 appender／reader」，這個模組不碰這兩者；所有隔離守門套件（governance-isolation、authority-archive、governed-execution-driver、governed-activation）照舊通過。`WorkerStore` 沒有改用它（維持 R2 已接受的本地 `readOwnFile`），避免替 `limited-worker/store.ts` 新增對 `automation/` 的相依。

### 讀取規則（`readRecordFile(path, maxBytes)`）

1. 以 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` 開啟：符號連結回報 ELOOP；FIFO 與裝置的開啟不會等待。
2. 讀取任何內容之前 `fstat`：必須是一般檔案、擁有者是目前使用者、`mode & 0o7077` 為 0（不得有 group／other 權限位元，也不得有 setuid／setgid／sticky；與 R2 相同。三個模組的寫入端都以 `openSync(…, 'wx', 0o600)` 建檔，所以不會擋到自己寫的檔案）、大小不超過上限。
3. **真正有界的讀取**：以 64 KB 為單位迴圈讀取，總量最多 `maxBytes + 1` 個位元組；一旦超過 `maxBytes` 立即拒絕。即使 fstat 回報的大小不實（檔案在讀取中變大），也不會讀超過上限加一。
4. 只有 `open(2)` 本身回報 ENOENT 才是「不存在」；其他任何問題（socket 開檔失敗、目錄、讀取錯誤）都是 `UNSAFE`。

| 模組 | 讀取點 | 上限 | 不存在 | 不安全 | 保留的既有檢查 |
| --- | --- | --- | --- | --- | --- |
| `durable-store.ts` | run 檔（`#load`；開啟時 `#assertIndexed`） | 16 MiB | 未知 run／pending ROOT（原語意） | `Unsafe controller storage file (原因)` | envelope、schemaVersion、checksum、runId 綁定、lifecycle 不變量、ROOT 索引 |
| `durable-store.ts` | admission 紀錄 | 1 MiB | 沒有紀錄（原語意） | `ADMISSION_RECORD_INVALID`（既有代碼） | sealed record、changeKey 綁定 |
| `durable-store.ts` | refusal 紀錄 | 1 MiB | `ADMISSION_RECORD_INVALID` | `ADMISSION_RECORD_INVALID` | sealed record、changeKey 綁定 |
| `file-invocation-journal.ts` | invocation 紀錄 | 4 MiB | `undefined`（原語意） | `InvocationJournalIntegrityError` | envelope、version 2、checksum、record schema、invocationId 綁定 |
| `authority/file-archive.ts` | canonical record | 4 MiB | `ARCHIVE_INTEGRITY`（不是一般檔案） | `ARCHIVE_INTEGRITY` | record hash、key 目錄、版本檔名、版本連續、supersession |

上限依現有 schema 推算：journal 結果最多 256 KiB（`MAX_RESULT_BYTES`），JSON 跳脫後最多約 6 倍，另加最多 8 筆短 history；Authority 文件與 admission 紀錄都很小；Controller run 取寬鬆上限。

行為變化：Controller store 與 journal 過去以路徑 `existsSync` + `readFileSync` 讀取，**會跟隨符號連結**；指向合法紀錄的符號連結過去會被接受，現在拒絕。Archive 過去有 lstat 與 `O_NOFOLLOW`，但沒有 `O_NONBLOCK`（lstat 與 open 之間換成 FIFO 會卡住），也沒有大小、權限、擁有者檢查。

### 既有測試的調整（請審查）

新規則讓 3 個既有套件中「手動放入新治理紀錄、未指定權限（因此是 0644）」的測試，改為被權限規則擋下。為了找出所有受影響處，暫時在編譯產物中加入診斷輸出（只改 dist，原始碼未動），記錄每一次權限拒絕，跑完 59 個套件（S1 測試檔除外，它刻意測權限）。結果共 9 次、6 行放檔程式碼，其中：

- 6 項測試直接失敗（期待的錯誤碼變成權限錯誤）；
- **2 項測試仍然通過，但原因換了**：authority-archive「24d. 不承接前一版的分叉版本」與 governed-read-model「E. 放進 Archive 的操作紀錄不是 Authority」原本要測 supersession 與 schema 檢查，卻改由權限規則擋下。

處理：這 6 行放檔改為 `{ mode: 0o600 }`，與 store 實際寫入的權限相同。修正後再跑一次診斷：權限拒絕 0 次，每個測試回到原本要測的檢查。診斷程式碼已移除（重新編譯，dist 中 0 處）。

| 套件 | 行 | 放入的檔案 |
| --- | --- | --- |
| `test-automation-run-admission.mjs` | `writeLegacyRun`、`writeClaim` | 舊式 run 檔、手動 admission 紀錄 |
| `test-automation-authority-archive.mjs` | 24d、36 | 分叉的第 2 版、偽造但雜湊相符的紀錄 |
| `test-automation-governed-read-model.mjs` | `plantRun`、E | 第二個 run、放進 Archive 的操作紀錄 |

## R3-B：已初始化 ledger 的缺檔

### 分析：哪些持久證據可以辨識「已使用過的 store」

程式中的事實：

- runner 先在 journal 記下 STARTED（`runner.ts:455`），之後才呼叫 adapter 預留；每一次預留之前都已完成 Activation。
- Activation 需要 ledger 中已有該 job（`governance.ts:63`）。
- limited packet 的 `objective` 就是完整 canonical contract，包含 `storageIdentity`（`contract.ts:68-70`）；Controller 自 ISSUE_PACKET 起保留 `activePacket`。

因此「這個 store 已有過預留或 claim」的證據有：

| 證據 | 位置 | 本輪是否使用 | 原因 |
| --- | --- | --- | --- |
| `activation-sets/`、報告目錄 | results 目錄（與 ledger 同處） | 是（本地證據） | 只在 job 存在後才會出現 |
| 已啟用、packet 綁定此 `storageIdentity` 的 Controller run | Controller store（另一個目錄） | 是（外部證據） | 精確綁定到這個 store，不會誤判其他 store |
| Archive 中的 IMPLEMENTATION_PACKET 內容 | Authority Archive | 否 | 只有 read model 可以 import Archive reader（守門測試），不為此放寬 |
| journal STARTED 紀錄 | journal 目錄 | 否 | 紀錄只有 packetId 與雜湊，沒有 packet 內容就無法對應到 store identity |

**以上沒有一項是「可信」的。** 它們都在同一個 OS 帳號下，同帳號程序可以全部刪除（D1）。本輪的防護是「偵測遺失」，不是「防止竄改」。

### 實作

- `WorkerStore` 新增選用參數 `initializationEvidence(storageIdentity)`。`ledger.json` 不存在時：
  1. results 目錄有 `activation-sets/` 或報告目錄 → `WORKER_LEDGER_MISSING_AFTER_INIT`；
  2. 外部證據回報存在 → `WORKER_LEDGER_MISSING_AFTER_INIT`；
  3. 外部證據本身讀不到（例如 Controller 檔不安全）→ `WORKER_LEDGER_MISSING_UNVERIFIABLE`；
  4. 都沒有 → 全新空白 ledger（合法的首次初始化）。
- 所有寫入都經過 `update()` → `read()`，所以 create、reserve、change、observe、recover 都會拒絕；送出前最後一道檢查也讀 ledger，同樣拒絕。沒有任何路徑會重建 ledger。
- 外部證據 `limitedLedgerEvidence(roots, clock)` 放在 `limited-worker/composition.ts`（它本來就 import Controller store 與 read model），接到三個 `WorkerStore` 建立點：composition、governed-execution 的 lease／recover 用 store、`main.ts` 的 Host store。**`main.ts` 每次啟動都會寫入 `RUNTIME_START`**；沒有這個接線，ledger 被刪後只要 Host 重啟，就會默默建立新的空白 ledger。

「已建立 job、但尚未 Activation」時遺失 ledger：仍讀成新的空白 ledger。Activation 之前不可能有預留（預留需要 Activation，而 Activation 會留下 Controller 證據），所以累積預留總額不變；但 job 與觀測紀錄會遺失。這一點沒有可用證據，列為剩餘問題。

### 資料遺失時的矛盾狀態

| 遺失的資料 | R3 之前 | R3 之後 | 證據 |
| --- | --- | --- | --- |
| 只有 ledger | 讀成空白；Host 重啟寫入新 ledger；累積預留歸零，新的 run 可再預留到上限 | read／create／reserve／observe／execute／activate 全部拒絕，ledger 不被重建 | 測試 R3-B 第 1 項 |
| ledger＋results 中的痕跡 | 同上 | Controller 證據 → 拒絕；送出後的同一 run 不再送出 | 測試 R3-B 第 2 項 |
| claim 之後、送出之前遺失 ledger | 送出前檢查找不到 job → 不送出 | 同左，且不重建 ledger | 測試 R3-B 第 3 項 |
| Controller 證據讀不到 | — | `UNVERIFIABLE`，拒絕 | 測試 R3-B 第 5 項 |
| ledger＋痕跡＋Controller run 檔 | 同第 1 列 | **擋不住**：admission 還在，看起來像 pending ROOT，證據消失 | 只有分析 |
| ledger 換成較舊的合法副本 | 接受 | **擋不住**：checksum 正確，之後的預留不見 | 只有分析 |
| Controller run 換成較舊版本 | 接受 | 仍接受；同一 run 不會重送（journal 每個 packet 最多 1 次、ledger claim 擋重送），但狀態倒退 | 只有分析 |
| 只有 journal | ledger 仍記著預留；`generationClaimed` 擋住重送 | 同左 | 只有分析 |

### 剩餘阻擋條件（正式執行維持 HOLD）

1. **全面刪除無法與首次初始化區分**：同帳號程序刪除 ledger、results 痕跡與 Controller run 檔後，store 看起來從未使用，累積預算歸零。解除條件：需要 AI 工具無法寫入或倒退的信任錨點，例如 Host 以獨立 OS 帳號執行並擁有 ledger／Controller／journal，或由 Human 簽署的預留收據（S2 類），或外部單調計數。
2. **ledger 倒退無法偵測**：建議下一刀加入防禦性不變量「journal 中每個已 STARTED 的 limited invocation，都必須對應到 ledger 中具相同 invocationId 的 job」，在預留前檢查。仍受 D1 限制。
3. **Controller run 倒退無法偵測**（不影響預算，影響狀態）。
4. **read model 的 `source-snapshot.ts:75` 仍缺 `O_NONBLOCK`**：它在執行路徑上（verifyPermit 與 Activation Set 驗證都讀 read model）。不在本輪三個檔案的範圍，建議下一刀優先處理。
5. `WorkerStore` 的 R2 讀取是「fstat 大小檢查＋`readFileSync`」，尚未改成本輪的迴圈有界讀取。
6. 擁有者不符：需要 root 才能 chown，只有程式檢查，沒有實測（同 R1、R2）。

## 實際差異

| 檔案 | 修改 |
| --- | --- |
| `src/automation/record-file.ts`（新） | `readRecordFile`：不跟隨、不阻塞、讀前 fstat、迴圈有界讀取 |
| `src/automation/durable-store.ts` | run 檔、admission、refusal 三處改用 `readRecordFile`；新增上限常數 |
| `src/automation/file-invocation-journal.ts` | `#load` 改用 `readRecordFile`；新增上限常數 |
| `src/automation/authority/file-archive.ts` | `readRecord` 改用 `readRecordFile`；新增上限常數 |
| `src/limited-worker/store.ts` | `WorkerStoreOptions.initializationEvidence`；`read()` 缺檔時 `#assertNeverUsed` |
| `src/limited-worker/composition.ts` | `limitedLedgerEvidence`；composition 的 store 接上證據 |
| `src/automation/live/governed-execution.ts` | lease／recover 用 store 接上證據（1 行＋import） |
| `src/limited-worker/main.ts` | Host store 接上證據；`clock` 移到 store 之前（2 行＋import） |
| `test-auto-p2-a4-s1.mjs` | 新增 11 項 R3 測試；`S1_ONLY` 名稱前綴過濾（供注入錯誤腳本縮短時間） |
| `test-automation-run-admission.mjs`、`test-automation-authority-archive.mjs`、`test-automation-governed-read-model.mjs` | 6 行放檔改為 0600（見上） |
| `regressions/auto-p2-a4-p0-s1/mutate.py` | 新增 M25–M37；支援一項注入改多處、只跑指定測試 |
| `regressions/auto-p2-a4-p0-s1-r3/` | R3 證據（含權限診斷與分套件結果） |

## 驗證證據

本機 macOS（Darwin 25.6.0，Node 24.15.0）；原文見 `regressions/auto-p2-a4-p0-s1-r3/`。

| 項目 | 結果 |
| --- | --- |
| TypeScript `tsc --noEmit` | 0 錯誤 |
| `test-auto-p2-a4-s1.mjs` | 54／54（S1 31＋R1 7＋R2 5＋R3 11）；連續 3 次皆 54／0（每次約 66 秒） |
| 完整 `npm test` | 60 個套件、2,329 項通過、0 失敗、0 SKIP（R2 為 2,318；新增 11 項），約 259 秒 |
| 分套件執行（修正放檔權限前） | 3 個套件、6 項失敗，全部是放檔權限造成（`per-suite-before-fixture-fix.txt`） |
| 權限診斷 | 修正前 9 次權限拒絕（`mode-diagnostic-before-fixture-fix.txt`）；修正後 0 次 |
| 注入錯誤 | 37／37 被抓到（約 30 分鐘）。M1–M24 照舊（整個測試檔）；R3 新增 M25–M37 只跑 R3 測試：M25／M26／M27 分別只拿掉 Controller／journal／Archive 的 `O_NONBLOCK`；M28 不查檔案型別；M29 不查權限；M30 讀取不設上限；M31／M32／M33 把不安全的 journal／Controller run／admission 當成不存在；M34 忽略本地證據；M35 忽略 Controller 證據；M36 證據不綁定 store identity；M37 證據讀不到當成沒有證據 |
| 修正前對照 | 未執行：新測試 import 本輪新增的 `readRecordFile` 與 `limitedLedgerEvidence`，換回舊程式時測試檔在載入階段就失敗，拿不到逐項結果。各層保護是否有作用改由 M25–M37 逐項證明 |

GitHub CI（Ubuntu `test`、macOS `r4t-macos` Seatbelt）須以本提交的 exact SHA 執行；結果記錄在提交後的回報與 HANDOFF，不寫回本檔，以避免自引用。

**STOP FOR GPT-6 ARCHITECT REVIEW。EXE／H1–H9 HOLD 維持不變；不得因本輪測試通過而解除 Live HOLD、核發 Authority 或啟動付費 Pilot。**
