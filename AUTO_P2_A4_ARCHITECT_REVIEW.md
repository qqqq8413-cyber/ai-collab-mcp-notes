# AUTO-P2-A4：可信 Host 接線候選

日期：2026-10-25 Asia/Taipei。Base：`aa44f36e02cd726724cf14f77818ce25ecef64e1`。
分支：`work/auto-p2-a4-governed-host-readiness`。工程候選，**EXE／H1–H9 HOLD，真實 Pilot 未驗收**。

## 實際完成的路徑

`createGovernedLimitedWorker` 位於既有可信 `automation/live/governed-execution` 邊界，將 Limited Worker 的同一個私有 Controller 傳入既有 AP1。Host 接受外部已核發的 Architect Implementation Packet，以及兩份獨立 Human grants：`LIVE_PROVIDER_MODEL_CALL`、`LIMITED_README_WORKER`。Host 不建立、不簽署 Authority，只能驗證並透過既有唯一 preserver 保存。

先驗證三份完整文件，再保存至 Authority Archive、重新讀取、經 AP1 進入 `PACKET_READY`；Driver 才能透過原 Controller occurrence／Invocation Journal 推進 Worker。核對 Goal、Run、exact implementation SHA、worker code hash、storage identity、source SHA/hash、packet、contract、provider/model、工具／egress、issuer principal、有效期及當前 Authority version。普通 Workspace composition 未注入可信保存能力；其 `activateIssued` 拒絕。Workspace 沒有核發、匯入授權或解除 HOLD 的 HTTP 路由。

這不是新增簽章系統。既有 principal reference 是可信上游程序聲明，不能把任意 JSON 的 issuer 字串視為已完成來源身分驗證。接線只有可信 Host 的程式能力，**沒有接到產品 CLI／Workspace／scheduler，也沒有開放真實模型執行**。未來仍需審查正式 Host 如何接收可信上游文件與保護本機檔案權限，不能直接將輸入端暴露給 Workspace。

三份文件保存不是跨檔案原子交易：若合法文件保存途中崩潰，可能留下部分有效 Archive 紀錄，Controller 尚未啟動；後續只能核對／冪等補齊，不能刪除或把不完整保存視為可執行。Host 的 activation／execute 使用同一 WorkerStore 排他 lease；cancel 不需取得該 lease，仍可中止在途工作。Host 進入時先恢復舊 RUNNING 為 UNCERTAIN，保留原預算，不重送。

## Provider Preflight 與資源界線

新增同一套純驗證器給 native transport 與 OFFLINE_SYNTHETIC transport：固定 Anthropic `claude-haiku-4-5-20251001`／API `2023-06-01`；model metadata 必須 exact id、type=model、active、200000 context、足夠 output capacity、可停用 thinking。缺少／未知／不符欄位都拒絕。**這些 metadata 語意以 mock 驗證，尚未驗證實際帳戶回應 schema；正式回應若不符會拒絕，不能聲稱帳戶相容。**

公開官方價格文件以模型／標準 input $1/MTok、output $5/MTok、context 200K、active legacy 解析，hash 與 quote 完整綁定，最長一小時。文件變動或價格不符需重新 review／建立契約，不猜價格。新 preflight fact 加入完整 request hash 與 contract hash；LIVE_PROVIDER 必須具備兩者，舊 ledger 可讀但不新增預設欄位改 checksum。

A3 政策不變：完整 README ≤16384 UTF-8 bytes，Goal ≤2000 UTF-16 units，完整 JSON body ≤131072 bytes，不截斷／偷偷正規化；tokens 不是精確硬保證。output max_tokens=2048；200000 是費用預留基礎，不是恢復舊4096規格。單次與同 store 累積 USD1，最壞預留210240 microUSD（USD0.210240），成功與不確定結果都不自動退還；一次生成、零retry／fallback、300秒或更早 grant／quote 到期。來源 Git blob 唯讀、隔離 report，無 shell／Git寫入／其他Agent。

公開文件讀取只有 PUBLIC_DOCUMENT_READ_ONLY 證據；不證明帳戶可用、API相容、發票總額或模型輸出。帳戶 API／付費生成／真實 key 讀取／正式 Authority 核發均0。原本 localhost preview 的金鑰 callback 保留但 native HOLD 在它之前拒絕，沒有讀取憑證。

