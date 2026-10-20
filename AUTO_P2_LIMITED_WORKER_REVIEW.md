# AUTO-P2 Limited AI Worker：Architect Review

日期：2026-10-21（Asia/Taipei）

狀態：實作候選，等待 GPT-6 Architect Review。**EXE HOLD，沒有真實模型執行驗收，沒有發布 main。**

基準：`a3164fd12d6d3129978da32ea024854d6e9b5cdc`。
工作分支：`work/auto-p2-limited-ai-worker`。Exact candidate SHA 與該 SHA 的 push CI，以完成回報及本機 closure 證據為準，不引用舊候選 CI。

## 1. 可以實際操作的範圍

獨立預覽：<http://127.0.0.1:4875/#/p/chief/automation>。

1. 在「現在」建立文件審查目標。
2. 到「自動化」，選擇目標及唯一的 README Worker，準備計畫。
3. 後端實際執行 Goal Queue → GC1 → RA1，保存真實 ROOT / IDLE Run 與限定工作契約。
4. 查看精確模型、README 版本／雜湊、Worker 版本／程式雜湊、Run、價格來源與有效期、額度及授權條件。
5. 檢查條件或取消未執行的工作。啟動按鈕為 LOCKED；直接呼叫後端 START 也回覆 403 / EXE_HOLD。

此預覽不自動核發、保存或匯入 Authority，不啟動 Agent。帳戶 API 未呼叫、usage／實際費用為 null，不顯示虛構進度。原 4873／4874 保持原程序、資料及設定；新資料與三個治理根目錄另行隔離。

## 2. 第一個 Worker

- 使用 Anthropic Messages HTTPS API，不是 Claude Code CLI，也不重用有 commit／push 能力的 implementation adapter。
- Provider `anthropic`、model `claude-haiku-4-5-20251001`、API header `anthropic-version: 2023-06-01`；沒有 CLI／SDK 版本漂移或 SDK 自動重試。
- 只提取基準 SHA 的 `README.md` Git blob。必須為普通 100644 blob，1–16,384 bytes；拒絕符號 ref、symlink、gitlink、過大或異常編碼。此版本為 5,568 bytes，SHA-256 `5a65327552f70506d0c68fe297f5202bf2a530f3cdc6e9c279ad6f74d8438d5d`。
- 模型收到的內容只有固定 system prompt、該 Human Goal 及 README 文字。把 Goal／文件視為資料，不賦予工具或執行權。
- 模型無工具、shell、瀏覽、skills、其他 Agent、Git 或部署介面。Host 僅以固定參數執行唯讀 Git blob 提取；模型不能提供命令或路徑。
- 唯一成果是隔離目錄 `<worker-root>/<bound-outputKey>/report.md`，固定路徑、wx 建立、最多 64KB、fsync 及雜湊；不覆寫 repo。
- 這是 API 資料／能力邊界，不是「把 Claude Code 放進新的 Seatbelt sandbox」。可信 Host 本身仍持有既有治理能力；現有 R4T／Seatbelt suites 另做回歸，不冒稱驗證了不存在的 CLI sandbox。

## 3. 費用和 Token 是怎麼擋住的

官方來源：

