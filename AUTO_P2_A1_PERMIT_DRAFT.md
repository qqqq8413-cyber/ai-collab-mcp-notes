# A1 全新單次 Pilot Permit Packet 草案

**UNISSUED_NOT_AUTHORITY / REVIEW_ONLY_PRODUCTION_HOLD / INPUT_LIMIT_DECISION_REQUIRED**

這不是正式Pilot許可，沒有issuedAt／expiresAt，也不會以「允許」文字或Operational Record取代Direct Authority。舊AUTO-P2草案不自動升格或移植。

## Human只需要確認的工作內容

- 工作：只審查選定目標所指定的README說明，交付繁體中文Markdown問題清單。
- 資料：repo固定版本的README.md普通blob，≤16KB；不能讀私聊、憑證、其他專案。
- Agent：唯一limited-readme-worker；Anthropic / claude-haiku-4-5-20251001 / API2023-06-01，帳戶可用性仍未驗證。
- 上限：單次／同store累積最多US$1；一次生成／零重試／最多300秒。
- 輸出：API max_tokens2048；固定隔離outputKey/report.md≤64KB，不寫Git、不部署、不叫其他Agent。
- 輸入：仍申請4096tokens硬上限；目前未證明可強制執行，因此阻擋。200000只是保守費用預留計算依據，不是放寬授權。
- 中止：使用者取消或期限到達即中止本機HTTP；遠端狀態未知時保留預留且禁止重送，須人工核對。

## 系統自動準備的部分

Goal／Run／slice、Worker Exact SHA/codeHash、source SHA/path/hash/bytes、output key與physical store identity、完整contract、contractHash、packetHash、provider/model/API/tools/egress、quote URL/hash/check time/expiry均由準備流程產生。

提交後的新隔離預覽會產生本機`PILOT_PERMIT_PACKET_A1.json`，綁定當輪Exact SHA。內含已生成的ImplementationPacket及契約，但Architect packet／兩筆Human grants的authority欄位全為null，issuedAt/expiresAt=null，不含偽造核發文件。

不能把這份JSON直接交給--permit-config當已發許可；它不是grant copies，更不是已歸檔的DIRECT_AUTHORITY。

## 正式核發的先決條件

1. Architect接受候選，Human決定保留嚴格4096並補足可證明enforcement，或**另外**核准規格變更；本輪不選擇或降低限制。
2. 決策後的啟用／執行版本完成審查，系統重新生成契約，不能重用綁舊SHA／codeHash／source／quote或已過期的計畫。
3. 經Human另一次授權，沿既有可信activation保存Architect ImplementationPacket與Human LIVE_PROVIDER_MODEL_CALL；另保存exact contractHash的Human LIMITED_README_WORKER。principal、Run、packet、repository/slice、scope、期限及版本全部核對。
4. EXE及必要H1–H9另依既有治理核准；前述文件本身不解除這版的硬HOLD。
5. 本機專用credential及exact帳戶model/API/capabilities檢查通過。價格snapshot最長一小時有效且送出前重查；任一grant／quote較早到期就先中止。無法確定費用上界時拒絕。
6. Human明確授權一次真正付費Pilot，再做真實model／usage／結果驗收。離線fixture不算。

目前尚未核發，模型呼叫0，無正式Authority寫入。STOP FOR ARCHITECT REVIEW。
