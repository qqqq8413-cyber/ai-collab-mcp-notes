# CHIEF M1-R1：Architect Authority 來源修正與首次 Live Pilot 準備

## 結論

- **R-1 已修正**：「Architect 接受的固定 Worker 類別」、「Host 依該類別衍生的單一 Run Packet」、「Architect 直接核發的 Authority」現在是三種不同的紀錄，治理驗證的每一個檢查點都能分辨。Host 自行衍生的 Packet 在 Authority Archive 裡標示為 `CLASS_DERIVED_AUTHORITY`，並記錄它是依哪一份 Architect 接受紀錄（雜湊、類別、程式版本）衍生；沒有明確的 class-delegation 規則時，任何檢查點都拒絕它。設定檔裡有 `architectPrincipalRef`，已不再足以讓衍生 Packet 被當成 Architect 親自核發。
- **常設類別接受機制保留**：每個 Run 仍不需人工轉貼 Packet。Architect 的接受紀錄現在有可核對的來源（審查識別＋決定原文的 SHA-256）與版本鏈（`acceptanceVersion`／`supersedes`），由 Human 釘在 root 擁有的批准設定檔；Human 每次用通行金鑰批准時，簽章同時涵蓋這份接受紀錄的雜湊與衍生 Packet 紀錄的雜湊。
- **首次 Live Pilot 候選已就緒，但仍停在 EXE HOLD**：只用 `limited-readme-worker`、一次 Messages API 請求、零重試、300 秒、2,048 output tokens、US$1 累積上限、README 唯讀、不寫 Git、不部署、不用 Claude Code CLI。已新增「正式啟用後仍只能執行已明確批准之 Run」的測試。
- **沒有任何真實付費呼叫**：沒有讀取真實 API key、沒有呼叫帳戶或模型 API、沒有核發 Authority、沒有解除 EXE／H1–H9、沒有建立任何憑證、沒有修改 main。

日期：2026-10-27（Asia/Taipei）。Base `a436caf6eaa46f77cd141ecf5de86d1387110cf0`；分支 `work/m1-real-task-activation`（fast-forward，未 rebase）。

## 1. R-1：三種紀錄，永不混用

| | 誰決定 | 存放位置 | 治理效力 |
| --- | --- | --- | --- |
| **ARCHITECT_CLASS_ACCEPTANCE**（常設類別接受） | Architect 的審查決定；Human 抄入 | root 擁有的批准設定檔 `architectAcceptance` | 不是 Run 授權；只定義「哪一個類別、哪一個程式版本」可被衍生 |
| **CLASS_DERIVED_AUTHORITY**（衍生 Run Packet） | 可信 Host 依 `packetFor` 機械衍生 | Authority Archive（與直接授權同一個 archive，不同紀錄類別） | 只有通過明確的 class-delegation 規則才被接受 |
| **DIRECT_AUTHORITY**（直接授權） | Architect 或 Human 直接核發 | Authority Archive | 與 M1 前完全相同（紀錄位元組與雜湊不變） |

### 1.1 常設接受紀錄的來源與版本綁定（`src/limited-worker/run-approval.ts`）

```json
{ "schema": "chief-architect-class-acceptance.v1", "recordClass": "ARCHITECT_CLASS_ACCEPTANCE",
  "delegationRule": "ARCHITECT_CLASS_DELEGATION_V1", "architectPrincipalRef": "<Architect principal>",
  "agentId": "limited-readme-worker", "classSchema": "chief-limited-worker-class.v1",
  "classHash": "<類別雜湊>", "implementationSha": "<Architect 接受的確切 SHA>",
  "acceptanceVersion": 1, "supersedes": null,
  "source": { "kind": "ARCHITECT_REVIEW_DECISION", "reviewRef": "<審查識別>", "decisionSha256": "<決定原文 SHA-256>" },
  "acceptedAt": "<ISO 時間>" }
```