- [Haiku 4.5 模型／定價](https://platform.claude.com/docs/en/models/haiku-4-5/overview)
- [本程式解析的官方 Markdown](https://platform.claude.com/docs/en/models/haiku-4-5/overview.md)
- [帳戶 Models API](https://platform.claude.com/docs/en/api/models/retrieve)
- [Messages API](https://platform.claude.com/docs/en/api/messages/create)
- [Token counting 的估計性質](https://platform.claude.com/docs/en/build-with-claude/token-counting)

公開來源目前列示模型為 Active (legacy)，200K context，標準 input US$1 / MTok、output US$5 / MTok。此事不代表特定帳戶一定可用；目前帳戶可用性 **UNVERIFIED**，不得替換模型。

`count_tokens` 是估計，不拿估計當 4,096 token 的硬保證。本候選的保守策略是：

| 項目 | Runtime enforcement |
|---|---|
| 輸入 | README 16KB + 既有 Goal 字數限制；另要求帳戶 metadata 的 max_input_tokens exact 200,000，按模型硬上界預留，而非偽稱精確 prompt token 數 |
| 輸出 | request max_tokens = 2,048；thinking disabled；回覆 usage 超限或缺失不接受成功 |
| 價格 | 解析官方結構化 Markdown 表格；精確 model／狀態／context／價格；完整來源雜湊綁定契約，最長 1 小時有效 |
| 送出前 | 重新抓官方文件，雜湊不得變；帳戶 GET /models/:exactId 必須確認精確模型、輸入上界、足夠輸出及 disabled thinking 能力，未知欄位即拒絕 |
| 單次預留 | 200,000 × 1 + 2,048 × 5 = 210,240 micro-USD，即 **US$0.210240** |
| 單次／總額 | 單次最多 US$1；同 Worker store 的持久總預留不得超過 US$1。以整數／BigInt 計算，沒有浮點餘額判斷 |
| 請求 | 一次 Messages generation，零 retry／fallback／redirect；metadata GET 不是生成請求 |
| 防重送 | send 前先落盤 generation claim；同 Run 不能第二次 claim。契約綁定實體 store path/dev/inode，不能複製 ledger 當新預算 |
| 時限 | 最長 300 秒，授權／quote 更早到期即縮短；AbortSignal 取消 HTTP，模型遠端是否已計費未知時保留全部預留 |

不使用 priority、batch、prompt cache、工具、beta 或其他附加計費能力；回覆若出現非標準 tier、cache usage、工具或異常模型，即 UNCERTAIN，不重試。

此上限針對本程式按已查驗 tariff 的標準 API inference 費用，不聲稱能控制帳戶其他使用、稅金、匯率或供應商帳單錯誤。公開文檔或帳戶 metadata 不足以確認上界時不執行。實際 usage 計算費用另存，並非供應商 invoice；沒有回覆時維持未知。

總預留保守不自動釋放，包含成功、失敗及不確定工作。建立新 store 不是自動續額，須有綁定新實體 store 的新 Human 授權。不存在預算 reset API。

## 4. 治理資料路徑

```text
Human local session → Goal Queue → GC1 → RA1 ROOT / IDLE
→ Architect packet + Human direct authority（本輪不核發）
→ 既有 governed activation / Authority Archive
→ governed Execution Driver → Controller → AutomationRunner
→ LimitedReadmeWorker → provider / isolated report
→ Invocation Journal → Workspace 唯讀狀態與結果
```

限定契約的 canonical JSON 放入既有 ImplementationPacket objective；packet 其餘欄位亦按固定規則重建並比較完整 packetHash，不只讀 objective。

沿用的 ImplementationPacket schema 仍有必填 targetBranch／validationCommands 等工程欄位；本候選把它們固定為不可由 UI 改寫的契約欄位，但這條限定路徑不執行它們，也不宣稱執行了工程 validation 或交付分支。它們不能變成 shell／Git 工具授權。

必須同時有：

1. 既有 `LIVE_PROVIDER_MODEL_CALL` Human grant，由 Driver／Runner 按既有規則驗證，Worker 在模型 preflight 後另重新確認其歸檔、未被取代與有效期。
2. 額外 `LIMITED_README_WORKER` Human grant，target exact contractHash，精確 Run／packet／scope／有效期，Archive bodyHash／subject／Human principal 均一致且未被新版取代。

契約含 repo、Goal/objectiveHash、Run、Worker SHA/codeHash、source SHA/path/hash/bytes、Agent、provider/model/API、兩個固定 Host 操作、outputKey、實體 store identity、token/call/retry/cost/timeout 及定價 snapshot。讀取前、provider preflight 後重新驗證。任一不匹配，不生成。

新增組合沒有 Authority appender、preserver、minter 或 RootRunAdmitter；沿用既有 GC1／RA1。Workspace 不匯入 Controller／provider 或 Archive writer，只接窄 operational port。可明確指定私有 `--permit-config`，但只載入已核發記錄的 operational copies，不能替代 Archive proof、發出授權或解除 HOLD。

只允許兩個 Driver step：準備 implementation occurrence，然後執行一次 Worker。不呼叫 Runner.drive，不進入 remote-SHA／Git delivery／第二 Agent／acceptance review／promotion。

成果完成時 Controller 是 **IMPLEMENTATION_COMPLETE，不是 CLOSED**。Workspace 只有在 report 檔案 hash、Invocation APPLIED 及該 Controller 狀態一致時，才投影為已保存且套用；不把文件成果冒充工程 delivery 完成。

## 5. 重啟、取消與失敗

- store 原子更新、checksum、單一程序 lease、單 Worker／Run claim。ledger／symlink／鎖狀態不確定時 fail closed，不修造歷史。
- 在送出前取消／超時：CANCELLED／TIMED_OUT，無生成請求。
- generation claim 後取消／超時／斷線／格式不符：UNCERTAIN，保留最壞情況預留，Invocation 同樣不確定或停在 HUMAN_STOP，不重送。
- crash 後原 RUNNING → UNCERTAIN；不自動執行。寫入鎖或證據損壞時需人工核對，不自動刪鎖或還原預算。
- UI 不把模型回覆、Invocation、操作日誌當成 Authority。D1 local session 是歸屬，不是付費執行授權或強式 Human 身分驗證。

## 6. 驗證與證據

`test-limited-worker.mjs` 有 48 項離線測試；第一個 E2E 實際使用既有 Goal/GC1/RA1/Controller/Driver/Runner/Archive/Journal，**只有模型來源、授權與來源內容是隔離合成 fixture**。沒有真實 AI 成功主張。

覆蓋：單次流程、無 Git／第二 Agent、HOLD、未歸檔／錯 principal／錯 contract/run/packet/model/provider/scope/expiry、來源／程式變更、模型 preflight／價格失效、input/output token、未知 usage／tier/cache/tool、取消／超時、並行去重、持久總費用、真實子程序 SIGKILL 恢復、lease／checksum／symlink、固定 Git blob 與大小限制、真實 HTTP session／origin／偽造欄位拒絕、成果遭改與 private grant copies。

完整 build／test 與本機 macOS isolation 結果見 `regressions/auto-p2-limited-worker/test-summary.json`。沒有把測試環境禁止開 loopback 的失敗隱藏成成功；最後以允許 loopback／Seatbelt 的環境完整重跑。遠端 exact candidate CI 另在 push 後查證 Ubuntu test、macOS r4t-macos 及兩個必要步驟，不能用本地結果代替。

最終本機完整結果：**57 suites，2,116 passed／0 failed／0 skipped**，2026-10-20T17:29:02.946Z 至 17:31:57.056Z，exit 0。其中限定 Worker 48 項。後續僅整理文件與證據，沒有更動受測程式。

瀏覽器 1440／768／390／320px：真正建立 Goal → 準備計畫 → 真實 GC1/RA1 IDLE、無 Invocation、START 403、偽造欄位 400、刷新／去重及 0 橫向溢出／page error。4873／4874 僅 GET UI/API，設定保持原樣。4873 原程式仍可能自然產生舊額度錯誤，本輪未替換服務或修其 live history。

證據目錄包含測試摘要、合成 E2E 摘要（明確 OFFLINE_SYNTHETIC）、瀏覽器／舊服務回歸、官方價格查核及截圖。沒有私聊、Session 內容、API key 或真實 Authority body。提交前的瀏覽器證據不是 final commit 的 runtime SHA 證明；最終預覽與 closure 在提交後另做 exact SHA 綁定，不製造自引用 commit。

## 7. 正式執行仍缺什麼

不是只差「允許」兩字或 API key。

1. Architect 驗收候選，確認 200K 保守輸入預留策略、API 資料隔離與只到 IMPLEMENTATION_COMPLETE 的範圍。
2. Human 另行核准限定 activation／EXE 及必要 H1–H9。這版 EXE 為硬 HOLD；普通 UI 操作、grant copies 或修改設定均不能解除。若授權後需新 activation 版本，必須重新審查該 Exact SHA／codeHash，不能沿用本候選的舊契約。
3. 本機以專用帳戶憑證配置 provider，只由 Human 在機器上處理，不交到聊天或 Git。正式 preflight 必須實際證明該帳戶可取得 exact 模型及必要 metadata；未知仍拒絕。
4. 在最終執行版本／實體 store 建新計畫，取得新鮮官方 quote，固定 exact Goal、Run、source、packet、成本與期限。
5. 經既有治理 activation 保存 Architect packet 與兩筆精確 Human grants，再由 Driver 驗證；不由 Worker／Workspace 自簽。有效期限取 quote 與 grant 的較早者。已過期／綁定舊程式的計畫不可重用，須新 Goal／Run。
6. Human 明確授權一次正式付費 Pilot；執行後以真正 provider message ID、usage、Journal、report hash、取消／不確定處理完成 live acceptance。

`AUTO_P2_LIMITED_WORKER_PERMIT.md` 及本機 machine packet 都是 **UNISSUED_NOT_AUTHORITY**，起訖時間為 null。不能拿草案當已准許執行。

## 8. Architect Review 建議

建議審查「限定 Worker 技術候選」，不核准 Pilot 或 main promotion。原 Human Authority 模型與 EXE/H1–H9 未更改；新增的只是限定操作需求與更嚴格 Archive proof。

殘餘風險：真實 provider schema／帳戶能力與取消後的遠端計費尚未 live 驗證；公開文件格式變動會保守拒絕；本機可信 Host 不是多租戶安全容器；既有依賴警示未在本輪擴大升級。Authority hash 只是完整性，不是簽章或真正 Human 認證。

STOP FOR ARCHITECT REVIEW。
