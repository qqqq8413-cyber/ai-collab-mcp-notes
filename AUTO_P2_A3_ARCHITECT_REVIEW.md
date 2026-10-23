# AUTO-P2-A3：可強制資源限制技術候選

## 決策與範圍

日期：2026-10-24（Asia/Taipei）。Base `3ab19000c42f68c9d85e690ce95a1b177a3208da`。
分支：`work/auto-p2-a3-resource-limits`。本輪僅為規格及技術候選授權，不是 EXE／H1–H9、Human Authority 或付費 Pilot 許可。

Human 正式取消嚴格4,096 input-token要求。R1的token上界研究結論仍是歷史事實，但不再是新A3工作的規格阻擋。沒有宣稱已解決精確token計數問題。

## 實際差異

| 層 | 修改 | 保留的邊界 |
| --- | --- | --- |
| Contract | 新增A3 resource policy；requestedHardLimitTokens=null、hardLimitVerification=NOT_CLAIMED；舊A1／A2 schema不改寫 | 固定模型/API、source/code/Run/Goal/store/quote完整綁定 |
| Input guard | 經完整schema驗證的A3政策可通過輸入政策檢查，不再一律INPUT_LIMIT_DECISION_REQUIRED | 這不是執行授權；舊政策仍拒絕，EXE仍HOLD |
| Payload | README≤16,384 UTF-8 bytes、Goal≤2,000 UTF-16 units；共用serializeRequest檢查完整JSON body≤131,072 bytes | 不截斷或正規化README；來源/hash/encoding檢查不移除 |
| Transport | 實際HTTPS送出使用與事前量測共用的序列化函式 | native HOLD-before-key／固定endpoint／無retry／redirect／fallback不變 |
| Planning | 新Goal產生新Run與A3契約；舊Goal已有舊計畫時要求另建新工作 | 不原地升級許可、不修改舊ledger/checksum、不轉移舊預留 |
| Governance | trusted staging候選可處理A3，仍經原AP1／Archive／Controller | 不新增Workspace writer／authority route，不解除Driver／Journal驗證 |
| UI | 顯示實際資源上限、預留與未知實際費用；A3不再顯示4K阻擋 | START仍LOCKED／後端403，未核發封包仍不是Authority |

完整JSON body包含system、完整Goal與README、source SHA/path、model、max_tokens、thinking與tier等請求欄位；此處的131,072 bytes不包含HTTP認證headers／TLS。字數定義是JavaScript UTF-16 units，不是Unicode graphemes、UTF-8 bytes或tokens。Token估計仍null／NOT_MEASURED，不用bytes/token假造數字；精確input tokens及token上界也仍null。

原inputPolicy工廠保留為歷史A2測試用途；產品新計畫使用resourceInputPolicy。舊嚴格政策證據與R1測試不刪除、不冒充A3。改政策會改contractHash、packetId／packetHash；舊Human grants不會綁定新契約，即使文字目標相同也不能使用。

## 成本與執行限制

- Anthropic `claude-haiku-4-5-20251001`，API `2023-06-01`不變；不改alias或SDK版本。
- 仍依既有200,000 input-context保守基礎及2,048 output上限預留210,240 microUSD（US$0.210240）；這不是精確輸入token上限或預期帳單。
- 單次及同store累積US$1；已成功或不確定的預留不自動退還，不因換政策／重啟歸零。第五份相同最壞預留會超過總額，必須拒絕。
- 一次生成、零自動retry／fallback、300秒或更早grant／quote到期；generation claim先持久化才send。取消／逾時中止請求；送出後不確定仍UNCERTAIN，不重送。
- 唯讀指定README普通Git blob、固定隔離report.md≤64KB；無Git寫入／push／部署／任意shell／其他Agent工具。

[固定模型公開規格與價格](https://platform.claude.com/docs/en/models/haiku-4-5/overview)重新取得並由原parser確認、內容hash綁quote、最長一小時有效；來源讀取紀錄見model-price-check.json。公開文件不等於帳戶可用性。[Models API](https://platform.claude.com/docs/en/api/models/retrieve)的實際帳戶查驗在native preflight中仍需HOLD後才可能讀key；本輪禁止讀key，因此**帳戶／固定API相容性／實際provider schema仍UNVERIFIED**。價格／model metadata未知、到期或不符時須拒絕；不聲稱已做帳戶探測。

## 治理與成果驗證

隔離測試使用真實Goal→GC1→RA1、既有preserver（只寫暫存合成Archive）、原AP1→Controller PACKET_READY→Driver→限定Worker→Journal APPLIED→sealed report。A3現在可完成此路徑，不再只用legacy無政策契約校正。第二次執行不產生第二個模型請求；report／ledger文字hash、Journal outcome／packet／Run／occurrence及Controller一致才投影成果有效。

所有測試模型回覆、usage、費用與Human文件均為OFFLINE_SYNTHETIC；它們不是正式核發、真實AI成果或產品效率證據。現有trusted staging候選仍沒有接成可由Workspace啟用的production authority入口。工作紀錄及按鈕不具簽發能力；本輪不允許以此候選解鎖正式呼叫。

新增27項A3測試（既有2,208項保留）覆蓋三組上下界、完整原文、政策篡改、A3完整E2E、超過舊4K的合成usage、live HOLD-before-key、缺／過期授權、未知preflight、逾時、取消後不重送、持久總預算、舊契約／permit不得升級、A3新計畫。完整測試／macOS Seatbelt／browser／exact CI以regressions/auto-p2-a3與提交後closure為準，不用base CI代替。

舊4873–4877只做唯讀比對，不啟停、不替換、不改排程；另用新4878及新資料目錄做HOLD預覽。舊服務不可連線時記NOT RUN，不冒充功能回歸成功。

## 新未核發Pilot Packet

提交後在乾淨exact SHA預覽建立新的Goal／Run／A3契約，系統產生本機`outputs/auto-p2-a3/PILOT_PERMIT_PACKET_A3.json`，避免讓封包含錯誤的pre-commit SHA或自引用commit。Authority三欄與issuedAt／expiresAt皆null、state=UNISSUED_NOT_AUTHORITY。一般Human不需手填hash／Run／Packet ID。

## 距離第一次真實Pilot

已解決：新A3不再因無法證明4,096而被全部拒絕；可用資源限制與既有治理鏈已能完成隔離工作。

尚需：Architect接受候選；另案審查可信production activation／execution接線與HOLD變更；Human另次限定EXE／H1–H9及單次付費授權；可信Host上的專用key與exact帳戶／API／model能力查驗、新鮮價格；最終版本新契約之Architect packet與兩筆Human grants經既有程序正式核發歸檔；最後才做真實usage／成果／Journal驗收。本輪無法且未假稱完成這些被明確禁止的操作。

**STOP FOR ARCHITECT REVIEW。不得自行啟動付費Pilot或合併main。**