## 一次性送出與 TOCTOU

先持久化預算與 generation claim，才可進入 transport。新的同步 guard 再讀 code／source／Goal／Archive 當前 versions／期限／Controller occurrence／Journal STARTED／相符 invocation／RUNNING claim／預留與取消／deadline。native HTTPS 在建立 request 前檢查一次，等 socket secureConnect 後、`write`／`end` 前再檢查；最後檢查與 write callback 間沒有 await，非同步 guard 被拒絕。mock socket 測試驗證建立連線時尚未寫 request、撤銷後0 write、合法時1 write。

**剩餘競態邊界：不能聲稱跨程序撤銷與網路送出是原子交易。** 另一可信程序仍可能在最後一次檔案讀取後／write 後變更 Authority；此時無法收回已送資料。這次縮短並測試 async handoff 的缺口，不證明零 TOCTOU。既有可信檔案與上游程序仍屬 trust boundary，正式啟用須由 Architect 接受此界線或另案要求跨程序調停。mock socket 不是實際 TLS／帳戶／生成驗收。

claim 後即使最後 guard 拒絕、尚未送任何 byte，也保守標記 UNCERTAIN、保留預留、不自動重送；網路中斷、取消、逾時／崩潰同理。完成需 report hash、Journal APPLIED、Controller IMPLEMENTATION_COMPLETE 相符；不能單靠 report 字串宣布完成。

## 驗收與證據

- 新增40項 A4 測試，專項133項通過；保留A3原2235項，完整測試／macOS Seatbelt與候選GitHub CI見 `regressions/auto-p2-a4/` 及提交後本機 `outputs/auto-p2-a4/CLOSURE.json`，不得以base CI替代。
- 首次完整回歸在既有driver capability測試失敗：可信Host模組原只允許 `createGovernedLiveAutomation` 一個匯出，A4新增 `createGovernedLimitedWorker` 後名單過時。保留原driver只暴露inspect／step等斷言，僅將可信模組的精確名單擴為這兩個factory；不放寬任意exports。首次失敗與後續完整重跑均保存，不刪失敗證據。
- OFFLINE_SYNTHETIC E2E：外部合成3文件→可信保存→AP1 PACKET_READY→Controller／Driver／Worker→1次合成回覆→Journal APPLIED／report hash一致。不是正式 Authority 或真實模型結果。
- 測試篡改SHA／Run／packet／provider／model／scope／有效期／principal／recordClass，過期／被取代／重播、unknown metadata／price／resource失敗，claim後撤銷及source／Goal／code／expiry／claim／cancel改變，網路中斷、排他lease與重啟預留。
- 獨立4879預覽桌面1440／768與手機390／320；建立工作只輸入目標、系統產生內部識別、進階證據預設收合、START LOCKED及後端403、偽造scope400、帳戶未驗證／Host待審查清楚顯示。提交後新契約綁新exact SHA，另驗自身重啟保留Goal／Run／預算／證據且0 invocation。
- 4873–4878本輪起始皆ECONNREFUSED；未啟動／停止／替換。前後比較設定、ledger、worktree與連線狀態，不冒稱舊服務完整功能回歸。沒有改main／Ruleset／憑證／全域Agent設定。

## 首次付費 Pilot 的精確剩餘條件

1. Architect 審查接受本候選，包含 stated principal、部分Archive保存及跨程序TOCTOU界線；審查後的正式Host部署／輸入認證與接線。
2. 另案 Human 對最終執行版本的 EXE／H1–H9 限定決策。本輪不改任何 HOLD 常數；改執行碼會改SHA，必須重新建立全部契約，不能沿用本輪Packet。
3. 另案授權可信Host管理專用憑證，查驗真實帳戶 exact model／pinned API／metadata與fresh官方價格。價格過期或schema未知須拒絕；不向Human索取明文key。
4. 系統自動建立最終exact Goal／Run／packet／contract，由可信上游正式核發Architect文件與兩筆獨立Human grants，綁定本次scope／期限／成本，保存Archive後才由Controller核對。
5. Human另次批准單次付費Pilot；完成真實usage／report／Journal一致性與人工品質驗收。離線結果不能替代這一步。

**目前尚不具備可直接按下執行的正式付費能力。工程接線候選完成，不等於執行授權。STOP FOR ARCHITECT REVIEW。**
