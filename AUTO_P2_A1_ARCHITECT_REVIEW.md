# AUTO-P2-A1：First Real Delegation Readiness

2026-10-23（Asia/Taipei）。Implementer：Codex；Reviewer：GPT-6 Architect；Human 保有最終權限。

**技術候選，REVIEW_ONLY_PRODUCTION_HOLD。不是 Pilot 授權，不是 live 模型驗收，不發布 main。**

Base exact SHA：`9a1579748c6764aa53cb2e0d2803d01cf28ee005`。
Branch：`work/auto-p2-a1-delegation-readiness`。
Final exact SHA／候選 push CI 見本輪 closure，不拿 base CI 代替。

## 1. Phase 0：實際查核

- 重新讀取 contract、adapter、transport、store、composition、service、Workspace 與既有 AP1 activation core，不以舊完成報告推導能力。
- Base 的 2,116 項測試對應上述 base SHA；重新取得 [CI #127](https://github.com/qqqq8413-cyber/ai-collab-mcp-notes/actions/runs/39467143570)，head SHA 相同，Ubuntu 與 macOS job 成功。這不是 A1 的 CI。
- 既有鏈為 Goal Queue → GC1 → RA1 ROOT/IDLE；limited composition 接真實 Controller、Driver、Runner、FileInvocationJournal 與 Archive 唯讀驗證，但沒有正式 activation 入口；原生 transport、composition、adapter、Workspace 各有硬 HOLD。
- 現場 GET 4873／4874／4875 均 ECONNREFUSED，**在實作前即如此**。未擅自啟動、重啟、替換或修理。三個既有工作樹 clean，SHA 分別為 913385b、a3164fd、9a15797。完整 SHA、設定及磁碟 hash 見 preflight／old-services 證據。
- 舊 Permit 草案不是授權；原先價格 snapshot 不能當新執行許可，必須重新查核。公開模型文件與 pinned 帳戶／API 的實際可用性是兩件事。
- 原生 Worker 不使用有 Git write 的 Claude implementation adapter，也沒有 CLI／tool loop。固定唯讀 Git blob 提取，不讀私聊、其他專案或全域 Agent 設定。

## 2. 安全啟用準備

`readiness.ts` 從真實 job、Goal、Run、source、版本、費用與 Driver 投影產生中文缺口／下一步／負責者，以及完整 `UNISSUED_NOT_AUTHORITY` review packet。所有內部識別、contractHash、packetHash、sourceHash、store identity、quote 與工具綁定由系統組裝。

這個機制不呼叫 activation、不簽發文件、不開啟 preserver 或 appender。Workspace 只讀取準備資料、保存操作與取消／核對需求；沒有 `/activate`、`/authority`、`/execute` 或任意 step 端點。既有 topology 防線及 Authority writer 數量不變。

新隔離測試實際呼叫既有 AP1 core，對暫存的合成 Direct Authority documents 完成 preserve → Controller PACKET_READY → exact-retry idempotence；驗證 proposal 不是 AuthorityDocument、偽造 principal 被拒絕。完整 A1 policy 即使已由測試 AP1 staging，也因 input decision 未解決而拒絕進入 Driver 執行。

另有一個 **legacy contract／OFFLINE_SYNTHETIC calibration**，僅用來驗證既有 AP1 → Driver → Runner → Worker → APPLIED Journal／report 的整合。它不是 A1 新輸入規格通過，更不是 live AI acceptance。正式 runtime 沒有選用 synthetic transport 的參數。

未來仍須把獨立核發的 Architect packet 與兩層 Human grants 經既有可信治理入口處理；本輪未把 Archive 寫入權交給 Workspace，也未擅自新增可用的正式啟用入口。既有 core 的可用性，不等於產品已開放啟用。

## 3. 輸入與費用規格差異

| 概念 | 目前真實狀態 |
|---|---|
| 原先申請 input 4,096 tokens | 保留在 A1 contract，hard verification = UNVERIFIED；decision = PENDING_HUMAN_ARCHITECT_REVIEW |
| 實際本機輸入限制 | README 普通 Git blob ≤16,384 bytes；Goal ≤2,000 UTF-16 code units；JSON request ≤131,072 bytes |
| token 估計 | null／NOT_MEASURED，未呼叫帳戶 token counting，也未假設 bytes = tokens |
| API 輸出限制 | max_tokens=2,048、thinking disabled、standard_only |
| 保守費用輸入上界 | 200,000：模型／定價的預留依據，不是新的 Human 輸入許可，不證明 4,096 已 enforce |
| 最壞預留 | 210,240 micro-USD（US$0.210240）；單次及同綁定 store 的持久總預留 ≤US$1 |
| 已回覆 usage | 驗證 model、usage、tier、cache 等後計算；與 provider invoice 分開 |
| 未回覆／不確定費用 | null，保留最壞預留，不自動退款或重送 |

request byte cap 是純資料序列化防線；既有 16KB source 與 2,000 字元 Goal 即使按 JSON escaping 的保守上界也在其內，不宣稱這是 4,096 token 的替代證明。

官方依據：[token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting) 仍將其描述為估計；[Messages](https://platform.claude.com/docs/en/api/messages/create) 的 max_tokens 控制生成輸出，不是 4,096 input cap。[模型／定價](https://platform.claude.com/docs/en/models/haiku-4-5/overview) 的公開值須由程式重新解析並綁定來源雜湊。

公開 API reference 現在顯示較新的 2026-10-21 版本；本 Worker 仍固定 `anthropic-version: 2023-06-01`，不默默遷移。特定帳戶、該 pinned API 與必要 metadata schema 的實際相容性 **未探測**，不能推論失效或可用；未知時仍拒絕。

### 需要 Human 決策

1. **保留嚴格 4,096 input token 要求**：繼續阻擋，直到有可獨立驗證的硬限制方法，再作受審修改。不拿估計或任意安全係數冒充保證，也不偷偷截斷來源。
2. **另行核准規格變更**：例如接受明確來源／字元限制加 provider-context 費用預留。這是新的規格與授權，不是本輪已決定事項；不自動換模型／provider。

本輪兩者都未代替 Human 選擇。Schema 只接受 PENDING，客戶端不能提交 APPROVED。`assertInputReady` 在 composition、adapter 及 native transport 的執行路徑阻擋。沒有 A1 input policy 的舊契約仍可唯讀查驗，但不能成為 live-ready 契約。

單次生成1、retry0、300秒及較早到期的 grant／quote、整數費用預留、全域 lease／Run claim、UNCERTAIN 不重放等限制保留。價格文件改變、模型能力未知或總預算不足皆不得生成。

## 4. 使用者流程

隔離預覽：<http://127.0.0.1:4876/#/p/chief/automation>。

使用者輸入要完成的工作，查看唯一 README Agent、固定版本資料、單次／累積 US$1 上限及 Markdown 交付範圍，再建立工作與計畫。也可選既有目標，不必手填任何技術識別。

畫面分開：已保存／尚未執行、執行鎖定、授權／input／帳戶／價格／版本／Controller／預算缺口與下一步。Run／hash／完整 proposal 放在預設收合的進階證據，定時更新不會關閉已展開內容。

START 前後端仍拒絕；不能以修改 DOM、提交假的 authority/model/scope 或重送事件取得執行權。取消未執行工作及中止正在執行的既有能力保留。UNCERTAIN 或結果矛盾時可「提出人工核對」，只保存需求，**不退款、不解除限制、不重送、不宣稱已解決**。

本機新增前置檢查失敗也保存 BLOCKED／reason，避免沒有 budget reservation 就遺失停止原因。沒有百分比或虛構 Agent 工作進度。

## 5. 成果一致性

除了 report 檔案 hash，新增核對 ledger 的畫面文字 hash。又要求 Journal 的 exact packet／Run／occurrence、APPLIED application 對應 Controller REPORT_IMPLEMENTATION_COMPLETE，以及 Journal outcome 的 Worker ID、report hash 與 evidence class 全部一致。

因此，即使有人把 ledger 的 report 和 report.md 同時換成另一份、重新計算 ledger checksum，也不能與原 APPLIED Journal 相矛盾卻仍被投影成成功。這是完整性檢查，不聲稱 checksum 是簽章或可對抗有權改寫所有 protected stores 的 Host owner。

Controller 最多到 IMPLEMENTATION_COMPLETE，不是工程 Run CLOSED；沒有進入 Git delivery、第二 Agent、審查或 promotion。完成時間只能在上述證據一致時產生，否則為 null／待人工核對。

## 6. 效率量測

詳細定義在 `AUTO_P2_A1_MEASUREMENT.md`。

- 同一持久 store 保存 setup open、form start、plan ready／reuse、check、HOLD refusal、cancel、reconciliation request、runtime start。request ID 去重；改內容重用 ID 拒絕。
- 完整授權設定仍未完成，因此 full setup time 是 null，不拿「首份計畫準備好」替代。
- 初次開啟到首份計畫、每次 form → plan 的 server-observed span 與 browser-reported span 分開；後者不可信作為 Authority 或精確 Human 工作時間。
- 只計收到的操作，不冒稱完整 Human 介入總數。最多保存2,000條觀察，超出有明確 dropped／bounded-window 標示；預算與 Invocation 不會隨量測視窗重設。
- 提供以 Goal／source／model／API／system prompt／delivery 綁定的 comparisonKey；直接操作 AI 的 baseline、品質、返工與未觀察時間仍為 null，沒有節省／優於單模型結論。
- 本輪所有新預覽測試紀錄與 fixtures 都是 OFFLINE_SYNTHETIC，native port 仍為 HOLD。當前沒有真正 AI 成果、帳戶 API 呼叫或付費請求。

## 7. 驗收

新增32項離線測試，完整既有及新增測試結果見 `regressions/auto-p2-a1/test-summary.json`，候選 CI 見提交後 closure。

凍結程式的最終本機結果：58 suites／2,148 passed／0 failed／0 skipped，UTC 2026-10-23T10:50:11.210Z–10:53:23.737Z，exit 0。其後僅整理文件與證據，不更動受測程式。

涵蓋 input 語意、不可偽造 approval、價格／版本／預算阻擋、既有 AP1 的隔離 staging、HOLD、無效授權、byte cap、legacy checksum 不改寫、量測保存／去重／容量、人工核對不重送、report／Journal／Controller 一致性，以及相同工作比較識別。既有48項仍涵蓋 model/scope/price、token/cost、cancel/timeout、真實子程序 SIGKILL／restart、總預算及零 retry。

瀏覽器實測1440／768／390／320px：實際填表 → 真實 Goal/GC1/RA1 IDLE → 自動封包 → START403／偽造400／刷新保存、進階區收合及 polling 保留、無橫向溢出／page error。所有受測效率數字標記合成測試，不是產品效率證明。

4873／4874／4875 的磁碟設定／資料 hashes 與原工作樹前後相同；服務仍是預先觀察到的無法連線狀態。**live 舊服務回歸 NOT RUN，不是 PASS；磁碟／狀態未受影響的比對 PASS。** 不擅自啟動它們來補造驗收。

## 8. 距離第一次正式文件審查

1. Architect 驗收這份候選與輸入／費用規格差異，Human 決定4096要如何保證或另行變更規格。
2. 對該決策實作並審查最終的可信 activation／執行版本。本輪僅有只讀準備與隔離 staging；沒有可繞過 HOLD 的產品啟用入口，不能說只差 key。
3. Human 另行核准 EXE／必要 H1–H9 的限定範圍；由既有可信治理流程處理，不由 Workspace 自簽。
4. 專用憑證只在可信 Host 本機配置；查驗 exact provider/model/API/account metadata 與新鮮官方 quote。不得把憑證貼到表單、聊天或 repo。
5. 系統在最終 SHA、physical store、Goal/Run/source/output 上重新產生 packet；正式 Architect packet 與兩筆 Human grants 全部歸檔、未過期且 exact 綁定。任何版本／source／quote 變更使舊契約不可重用。
6. Human **另一次明確授權**單次付費 Pilot，再用真正 provider message ID、usage、Journal、report 與取消／不確定結果完成 live acceptance。

本輪不核發、不解除 HOLD、不呼叫付費模型、不發布 main。STOP FOR ARCHITECT REVIEW。
