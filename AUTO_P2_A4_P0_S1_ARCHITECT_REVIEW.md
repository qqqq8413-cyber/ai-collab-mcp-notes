# AUTO-P2-A4-P0-S1：Lease 安全與 ACTIVATION_SET

> **R1 更新（2026-10-26）**：集合檔案層檢查、提交持久性與 S2 簽章前像契約見 `AUTO_P2_A4_P0_S1_R1_ARCHITECT_REVIEW.md`。本檔中「斷電」相關測試是 SIGKILL 與人工建構的殘留狀態，不是實測斷電；符號連結現在回報 `ACTIVATION_SET_FILE_UNSAFE`。

## 決策與範圍

日期：2026-10-25（Asia/Taipei）。Base `cfd0e621f8fd4c9035ac2946fcb5e8f31666b384`。
分支：`work/auto-p2-a4-p0-s1-lease-activation-set`。本輪是工程候選，不是 Authority、不是 EXE／H1–H9 決策，也不是付費 Pilot 許可。

- 未核發任何正式 Authority；未讀取任何 API key；未呼叫任何付費模型或帳戶 API；未部署 Host；未合併 main。
- 全部測試只用 OFFLINE_SYNTHETIC 文件、回覆與暫存目錄。A3 資源與費用限制（單次／累積 US$1、最壞預留 US$0.210240、一次、零重試、300 秒）未改。
- **Activation Set 工程測試通過不代表解除 Live HOLD。** 未簽署的集合一律 `liveEligibility = NOT_SIGNED`。

## 威脅模型

| # | 威脅 | S1 前 | S1 後 | 證據（`test-auto-p2-a4-s1.mjs`） |
| --- | --- | --- | --- | --- |
| T1 | 兩個程序同時接管同一個過期 lease | 核對 inode 後以路徑 `unlink`：晚到者會刪掉剛被別人取得的新 lease，兩個 Host 同時認為持有 | 每個過期 nonce 只有一個接管 token（`wx`）；持 token 後重讀，仍是同一筆過期紀錄才以 `rename` 原子取代；release 只刪自己 nonce 的 lease | 舊演算法重現（B 的檔案 `nlink=0`）；同一插隊序列在新演算法下晚到者 BUSY、B 的 lease 原封不動；6 程序 × 8 輪（空閒／過期）每個持有者到釋放前 lease 皆完整、時段不重疊 |
| T2 | PID 被重用 | 只用 `kill(pid,0)`，同樣判活 | 任何活著的程序（含重用、他人 EPERM）一律 BUSY，不接管 | PID 重用測試：BUSY 且檔案不變 |
| T3 | 寫入 lease 中途當機留下空檔／半檔 | `open(wx)` 後才寫入：空檔永遠 UNCERTAIN | 先寫私有暫存檔＋fsync，再以 `link(2)` 一次發布完整紀錄 | SIGKILL 持有者後 lease 完整、可被乾淨接管 |
| T4 | 接管者自己中途死亡 | 不適用 | 失敗的接管保留 token → 該過期 lease 之後一律 BUSY（fail closed），交 Human 復原 | 殘留 token 測試：3 次皆 BUSY，目錄零變化 |
| T5 | `write.lock` 殘留 | 原始 `EEXIST` 例外（WORKER_FAILED_CLOSED），無程序 | 具名 `WORKER_STORE_WRITE_LOCK_HELD`，永不自動刪除；Human 程序見下 | 殘留時 change／reserve／execute 皆拒絕，ledger 位元組不變；依程序復原後可寫 |
| T6 | 三份文件只保存一部分（當機） | 允許部分保存（Archive 只增不刪） | 三份都保存並驗證後才發布集合；沒有集合就不進 Controller | 第 0／1／2／3 份後注入當機；SIGKILL 在第 1／2／3 份後及集合後；皆無啟用、零送出，原樣重試僅啟用一次 |
| T7 | 孤兒、混合版本、已被取代 | 個別文件各自核對 | 每次核對都由目前 Archive 重新推導「應有集合」：成員必須恰好一筆已保存、且為最新版本 | MEMBER_NOT_ARCHIVED／MEMBER_NOT_CURRENT／RUN_MISMATCH |
| T8 | 偽造、損壞、截斷、符號連結、權限過寬 | 不適用 | 內容定址（檔名＝完整內容 SHA-256）、O_NOFOLLOW、64KB 上限、strict schema、目錄 0700 | 偽造標記不被讀取；截斷／改內容／空檔／symlink → CORRUPT；0755 → STORAGE_UNSAFE |
| T9 | 同名不同內容（衝突） | 不適用 | 發布為獨佔 `link(2)`；同內容為冪等，不同內容為 CONFLICT | CONFLICT 測試；4 程序重複提交 → 3 筆 Archive、1 個集合 |
| T10 | claim 後、送出前集合被移除／損壞／過期 | 不適用 | 最後同步送出防線 `beforeSend` 重新驗證集合 | 移除／損壞／被取代三案：零送出、UNCERTAIN、預留保留 |
| T11 | 多個 Host 程序重複送出 | 單程序測試 | 跨程序 lease＋claim | 4 個 Host 程序同時執行：總送出 1；Host 在 claim 後或送出後被 SIGKILL，重啟後皆不再送出 |
| T12 | 同一使用者帳號下的 AI 工具偽造 Authority 與集合（D1） | 未解 | **仍未解**。集合是完整性提交紀錄，不是簽章；同帳號程序可寫 Archive 與集合 | 只能保證未簽署集合永不取得正式 Live Eligibility（測試） |

