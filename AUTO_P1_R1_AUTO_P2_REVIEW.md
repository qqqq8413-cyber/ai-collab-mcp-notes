# AUTO-P1-R1 + AUTO-P2 Preparation

狀態：候選實作，等待 GPT-6 Architect Review。EXE HOLD / H1-H9 不變，未發布 main。

基準候選：`913385b0e1b8f8c529152a091255f46cad67787a`。工作分支：`work/auto-p1-r1-auto-p2-preparation`。正式 main：`e7eb87b4b481c885bea8730f8498eb493dc38184`。

## P0 實際修正

- 以滾動一小時的實際 snapshot 開始時間計算 30 次額度；跨整點不重置。這是每個資料目錄內所有已配置專案共用的 snapshot 額度，不是 GitHub API request 數或帳戶總 rate limit。
- 額度不足時，在讀取開始前持久化 `DEFERRED` / `GITHUB_READ_BUDGET` 與最早可用時間。週期工作不新增失敗 Run；手動待辦保留原 request / Run，額度恢復後只執行一次，沒有 retry。
- 實際讀取／驗證失敗仍 FAILED；使用者取消仍 CANCELLED。STOP 會停排程、中止當前讀取並取消未開始待辦；PAUSE 僅停未來觸發。
- 重啟取消已過期的 QUEUED 週期 occurrence 並保留原因；過期 nextDue 推至未來一個原設定週期，不補發每個漏失時段。RUNNING 中斷仍保留既有 FAILED / 不重播語意。
- 保留單一排程 lease、全域同時一件、request / occurrence 去重、重試及容量上限。新增 DEFERRED 也計入 pending／queue 上限。
- UI 顯示讀取頻率、下次執行／恢復、共用預算剩餘及延後原因。新工作表單預設建議 300 秒；既有 60 秒設定不改寫。
- 儲存 schema 只新增 optional 欄位，不以 defaults 破壞舊 checksum；有界歷史政策維持原狀，不宣稱無限保存。

## P1 已可操作的整合

獨立預覽：`http://127.0.0.1:4874/#/p/chief/automation`。與 4873 使用不同資料目錄、lease 及治理根目錄。

1. 點「建立目標」，使用原有 Goal Queue 加入限定文件審查目標。
2. 回「自動化」，選既有目標及 Agent，建立持久化的權限申請草案。
3. 點「準備受控工作（不執行）」：實際呼叫 GC1 mint 與 RA1 admission，由既有 Controller Store 保存真正的 ROOT / IDLE Run。
4. 由既有 WE1 / Human Authority Archive reader 顯示實際狀態及識別；「檢查條件」只讀。
5. 「啟動執行」保持 disabled；即使繞過 UI 呼叫 START，伺服器仍回 403 / EXE_HOLD，不呼叫 Driver 或模型。

Workspace 僅接三個 injected preparation-only endpoint，仍無 outbound、Controller、Archive appender、Driver.step 或模型能力。Host 必須明確 opt-in，原 `workspace:pilot` 啟動方式不變。

新準備入口：建置後 `npm run workspace:ai-preparation -- --host-config <隔離設定檔> --port 4874`。設定沿用 TrustedWorkspaceHostConfig；三個已存在的私有治理根目錄必須互斥，與 Workspace/UI 分離。不提供授權核發或執行開關。

## 已驗證與尚未接通

| 模組 | 本輪狀態 |
| --- | --- |
| Goal Queue / D1 local session | 真實 UI/API/store 整合；Human attribution 從 server session 推導，不接受 client 覆寫 |
| GC1 / Run Admission / Controller Store | 真實 mint / admission / IDLE，去重與重啟驗證 |
| Human Authority Archive / WE1 | 既有唯讀狀態查詢；空隔離 Archive 沒有補寫任何 grant |
| Execution Driver | 隔離測試注入真正的 inspect-only port，驗證 Goal→實際 run target 與 IDLE 阻擋；預覽未組合 Driver，顯示 null / NOT_COMPOSED |
| Invocation Journal | 隔離測試接真正 FileInvocationJournal，驗證讀取與重啟，合成 outcome 明確只屬離線 fixture；預覽未接 reader，顯示「未接通」，不是捏造 0 次 |
| Model Adapter | 檢查既有 Claude implementation 與 Codex architect-review，既有全套 adapter / runner / Seatbelt 回歸；未建立或啟動 live adapter |
| Workspace UI | 真實草案、狀態及阻礙，不顯示假 AI 進度或假成果 |

現有 Claude adapter 需要工作樹、commit / push；Codex adapter 需要實作 SHA、審查封包與 lineage。兩者都不是所提議的單次唯讀文件 Worker，不能只解除 HOLD 就用。

其他必要條件：精確模型／CLI／egress binding 尚未驗證；USD 費用硬上限及定價來源尚未落實；正式 source hash / packet、隔離輸出位置、Driver / journal host composition、可驗證停止，以及 Human 的限定有效授權仍未完成。模型名稱只呈現 repository default 的申請值，不宣稱可用、已連線或已定價。

## 驗收證據

`regressions/auto-p1-r1-auto-p2/` 保存完整測試摘要、真實唯讀 GitHub 結果、瀏覽器驗收、舊資料副本相容性與新預覽重啟證據；截圖只包含本輪公開測試目標及公開 GitHub CI，沒有私人對話。

- 新增 P0 16 項：跨小時、分批釋額、額度延後、恢復、去重、重啟不補發、手動取消／STOP、全域預算及舊設定保留。
- 新增 P2 24 項：真實治理路徑、Driver / Journal 離線接線、HOLD 拒絕、身份／來源綁定、偽授權、錯誤資料、隔離、持久化、XSS、來源刪除及容量不足時保留舊證據。
- 完整 build / npm test：56 組、2,068 passed、0 failed、0 skipped，包含實際 macOS Seatbelt 隔離回歸。兩次中途失敗屬精確拓撲白名單：新準備入口的 preflight、以及會被編譯移除的 Driver 型別引用；已明確列名，未放寬 Workspace／執行寫入界線。首次未授權 localhost 的測試環境亦曾 EPERM，允許 localhost 後重跑通過。
- 瀏覽器：建立目標→保存草案→真實 RUN_IDLE；START=403；唯讀 GitHub→保存→顯示 5 個真實 CI；1440 / 768 / 390 / 320px 無橫向溢出，page errors=0。
- 新預覽程序重啟：草案與 CI 檔案 hash 不變，1 個原 Run，沒有重複，排程保持關閉、Authority Archive 仍空。
- 原始 4873 資料唯讀快照的隔離副本：保留 249 筆 Run、6 個 CI 及既有設定。合成額度耗盡不產生新 Run 或 GitHub request；不把此合成測試冒充 live 預算跨小時驗收。

## 部署及審查界線

**沒有替換／停止正在運作的 4873 服務，也沒有改其 60 秒 enabled 排程。因此舊服務仍可能按舊程式產生額度 FAILED；本修正尚未部署到它。** Architect 接受後，仍需 Human 明確授權切換服務／調整舊排程。不能把「候選修好」宣稱為「目前運作服務已修好」。

不修改 main、GitHub Ruleset、管理員憑證或其他 Agent 全域設定。不呼叫付費模型、不啟用自主執行。既有 5 項 dependency advisories 未在本輪修復；`npm ci --offline` 的摘要不是最新安全審查。

建議 Architect 先審 P0 的恢復／取消語意與 P2 的唯讀界線，再另開最小 adapter＋成本 enforcement slice；本輪不擴充成自主執行。

STOP FOR ARCHITECT REVIEW。