- `acceptanceHash` ＝ SHA-256(`CHIEF-ARCHITECT-CLASS-ACCEPTANCE-V1\n` ＋ canonical(紀錄))，網域分隔；任何欄位（來源、審查識別、版本、SHA、類別、principal、時間）改變都會改變雜湊。
- 版本鏈：第 1 版 `supersedes` 必須為 `null`；第 N 版（N＞1）必須指名被取代版本的雜湊。違反時回 `CLASS_ACCEPTANCE_INVALID`。
- `classSchema`、`delegationRule`、`agentId` 都是固定值；其他值（例如 `…class.v2`、Claude Code 讀取器）一律無效。

### 1.2 衍生紀錄（`src/automation/authority/document.ts`）

- 文件信封新增紀錄類別 `CLASS_DERIVED_AUTHORITY` 與 `derivation`：`{ rule: ARCHITECT_CLASS_DELEGATION_V1, derivedBy: CHIEF_TRUSTED_HOST, acceptanceHash, classHash, implementationSha }`。
- 規則：有 `derivation` ⇔ 衍生類別；只有**第 1 版的 IMPLEMENTATION_PACKET** 可以是衍生的（授權、更正 Packet、接受決定都不行），所以衍生紀錄不能取代直接授權，也不能被當作直接授權的後續版本。
- `issuer` 仍是 `{ GPT_ARCHITECT, <接受該類別的 principal> }`，意思是「委託者」，不是「作者」；紀錄類別已明示這份文件不是 Architect 親自核發。
- 直接授權紀錄不含 `derivation` 欄位，位元組與雜湊和 R-1 之前完全相同（測試確認）。把衍生紀錄的類別改成 DIRECT 或改動 `derivation`，Archive 讀取時就是完整性錯誤。

### 1.3 明確的 class-delegation 規則（`classDelegationVerifier`）

只有同時符合以下全部條件，衍生 Packet 才被接受：
1. 版本 1；issuer 角色為 `GPT_ARCHITECT`，principal 等於**接受紀錄**中的 Architect principal（不是 Host 設定字串單獨決定）；
2. `derivation.acceptanceHash` 等於 root 擁有設定檔中釘住的接受紀錄雜湊（來源或版本被替換就不符）；
3. Packet 必須逐字等於 `packetFor(它自己的契約)`（`contractOf` 會拒絕任何不是逐字衍生的 Packet）；
4. 契約的 Agent、類別雜湊、程式 SHA 都等於接受紀錄；`derivation` 內的類別與 SHA 也必須相同；
5. 請求上限已證明（README Worker：1 次、0 重試）。

### 1.4 每個治理檢查點都分辨衍生與直接

| 檢查點 | 衍生 Packet 沒有規則時 | 規則拒絕時 |
| --- | --- | --- |
| Activation core（`activation-core.ts`，Controller 寫入前） | `AUTHORITY_DERIVED_WITHOUT_DELEGATION`，零寫入 | `AUTHORITY_DELEGATION_INVALID`（附規則代碼），零寫入 |
| Limited Worker staging（`limitedActivationCandidate.stage`，保存前） | `ACTIVATION_PACKET_DERIVED_WITHOUT_DELEGATION`，零保存 | 規則代碼，零保存 |
| `verifyPermit`（每次 Worker 檢查，包括送出前最後檢查） | `PACKET_AUTHORITY_DERIVED_WITHOUT_DELEGATION` | 規則代碼 |
| 通行金鑰紀錄重驗（`attestationVerifier`） | — | 接受紀錄雜湊不符 → `ATTESTATION_BINDING_MISMATCH` |
| Read model／Workspace 狀態 | 事實帶 `recordClass` 與 `derivation`；狀態卡片標示「Host 依 Architect 接受的類別衍生，非 Architect 逐次核發」 | — |

- 只有可信的 limited Host（`live-runtime.ts`，從同一份 root 擁有的接受紀錄建立規則）會傳入規則；通用的 governed live composition 從不傳入，因此一律拒絕衍生 Packet。
- **沒有藉由修改 issuer 字串繞過檢查**：原有的 issuer 角色與 principal 檢查一行未放寬；衍生紀錄必須先通過原有檢查，再額外通過 delegation 規則。
- 通行金鑰 payload 新增 `packetRecordClass`（固定 `CLASS_DERIVED_AUTHORITY`）、`packetRecordHash`、`acceptanceHash`：Human 的簽章直接涵蓋衍生紀錄本身與它依據的接受紀錄。