## S1-A：Lease 設計

**取得**：`runtime.lock.<nonce>.tmp`（`wx`、0600、fsync）→ `link(2)` 至 `runtime.lock`；成功即持有，`EEXIST` 進入接管判斷。發布後目錄 fsync，暫存名稱必刪。

**接管**（只在持有者已死時）：
1. 讀取現有 lease（O_NOFOLLOW、≤500 bytes、strict `{pid, nonce}`）；不存在 → BUSY（不等待，呼叫者重試）；無法讀或格式錯 → UNCERTAIN。
2. `pid` 存活（含 PID 重用與 EPERM）→ BUSY。
3. 以 `wx` 建立 `runtime.lock.takeover-<過期nonce>`；已存在 → BUSY。
4. 持 token 重讀 lease：仍為同一過期 nonce 才 `rename` 新紀錄覆蓋；否則（已被取代或已不存在）BUSY。
5. 成功或「該過期 nonce 已不存在」時移除 token（nonce 永不重用，token 已無保護對象）；其他失敗保留 token，該過期 lease 之後 fail closed。

只有持有該過期 nonce 之 token 的程序能取代該紀錄，而存活持有者的 lease 永遠不會被接管，所以任何程序都不會刪除或覆蓋另一程序剛取得的 lease。釋放只在 lease 仍帶自己 nonce 時刪除，重複呼叫 release 不會刪掉後來者的 lease（測試）。

**前提與不保證**：同一台主機、同一本機 POSIX 檔案系統（`link`／`rename` 原子；不支援 NFS／網路磁碟）、同一 PID namespace。PID 重用會讓過期 lease 暫時 BUSY（可用性代價，不是安全問題）。`main.ts` 的 Workspace runtime 在整個程序期間持有 lease，行為與 S1 前相同。

### 殘留鎖的 Human 復原程序（不自動刪除任何鎖）

適用：`write.lock`、無法讀取的 `runtime.lock`、或殘留的 `runtime.lock.takeover-<nonce>`。系統只會回報 `WORKER_STORE_WRITE_LOCK_HELD`、`WORKER_LEASE_UNCERTAIN` 或持續的 `WORKER_LEASE_BUSY`。

1. 停止此資料目錄的所有 CHIEF Host／限定 Worker 程序，並確認：`pgrep -fl 'limited-worker|governed'` 無結果、`lsof <results>/write.lock` 無結果。
2. 若殘留的是 token：確認 `runtime.lock` 內的 `nonce` 等於 token 名稱的後綴，且 lease 與 token 內的 `pid` 皆已不存在（`ps -p <pid>` 無結果）。
3. 唯讀核對 ledger：以 `WorkerStore.read()` 讀取必須通過 checksum 與總額檢查；失敗則停止，交 Architect，不得繼續。
4. **改名保留，不刪除**：`mv write.lock write.lock.recovered-<UTC時間>`（token／lease 同理）。系統不讀取其他名稱，證據保留。
5. 記錄於 HANDOFF（時間、檔名、pid、ledger checksum），再重新啟動 Host。任何 `RUNNING` 工作會由 `recover()` 轉為 `UNCERTAIN`，不重送、不退預留。

