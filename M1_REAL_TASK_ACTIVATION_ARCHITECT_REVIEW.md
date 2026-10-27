# CHIEF M1：真實任務啟用（First Authorized Live Automation）

## 結論

- **正式 Host 已完整接線，停在 EXE HOLD**：使用者在 CHIEF 介面輸入任務 → 看到任務、資料範圍、模型、預算上限與請求上限 → 用通行金鑰（Touch ID）批准這一個 Run → 可信 Host 驗證簽章、保存三份文件、發布 M1 簽章集合 → 受信 governed Worker 送出**一次** Messages API 請求 → 成果、usage、message id、request-id 回到同一張卡片。目前程式常數 `EXE = 'HOLD'`，所以批准與執行都在任何寫入、驗證或請求之前回 `EXE_HOLD`。
- **解除 HOLD 後的路徑已用「暫存副本」驗證**：測試把 `dist` 複製到暫存資料夾，只在副本把 `EXE` 改成 `LIVE_PILOT`，搭配本機假 TLS Provider 與軟體通行金鑰，從 HTTP 介面跑完整流程。repo 的原始碼與 dist 都維持 HOLD。
- **M1-A 結論：Claude Code CLI 無法證明請求上限**。以真實 `claude` 2.1.283（固定 SHA-256）對本機假 Provider 實測：最嚴格設定下 `--max-turns 3` 仍送出 4 次請求。因此首次 Live Pilot 只用單次 Messages API 的 README Worker；Claude Code 讀取器的 Live 路徑一律拒絕（`READER_REQUEST_BOUND_UNPROVEN`）。
- **沒有任何真實付費呼叫**：沒有讀取真實 API key、沒有呼叫帳戶或模型 API、沒有核發 Authority、沒有解除 EXE／H1–H9、沒有建立任何憑證。

日期：2026-10-27（Asia/Taipei）。Base `5986626a6e9968a5c2e4c77a0ed3e5ea66c9f3d6`；分支 `work/m1-real-task-activation`。

## M1-A：一致的請求、預算與重試約束

| Agent | 每次 governed invocation 的 Provider 請求 | 重試 | 證明 | Live |
| --- | --- | --- | --- | --- |
| README Worker | 1（原生 HTTPS POST，無 SDK、無重新導向、無工具迴圈） | 0 | 程式結構＋測試（假 Provider 計數＝1） | 可（需批准） |
| Claude Code 讀取器 | **無法證明**（輪數不等於請求數） | 環境變數設 0，但仍不足以界定上限 | 真實 CLI 實測（下表） | 拒絕 |

- `providerCallAuthorization.maxCalls` 計的是 governed invocation（Invocation Journal 的 start 次數），**不是** Provider 請求數；契約文件與程式註解已寫明。
- README Worker 的 packet 不變（仍為 `ONE_MODEL_REQUEST`，位元組相同）；讀取器的 packet 改為 `ONE_GOVERNED_INVOCATION`、`CLI_TURN_LIMIT_IS_NOT_A_REQUEST_LIMIT`、`NO_LIVE_PROVIDER_REQUEST_UNTIL_REQUEST_BOUND_PROVEN`，不再宣稱一次請求。
- `requestBound(c)`／`assertLiveRequestBound(c)`：Adapter 的每次檢查、讀取器 transport、Service 的計畫與 START 都用同一個判斷；Live 讀取器在預留之前就被拒絕。
- 讀取器環境（只用於離線演練）加上 `CLAUDE_CODE_MAX_RETRIES=0`、`CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1`、`CLAUDE_CODE_DISABLE_THINKING=1`、`MAX_THINKING_TOKENS=0`。

### 真實 CLI 非付費實測（`regressions/m1/cli-probe-result.json`）

真實執行檔 `/Users/Dawn/.local/share/claude/versions/2.1.283`（SHA-256 `d8cb1e5c79684cc12a8bfc813e3a2073406921b6245744b3009be3ab5651d21e`）在 Seatbelt 中執行：對外連線只允許 localhost、拒絕讀取鑰匙圈與 `~/.claude`、空的 HOME／CLAUDE_CONFIG_DIR、假金鑰；`ANTHROPIC_BASE_URL` 指向本機假 Messages API。沒有任何 Provider 可達。