### 1.5 刻意未改（請 Architect 知悉）

1. **Controller 稽核詞彙**：`ISSUE_PACKET` 仍以 `GPT_ARCHITECT` 角色與設定的 principal 記錄（lifecycle 規定只有該角色能發 Packet）。該 Run 的 `activePacket` 解析到的 Archive 紀錄會標示衍生類別，所以可分辨；但若要 Controller 稽核本身也出現「委託」字樣，需要改 lifecycle，超出最小範圍。
2. **M0 離線演練 Host**（`rehearsal.ts`）：仍以合成 principal 寫 DIRECT 文件；它只用 OFFLINE_SYNTHETIC 傳輸，永遠不具 Live 資格。若 Architect 要求一致，可在後續改為衍生紀錄。
3. 類別雜湊不變：`13aa694095a1c17535a6b60ad2b6d8e37ce8a57ca29d880be8527dda80153542`（R-1 只改紀錄的來源標示，不改類別內容）。

## 2. 首次 Live Pilot 候選

| 項目 | 值（由類別雜湊固定；任何其他值都不是合法契約） |
| --- | --- |
| Agent | `limited-readme-worker`（Claude Code 讀取器的 Live 路徑仍拒絕：`READER_REQUEST_BOUND_UNPROVEN`） |
| 請求 | 1 次 `POST /v1/messages`，0 重試（原生 HTTPS，無 SDK、無重新導向、無工具迴圈） |
| 時間／輸出 | 300 秒；2,048 output tokens |
| 費用 | 最壞預留 US$0.210240；累積上限 US$1；預留不退回 |
| 資料 | 只讀 `README.md` @ `a3164fd…`（5,568 bytes） |
| 禁止 | ALL_SOURCE_WRITES、GIT_WRITE、PUSH、DEPLOY、AUTHORITY_WRITE、SHELL、OTHER_AGENTS |

新增：
- **正式啟用後只能執行已批准的 Run**（EXE 解除的暫存副本、HTTP）：Run A 批准後完成；Run B 未申請批准、沒有通行金鑰、重放 A 的簽章、把 A 的批准紀錄複製成 B 的名字、直接呼叫 runtime，全部拒絕；Run C 被同帳號寫入者事先放入「正確衍生」的 Packet 與兩份授權，仍然不能執行（沒有已消耗的批准紀錄）。全程只有 1 次 Messages 請求。
- **EXE HOLD 自我強制**：`live-runtime.ts` 的 `requestApproval` 與 `execute` 在任何讀取批准、寫入或驗證之前自行回 `EXE_HOLD`（不只靠 Service）。真實 build 上以有效候選（類別與 SHA 已接受、公鑰已釘）並在環境變數設 `EXE`／`CHIEF_EXE`／`CHIEF_LIMITED_EXE=LIVE_PILOT`，直接呼叫 runtime 仍回 `EXE_HOLD`，零寫入、零請求。
- **一般 Agent 無法自行解除 HOLD**（靜態測試）：`EXE` 只在 `contract.ts` 宣告一次且為 `'HOLD'`；沒有其他指派；原始碼不含 `LIVE_PILOT`；limited worker 只讀一個環境變數（Host 的 API key）；正式 Host 只接受 4 個參數；HTTP 動作只有 `CHECK／START／CANCEL／RECONCILE／REQUEST_APPROVAL`。解除只能透過一個經 Architect 接受的提交，而該提交會讓「repo build 保持 HOLD」的測試失敗，必須一併更新。
- **正式與假 Provider 清楚區分**：每個 Live 工作記錄 `providerEndpoint`（`ANTHROPIC_PUBLIC_API` 或 `INJECTED_TEST_REQUESTER`），由傳輸層自己決定（只有測試注入 requester 才會到假 Provider；URL 白名單只允許 `api.anthropic.com` 與官方價格頁）。假 Provider 的模型 metadata 標為 `TEST_REQUESTER_NOT_ACCOUNT`，不算帳戶驗證；卡片顯示「測試用假 Provider（注入的請求器，不是真實供應商）」。正式 Host（`main.ts`）不傳 requester（靜態測試）。

