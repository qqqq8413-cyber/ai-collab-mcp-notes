# A1 操作效率量測定義

狀態：量測能力已實作／待審；產品效率尚未證明。所有本輪樣本是 **OFFLINE_SYNTHETIC**。

| 指標 | 來源與定義 | 不能推論 |
|---|---|---|
| 初次準備 | server 收到 SETUP_OPENED → 第一個 PLAN_READY | 不是完整授權／憑證設定時間 |
| 完整初次設定 | fullyAuthorizedSetupMs=null；EXE HOLD 尚未完成 | 不可把未完成填0或首份計畫時間 |
| 每次建立工作 | 同一 interactionId 的 TASK_FORM_STARTED → PLAN_READY | 缺少起點／倒退時鐘回null，不補估 |
| browser 操作時間 | performance.now 回報，單獨 clientReportedFormMs | 客戶端可偽造，不是 Authority 或精確人工投入 |
| 介入次數 | 已收到且去重的 plan ready/reuse/check/start-refused/cancel/reconcile | 不是所有 Human 介入，也不是強認證的 Human 次數 |
| HOLD／停止原因 | server refusal code、job.reason、runtime recovery event | 不能把一般錯誤推論為已扣款或模型成功 |
| Goal到成果 | Goal.createdAt → 同一 Invocation APPLIED.at，且完整結果一致 | 不以 report 存在或 COMPLETED 文字單獨計算 |
| 重啟與恢復 | RUNTIME_START；RUNNING→UNCERTAIN 的恢復事件 | 啟動≠重新派工；核對需求≠核對成功 |
| 費用 | reservation、usage計算費用與未知值分開 | 不是 provider invoice，不把未知費用填0 |

## 資料與完整性

觀察資料放在 Worker ledger 的 optional observations 區，原子寫入、checksum、單一 lease；不寫入 Authority。舊 ledger 沒有量測欄位仍可驗證讀取，不回填或改寫其 checksum。新觀察有 UUID、project、server UTC、種類、可選job／interaction、reason、evidence class與client elapsed；不含prompt、private Session或key。

最多2,000條觀察。超出後標示 observationsDropped／BOUNDED_WINDOW_WITH_DROPS，不能把視窗中的操作數冒稱終身總數。這不影響預算、Run claims、Journal、成果或 Authority 的保存。

HOLD的START仍403，但拒絕觀察持久化且同一request不重複計數。輪詢GET不算Human操作，不為量測觸發模型。RECONCILE僅保存人工核對需求，不重送、不退還預留、不改Authority或結果。

所有時間是可觀察區間，不是人的專注工時。未觀察的操作、平台外處理、憑證配置與等待審查時間若無可信起訖就保持null。時鐘倒退時不顯示負耗時。

## 後續成對比較

每個job提供comparisonKey，綁定objectiveHash、sourceSha/hash、provider/model/API、system prompt hash與輸出／delivery條件。跨不同payload／model的樣本不能當成同工作比較。

直接操作AI的baseline目前沒有資料；不自動生成或執行它。未來須取得另外授權，採同一任務／資料／模型／可接受成果及相同品質驗收，分別記錄：初次設定、每次Human主動操作、等待、介入、品質／重大錯誤、返工、取消與復原、是否再次使用。

必須保留實際provider、付費與失敗／不確定結果；不能只比較成功樣本。若直接AI沒有同模型或實際輸入證據，標示不可直接比較。不在本輪設計未經證實的節省百分比或付費轉換率。

STOP FOR ARCHITECT REVIEW。