| 情境 | 環境 | Messages 請求 | 說明 |
| --- | --- | --- | --- |
| 未知參數（校正） | — | 0 | `error: unknown option`，證明探測能分辨參數 |
| M0 參數，直接回答 | M0 | 1 | M0 全部參數被接受（含未列在說明中的 `--max-turns`） |
| 一次 529 | M0 | **2** | 自動重試 |
| 空的串流回應 | M0 | **2** | 自動改用非串流再送一次 |
| 一次 529／空串流／一直 500 | 嚴格 | 1 | 重試與後備已關閉 |
| 每次都要求工具 | 嚴格 | 3 | 工具迴圈停在 `--max-turns 3` |
| 每次都在 max_tokens 截斷 | 嚴格 | **4** | 自動續寫不受 `--max-turns` 限制 → 無請求上限 |

其他發現：`num_turns` 回報值＝實際請求數＋1（M0 的結果檢查會誤判合法執行）；M0 環境預設送出 `thinking: enabled`；CLI 啟動時會先送 `HEAD /api/hello`（非模型請求）；`--max-budget-usd` 與 `total_cost_usd` 都是客戶端依自身價格表計算，不是供應商端硬上限。

## M1-B：正式 Host 與單一 Run 授權

### 正式 Host（`src/limited-worker/main.ts`）

- 改用受信的 `createGovernedLimitedWorker`（經新的 `live-runtime.ts`），不再使用未受信的 `composeLimitedWorker`。
- Runtime lease 只在啟動恢復時持有（M0 的 gotcha：受信 Worker 每次執行自取 lease）。
- 新參數 `--approver-config <path>`：Human 的批准設定檔；**必須 root 擁有**、不可被群組／其他人寫入、不可是連結（live Host 只接受 uid 0）。移除舊的 `--permit-config`（手動貼授權副本的路徑）。
- README Worker：`nativeAnthropicTransport`，金鑰只從 Host 程序的 `CHIEF_LIMITED_ANTHROPIC_KEY` 讀取；Claude Code 讀取器：`unconfiguredLiveTransport('READER_REQUEST_BOUND_UNPROVEN')`。

### Human 授權來源：通行金鑰（WebAuthn ES256，需使用者驗證）

- 不接受瀏覽器送來的 principal 字串。Host 驗證：固定的 credential、`webauthn.get`、challenge 完全相等、origin 為 `http://localhost:<port>`、RP ID `localhost`、UP 與 **UV**（Touch ID／裝置密碼）旗標、以固定公鑰驗 ES256 簽章。
- **簽什麼**：Host 為這一個 Run 推導 payload（S1-R1 Fix 3 的 S2 前像欄位：`setHash`、`runId`、`contractHash`、`packetId`、`packetHash`、`implementationSha`、`workerCodeHash`、兩份授權的 `recordHash`、`signerKeyId`、`issuedAt`／`expiresAt`、`nonce`；另加 `classHash`、Agent、模型、`maxModelRequests 1`、`maxRetries 0`、批准的預留金額）。challenge ＝ SHA-256(`CHIEF-ACTIVATION-ATTESTATION-V1\n` ＋ canonical(payload))。`setHash` 在任何文件保存之前就由文件內容推導（`prospectiveActivationSet`），保存後由 Archive 重新推導，必須相等。
- **短期、單一 Run**：有效期最長 15 分鐘（設定預設 10 分鐘）、不超過價格證據期限；驗證成功後寫入獨佔的 0600 紀錄檔（`m1-approvals/<jobId>.json`）＝消耗，第二次使用回 `APPROVAL_ALREADY_USED`；同一簽章無法批准另一個 Run（challenge 不同）。
- **之後每次檢查都重驗**：Activation、執行前與送出前最後檢查都會讀回紀錄、重算 challenge、用固定公鑰重驗簽章並檢查時窗；紀錄被改寫、刪除、權限放寬或過期都在送出前拒絕。
- **Activation Set**：新增簽章政策 `M1_PASSKEY_RUN_V1`（`humanSignatureRequired: true`）；政策是集合內容，所以是不同的 setHash。簽章放在獨立紀錄，集合的 `attestations` 永遠為空。`S1_UNSIGNED_V0` 集合永遠不具 Live 資格（即使呼叫者宣稱已簽）。
- **一次性登記**：`npm run workspace:m1-passkey-enroll -- --out <abs> --human <principalRef>` 開一個 localhost 頁面，Human 用 Touch ID 建立通行金鑰；工具驗證註冊（UV、credential 自己的 COSE 金鑰＝回報的公鑰），寫出**草稿**。草稿中的 Architect 接受欄位是佔位字串，驗證必定失敗，直到 Human 填入並把檔案改成 root 擁有。