Pilot Packet 已依新 SHA 重新產生（repo 外，未核發）：`~/Documents/CHIEF-UI1/ws/outputs/m1-r1/REAL_PILOT_PACKET_M1_R1.md`。

## 3. 驗證證據（本機 macOS，Node 24.15.0；原文見 `regressions/m1-r1/`）

| 項目 | 結果 |
| --- | --- |
| TypeScript `tsc --noEmit` | 0 錯誤 |
| `test-m1-r1-provenance.mjs`（新套件，已加入 `npm test`） | 11／11：紀錄類別、接受紀錄雜湊與版本鏈、delegation 規則（issuer／來源／版本／類別／SHA／Packet 替換）、治理驗證、WebAuthn 偽造、WebAuthn 重放、Pilot 範圍、EXE HOLD 靜態檢查、HOLD 下直接呼叫、只執行已批准 Run、接受紀錄替換 |
| `test-m1-real-task-activation.mjs` | 16／16（完整流程新增衍生紀錄、payload 綁定與假 Provider 標示的斷言） |
| `test-governed-activation.mjs` | 47／47（新增 R-1：無規則拒絕、規則拒絕零寫入、規則接受後仍標示衍生、直接 Packet 不需規則） |
| `test-auto-p2-a4-s1.mjs` | 55／55（新增 S1-M1R1：staging 在保存前拒絕） |
| `test-goal-execution-status.mjs` | 16／16（新增：狀態視圖把衍生 Packet 標為 `CLASS_DERIVED_AUTHORITY`） |
| `test-m0-first-automation.mjs` | 10／10（未改） |
| 完整 `npm test` | 63 個套件（新增 1 個）、2,369 項通過、0 失敗、0 SKIP（M1 為 62／2,355） |
| 假 Provider 單次請求 | 完整流程：Messages 1 次、模型 metadata 1 次、價格頁 1 次、其他 0；`only-approved` 情境三個 Run 合計 Messages 仍只有 1 次 |
| 真實 Provider／付費呼叫 | 0 次；沒有讀取真實 API key |

### Mutation（`regressions/m1/mutate-r1.py`，錨點為編譯後 JS）

| 編號 | 拿掉的防線 | 結果 |
| --- | --- | --- |
| MR1 | Activation core 不需規則就接受衍生 Packet | 抓到 |
| MR2–MR3 | 衍生紀錄可不帶 derivation；授權或第 2 版也可衍生 | 抓到 |
| MR4–MR6 | 驗證層放行無規則的衍生紀錄；staging／verifyPermit 跳過來源檢查 | 抓到 |
| MR7 | Run Packet 被寫成直接授權 | 抓到 |
| MR8–MR12 | 規則不檢查 issuer／版本、接受紀錄、類別、SHA、Packet 是否逐字衍生 | 抓到 |
| MR13–MR14 | 接受紀錄雜湊沒有網域分隔；版本鏈不強制 | 抓到 |
| MR15–MR16 | 批准紀錄重驗不比對接受紀錄；複製到別的 Job 名下的紀錄被接受 | 抓到 |
| MR17 | 批准綁定不比對 payload 的 `packetRecordClass／packetRecordHash／acceptanceHash` | **未抓到（重複防線）**：payload 的 `setHash` 已涵蓋衍生紀錄的 recordHash，而 recordHash 涵蓋 derivation 與接受紀錄雜湊；拿掉這三個欄位的比對後，替換仍被 `setHash` 擋下（`APPROVAL_BINDING_MISMATCH`） |
| MR18 | Runtime 不自行強制 EXE HOLD | 抓到 |
| MR19–MR20 | 假 Provider 被標成正式 API；假 Provider 的 metadata 算成帳戶驗證 | 抓到 |
| MR21 | 狀態視圖把衍生 Packet 標成直接授權 | 抓到 |

