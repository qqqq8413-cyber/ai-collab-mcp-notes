# AUTO-P2-A4-P0-S1-R1：Activation Set 強化

## 決策與範圍

日期：2026-10-26（Asia/Taipei）。Base `d48347ec61258cfc78ab2b3e93b8ebf1da4c15ea`；同一分支 `work/auto-p2-a4-p0-s1-lease-activation-set` 上新增一個提交（fast-forward，無 force push）。

Architect 決定 CHANGES REQUESTED：保留 S1 的 Lease 與 Activation Set 架構，只修正 Fix 1／Fix 2／Fix 3。Lease、Controller、AP1、Authority Archive、EXE 常數、A3 限制、CI workflow 皆未改。未修改 main、未解除 HOLD、未核發 Authority、未讀取 API key、未執行真實模型；測試全為 OFFLINE_SYNTHETIC。

## Fix 1：集合檔案本身的檢查

`readSetFile()`（Activation、執行前、最後送出防線，以及發布時遇到既有檔案的 EEXIST 路徑都經過它）現在依序要求：

1. 以 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` 開啟：符號連結不跟隨，FIFO 不會讓讀取卡住。
2. `fstat`：必須是一般檔案；擁有者是目前使用者；權限**恰為 0600**（含 setuid／setgid／sticky 位元在內的 12 個位元全部比對）。
3. 硬連結：`nlink` 為 1；或其他名稱只能是同一受保護目錄內發布者自己的暫存名稱 `.<uuid>.tmp`（`link(2)` 與刪除暫存名稱之間的窗口，或在這個窗口當機留下的殘留）。任何其他名稱，包括目錄外、同目錄其他名稱、不符格式的 `.tmp`，都拒絕。掃描後再 `fstat` 一次，連結數超過目錄內找到的名稱數即視為目錄外有連結。
4. 大小 ≤ 64KB，然後才做 strict schema 與內容雜湊檢查。

以上任一項不符即回報新錯誤碼 `ACTIVATION_SET_FILE_UNSAFE`（fail closed）。符號連結先前回報 `ACTIVATION_SET_CORRUPT`，現在改為 `ACTIVATION_SET_FILE_UNSAFE`。兩層目錄另外加查擁有者。發布端以 `fchmod(0600)` 明確設定權限，不受 umask 影響。

測試：0600 正常；0644、0666、0640、0604、0660、0400、0700 在 verify、publish（EEXIST 路徑）與執行（claim 前 BLOCKED、零送出）三處都被拒絕；父目錄或集合目錄 0755 拒絕（STORAGE_UNSAFE，與檔案權限分開測）；在集合名稱放目錄、FIFO（在有時限的子程序中檢查，證明不會卡住）、符號連結皆拒絕；四種非法硬連結拒絕、發布者自己的暫存名稱接受。

未以測試證明：「擁有者不是目前使用者」需要 root 權限才能 chown，本輪不以特權執行測試，因此只有程式檢查，沒有實測。

## Fix 2：提交持久性

新建時的順序（測試以追蹤 fs 系統呼叫比對完整序列）：

`mkdir(activation-sets)` → `fsync(results)` → `mkdir(<run>)` → `fsync(activation-sets)` → `open(temp, wx, 0600)` → `fchmod(0600)` → `write` → `fsync(temp)` → `link(temp → <setHash>.json)` → `unlink(temp)` → `fsync(<run>)` → return

- **父層同步**：每一層目錄在建立或確認後，都 fsync 其父目錄；**每次都做**，不只在本次新建時。前一個發布者若在 fsync 父目錄前當機，留下的目錄項目會在任何內容提交前補做同步。
- **EEXIST 冪等返回前**：先通過 Fix 1 全部檢查並比對雜湊，再對既有檔案本身 fsync，刪除自己的暫存名稱，fsync 集合目錄，然後才返回。前一個發布者可能在目錄 fsync 前死亡，所以冪等路徑同樣要完成這些持久化步驟。
- **Controller 之前**：Activation 的順序仍是「三份文件保存 → 發布（上述步驟完成才返回）→ 以全新 read model 驗證 → AP1 `core.activate`」。測試追蹤一次完整 Activation，確認第一個 Controller 寫入發生在最後一個集合 fsync 之後；並在 Activation 期間對集合目錄下的每一步注入停止，Controller 都不動。
- 刪除暫存名稱是 best effort：失敗會被吸收，提交照常完成（暫存名稱永遠不會被當成集合讀取）。測試明確驗證這是唯一會吸收停止的步驟。

### 驗證層級（不混用，不誇大）

| 層級 | 方法 | 證明了什麼 | 沒有證明什麼 |
| --- | --- | --- | --- |
| 1 系統呼叫順序 | 追蹤 builtin fs 呼叫，比對新建與冪等兩條路徑的完整序列 | 程式在 link 前 fsync 暫存檔、在返回與 Controller 寫入前 fsync 檔案與目錄、每層父目錄都同步 | 核心或磁碟真的把資料寫到永久儲存 |
| 2 注入停止（同程序） | 在 14 個發布步驟的每一步之前拋出例外；另在 Activation 期間對每一步集合操作注入 | 每個中斷點的結果只會是「沒有集合」（link 之前）或「完整集合」（link 之後）；原樣重試只提交一次；Controller 不動 | 程序真的死亡 |
| 3 SIGKILL（真實程序死亡） | 子程序在 14 步的每一步之前被 SIGKILL，父程序重啟 | 真實程序死亡後的檔案狀態同第 2 層；重啟後只啟用一次、只送出一次 | **斷電**：SIGKILL 時核心仍在運作，已寫入核心的資料之後仍會落盤，所以這不是斷電測試 |
| 4 模擬斷電殘留 | 人工建構殘留狀態（暫存檔、截斷、空檔、缺檔、權限、硬連結） | 讀取端遇到這些狀態一律 fail closed | 這些是否涵蓋真實斷電會產生的全部狀態 |
| 5 真實斷電 | **未執行** | — | **未宣稱**。需要實體機或 VM 硬斷電，或 dm-flakey／LazyFS 類的故障檔案系統 |

平台限制：macOS 的 `fsync(2)` 不保證磁碟清空寫入快取（需 `F_FULLFSYNC`，Node 沒有對應 API），所以在 macOS 上連原理上都不宣稱能撐過斷電。Linux（ext4／xfs）採 POSIX 建議的「檔案 fsync ＋ 目錄 fsync」順序，但本輪沒有實測斷電。不支援網路檔案系統。

安全性不依賴持久性：如果真實斷電讓集合檔案或其目錄項目遺失，而 Controller（由其自己的存放區另行同步）已是 PACKET_READY，那麼執行前檢查會回報 `ACTIVATION_SET_MISSING`，在 claim 前就拒絕。結果是不會送出，不會變成不安全的送出；代價是該工作轉為 BLOCKED，需要新的 Goal／Run。

## Fix 3：S2 簽章前像契約（設計規定，本輪未實作）

1. **獨立、版本化的 attestation**：簽章放在獨立紀錄 `chief-activation-attestation.v1`，與集合分開存放，**永遠不寫回集合**。集合內容（因此 setHash）永遠不包含任何簽章；v1 集合的 `attestations` 欄位永遠為空陣列，S2 不得填入。
2. **待簽 payload（前像）不含自身簽章**：待簽位元組 = 網域分隔字串 `CHIEF-ACTIVATION-ATTESTATION-V1\n` ＋ payload 的 canonical JSON。payload 只含下列欄位，不含簽章本身、其他 attestation、檔案路徑或名稱，也不含任何可變狀態：
   - `payloadSchema`、`policyVersion`（必須是要求 Human 簽章的政策，例如 `S2_HUMAN_SIGNED_V1`）
   - `setHash`、`runId`、`repository`、`contractHash`、`packetId`、`packetHash`、`implementationSha`、`workerCodeHash`
   - `operations`：授權操作的精確清單（`LIMITED_README_WORKER`、`LIVE_PROVIDER_MODEL_CALL`，排序固定）
   - `grants`：兩份 Human 授權各自的 `authorityId`、`version`、`recordHash`
   - `signerKeyId`（公鑰指紋）、`issuedAt`、`expiresAt`（不晚於任一授權到期，最長 1 小時）、`nonce`
3. **驗證端重算，不信任 attestation 自述**：驗證端從 Archive 重新推導應有集合與 setHash，再加上可信 Host 設定，重建 payload，以位元組完全相同的 canonical 形式比對；用可信 Host 設定中固定的公鑰（AI 工具不可寫）驗簽；檢查政策版本、時間窗與操作清單是否完全相等。
4. **不得自動升級**：`S1_UNSIGNED_V0` 的集合永久不具 Live 資格（測試：即使呼叫者聲稱 `signed: true`，結果仍不合格）。簽章政策是集合內容的一部分，換政策就是另一個集合（不同 setHash），必須重新發布、重新簽署；對 S1 setHash 的任何 attestation 一律拒絕。
5. **防重放**：attestation 綁定 setHash，而 setHash 綁定 Run、Contract 與三份成員的確切版本，另有時效與 nonce。任何成員被取代，setHash 就改變，舊簽章自動失效。
6. **金鑰**：由 Human 持有（passkey／硬體金鑰，或獨立 OS 帳號的簽署器），私鑰永遠不進入 AI 可達環境。演算法建議 Ed25519（Node 內建可驗證），由 S2 決定。
7. **撤銷**：屬 D2，另案設計；不以刪除 attestation 代替撤銷。

## 實際差異

| 檔案 | 修改 |
| --- | --- |
| `src/limited-worker/activation-set.ts` | Fix 1：`readSetFile` 檔案層檢查、`ACTIVATION_SET_FILE_UNSAFE`、目錄擁有者檢查；Fix 2：`ensureSetDirectory`（每層 fsync 父目錄）、發布順序、EEXIST 路徑 fsync、`fchmod(0600)` |
| `test-auto-p2-a4-s1.mjs` | 新增 7 項 S1-R1 測試；S1 兩處更新：符號連結的期望錯誤碼改為 FILE_UNSAFE；「power-loss」測試改名為「simulated power-loss residues (constructed states, not a real power cut)」 |
| `regressions/auto-p2-a4-p0-s1/mutate.py` | 新增 8 項注入錯誤（M11–M18） |
| `AUTO_P2_A4_P0_S1_ARCHITECT_REVIEW.md` | 開頭加註 R1 指引與「斷電」用語更正 |
| `regressions/auto-p2-a4-p0-s1-r1/` | R1 證據 |

## 驗證證據

本機 macOS（Darwin 25.6.0，Node 24.15.0，與 CI 相同版本）；原文見 `regressions/auto-p2-a4-p0-s1-r1/`。

| 項目 | 結果 |
| --- | --- |
| TypeScript `tsc --noEmit` | 0 錯誤 |
| S1＋R1 測試 `test-auto-p2-a4-s1.mjs` | 38／38（S1 31 項＋R1 7 項）；連續 3 次皆 38／0（每次約 57 秒） |
| 既有 A4 `test-auto-p2-a1.mjs` | 133／133 |
| 完整 `npm test` | 60 個套件、2,313 項通過、0 失敗（S1 為 2,306；新增 7 項） |
| 注入錯誤（`regressions/auto-p2-a4-p0-s1/mutate.py`） | 18／18 被抓到。S1 的 M1–M10 照舊；R1 新增 M11 不查檔案權限、M12 讀取可能被 FIFO 卡住、M13 允許目錄外硬連結、M14 允許同目錄任意別名、M15 不同步父目錄、M16 link 前不 fsync 暫存檔、M17 冪等路徑未同步即返回、M18 link 後不 fsync 集合目錄。M9 的錨點因本輪改寫該行而失效，第一次完整執行時沒有跑到；修正錨點後單獨重跑，結果為被抓到（兩段原文都保留） |

GitHub CI（Ubuntu `test`、macOS `r4t-macos` Seatbelt）須以本提交的 exact SHA 執行；結果記錄在提交後的回報與 HANDOFF，不寫回本檔，以避免自引用。

## 本輪發現、未修改（請 Architect 決定）

`WorkerStore` 讀取 lease 紀錄（`runtime.lock`）、ledger（`ledger.json`）與報告（`report.md`）時同樣只用 `O_RDONLY | O_NOFOLLOW`，沒有 `O_NONBLOCK`（`src/limited-worker/store.ts` 三處）。同帳號程序若在這些名稱放一個 FIFO，讀取會永久卡住，而不是 fail closed。這屬於 D1 的同帳號威脅類；修法與 Fix 1 相同（加 `O_NONBLOCK` ＋ 檔案型別檢查），改動只有幾行。本輪範圍限定於集合檔案，因此沒有修改。其他讀取點尚未全面盤點。

**STOP FOR GPT-6 ARCHITECT REVIEW。不得因本輪測試通過而解除 Live HOLD、核發 Authority 或啟動付費 Pilot。**
