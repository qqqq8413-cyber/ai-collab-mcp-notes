# AUTO-P2 Limited Worker 驗收證據

- `test-summary.json`／`npm-test-output.txt`：完整本機 build／npm test，含既有 macOS isolation suites。以 exitCode、failed、skipped 的實際值為準。
- `offline-e2e.json`：真實治理元件鏈的隔離合成測試。模型、授權、source 都是 fixture，**不是 live AI acceptance**，synthetic usage 費用不是實際付費。
- `browser-acceptance.json`：預提交候選在4875的真實UI／HTTP測試、HOLD拒絕及0 Invocation。當時Worker SHA不是final commit證明；提交後的exact候選預覽／CI另在本機closure紀錄。
- `existing-services-regression.json`：原4873／4874唯讀UI/API，未改設定或重啟。live run歷史會自然變動，不能用hash不變假證明。
- `model-price-check.json`：官方公開模型／價格Markdown的來源雜湊、查核時間及tariff；不含完整轉載文檔。沒有帳戶／生成API呼叫，actual usage／cost未知。quote有期限，不得拿過期證據授權未來呼叫。
- `source-seals.json`：新增／修改程式與測試的SHA-256。不是final commit或Architect接受宣告。
- `worker-1440.png`、`worker-390.png`、`worker-320.png`：無私人內容的真實瀏覽器截圖。

沒有private Session、模型API key、真實Authority body或Human簽發文件。所有本輪正式啟動仍LOCKED／EXE HOLD。Exact SHA push CI需在提交後另查，不使用舊候選結果。STOP FOR ARCHITECT REVIEW。
