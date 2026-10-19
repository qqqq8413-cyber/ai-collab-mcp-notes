# SRC-C1：真實 AI 工作事件

本版本只觀察、保存、顯示；不解除 EXE HOLD，不啟動 Claude Code／Codex，不呼叫模型，不更動 Human 授權。

## 已接通的來源

Claude Code 在本機已存在的 Session `.jsonl` 紀錄。明確指定一個來源檔、來源工作目錄及 Workspace 專案。
不是 Hook，也不修改任何 AI 全域設定。來源是本機紀錄，不是 provider 簽章或獨立完成證明；本機檔案可被其他程式修改。

只讀取頂層 `assistant` 的公開 `message.content[type=text]`；忽略 user、thinking、tool_use、tool_result、其他 operational rows 與 sidechain。
無法據此推算收件者、Human 決策、任務成功率或完成百分比。保留原本未指定收件者的相容顯示規則，不聲稱其他 Agent 已讀到。

## 操作

先以 `npm ci`、`npm run build` 建置。複製 `workspace.example.json` 為自己的設定，確認 `projects` 包含目標專案，並設定自己的 `dataDirectory`。
不要把私人 transcript 或匯入後的事件庫提交到 Git。

一次匯入：

```sh
npm run events:import -- --config /absolute/workspace.json --project chief --session-file /absolute/SESSION-UUID.jsonl --source-cwd /absolute/original-working-directory
```

持續觀察同一份檔案：

```sh
npm run events:import -- --config /absolute/workspace.json --project chief --session-file /absolute/SESSION-UUID.jsonl --source-cwd /absolute/original-working-directory --watch
```

首次讀取一律是「歷史匯入」；之後每兩秒讀取新增、換行完整的紀錄，標為「監看收到」。Ctrl+C 停止監看。
這個標示只證明本次監看收到紀錄，不證明內容剛產生或 AI 仍在執行。停止後重新監看，未匯入的 backlog 仍是歷史匯入。
若來源替換、截短、既有完整內容改寫、完整行 JSON 錯誤、Session／來源工作目錄不符，停止，不跳過修復。

開啟同一份 Workspace 設定：

```sh
npm run workspace -- --config /absolute/workspace.json --port 4872
```

在瀏覽器開啟 `http://127.0.0.1:4872/#/p/chief/collaboration`。
協作室每三秒讀取目前開啟的房間；隱藏頁面不輪詢，不變更網址、不寫入、不輪詢執行狀態。
每則訊息可展開來源、Session ID、Event ID、事件類型、來源時間與接收時間。
重新啟動 CHIEF、重新匯入同一份紀錄不會丟失或重複事件。

## 儲存與驗證界線

- 新檔位於 `<dataDirectory>/collaboration/<projectId>.events.json`，不使用 Goal、Controller、Change Registry 或 Authority Archive。
- 去重鍵：project + source + session + event UUID + text block index + segment index。同一鍵內容不同會拒絕整批，不覆寫。
- 保留來源文字 SHA-256；顯示時 CRLF 轉 LF、tab 轉四個空格；超過 4000 字元分段並標示段數，避免切斷 surrogate pair。原 UI 仍 trim 訊息邊界空白。
- 一個專案最多 10,000 段，檔案及來源各最多 64 MiB。這是本輪有界 MVP，沒有分頁、輪替或永久無限保留。
- 嚴格 schema、checksum、獨占 lock、暫存檔 fsync／rename／directory fsync。損壞不修復、舊 lock 不偷清除；checksum 是完整性檢查，不是可信簽章。
- API 僅 `GET /api/v0/projects/:projectId/collaboration`，沿用 D1 Session、loopback、Host／Fetch-Site、防跨站與 CSP。沒有任意檔案讀取、事件 POST、事件觸發器或執行授權。
- 所有錯誤／合成測試資料都屬測試，不宣稱為真實 AI 事件。真實來源測試只讀取既有本機紀錄，不額外呼叫模型；私人內容不納入提交。

## 本輪未做

Codex 或第二個 Agent、Claude sidechain 身分識別、工具進度／開始結束事件、來源自動掃描、provider 驗證、任務狀態推論、AI-to-AI 實際投遞、自主執行、模型 API、main promotion。

STOP FOR ARCHITECT REVIEW