### 審查重點 R-1：以「Architect 接受的類別」取代每個 Run 的 Architect packet

- 為符合 M1-D（不在多個聊天視窗之間搬運），每個 Run 的 IMPLEMENTATION_PACKET 不再由 Architect 逐次核發，而是：Architect **一次**接受 README Worker 類別（`workerClass(c)`：除了每個 Run 不同的欄位以外的整份契約、價格欄位、請求上限、packet 範本）與確切程式 SHA；Human 把 `classHash`、`implementationSha`、`architectPrincipalRef`、`reviewRef` 寫入 root 擁有的批准設定檔。
- Host 只在類別雜湊、程式 SHA、principal 全部相符時，依 `packetFor` 推導該 Run 的 packet 文件（issuer 仍是設定中的 GPT_ARCHITECT principal），並且只在通行金鑰驗證成功**之後**保存。Human 的簽章涵蓋 `classHash` 與三份文件的確切雜湊。
- 這是治理規則的改變：**請 Architect 明確接受或否決**。否決時的替代方案：首次 Pilot 由 Architect 逐次核發 packet（需要一次人工轉貼）。
- 目前 README Worker 類別雜湊（固定 README `a3164fd…`、5,568 bytes）：`13aa694095a1c17535a6b60ad2b6d8e37ce8a57ca29d880be8527dda80153542`。

## M1-C：Claude 執行器

- 模型固定 `claude-haiku-4-5-20251001`；回應的 `model` 必須完全相等（schema literal），usage 不得有 cache token。
- 送出前 preflight（既有）：抓官方價格頁並比對快照雜湊、`GET /v1/models/{model}` 確認帳戶可用與模型 metadata；兩者都只在 Live 執行時、批准之後才發生（本輪未執行）。
- 新增保存 Provider 的 `request-id` 回應標頭（`providerRequestId`）與 message id，作為事後對帳證據。
- 費用：依 usage × 公開價格計算（`USAGE_TIMES_PUBLISHED_PRICE_NOT_PROVIDER_INVOICE`），不是帳單；預留 210,240 µUSD 完成後不退回。供應商端硬上限只有 Anthropic Console 的支出上限（Human 設定，H9）。
- 零自動重試、隔離報告、唯讀來源、輸出檢查維持不變；金鑰只存在 Host 程序環境，測試確認所有資料檔都不含金鑰字串。
- CLI 版本與 SHA-256 已固定並記錄；但 CLI 不在首次 Pilot 範圍。

## M1-D：使用體驗與持久性

- 同一張工作卡片：任務 → 「批准前請確認」（任務、模型、唯讀資料範圍、預算上限與累積上限、請求上限、時間上限、連線對象、費用證據性質）→ 勾選確認 → 「以通行金鑰（Touch ID）批准並執行」→ 結果、usage、費用、message id／request-id。
- 正式 Host 上 Claude Code 選項標示「僅離線演練」並停用；預設 README Worker。非 `localhost` 開啟時提示改用 `http://localhost:<port>`。
- 持久化：所有狀態在 ledger、Journal、Archive 與批准紀錄；重新整理只是重讀。測試：瀏覽器在請求進行中斷線，Host 仍完成且只送 1 次；重啟 Host 後狀態相同、不重送。
- **未完成能力**：沒有背景工作佇列；執行在同一個 Host 程序的 HTTP 請求中進行（斷線不影響）。Host 程序在送出後當機 → 該工作成為 `UNCERTAIN`，不重送、需人工核對（既有設計）。

## 驗證證據（本機 macOS，Node 24.15.0；原文見 `regressions/m1/`）

