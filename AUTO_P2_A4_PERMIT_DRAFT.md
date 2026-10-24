# AUTO-P2-A4：首次 README 文件審查申請草案

**UNISSUED_NOT_AUTHORITY／OPERATIONAL_RECORD。不是許可、不是Authority、不得執行。**

| Human 要確認的事項 | 本次準備範圍 |
| --- | --- |
| 工作 | 閱讀CHIEF指定版本完整README.md，產生繁體中文Markdown文件問題審查報告 |
| 允許資料 | repository `qqqq8413-cyber/ai-collab-mcp-notes`，source SHA `a3164fd12d6d3129978da32ea024854d6e9b5cdc` 的README.md；5568bytes；SHA256 `5a65327552f70506d0c68fe297f5202bf2a530f3cdc6e9c279ad6f74d8438d5d` |
| Agent／模型 | limited-readme-worker／Anthropic `claude-haiku-4-5-20251001`；API `2023-06-01` |
| 資料上限 | README16384 UTF8bytes、Goal2000 UTF16units、JSONrequest131072bytes；不截斷、不保證精確tokens |
| 成本 | 單次與同store累積USD1；目前標準價格下最壞預留USD0.210240；不確定請求不退預留；無帳戶級跨工具總額保證 |
| 次數／時間 | 一次生成、零自動重試、最多300秒；grant／quote先到期則更早停止；grant最長1小時 |
| 工具與網路 | 只讀指定Git blob、只寫指定隔離report；無shell／Git寫入／push／部署／其他Agent／私人Session；固定官方price URL及api.anthropic.com模型metadata／Messages路徑 |
| 預期成果 | 一份隔離Markdown報告、真實usage（尚未取得）、Controller／Driver／Journal／report hash一致性證據 |
| 中止 | Human取消、deadline／scope／身份／版本／價格不符即拒絕或中止；claim後不確定不得重送 |
| 狀態 | EXE／H1–H9 HOLD；帳戶與live schema未驗證；正式Architect及Human Authority皆未核發 |

系統在乾淨最終候選版本產生全新 `PILOT_PERMIT_PACKET_A4.json`；exact implementation SHA、worker code hash、Goal、Run、packet、contract、source及fresh quote由系統填入，Human不手填內部欄位。Packet的authority三欄／issuedAt／expiresAt均null。檔案位於本輪工作目錄 `outputs/auto-p2-a4/`，獨立於Git提交，避免把自身SHA寫回自身提交造成不一致。

仍缺：Architect正式Implementation Packet；Human獨立 `LIVE_PROVIDER_MODEL_CALL` 及 `LIMITED_README_WORKER`；另案EXE／H1–H9限定決策、可信Host部署／帳戶與模型檢查、一次付費Pilot批准。這些不能由Workspace、操作記錄或本草案核發。正式文件須由既有可信程序保存至Authority Archive，Controller核對PACKET_READY，Driver與Worker核對同一份最終契約。

本A4雖沿用A3資源政策，但execution SHA與新Goal／Run／packet／contract重新綁定。A1／A2／R1／A3舊Permit不自動取得資格；任何新執行版本或價格變化需重新準備與授權。未核發草案中的quote會過期，不能被當作永久有效價格。

**STOP FOR ARCHITECT REVIEW。不得啟動真實模型。**