合計 21 項：20 項被抓到，1 項為已說明的重複防線。原始輸出：`regressions/m1-r1/mutation-output.txt`。另外，原本規則中「Packet 必須等於 packetFor」的明確比對經 mutation 證明與 `contractOf` 的檢查重複，已刪除，改以 MR12 驗證 `contractOf` 那一層。

## 4. 守門測試與既有測試調整（請審查）

1. `test-automation-authority-archive.mjs`「archive 不接到執行介面」守門：**白名單未改**。R-1 新符號（`CLASS_DELEGATION_RULE`、`isAuthorityPrincipalRef`、兩個型別）由 `governance.ts`（已在白名單）轉出口；`adapter.ts`、`composition.ts`、`run-approval.ts`、`passkey-enroll-main.ts` 只從 `governance.ts` 取得，不直接引用 authority 文件模組。
2. `test-m1-real-task-activation.mjs`：fixture 改用新的接受紀錄格式與 payload 欄位；完整流程斷言新增「Packet 為衍生紀錄、payload 綁定接受紀錄、假 Provider 標示」。
3. `test-governed-activation.mjs`、`test-auto-p2-a4-s1.mjs`、`test-goal-execution-status.mjs`：測試世界新增可選的 `classDelegation`／`derivation` 參數，並各加一個 R-1 測試。
4. `regressions/m1/lifted-host.mjs`：新增 `only-approved`、`substitution` 情境與 HOLD 下直接呼叫 runtime；`package.json` 的 `npm test` 加入 `test-m1-r1-provenance.mjs`。
5. 介面文字：啟用前步驟與卡片說明改為「Architect 類別接受紀錄」與「Packet 由 Host 衍生」；沒有使用 "activation" 字樣。

## 5. 未證明事項（分層）

- **真實 Provider**：沒有真實請求；帳戶可用性、真實 `request-id` 格式、usage 與帳單是否一致都未實測。
- **真實通行金鑰**：仍以軟體 P-256 金鑰測試；Touch ID／iCloud 鑰匙圈在 Chrome／Safari `localhost` 的行為未實測。
- **Architect 身分**：接受紀錄的來源是「Human 抄入的審查識別＋決定原文雜湊」，不是 Architect 的密碼學簽章；它防止替換與版本混用，但不證明那段文字出自 GPT-6。
- **同帳號威脅**：root 擁有的設定檔防止同帳號程序改寫公鑰與接受紀錄；但同帳號程序若自起 Host、自備 root 檔案並取得 Human 的 API 金鑰，仍超出同帳號檢查能力（D1）；撤銷（D2）未實作。
- **持久性**：沿用 S1 的 fsync 順序；斷電未實測。
- **Controller 稽核**：見 1.5 第 1 點。

## 6. Human 首次啟用所需操作（摘要；完整版見 Pilot Packet）

1. GPT-6 接受本 SHA 與 R-1 設計。
2. GPT-6 另行核准「解除 EXE」提交（只改 `contract.ts` 一行＋更新斷言 HOLD 的測試）；該提交的確切 SHA 才是接受紀錄的 `implementationSha`。Agent 不會自行提交或推送。
3. Human 把 GPT-6 的接受決定原文存成檔案，計算 `shasum -a 256`。
4. Human 登記通行金鑰（`npm run workspace:m1-passkey-enroll …`），在草稿填入接受紀錄，`sudo chown root:wheel` 並 `chmod 644`。
5. Human 在 Anthropic Console 設定支出上限（H9，建議 ≤ US$1），API key 只放在啟動正式 Host 的終端機。
6. 在乾淨、確切 SHA 的 checkout 啟動正式 Host，透過 `http://localhost:4876/` 建立 README 任務，核對卡片後以 Touch ID 批准一次。
7. 保存證據；Pilot 後以一個提交恢復 `HOLD`。

**STOP FOR GPT-6 ARCHITECT REVIEW。**