| 項目 | 結果 |
| --- | --- |
| TypeScript `tsc --noEmit` | 0 錯誤 |
| `test-m1-real-task-activation.mjs` | 16／16（新套件，已加入 `npm test`） |
| `test-m0-first-automation.mjs` | 10／10（4 處斷言隨 M1 更新，見下） |
| `test-auto-p2-a4-s1.mjs` | 54／54 |
| 完整 `npm test` | 62 個套件（新增 1 個）、2,355 項通過、0 失敗、0 SKIP（M0 為 61／2,339） |
| 真實 CLI 探測 | 16 個情境，見上表；0 次真實 Provider 連線 |
| 瀏覽器 | HOLD 版：批准前資訊完整、按鈕 LOCKED、Claude Code 標示僅離線演練；解除 HOLD 副本：顯示通行金鑰指紋與接受狀態，勾選後按鈕可用（未實際按下，避免觸發 Touch ID） |

主要測試內容：通行金鑰 8 種錯誤斷言各自被拒；註冊驗證（UV、COSE 金鑰比對、演算法）；批准設定檔（非 root、群組可寫、連結、私鑰、P-384、佔位字串、時窗過長、非 localhost origin）；payload 網域分隔與欄位限制；S1 集合永不合格；批准紀錄只能寫一次且被改寫／權限放寬／刪除／過期都拒絕；HOLD 版 HTTP 全流程零寫入；解除 HOLD 副本的完整流程（1 次請求、固定請求內容、三份文件、M1 集合、紀錄 0600、金鑰不落檔、重放與重送被拒、重啟一致）；7 種竄改與過期零保存零請求；斷線；類別未接受。

## 守門測試與既有測試調整（請審查）

1. `test-governed-execution-driver.mjs`：`governed-execution.js` 使用者白名單加入 `src/limited-worker/live-runtime.ts`（與 M0 加入 `rehearsal.ts` 同類）。
2. `test-m0-first-automation.mjs`：正式 Host 讀取器理由碼改為 `READER_REQUEST_BOUND_UNPROVEN`；`execution` 多 `approvalMethod`；Agent 選單 README Worker 在前；LOCKED 按鈕文字。
3. 未改：`activation-set.ts` 對 authority 模組的匯入行（record hash 由呼叫端計算），兩條 authority 匯入守門測試維持原樣。

## 未證明事項（分層）

- **真實 Provider**：沒有真實請求；帳戶可用性、真實 `request-id` 格式、真實 usage 與帳單是否一致都未實測。
- **真實通行金鑰**：WebAuthn 驗證以軟體 P-256 金鑰測試；真實 Touch ID／iCloud 鑰匙圈在 Chrome／Safari 的 `localhost` 行為未實測（登記與批准都需要 Human 操作）。
- **同帳號威脅**：root 擁有的設定檔防止同帳號程序改寫公鑰；但同帳號程序若能自己起一個 Host、自備 root 檔案並取得 Human 的 API 金鑰，仍超出同帳號檢查能力（D1：獨立簽署帳號）。撤銷（D2）未實作。
- **持久性**：沿用 S1 的 fsync 順序；斷電未實測。
- **CLI**：只測了 16 個情境；其他可能增加請求的路徑（例如自動壓縮）未窮舉，因此維持「無上限」結論。

## 完整阻擋清單（首次真實 Pilot 前）

1. Architect 審查 M1 與 R-1（類別接受取代每 Run packet），並接受確切 SHA。
2. EXE／H1–H9：Human 與 Architect 決定是否解除。解除需要一個經 Architect 接受的提交（一行，見 Pilot Packet）以及隨之更新的 HOLD 測試。
3. Human 一次性登記通行金鑰、填入接受欄位、把批准設定檔改成 root 擁有。
4. Human 在 Anthropic Console 設定支出上限（H9），並只在正式 Host 環境提供 `CHIEF_LIMITED_ANTHROPIC_KEY`。
5. 正式 Host 設定檔（Workspace＋execution status）與乾淨、確切 SHA 的 checkout。
6. Human 在對話中明確授權 Live Pilot 後，才可執行唯一一次真實呼叫。

未核發的 Real Pilot Packet 在 repo 外：`~/Documents/CHIEF-UI1/ws/outputs/m1/REAL_PILOT_PACKET_M1.md`。

**STOP FOR GPT-6 ARCHITECT REVIEW。**