不得在 Host 執行中操作；不得寫成自動化腳本；不得用於「加速重試」。

## S1-B：ACTIVATION_SET 設計

**內容**（`chief-activation-set.v1`，strict schema）：`recordClass: OPERATIONAL_RECORD`、`notAuthority: true`、`runId`、`repository`、`sliceId`、`packetId`、`packetHash`、`contractHash`、`implementationSha`、`workerCodeHash`；`members` 恰為三筆 `{role, kind, authorityId, version, recordHash, bodyHash}`（IMPLEMENTATION_PACKET／LIVE_PROVIDER_MODEL_CALL／LIMITED_README_WORKER）；`signaturePolicy: {version: 'S1_UNSIGNED_V0', humanSignatureRequired: false}`；`attestations: []`（S1 上限 0）。

**位置**：`<results>/activation-sets/<sha256(run)>/<setHash>.json`，目錄 0700、檔案 0600。放在 Worker 結果區而非 Authority Archive：它不是 Authority，Archive 與 E2–E5 歷史完全不寫、不改（測試核對 Archive 位元組不變，`preserve()` 拒收集合）。

**發布順序**（可信 Host `stage`）：驗證三份外部已核發文件 → 既有 preserver 逐份保存 → 讀取最新 read model → 由 Archive 重新推導應有集合（三份皆須恰好保存一筆且為最新）→ 暫存＋fsync＋獨佔 `link(2)`＋目錄 fsync → 以全新 read model 再驗證 → 才呼叫既有 AP1 `core.activate`。內容相同的重試為冪等（同一個 setHash）。

**重新驗證點**：(1) Activation；(2) 執行前檢查（reserve 前）；(3) preflight 後檢查；(4) 最後同步送出防線 `beforeSend`（`dispatchGuarded` 內，socket ready 之後、寫入之前）。可信 Host 組合（`requireActivationSet`）與任何 `LIVE_PROVIDER` transport 都要求集合；Workspace 未受信組合的 OFFLINE 路徑行為不變。

**超越／衝突**：集合以內容定址，成員有新版本時應有集合的雜湊就改變，舊檔永遠不再相符（MEMBER_NOT_CURRENT）；同名不同內容為 CONFLICT／CORRUPT。舊集合檔不刪除。

**簽章保留欄位**：`signaturePolicy` 與 `attestations` 為 D1 預留。S1 不產生、匯入或讀取任何私鑰；帶任何 attestation 的集合無法通過 schema。`liveEligibility()` 在 S1 永遠回傳不合格（`ACTIVATION_SET_NOT_SIGNED`／`ACTIVATION_SET_MISSING`），stage 結果另加 blocker `ACTIVATION_SET_UNSIGNED`。

## 實際差異

| 檔案 | 修改 |
| --- | --- |
| `src/limited-worker/activation-set.ts`（新） | 集合 schema、推導、發布、驗證、`liveEligibility` |
| `src/limited-worker/governance.ts` | 保存三份後發布並重驗集合，再進 AP1；結果附 `activationSet`、`liveEligibility`、`ACTIVATION_SET_UNSIGNED` |
| `src/limited-worker/adapter.ts` | `check()` 驗證集合（涵蓋執行前、preflight 後、最後送出防線）；LIVE 要求已簽署 |
| `src/limited-worker/composition.ts` | 可信組合 `requireActivationSet: true` |
| `src/limited-worker/store.ts` | 新 lease（link 取得、token 接管、nonce 釋放）；`write.lock` 具名拒絕、不自動刪除 |
| `src/limited-worker/readiness.ts` | 未核發 Packet 說明集合要求（`setHash: null`、`NOT_ELIGIBLE_UNSIGNED`） |
| `test-auto-p2-a4-s1.mjs`（新）、`package.json` | S1 測試並入 `test:pilot` |
| `test-automation-authority-archive.mjs`、`test-automation-governance-isolation.mjs` | **兩個既有守門測試的 `authority/document.js` 匯入白名單加入 `activation-set.ts`**（它只 import `authorityBodyHash` 計算成員 body hash，不複製雜湊函式）；同時新增斷言：只 import `authorityBodyHash`／`JsonObject`，且照舊不得出現 reader／appender／append 能力。請 Architect 特別審查此項 |
| （設計調整） | `activation-set.ts` 以結構型別 `ActivationSetFacts` 接收 read model 事實，不 import read model 模組，因此 read model 匯入白名單（`test-governed-execution-driver.mjs` 等）不需擴大 |
| `regressions/auto-p2-a4-p0-s1/` | 最終完整測試輸出；第一、二次完整測試（各被一個守門測試擋下）原文；10 項注入錯誤結果與腳本 |

