# A1 驗收證據

本輪不是付費Pilot。`OFFLINE_SYNTHETIC`資料不是真實模型驗收或正式產品效率證據。

- preflight.json：實讀基準程式後的已知阻擋、base SHA與CI#127／2116對應；三個舊服務當時無法連線。
- old-services-before/after.json：實測舊設定／資料hash及工作樹不變，原服務仍DOWN。live回歸NOT RUN，不以磁碟比對冒稱live PASS。
- test-summary.json／npm-test-output.txt：本機完整build/test與macOS隔離，actual exit／pass／fail／skip。
- offline-activation.json：既有AP1／Driver／Worker／Journal／report的legacy calibration；所有Authority、source與model均暫存合成fixture，不代表A1 pending input policy可執行。
- browser-acceptance.json／worker-*.png：真實loopback新4876 UI／HTTP，建立Goal／Run／系統封包、HOLD拒絕、手機與桌面；操作與效率明列合成測試。
- model-price-check.json：官方公開Markdown的查核時間／hash／tariff；不做帳戶或生成呼叫，不以過期quote授權未來執行。
- source-seals.json：受測程式與測試的SHA-256，提交前不是final SHA斷言。

工作分支exact push CI、提交後fresh預覽、重啟與新未核發Permit，在本機closure另行核對，避免把自引用commit或舊CI當成本候選證據。沒有private Session、API key或真實Authority文件。