未修改：EXE／H1–H9 常數、AP1 activation core、Controller、Authority Archive／preserver、E2–E5 紀錄、CI workflow、Ruleset、A3 資源與費用限制。

## 驗證證據

本機 macOS（Darwin 25.6.0，含 Seatbelt 套件）；原文見 `regressions/auto-p2-a4-p0-s1/`。

| 項目 | 結果 |
| --- | --- |
| TypeScript `tsc --noEmit` | 0 錯誤 |
| 新增 S1 測試 `test-auto-p2-a4-s1.mjs` | 31／31 通過；連續 4 次皆 31／0（約 45 秒，含 6 程序 × 8 輪 × 2 種 lease 競爭、3 程序 × 5 輪 reserve 競爭、4 個 Host 程序同時執行、多次 SIGKILL） |
| 既有 A4 `test-auto-p2-a1.mjs` | 133／133 |
| 完整 `npm test` | 60 個套件、2,306 項通過、0 失敗（S1 前 base 為 2,275 項；新增 31 項） |
| 注入錯誤（`mutate.py`，對編譯後程式逐一注入再還原） | 10／10 被抓到：接管不重讀 nonce、token 非獨佔、忽略 PID 存活、release 不核 nonce、自動刪 write.lock、Worker 不驗集合、成員不必已保存、成員不必最新、發布忽略衝突、驗證不比對雜湊 |
| 第一、二次完整測試 | 各被一個既有守門測試擋下（`authority/document.js` 匯入白名單）；處理方式見「實際差異」，原文保留 |

GitHub CI（Ubuntu `test`、macOS `r4t-macos` Seatbelt）須以本提交的 exact SHA 執行；結果記錄於提交後的回報與 HANDOFF，不寫回本檔以避免自引用。

## 新未核發 Pilot Packet

提交後在乾淨的 exact SHA 工作樹，經既有 Workspace service（`prepare → reviewPacket`）產生 `PILOT_PERMIT_PACKET_A4_S1.json`，位於 repo 之外（`ws/outputs/auto-p2-a4-p0-s1/`），避免封包含自身提交 SHA 的自引用。Authority 三欄、`issuedAt`、`expiresAt` 皆為 null，`state = UNISSUED_NOT_AUTHORITY`；新增 `activationSet` 區段說明三份成員、綁定欄位、`setHash: null`、`liveEligibility: NOT_ELIGIBLE_UNSIGNED`。quote 會過期；最終候選版本須重新產生。

## 剩餘 D1／D2 阻擋與建議後續

1. **D1 身分（仍阻擋 Live）**：principalRef 只是字串；同帳號 AI 工具可寫 Archive 與集合。建議 S2：Human attestation（例如硬體金鑰／passkey 或獨立 OS 帳號的簽署器）簽 `setHash`，新政策版本 `humanSignatureRequired: true`，私鑰永不進入 AI 可達環境。
2. **D2 撤銷**：沒有獨立 REVOCATION 類型，只能以新版本取代；跨程序取消不存在（取消只在同程序 AbortController）；claim 前取消不退預留（現況保守，未改）。
3. **D2 fence**：lease 不是下游 fencing token；Controller／Journal 不核對 lease。建議把 lease nonce 寫入 claim 事件並在最後防線核對。
4. **D2 環境**：不支援網路檔案系統與跨 PID namespace（容器）；需在 Host 部署條件中明列。
5. **D3 範圍**：集合只在限定 Worker 的可信 Host 與 LIVE 路徑強制；`createGovernedLiveAutomation` 的一般 activation core 未加集合（EXE HOLD 下不可執行，另案）。
6. 殘留鎖目前只有 Human 程序；若要自動化，必須先有 D1 身分與 fence。

**STOP FOR GPT-6 ARCHITECT REVIEW。不得因本輪工程測試通過而解除 Live HOLD、核發 Authority 或啟動付費 Pilot。**
