# ai-collab-mcp — Progress Report (2026-09-06, rev. 19)

> ## 交接狀態
>
> | 項目 | 狀態 |
> |---|---|
> | Step 1–5、5.1、6、6.1 | ✅ 已完成,63 項離線測試全過 |
> | **Step 6.1 Worker Context Propagation** | **DONE —— worker input contract 已落地** |
> | **Post-6.1 SIMPLE live regression** | **DONE —— rev.7/8 共 3 種題型各 n=1,當時三段式皆完整執行** |
> | **Step 7 V1 Complexity Router** | **CODE + RUNTIME ACCEPTED —— 有界 SIMPLE direct delivery** |
> | **Step 7.1 E2E Runtime Acceptance** | **DONE —— Test A PASS / Test B PASS,詳見第十八節** |
> | **Milestone 2 scope analysis** | **DONE —— 見 `MILESTONE2_SCOPE_ANALYSIS.md`、第二十節** |
> | **Experimental Milestone 2-A Prototype** | **PRE-LIVE FINALIZED / DEFAULT OFF —— 詳見第二十一節** |
> | **M2-A Diagnostic Live #1 / #2** | **兩次皆 NOT EXERCISED —— 被兩個不同條件擋在 gate 之前,詳見第二十二節** |
> | **M2-A Controlled Replay #3** | **NOT EXERCISED —— gate 首次真正執行,但認出分歧後選擇在答案內解決,未輸出區塊,詳見第二十三節** |
> | **Claude Code handoff** | **EXECUTED —— deliverable 已產出,等 architecture review** |
> | **目前離線測試** | **208 項全過 = rev.14 的 99 + M2-A 累計 109** |
> | **Step 8 Scope Analysis** | **DONE —— runtime usage / pricing / cost / reporting 已分層,詳見第十七節** |
> | **Step 8 Implementation** | **DEFERRED —— Milestone 2 驗證後再回來** |
> | 未完成的程式修改 | **無** |
>
> **Experimental Milestone 2-A prototype 已實作,default OFF。** 關掉時的行為與回傳 payload 與 rev.14 逐欄相同,99 項既有測試無一需要放寬。新增 73 項測試涵蓋 stage 標記、call ceiling、best-effort parsing、issue 驗證、deterministic selection、selective peer context、失敗回退與 evidence 不變式。這是量測用的 prototype,不是 production feature,尚未跑過任何 live A/B/C/D。
>
> **Milestone 2 scope analysis(rev.14)。** `MILESTONE2_SCOPE_ANALYSIS.md` 依實際 code 回答全部 18 題,並修正兩處 rev.13 邊界:DEEP logical call ceiling 應寫成 `N + 4`(在 `SPECIALIST_CAP.deep` 下是 8,不是約 7),且 synthesizer 目前完全收不到 retrieval metadata —— 被要求判斷 `needs_evidence` 的 gate 會是在對它看不到的證據做推論。核心設計建議是**不要把交付物押在 parse 上**:自由文字答案在前、選擇性 JSON 區塊在後、best-effort 解析,任何解析失敗都退回今日行為。7 個 `[OPEN]` 問題待 architecture review 拍板,未經批准不進入 implementation。

## rev. 19 改了什麼(去識別化與 benchmark reset)

1. **⚠️ BENCHMARK RESET** —— `benchmark-task.mjs` 裡的公司名稱原本是真實名稱,而這個檔案在 `main` 上、公開。已換成固定佔位名稱「星芒影像工作室」。**這正是已知會讓計畫從 `deep` 變成 `normal` 的那種替換**,所以 **rev.19 之前所有 BENCHMARK_TASK 的測量值都是歷史數據,與之後的執行不可比較**。要比較前必須重新建立 baseline;佔位名稱現在自己就是控制變數,不得再改。
2. **這是一個取捨,不是清理** —— 換掉的代價是既有 benchmark 數據脫鉤,留著的代價是公司名稱持續公開。使用者選擇去識別化優先。受影響的只有 `test-chief-live.mjs` 與 `test-orchestrator.mjs` 兩個 live-only 腳本,`npm test` 的 208 項離線測試不使用 BENCHMARK_TASK。
3. **README 更新** —— 公開版原本停在「Step 7 V1 / 99 項測試」,已更新為 208 項、加入 M2-A 的 default-OFF 狀態與「三次 live 後機制後半段仍未執行」的事實,並指向 `diagnostics/m2a-live/`。發佈前的英文完整版保留為本機檔案,已加入 `.gitignore`。
4. **`.gitignore` 補洞** —— 新增 `/orchestrator-run-*.txt`(原本只擋 `.json`,一份含真實公司名稱的 2,355 行執行紀錄因此暴露在 untracked 狀態)與 `*.local.md`。
5. **決定不改寫歷史** —— `eabae9e` 的兩個 harness 檔含本機使用者名稱(暫存路徑),tip 已在 `27a743c` 修掉。**不做 history rewrite**,因為每一個 commit 的作者欄位本來就是 `qqqq8413 <qqqq8413@gmail.com>` —— 移除路徑裡的名字、卻留著每個 commit 上的 email,是形式而非實質。若之後要處理身分揭露,對象應該是 commit 作者資訊,那需要改寫全部歷史並調整 git config。
6. **未修改任何 runtime** —— `src/` 與 `d1d1d28` 逐位元組相同,`npm test` 208 passed / 0 failed。

---

## rev. 18 改了什麼(Controlled Frozen Round-1 Replay)

1. **不再靠自然任務碰運氣** —— 改用 controlled frozen Round-1 replay,直接把一份合法的 `deep` / `SUCCESS` / N=2 / 帶明確 B vs C 衝突的 synthetic snapshot 送進真實 downstream path。
2. **不需要任何 bypass flag** —— 既有的 `replaySynthesis()` 就足以讓合法 snapshot 進入 `runSynthesisStage()`,也就是 live 路徑本身。沒有新增 `forceCollaborationGate` 之類的 runtime trigger,production execution semantics 未被污染。
3. **gate 第一次真正執行了** —— 附錄、40 個 deterministic reference(`business_strategist:p1…p18`、`brand_creative:p1…p22`)、max-one 規則都以 captured prompt 驗證確實送達模型。
4. **但仍是 `NOT EXERCISED`** —— `SKIPPED / no_issue_block`,`issues.emitted = 0`。
5. **⚠️ 失敗的原因與預期完全不同** —— gate **認出了**那個分歧。它的回答裡有一段標題是「專家分歧與如何處理」,精準點名 B vs C 與雙方論據,然後把 C 當作 Kill Switch 整合進 B 的方案裡。**它在答案內解決了衝突,因此依附錄自己的規則不該提報。** 這不是 recall 問題,是通道問題,兩者修法完全不同。
6. **新增一條工程原則** —— 見第十五節:同一次呼叫同時被要求「解決衝突」與「回報未解決的衝突」,做好前者就消滅了做後者的理由。
7. **未觸發路徑在真實執行中再次成立** —— provisional answer 完整交付且與 gate 回應逐字元相同、`finalOutput == banner + gate 回應`、evidence label 以凍結 Round 1 獨立重算一致、唯一一次呼叫無 retrieval。
8. **證據保存** —— `diagnostics/m2a-live/controlled-replay/`,含逐字 fixture(task、兩份 mission、兩份 synthetic Round 1)、fixture hash、harness、完整 artifact(gate prompt 與回應原文)。
9. **未修改任何程式** —— `src/` 與 `d1d1d28` 逐位元組相同,`npm test` 208 passed / 0 failed。本次 commit 只新增 diagnostics 與文件。

---

## rev. 17 改了什麼(兩次 Diagnostic Live 的結果)

1. **兩次 live 都執行了,兩次都 `NOT EXERCISED`** —— targeted peer challenge 機制到目前為止**一次也沒有被真正執行過**。這不是 runtime 缺陷:兩次都沒有出現任何 defect,但也沒有任何一次讓 gate 有機會運作。
2. **阻擋點是兩個不同的條件** —— #1 是 `single_specialist_no_peer`(Chief 只派 1 位),#2 是 `complexity_not_deep (normal)`(Chief 派了 2 位,但把任務判為 normal)。修掉其中一個不會讓另一個消失。
3. **Planning Reachability 在 #2 通過** —— 在一個同時具備商業可行性、市場需求判讀、品牌定位三種資訊的固定 fixture 上,Chief 自行派出 2 位專家(business_strategist + brand_creative),並明確排除 market_researcher,理由是 fixture 已寫明不需外部搜尋。`planningAdjustments` 為空,沒有任何 enforcement 介入。**這是 Chief 自己的判斷,不是被規則逼出來的。**
4. **兩次的 runtime 不變式都成立** —— gate 未啟動時 synthesis prompt 不含附錄(以實際 captured prompt 驗證)、`finalOutput` 逐字元等於 `banner + synthesis 原文`、evidence label 以 Round 1 結果獨立重算一致、四次/三次呼叫皆無 retrieval request、call ceiling respected。
5. **保存完整證據** —— `diagnostics/m2a-live/` 收錄兩次執行的 artifact(含每次呼叫的 prompt 原文與回應原文)、harness 與 #2 的逐字 fixture。harness 是 pass-through recorder,參數原封轉給真正的 `callProvider`,runtime 行為未改變。
6. **未修改任何程式** —— 兩輪 diagnostic 期間 `HEAD` 始終是 `d1d1d28`,working tree 全程 clean。本次 commit 只新增文件與證據。
7. **修正審查包的一句過期敘述** —— 舊版結尾寫「一次 live 都還沒跑過」,現已改為「跑過兩次,機制仍未被執行」,以免審查者以為機制已被實測。

---

## rev. 16 改了什麼(M2-A Pre-Live Finalization)

1. **Deterministic chunk reference 取代 head slice** —— Round 1 輸出由 runtime 依空白行切成 `p1`、`p2`…,`sourceRef` 改成 `<agentId>:<chunkId>`。offset 全部由 runtime 產生並記錄,模型從不提供 offset,也沒有 fuzzy quote matching。`output.slice(0, limit)` 已移除:被挑戰的內容通常不在回答開頭,拿開頭充數會讓 Round 2 在回應一段不相關的文字。
2. **bare `<agentId>` 只在無歧義時接受** —— 該專家的回答只有一個 chunk 時可用,否則拒絕並回報可用的 passage 清單。用「取開頭」來解歧義,正是這次要修掉的東西。
3. **Gate 明示最多一個 peer challenge** —— 附錄加入「At most one … select only the one whose resolution would have the greatest effect on the final decision」。模型違規回多個時,runtime 用既有的固定排序取一個並記一條 note,**不新增 severity 評分呼叫、不建 ranking 子系統**(測試斷言違規情況下呼叫數仍是 N+4)。
4. **Decision Synthesis 中立性守則** —— 明確要求「不得因為較新或屬於修訂版就視為較正確;revision、recency、專家彼此同意都不是證據」。同時保留:未解分歧可以明示、不強迫 consensus、peer agreement 不提升 evidence status(測試斷言 prompt 中不出現任何要求達成共識的措辭)。
5. **Parser edge cases 補齊** —— 四種情境端到端驗證:結尾的一般 JSON 範例不被誤剝、合法區塊被解析且從使用者可見答案中移除、malformed 區塊仍交付 provisional 且報告記下 parse failure、只有區塊沒有答案時 graceful fallback。四種都斷言 `RunStatus` 不受影響。
6. **frozen Round-1 replay** —— 新增 `replaySynthesis()` 與 `toRound1Snapshot()`。凍結同一份 Round 1,只重跑 synthesis,即可比較 B(既有 prompt)與 B′(gate prompt + Round 2 關閉)。它呼叫 live path 同一個 `runSynthesisStage()`,不是第二份實作 —— 否則 replay 量到的是另一個系統。
7. **`disableRound2` 成為正式 config** —— 這就是 arm B′,live 與 replay 都能用。
8. **provisionalAnswer 保存在每一次 gate 有跑的執行** —— 讓 `C_provisional` vs `C_final` 成為**同一個任務內**的配對比較。`chunkMap` 也一併保存,讓被拒絕的 sourceRef 可以事後稽核。
9. **⚠️ 推翻我 rev.15 寫的識別策略** —— 用 SKIPPED vs COMPLETED 估計 peer interaction 效果有 selection bias,已停用。詳見第二十一節。
10. **測試** —— 175 → 208(本輪新增 33)。0 failed。未跑 live。
11. **未改動** —— `policy.ts`、`chief.ts`、`registry.ts`、`capabilities.ts`、`debate.ts`、`pipeline.ts` 與三個 provider adapter 全部 byte-identical;`RunStatus`、`EvidenceLabel`、retrieval、Step 7 的判定與快速路徑均未觸碰(以 `git diff` 驗證)。

---

## rev. 15 改了什麼(Experimental Milestone 2-A Prototype)

1. **實作 targeted peer challenge,default OFF** —— `Chief → Round 1 → Synthesis Gate →(有 decision-sensitive peer challenge 才)Round 2(最多 1 位)→ Decision Synthesis`。開關是 `experimental.collaboration.enabled`,不給就完全走舊路徑:stage 序列、`finalOutput`、回傳物件的 key 全部與 rev.14 相同,測試逐項比對過。
2. **先換掉會壞掉的測試基礎設施** —— `CallStage` 成為 `CallOptions` 的顯式欄位(`planning` / `round1_worker` / `synthesis` / `synthesis_gate` / `round2_worker` / `decision_synthesis`)。舊 harness 用「沒有 system prompt」判定 synthesis,M2 加入第二個 synthesis 等級呼叫後必然誤判。三個 provider adapter 都不 spread `CallOptions`,所以這個標籤不可能流進任何廠商 API。
3. **交付物不押在 parse 上** —— gate 先寫完整答案,再選擇性附一個 fenced JSON 區塊。區塊不存在、JSON 壞掉、schema 不符、agent 不存在、issue 不合格,五種情況全部退回 provisional answer 加一條註記,run 不會 FAILED。只有結尾、且內容含 `collaborationIssues` 的區塊才會被當成 metadata —— 答案裡真正的 JSON 範例不會被吞掉。
4. **`sourceRef` 必須是不同的 agent** —— 自己引用自己會被擋下並記為 `self-review, not a peer challenge`。這不是潔癖:允許它就等於讓 arm C 混進 arm D 的行為,實驗會用錯誤的方式回答自己的問題。
5. **deterministic selection** —— 多個合格 issue 時依「被挑戰者在 assignment order 的位置 → 挑戰來源的位置 → gate 產出順序」固定排序取一個。不隨機、不再問模型、不全部執行。同一份 gate 輸出永遠選到同一個 issue。
6. **selective peer context** —— Round 2 只收到 original task、自己的 mission、自己的 Round 1 輸出、**一段** peer excerpt 與**一條** challenge。測試明確斷言第三位專家的輸出**不在** prompt 裡。沒有重用 `run_debate` 的 full-broadcast。
7. **excerpt 是 runtime 擷取的,不是模型給的 offset** —— 由 runtime 從 `sourceRef` 的 Round 1 輸出取前 N 字元,記錄 `startChar` / `endChar` / `truncated` / `charLimit`。`peerExcerptChars` 是 configurable experimental parameter,預設值沒有任何實測支持,每次執行都把實際用值寫進報告。
8. **Round 2 不做 retrieval** —— 即使被挑戰的專家是 `evidenceCapable` 也不掛。`needs_evidence` 只記錄不執行。理由是隔離變因:同時加入 peer interaction 與新的外部檢索,之後就無法分辨改善來自哪一個。
9. **Evidence 不變式由結構保證** —— Round 2 的輸出不進 `workerResults`、不進 `summarizeRetrieval`、不進 `deriveEvidenceLabel`。banner 一律由 Round 1 的 report 產生。測試斷言 label 與 banner 在開關兩種狀態下完全相同,且沒有任何路徑能產生 `EVIDENCE_BACKED`。
10. **失敗一律回退到 provisional answer** —— Round 2 失敗或 Decision Synthesis 失敗,`answerSource` 保持 `round1_provisional`,`RunStatus` 保持 Round 1 語意。Round 1 已經付過錢,M2 的任何失敗都不該讓使用者失去那份工作。
11. **獨立 `CollaborationReport`** —— `NOT_TRIGGERED` / `SKIPPED` / `COMPLETED` / `FAILED` 四態、reason、selected issue、round2 agent、`answerSource`、peer excerpt metadata 與獨立 timings 區塊。既有 `planningMs` / `workersMs` / `synthesisMs` / `totalMs` 語意與形狀未動。
12. **修正 rev.14 的一條原則** —— 使用者指令第 14 條推翻了我寫的「觸發率就是 kill criterion」。低觸發率同樣可能代表 gate 精準。觸發率降為 diagnostic,真正要量的是 triggered usefulness。詳見第十五節。
13. **控制組被證明沒有漂移** —— 為了做出 gate 版本,synthesis prompt 被抽成變數。arm B 是實驗的控制組,這種重構正是會靜靜搬動一個換行的地方,而漂移過的控制組比沒有控制組更糟 —— 之後每一個 C 對 B 的差異都會有一部分是這次編輯造成的。因此加了測試,用 M2 之前的寫法重建 prompt 並逐位元組比對(SUCCESS 與 DEGRADED 兩種情況),並斷言 gate 版本是「控制組 prompt + 附錄」,沒有刪去任何東西。
14. **測試** —— 99 → 175(新增 76 項)。0 failed。未跑任何 live benchmark。

---

## rev. 14 改了什麼(Milestone 2 Scope Analysis)

1. **產出 `MILESTONE2_SCOPE_ANALYSIS.md`** —— 依 `CLAUDE_CODE_HANDOFF.md` 的 deliverable 逐條回答 18 個問題,每個主張標記 `[FACT]` / `[DESIGN]` / `[SIGNAL]` / `[DECISION]` / `[OPEN]`,把「code 讀出來的事實」與「還沒有證據的設計選擇」分開,不讓提案借用觀測的可信度。
2. **修正 call ceiling 的寫法** —— rev.13 的「deep logical call ceiling 候選約 7」只對三專家計畫成立。Planning 是 bounded-not-deterministic(同一 DEEP task 實測出現過 2 與 3 個 mission),上限必須寫成 `N + 4`;在 `SPECIALIST_CAP.deep = 4` 下是 8。否則一次合法的四專家執行會被誤讀成違規。
3. **確認 synthesizer 看不到 retrieval metadata** —— synthesis prompt 只拿到 original task 與每個成功 worker 的 `agentId` / `mission` / `output`。**寫出最終答案的模型從來沒看過檢索到哪些來源**;source URL 只進到 report 與 banner。要 gate 判斷 `needs_evidence`,必須先補這條輸入,這是 M2 的前置改動而非附帶效果。
4. **交付物不得押在 parse 上** —— 目前 orchestrator 只有一個 parse 依賴(Chief 計畫),且它失敗在任何 worker 花錢之前。Synthesis gate 會加上第二個 parse 依賴,位置在所有 worker 成本已付出之後(實測 DEEP 為 232.9s),且就在產生交付物的那一次呼叫上。因此建議自由文字在前、選擇性 JSON 在後、best-effort 解析,解析失敗等於現狀加一條註記。
5. **主要風險是 latency,不是 correctness** —— synthesis 已是最慢單一階段(110.4s / 251.3s,44%),觸發路徑等於再加一次 synthesis 等級呼叫。新增一條 handoff 未列的 kill criterion:**若 gate 幾乎不觸發,C 就等於 B 再加一個浪費在關鍵路徑上的結構化輸出要求;觸發率本身就是停止條件,而且比品質更早可量測。**
6. **實驗設計的兩個 code-level 阻礙** —— E1:只有 `gemini-3.1-pro-preview` 的 `grounded_retrieval` 是 `enabledInRuntime: true`,arm A 的檢索對等目前只能是 Gemini,否則全部 arm 關檢索、證據維度整個離開實驗(Q-B)。E2:banner 會把 `PARTIALLY_GROUNDED` / `DEGRADED` 印在交付物第一行,評估者一眼看出 arm,必須比較去掉 banner 的文字。
7. **一個會壞掉的測試基礎設施** —— `test-execution-policy.mjs` 以「沒有 system prompt」辨識 synthesis 階段。M2 引入第二個 synthesis 等級呼叫後,任一個帶 system prompt 就會被誤判成 worker。必須在寫 M2 測試之前換成明確 stage 標籤,否則呼叫數斷言會安靜地量錯東西。
8. **兩處交接快照不一致(皆非 runtime 缺陷)** —— D1:本地工作目錄不是 git checkout,無法 diff/revert,實作 M2 的人應該用 clone;改以逐位元組比對確認五個關鍵原始碼檔與遠端 `main`(HEAD `656d7b6`)相同。D2:`regressions/step7-1-e2e/SIMPLE-direct/normalized-result.json` 仍寫 `outcome: FAIL`,那是 rev.12 已記錄且已在 `run-case.mjs` 修掉的 harness false negative,artifact 未重跑。
9. **本輪範圍** —— 只做 scope analysis。未修改 `src/`、prompts、tests、retrieval、Step 7/8/9/10 runtime,未執行 live benchmark;`npm test` 99 passed / 0 failed。

---

## rev. 13 改了什麼(Claude Code Handoff / M2 Candidate Downscale)

1. **完成乾淨交接** —— 新增 `CLAUDE_CODE_HANDOFF.md`,整理 current runtime facts、Milestone 2 候選架構、hard boundaries、實驗設計、code-reality questions 與明確禁止事項。下一個 deliverable 是 `MILESTONE2_SCOPE_ANALYSIS.md`,不是 runtime code。
2. **候選架構縮減** —— 原本的 independent Chief Review + 全員 Round 2 + Chief Decision 方案不採用。現候選為既有 Round 1 後的 synthesis gate;只有 decision-sensitive cross-agent issue 才觸發最多 1 位 specialist 的 targeted Round 2,再做 decision synthesis。總 rounds 上限 2,deep logical call ceiling 候選約 7。
3. **Review 證據定位** —— Claude 與 Gemini 的 independent architecture reviews 都警告重複 call、full broadcast/context growth、過早 taxonomy 與「多 token」confound;GPT 後續整合成較小候選。這些是 convergent review signals,不是 empirical proof,Claude Code 必須回到 repository code 驗證。
4. **已確認 code reality** —— 現有 `run_debate` 每輪將所有其他 panelist 的完整答案廣播給每位 panelist,所有 panelists 都執行,round count 固定,最後另呼叫 Judge;它沒有 orchestrator 的 dispatcher injection、run status、retrieval report 或 timings。現有 orchestrator 是 planning → parallel workers → optional synthesis,而 synthesis prompt 只接 Worker 文字,不接 retrieval metadata。
5. **Evidence invariant** —— collaboration 只能暴露不確定性、衝突與 evidence gap,不得提升 `evidenceLabel`。`groundingSupports` 目前只存在 provider raw metadata,沒有 runtime consumer;M2 目前不能做 claim-level evidence validation,該能力仍屬 Step 10。
6. **Productionization gate** —— scope analysis 必須設計 A 強單模型、B 現有 orchestrator、C targeted peer interaction、D 單模型 self-review 的 ablation。只有 C 對 B 有 material improvement,且增益不能合理由 D 解釋,才值得 productionize;不先捏造百分比門檻。
7. **本輪驗證與範圍** —— `main` 與 `origin/main` 同步,以 rev.12 commit `97e89d8d5b8ad9375b6d8fff232b3ca43aaa9b53` 為起點;`npm test` 99 passed / 0 failed。未修改 `src/`、prompts、tests、retrieval、Step 7 或 Step 8/9/10 runtime,未執行 live benchmark。

---

## rev. 12 改了什麼(Step 7.1 E2E Runtime Acceptance)

1. **Test A PASS** —— 固定 `SIMPLE_TASK` 經 MCP production path 實跑:planning 7.318s、worker 5.216s、synthesis 0、total 12.534s;`simple`、1 assignment、`SUCCESS`、2 logical model calls、`policy.synthesize=false`、正確 reason,且 `finalOutput === Worker raw output`。
2. **Test A 內容驗收** —— 5% 含稅金額 A=50,400、B=55,125、C=48,090 與 C→A→B 排序正確;繁中、constraints、format、readability 均 PASS。輸出偏長並帶 mission-scope 結尾,記為 cosmetic presentation variance,不是 correctness regression。
3. **Test A harness false negative 完整保留** —— 初版 checker 未移除 Markdown emphasis/punctuation,把正確輸出誤判 FAIL。修正 local normalization 後以同一 raw response重驗 PASS,未重燒 API、未改 runtime。
4. **Test B attempt 1 = TEST NOT EXERCISED** —— 初版 task 只描述新服務提案,未定義 major investment/high stakes;依 Chief 既有「按 stakes 判級」規則合理回 `normal`。該次仍自然選研究能力並完成 6 queries / 20 sources、metadata preservation 與 synthesis,但沒有進入 DEEP evidence-label branch。完整 raw evidence 保留。
5. **Test B PASS** —— 只修正 fixture stakes,不指定 agent/provider/model。Chief 回 `deep`,自然選 3 capabilities;三 Worker 全成功。`market_researcher` 實際 `GROUNDED`,回報 6 queries / 21 sources及 `webSearchQueries`、`groundingChunks`、`groundingSupports`;report counts/sources 保留一致。
6. **Synthesis / evidence semantics PASS** —— 5 logical model calls;planning 18.854s、workers 122.082s、synthesis 110.377s、total 251.313s;policy 為 collaborative / synthesize=true / `non_simple_execution`;report 為 `PARTIALLY_GROUNDED`,finalOutput 以 exact「claims not yet validated」banner 開頭,從未宣稱 `EVIDENCE_BACKED`。
7. **證據與完整性** —— `regressions/step7-1-e2e/` 保存 fixtures、harness、raw MCP responses、normalized results、manual evaluations、timestamps、runtime fingerprints 與 `hashes.json`;offline verifier 對 A/B 皆 PASS 且 hash seal VERIFIED。未保存 API keys或 `.env`。
8. **驗證與 scope** —— 本輪開始前重新 build 實際專案、確認 repo/project `src/` 一致,並重跑 `npm test`:99 passed / 0 failed。只有 harness、evidence 與 HANDOFF 變更;本輪未確認需修復的 runtime defect、沒有 runtime code 修改、沒有開始 Milestone 2 或 Step 8 implementation。

---

## rev. 11 改了什麼(Step 7.1 + Milestone 2 Roadmap Decision)

1. **Step 7 不回滾,但拆開兩種 acceptance** —— 99 項離線測試證明 implementation 符合 specification,不證明未來所有 SIMPLE output 都具高品質。Step 7 V1 為 code accepted;production/runtime acceptance 尚待 Step 7.1。
2. **新增 Step 7.1 Test A** —— 跑一次真正的 SIMPLE direct-delivery E2E,驗證 planning → worker → direct delivery、2 model calls、`SUCCESS`、`policy.synthesize=false`、正確 reason、`synthesisMs=0`、`finalOutput === Worker raw output` 與 MCP consumer 可正常讀取。
3. **新增 Step 7.1 Test B** —— 跑一次明確需要最新外部證據的 DEEP grounded E2E,驗證 Chief 自然選到 evidence-capable specialist、實際 search、`GROUNDED` metadata/sources 保存、synthesis 執行,以及 `PARTIALLY_GROUNDED` banner/warning/source information 正確。
4. **不擴張錯誤修法** —— 不加入 readability regex,不新增一個 LLM quality gate,也不把 DEEP 重跑擴成 n=5 latency/planning distribution 研究。Direct delivery 目前只支持「未觀察到 material correctness regression」,不保證 presentation 與 synthesis 逐字等質。
5. **插入 Milestone 2** —— Step 7.1 通過後不直接實作 Step 8,先做 True Multi-Agent Collaboration scope/acceptance:Round 1 多專家產出 → Chief 找出 disagreement/gaps → Round 2 針對彼此輸出交叉挑戰/修正 → Chief Decision。
6. **北極星與證據層級** —— Milestone 1 已證明 pipeline/orchestrator/debate 基本協作可運作;Milestone 2 要回答「三模型互補是否明顯優於單模型」,不是只證明三個 API 可並行。證據強度依序為 runtime measurement、code/deterministic tests、independent external evidence、multi-model critique、single-model reasoning;模型收斂不是獨立實證。
7. **Step 8 狀態** —— scope analysis 已完成且保留;implementation 順序改到 Milestone 2 之後。本輪只更新 roadmap/documentation,未執行 Step 7.1、Milestone 2 或 Step 8 implementation。

---

## rev. 10 改了什麼(Step 8 Scope Analysis)

1. **Step 7 freeze** —— 使用者已驗收 Step 7 V1;本輪不修改 execution policy、runtime 或測試。
2. **Usage code reality** —— OpenAI `response.usage`、Anthropic `response.usage`、Gemini `response.usageMetadata` 在現行 SDK/API response 可取得不同程度的 metadata,但三個 adapters 都未把它帶出 `CallResult`。
3. **Timing code reality** —— orchestrator 以 `Date.now()` 保存 planning/workers/synthesis/total phase wall time;`workersMs` 是平行 worker span,不是 call duration 總和。pipeline/debate 沒有 run-level timing/usage report。
4. **四層責任分離** —— runtime usage truth、versioned pricing registry、pure cost calculation、run-level reporting 不混用;unknown/partial/reported zero 必須可區分。
5. **V1 建議** —— 先做 provider-native usage extraction、monotonic per-call duration、deterministic call ledger 與 coverage-aware token/latency aggregation。Pricing/cost interfaces 可先定義,但 price book 保持空,不得產生假美元總額。
6. **文件與狀態** —— 完整 schema、provider gaps、資料流、測試策略、scope 與 review questions 見 `STEP8_SCOPE_ANALYSIS.md`。本輪只有文件,Step 8 implementation 仍為 NOT STARTED。

---

## rev. 9 改了什麼(Step 7 V1 Implementation)

1. **使用者正式批准 Step 7 V1** —— 依 rev.8 的三種 SIMPLE 題型證據實作有界 fast path;舊版「不要開始 Step 7」是當時的限制,本輪已被新要求取代。
2. **獨立 Execution Policy** —— `src/agents/policy.ts` 的 `deriveExecutionPolicy(facts)` 集中判斷,不讀取 provider/model 身分。orchestrator 根據 plan、實際 Worker 結果與 retrieval request facts 推導 `report.policy`。
3. **Direct Delivery** —— 合格任務只呼叫 planning + worker;`finalOutput` 為 Worker 原文,無改寫/翻譯/格式化/額外 model call,保留 `synthesisMs: 0` 與其餘 timing 欄位。
4. **既有行為與稽核** —— 保留 Run Status、evidence banner、grounding metadata、Chief/Worker prompts、角色與模型綁定。`synthesisAllowed` 仍是失敗保護,實際執行決策由 `report.policy.synthesize/reason` 表示。兩個既有 live 測試腳本的呼叫數/輸出標籤同步讀取 policy,本輪未執行它們。
5. **離線驗證** —— `npm test` 通過 **99 項**;新增 36 項涵蓋 eligibility、raw bytes、timings、report、retrieval、失敗、異常狀態與 model independence。既有 Step 6.1 三項測試仍通過,SIMPLE-2/3 只使用已存原文做離線 replay。
6. **程式碼納入 Git** —— 經使用者確認,沿用 `ai-collab-mcp-notes/main`,納入可建置 source、lockfile 與測試。先以 `de876be` 匯入未修改的 Step 6.1 baseline,再獨立提交本輪 diff。`.env`、`node_modules/`、`dist/` 不入 Git;原 `AI Agent/` 同步本輪變更。

---

## rev. 8 改了什麼(SIMPLE-2 / SIMPLE-3 Worker Readiness)

1. **確認起點** —— 遠端 `ai-collab-mcp-notes/main` 為 rev.7,commit `fc19711e26e4b63dfd2d379d8460e51ce2b2472f`。
2. **新增兩種 SIMPLE live cases,各跑一次** —— SIMPLE-2 測嚴格 Markdown 表格與條件/排除項保留;SIMPLE-3 測短摘要的最終決議與未定事項保留。目的為評估 Worker 可否原樣直接交付,不估計 latency distribution。
3. **保持既有三階段與 roster** —— Chief 自行分類與選專家,未覆寫 Chief prompt、Worker contract 或角色;兩題皆 `simple`、1 assignment、`SUCCESS`,synthesis 完整執行。
4. **品質結果** —— 兩題 Worker 的 correctness、language、format、constraints、mission scope、user-facing readiness 皆 PASS;兩題 Synthesis 都與 Worker 逐字相同。
5. **證據與驗證** —— 第十二-C節記錄 task、Chief mission、Worker / Synthesis raw output、metadata、latency 與評估;`regressions/simple-readiness/` 保留 fixture、harness、原始 MCP 回應、JSON 與檔案雜湊。證據驗證通過。
6. **程式範圍** —— 本輪只有測試/證據與交接文件變更。專案 `src/`、`dist/` 與原 baseline 未變,Step 7 仍未實作。63 項離線測試為 rev.6 的既有通過紀錄,本輪未重跑該套件。

---

## rev. 7 改了什麼(Post-6.1 SIMPLE live regression)

1. **確認遠端狀態** —— `ai-collab-mcp-notes/main` 在本次開始時仍停在 rev.5,rev.6 尚未同步。
2. **用完全相同的 SIMPLE baseline 重跑 live regression** —— task 仍來自 `benchmark-task.mjs` 的 `SIMPLE_TASK`。
3. **未開始 Step 7** —— execution path 仍是 planning → worker → synthesis,API calls = 3,沒有 single-specialist fast path。
4. **觀察結果** —— Chief mission 仍是英文;Worker 在 Step 6.1 contract 下產出中文;Synthesis 輸出中文且更短。
5. **完整紀錄** —— Chief mission、Worker 原始輸出、Synthesis 原始輸出與 latency 見第十二-B節。

---

## rev. 6 改了什麼(Step 6.1 Worker Context Propagation)

1. **修復 Worker Context Loss** —— Worker 呼叫現在透過 `buildWorkerPrompt(task, mission)` 同時帶入 Original User Task 與 Assigned Mission。
2. **保留 Mission Scope** —— worker contract 明確要求只執行 Assigned Mission,不得接管完整任務或做跨專家最終決策。
3. **新增離線測試** —— 驗證 Language / Format / Constraint / Scope / Explicit Exclusion 五個 task-level context 維度會出現在 worker prompt,並驗證 scope takeover 防線。
4. **未開始 Step 7** —— synthesis 邏輯、execution policy、direct/fast path 均未修改。
5. **63 項離線測試全過**:`npm test`。

---

## rev. 5 改了什麼(SIMPLE baseline + Step 6.1 前置項目)

1. **首次量測了 simple 任務** —— 先前 6 次量測全部是 deep(第十二節)
2. **發現 Worker Context Loss** —— Worker 在 delegation boundary 看不到 Original User Task(第十三節)
3. **Step 7 的 V1 提案被推翻** —— 「單一專家跳過 synthesis」會造成輸出回歸,不是優化(第十三節)
4. **新增 Step 6.1** 作為 Step 7 的前置條件(第十四節)
5. **未修改任何程式碼**

---


> **立場揭露(沿用前版):** 第六節那個問題,兩位讀者都不是中立第三方。Gemini 是被討論要不要繼續使用的對象;GPT 既是做出排除決定的 Chief(`gpt-5`)也是被選用的 `brand_creative`(`gpt-5`)。
>
> **但 rev. 4 對這件事有一個結構性的新發現 —— 見第五-E 節。簡短版:Chief 從來就看不到哪個專家背後是哪家模型。** 前三版關於「Chief 對 Gemini 的偏誤」的所有討論,包括兩位審查者各兩輪、共四份回答,都建立在一個它不可能做到的行為上。

## rev. 4 改了什麼(Step 6)

1. **Chief of Staff System Prompt 完成**(§23 第 6 項)—— 常設簡報與單次任務指令分到兩個欄位(第五-E 節)
2. **發現「能力優先於模型」一直是結構性成立的** —— Chief 收到的名單只有 id 和 role,沒有 provider(第五-E 節)
3. **修掉一個我自己製造的比較謬誤** —— 驗證腳本用了不同的 task 字串,基準任務已抽成單一來源(第五-F 節)
4. **60 項離線測試 + 8 項真實規劃驗證**,全數通過

## rev. 3 改了什麼(Step 5、5.1)

1. **發現 rev. 2 的 Evidence Label 在說謊** —— 三個 provider 都沒有接上任何檢索,`EVIDENCE_BACKED` 標記的是意圖不是事實(第五-A 節)
2. **Model Capability Registry 完成**(§23 第 5 項),把「廠商有沒有」和「我們接了沒有」拆成兩個欄位(第五-B 節)
3. **Grounded Retrieval MVP 完成**(Step 5.1),Gemini Google Search 已接上並實測通過(第五-C 節)
4. **`EVIDENCE_BACKED` 這個標籤被移除** —— 最高只能到 `PARTIALLY_GROUNDED`(第五-D 節)
5. **49 項離線測試 + 6 項真實 grounding 實測**,全數通過

## rev. 2 改了什麼

1. 新增第 3 項功能:Run Status / Evidence Label(第五節)
2. 第 5 次執行推翻了 rev. 1 的核心前提 —— Chief 這次**選了** Gemini(第六節)
3. §25 穩定度的說法改弱 —— `normal` 已驗證,`deep` 未驗證(第八節)
4. 新增 GPT 與 Gemini 的審查結果與已採行的決定(第七節)

---

# 一、這個專案是什麼

## 目標

讓 Claude、GPT、Gemini 三家模型在同一個工作流裡協作,而不是各自獨立回答。以 **MCP(Model Context Protocol)server** 的形式實作,任何 MCP client(Claude Code、Claude Desktop、Cursor 等)都能直接呼叫。

## 技術棧

```
TypeScript (ESM) + @modelcontextprotocol/sdk + zod
```

## 三種協作模式(已全部跑通)

| 模式 | 機制 |
|---|---|
| **`run_pipeline`** | 接力式管線。上一步的輸出經 `{{input}}` 模板成為下一步的輸入 |
| **`run_orchestrator`** | 任務分工。一個模型當 Chief 負責拆解與分派,多個 worker 各自執行,最後由 synthesizer 整合 |
| **`run_debate`** | 多模型辯論。各自獨立作答 → 互相批評修正 N 輪 → judge 裁決 |
| **`list_providers`** | 檢查三家 API Key 設定狀態 |

## 目前的角色分工(orchestrator 模式)

| 角色 | 模型 | 職責定義 |
|---|---|---|
| **Chief**(規劃者) | `gpt-5` | 判斷複雜度、決定需要哪些能力、分派 mission |
| `business_strategist` | `claude-sonnet-5` | 商業模式、財務邏輯、商業風險、策略漏洞、可行性、反方觀點 |
| `market_researcher` | `gemini-3.1-pro-preview` | 市場情報、競品、客群、成長機會、外部環境、**證據蒐集** |
| `brand_creative` | `gpt-5` | 品牌策略、Creative Direction、產品化設計、服務設計、差異化 |
| **Synthesizer**(整合者) | `gpt-5` | 把所有 worker 產出整合成單一答案 |

## 架構文件的關鍵原則(你需要知道的節錄)

這個專案照著一份內部架構文件開發,以下幾條與後面的討論直接相關:

- **§4 Minimum Sufficient Collaboration** — 目標不是「用最多 agent、想最多」,而是用**最少的專家、最小的 context**達成足夠好的決策。
- **§5 Multi-Agent only when necessary** — 單一模型能解的事就不要動用多模型。
- **§9 Agent Capability Pool** — 把 Gemini 定位為 `Intelligence / Context` 層,負責 research 與 **evidence gathering**。
- **§14 Complexity Router** — 任務分三級:
  - `simple`(最多 1 位專家):計算、格式化、短摘要、單一資訊處理
  - `normal`(最多 3 位):報價分析、腳本評估、商業提案、一般專案決策
  - `deep`(最多 4 位):**公司年度策略**、重大投資、高風險合約、財務策略、大型品牌專案
- **§17 Run Status** — 讓 worker 失敗在最終結果上可見,而不是靜默降級。**(本次已實作)**
- **§19 Validation Layer**(尚未實作) — 在 worker 完成後檢查產出是否有未經證據支撐的重大假設。
- **§23** — 開發順序。**§24** — 明確不做的項目。**§25** — 驗收標準。**§28** — Chief Planning Protocol V1 的要求清單。

## 測試用的 task

為了讓測試有真實難度,用的是一個真實的商業規劃需求。以下以 **Studio X** 代稱(一家中小型影像製作公司):

```
請規劃 Studio X 2027 年如何提升:
1. 營收  2. 品牌影響力  3. 案源品質
請提出可執行的成長策略。
```

這個 task 之所以適合當測試案例:它同時需要商業、市場、品牌三種能力,而且**照 §14 的定義屬於 `deep`(公司年度策略)** —— 剛好可以用來驗證 complexity 分類是否正確。

---

# 二、Milestone 1 驗證結果(已完成)

## `run_pipeline` ✅

```
Input → OpenAI (gpt-5) → Claude (sonnet-5) → Gemini (3.1-pro-preview) → Final
```

**品質觀察**:GPT 提三大策略 → Claude 抓出產能假設過樂觀 / 目標市場是紅海 / CAPEX 沒列回本期 / KPI 只看營收 → Gemini 整合成「1 主線 + 1 副線 + 1 實驗」的分階段方案。**Claude 的批判確實被 Gemini 吸收進最終版**,不是各說各話 —— 這是接力模式真的有效的證據。

## `run_orchestrator` ✅

13 個子任務全數完成、0 失敗、整合出 8,614 字策略文件。角色分派合理(市場研究給 Gemini、品牌創意給 GPT、商業風險給 Claude)。

---

# 三、修正記錄

## 帳務問題(非程式問題,已處理)

1. **OpenAI**:`429 no credits remaining` → 已儲值
2. **Gemini**:`429 quota exceeded` → 原本 Free tier,已開通 billing 並購買 prepay credits

## Bug 1 — OpenAI 參數名稱過時

`gpt-5` 不再接受 `max_tokens` → 改用 `max_completion_tokens`。

## Bug 2 — Gemini 預設模型已下架

`gemini-2.5-pro` 已停止提供給新用戶 → 改用 `gemini-3.1-pro-preview`。

## Bug 3 / 4 — 推理模型的思考額度吃掉正文(最關鍵)

### 現象
Orchestrator 第一次跑,6 個 worker 任務中**有 2 個回傳 0 字元**,流程不報錯,空字串被直接送進整合階段。

### 根因(實測數據)

三個模型**全部**都會先思考再回答,而**隱藏的思考 token 跟正文共用同一個輸出額度**:

| 模型 | 輸出額度 | 思考用掉 | 結果 |
|---|---|---|---|
| claude-sonnet-5 | 4096(用滿) | **3147 (77%)** | `stop_reason: max_tokens`,正文被截斷 |
| gpt-5 | 7893 | **3904 (49%)** | 勉強夠 |

任務越難、思考越久,正文就越少;難到一定程度就**完全沒有正文**。

### 修正
1. `DEFAULT_MAX_TOKENS = 16384`,三個 provider 共用
2. **空輸出直接 `throw`**,附上 `stop_reason` / `finish_reason` 與思考 token 數

> 沒有第 2 點的話,worker 靜默失敗會讓最終答案品質悄悄下降卻完全看不出來 —— 整合階段收到空字串只會自己腦補,不會報錯。

---

# 四、Phase 5 第 1、2 項:Chief Planning Protocol V1

## 要解決的問題

Planning V1 之前,**同一個 task 跑兩次,Chief 拆出的子任務數是 6 和 13** —— 差距超過 2 倍。成本與延遲完全無法預測。

## 實作內容(對應 §28 十項要求)

| §28 要求 | 實作 |
|---|---|
| 1. 先輸出 complexity | schema 第一欄位,`simple`/`normal`/`deep`,並附 §14 的語意定義與判斷範例 |
| 2. 先輸出 required capabilities | `requiredCapabilities` 陣列,prompt 要求先列能力再選人 |
| 3. 限制 Specialist 數量 | `SPECIALIST_CAP` = simple 1 / normal 3 / deep 4 |
| 4. 一個 Agent 一個 coherent mission | 重複 agentId 直接丟棄並記錄 |
| 5. 限制 mission 數量 | 受 cap 約束,超出時依 priority 保留高的 |
| 6. 限制 mission 描述長度 | 600 字元上限,超過截斷並記錄 |
| 7. structured schema | zod 驗證;JSON 解析可處理 markdown fence |
| 8. 預留 cost / latency constraints | `budget` 參數:`maxSpecialists` 強制執行,cost/latency 傳達給 Chief |
| 9. 保留 planning rationale 供 audit | `reason` 欄位 + `planningAdjustments` 記錄約束層的每次修正 |
| 10. 同一 task 連跑多次比較 | 已執行 5 次,結果如下 |

### 關鍵設計:約束不只寫在 prompt

Prompt 可以被模型忽略,所以另外實作了 `enforceConstraints()`,把違規計畫強制修正成合規,**並把每次修正記錄在 `planningAdjustments`**。這樣同時保證成本可預測、以及 Chief 是否守規矩可被稽核。

## 追加修正:Complexity 校準

第一輪 3 次測試中 Chief 都判為 `normal`,但 §14 明確把「公司年度策略」列為 **DEEP** —— 而測試 task 正是公司年度策略。

**原因**:第一版實作只給了各級距的人數上限,漏了 §14 的語意定義與判斷範例,Chief 等於沒有判準在猜。修正後 Run 4、Run 5 都正確判為 `deep`。

## 全部 5 次執行紀錄

| Run | complexity | missions | agents | API calls | adjustments | failures | total |
|---|---|---|---|---|---|---|---|
| 1 | normal | 2 | BS + BC | 4 | 0 | 0 | 255.2s |
| 2 | normal | 2 | BS + BC | 4 | 0 | 0 | 277.9s |
| 3 | normal | 2 | BS + BC | 4 | 0 | 0 | 252.6s |
| 4 | **deep** | 2 | BS + BC | 4 | 0 | 0 | 239.0s |
| 5 | **deep** | **3** | **MR + BS + BC** | **5** | 0 | 0 | 213.9s |

> BS = `business_strategist`(Claude)、BC = `brand_creative`(GPT)、MR = `market_researcher`(Gemini)
>
> Run 1–3 在 complexity 校準前;Run 4–5 在校準後。Run 5 是 Run Status 上線後的第一次執行。

### 修正前後對比

| | 修正前 | 修正後(5 次) |
|---|---|---|
| Mission 數 | **6 vs 13**(差 2 倍以上) | **2–3** |
| API 呼叫 | 8 / 15 | **4–5** |
| Complexity 分類 | 無此概念 | 校準後 2/2 正確判為 deep |
| 約束層介入 | — | **0 次**(Chief 自己就遵守) |
| Worker 失敗 | 2 個空輸出 | 0 |

`adjustments = 0` 是很好的訊號:Chief 在讀到明確約束後**自願遵守**,強制層完全沒有介入,代表約束是被理解而非被硬套。

### ⚠️ 但「穩定」這個詞用得太滿了

rev. 1 說「已收斂到 2/2/2」是根據 3 次 `normal` 執行。加入 deep 的兩次之後,準確的說法是:

> **Planning V1 讓計畫變得有界(bounded),不是變得確定(deterministic)。**

- **`normal`:3/3 完全一致** —— 這條站得住
- **`deep`:2 次跑出 2 個不同的計畫**(2 missions vs 3 missions,選人也不同)—— 未驗證

原本 6 vs 13 的擺盪確實消失了(現在 2–3),所以 §25「不應再出現 6 / 13 / 20」仍然成立。但不能說成「穩定」。

---

# 五、Phase 5 第 3 項:Worker Failure / Run Status(本次新增)

對應 §17。`run_orchestrator` 現在額外回傳一個 `report`。

## Run Status

| 狀態 | 條件 | 行為 |
|---|---|---|
| `SUCCESS` | 全員回傳 | 正常整合 |
| `DEGRADED` | 有人失敗,至少一人成功 | 整合照做,但 **synthesizer 會被明確告知誰缺席、不准腦補其貢獻**,並要求說明答案哪裡因此變薄 |
| `FAILED` | 全員失敗 | **跳過整合階段**,`finalOutput` 回 `null` |

`FAILED` 那條是重點。原本的行為是把 error 字串塞進 synthesis prompt 讓模型自己看著辦 —— 那正是「靜默降級」的來源。現在不花那筆錢,也不產生一份用錯誤訊息寫成的策略。

## Evidence Label

> ⚠️ **以下這張表是 rev. 2 的版本,已被 rev. 3 取代 —— `EVIDENCE_BACKED` 已被移除。**
> 保留在這裡是為了讓第五-A 節的問題可以被對照理解。現行定義見第五-D 節。

| 標籤 | 條件 |
|---|---|
| `NOT_APPLICABLE` | complexity 不是 `deep` |
| ~~`EVIDENCE_BACKED`~~ | ~~有標記 `evidenceCapable` 的專家成功回傳~~ ← **這條在說謊,見第五-A 節** |
| `CONDITIONAL` | 有找 evidence 專家,但全部失敗 |
| `HYPOTHESIS` | deep 任務,但根本沒找 evidence 專家 |

**`CONDITIONAL` 和 `HYPOTHESIS` 會把警告直接加在 `finalOutput` 開頭**,不只放在 metadata:

```
> **UNVERIFIED — HYPOTHESIS**
> No external evidence was gathered for this answer. Treat it as a strategy
> hypothesis to be validated, not as a conclusion. Pricing, market and growth
> figures below are unchecked model assumptions.
```

metadata 保護不了讀者 —— 一份沒有實證的策略文件,讀起來跟有實證的一模一樣。標記必須長在文件上。

## 關鍵設計:結構判定,不做自我評估

**label 完全由 complexity 與「誰實際回傳了」決定,絕不去問 Chief 覺得需不需要研究。**

理由是實測的:Chief 在 4 次執行中每次都回答「不需要市場研究」。它的自我評估不是可用訊號。§14 已經把 `deep` 定義成公司年度策略、重大投資、高風險合約 —— 這些本質上依賴外部事實,不需要再問一次。

> 這一點刻意**不採用** GPT 建議的 `requiresEvidence: true` 由 Chief 標記 —— 理由見第七節。

## 離線測試

```bash
npm test   # 不花任何 API 額度
```

真實跑一次要約 4 分鐘、4–5 次模型呼叫,狀態規則不該需要那個。其中一項專門鎖住上述設計決定:

```
✓ label never depends on the Chief saying research was unnecessary
```

同樣的 worker 結果、同樣的名單,只有 complexity 能移動 label —— 沒有任何欄位能讓 Chief 用嘴巴脫離 `HYPOTHESIS`。

---

# 五-A、⚠️ rev. 2 的 Evidence Label 在說謊

## 怎麼發現的

實作 Model Capability Registry 時必須先確認每個模型實際能做什麼,於是查了三個 provider 的原始碼:

| 檔案 | 呼叫方式 | tools / grounding |
|---|---|---|
| `gemini.ts` | `generateContent` | **無** |
| `openai.ts` | `chat.completions.create` | **無** |
| `claude.ts` | `messages.create` | **無** |

**當時這個系統裡沒有任何模型能檢索外部資訊。** 三家都是純文字進、純文字出。

## 後果

- `market_researcher` 標的 `evidenceCapable: true` **在實質上是假的**。它跟 Claude、GPT 一樣從訓練資料產出市場說法,認知地位完全相同。
- **Run 5 的 `EVIDENCE_BACKED` 標記是錯的。** 那次沒有蒐集到任何證據。
- 更早那句「Gemini 提供了競品定價標竿,直接成為最終文件裡定價帶與毛利率的依據」—— 那些標竿是**生成的,不是查來的**。§9 把 Gemini 定位為 evidence gathering 這件事,從來沒有被接上。

rev. 2 蓋的防護層,染上了它本來要治的病:讓未經驗證的東西看起來已驗證。GPT 與 Gemini 各審查兩輪、四份回答,沒有一份提到這件事;Gemini 還為自己的證據角色辯護了很長一段。

---

# 五-B、§23 第 5 項:Model Capability Registry

`src/models/capabilities.ts` 記錄的是**在這個 codebase 裡實際接通的能力**,不是廠商官網宣稱什麼。每個能力拆成兩個獨立事實:

```ts
grounded_retrieval: { supportedByProvider: true, enabledInRuntime: false }
```

**只有 `enabledInRuntime` 能授予能力。** `supportedByProvider` 存在的目的,是讓「廠商有提供」和「我們接了」之間的落差保持可見,而不是被悄悄混為一談。

`list_models` 兩個都報,並列出「廠商有提供但這裡沒接」的清單。

### 定價刻意留空

`pricing` 沒有填任何數字。沒有經過查證的即時價格,而編一個看起來合理的數字會直接流進第 8 項成本追蹤,變成這個系統自己定義要抓的那種「無錨點的量化宣稱」。有一項測試鎖住:`assert.doesNotMatch(text, /\$\d/)`。

要啟用成本追蹤,得有人去官方定價頁抄真實數字,連同 `source` 與 `checkedOn` 一起填。**Grounded search 是在 token 之外另外計費的,所以這件事現在更重要,不是更不重要。**

---

# 五-C、Step 5.1:Grounded Retrieval MVP

## 設計

檢索是**逐次呼叫掛上去的,不是預設開啟**:

```ts
callGemini(mission, { retrieval: { enabled: true } })
```

`run_orchestrator` 只把它掛給 `evidenceCapable` 推導為 true 的專家,所以一般推理任務不會無聲地開始產生搜尋費用。Provider interface 用的是 capability option,`gemini.ts` 裡沒有寫死任何 agent id。

| `status` | 意義 |
|---|---|
| `GROUNDED` | 搜尋執行了,並回傳至少一個來源 |
| `UNGROUNDED` | 搜尋有提供,但模型選擇不用 / 沒有可用來源 |
| `FAILED` | 要求檢索但無法執行(例如該 provider 在 runtime 沒接) |

向 Claude 或 OpenAI 要求檢索會回 `FAILED` 並附說明,**而不是回一個沒有標記的訓練資料答案**。

## 實測結果(2026-09-05,`node test-grounding-live.mjs`)

6 項全過:

```
✓ ordinary call carries no retrieval result
✓ evidence call returned a retrieval result
✓ status is GROUNDED
✓ at least one source URL
✓ source urls are real urls
✓ query count reported by the API
```

實際回傳:

```
status       : GROUNDED
queries      : ["site:blackmagicdesign.com \"PYXIS 6K\" price"]
queryCount   : 1
sourcesFound : 1
raw metadata : searchEntryPoint, groundingChunks, groundingSupports, webSearchQueries
```

## 實測揭露的限制(以實測為準)

1. **來源 URL 不是出版者的網址。** 回傳的是 `vertexaisearch.cloud.google.com/grounding-api-redirect/…` 轉址連結,出版者網域出現在 chunk 的 title 裡。**這些是查詢用的轉址,不是可長期引用的出處。**
2. **`groundingSupports` 會把答案的片段對應到支撐它的 chunk。** 目前沒有任何程式用它 —— 但這正是 claim-level validation 需要的原始材料,Step 10 應該直接用。
3. `gemini-3.1-pro-preview` 會回傳暫時性的 `503 high demand`。第一次實測就撞到,重試即成功。**這要當成暫時性錯誤處理,不是 grounding 失敗。**
4. 一次提問只產生 1 個查詢、1 個來源。搜尋量由模型自己決定,不是我們控制的。

---

# 五-D、`EVIDENCE_BACKED` 已被移除

Grounding 接上後最危險的事,是把「某個專家搜尋過」直接升級成「整份答案有實證」。所以標籤上限被刻意壓住:

| 標籤 | 條件 |
|---|---|
| `NOT_APPLICABLE` | 不是 deep |
| `HYPOTHESIS` | 完全沒有嘗試檢索 |
| `CONDITIONAL` | 嘗試了但沒拿到東西(模型沒搜、檢索失敗、或該專家掛掉) |
| `PARTIALLY_GROUNDED` | **上限** —— 至少一位專家做了真實的 grounded retrieval |

**沒有 `EVIDENCE_BACKED` 可以拿,因為這一層裡沒有任何東西賺得到它。** 一個 grounded 專家只證明那位專家搜尋過,不能證明最終答案的重大 claim 有被它找到的來源支撐 —— 那是 claim-level 的工作,屬於 Validation Layer(第 10 項)。

而且 `PARTIALLY_GROUNDED` **仍然會在產出文件開頭印警告**:

```
> **PARTIALLY GROUNDED — claims not yet validated**
> 1 specialist(s) searched and cited 2 source(s), listed in the run report.
> That covers their own research only. Nobody has checked whether the figures
> and claims below are the ones those sources support.
```

## evidenceCapable 的推導鏈

```
Agent Intent (providesEvidence)
        ×
Model Runtime Capability (enabledInRuntime)
        ×
Execution Retrieval State (GROUNDED / UNGROUNDED / FAILED)
```

agent 不能宣告、呼叫端不能強制、**品牌本身不算數** —— 有一項測試專門擋掉 `provider === "gemini" → evidenceCapable = true` 這種捷徑:一個綁在 Gemini 上但不是用來蒐證的專家,必須保持普通。未列在 registry 裡的模型一律視為不具備能力,不給予推定。

## 測試

| 檔案 | 項數 | 內容 |
|---|---|---|
| `test-run-status.mjs` | 22 | run status、evidence label、retrieval 統計、輸出標記 |
| `test-registry.mjs` | 20 | agent 展開、能力推導、runtime vs vendor、品牌捷徑防護 |
| `test-mcp-smoke.mjs` | 7 | MCP server、工具註冊、union schema、不得虛構定價 |
| `test-chief.mjs` | 11 | 常設簡報內容、拆分未新增約束、名單不洩漏模型 |
| **合計** | **60** | **全部離線,零 API 成本** |
| `test-grounding-live.mjs` | 6 | 真實 Gemini grounding(需 API 額度,不在 `npm test` 裡) |
| `test-chief-live.mjs` | 8 | 真實規劃呼叫,只跑規劃階段(1 次呼叫) |

---

# 五-E、§23 第 6 項:Chief of Staff System Prompt

## 做了什麼

Chief 以前把所有東西擠在一個 user prompt 裡,`system` 是空的。現在分成兩個欄位:

| | 位置 | 內容 |
|---|---|---|
| **常設簡報** | `system` | 身分、最小充分協作、能力優先於模型、複雜度定義、9 條規劃規則 |
| **這一件工作** | `user` | 任務、名單、預算約束、輸出 schema |

`CHIEF_SYSTEM_PROMPT` 在 `src/agents/chief.ts`,可用 `orchestrator.systemPrompt` 逐次覆寫。

## 這是職責分離,不是重新校準

先前的決策是**不修改 Planning Prompt**。所以原本的原則、複雜度定義、9 條規則全部逐字搬移,**一條新規則都沒加**。兩項測試鎖住這件事:

```
✓ carries all nine planning rules
✓ the split introduced no new numeric constraint   (caps 仍是 1/3/4,mission 仍是 600 字元)
```

### 刻意沒加的東西

原本可以在常設簡報裡加一句「不要因為你寫得出一份看起來完整的答案,就認定不需要外部證據」—— 那正是 GPT 與 Gemini 獨立診斷出的 Run 2 病灶。

**但那就是被否決掉的那種 prompt 校準**,而且它會推高研究專家被選中的機率,直接改變行為。結構性的 Evidence Label 已經在處理這個風險,不需要再用 prompt 去推。

## ⚠️ 結構性發現:Chief 看不到模型

寫測試時去看 Chief 實際收到的名單長什麼樣:

```
- agentId: business_strategist | role: Business Strategist — 商業模式、財務邏輯
- agentId: market_researcher   | role: Market Analyst — 市場情報
- agentId: brand_creative      | role: Brand Strategist — 品牌策略
```

**只有 `agentId` 和 `role`。沒有 provider、沒有 model。**

`buildPlanningPrompt` 從第一版起就是這樣寫的。也就是說:

- **「能力優先於模型」一直是結構性成立的**,不是靠 prompt 裡的一句話。Chief **沒辦法**依品牌偏好或排斥任何專家,因為它從來不知道誰是誰。
- **rev. 1「Chief 系統性排除 Gemini」的整個前提,描述的是一個它做不到的行為。** 它不知道 `market_researcher` 背後是 Gemini。它選或不選,是基於 role 描述裡的「市場情報、競品、證據蒐集」這個能力,與模型品牌無關。

rev. 2 用 Run 5 的實測推翻了那個結論;rev. 4 補上了為什麼 —— 那個結論從一開始就不可能成立。

**兩位審查者各兩輪、四份回答,寫了大量關於「Chief 對 Gemini 的認知偏誤」的分析,沒有一份想到要去確認 Chief 到底看得到什麼。** 提問文件也沒提供這個資訊。這是一個所有參與者都跳過了「先看實際輸入」這一步的例子。

已鎖成測試:

```
✓ the roster hides which model backs each specialist
```

## 真實驗證(1 次 API 呼叫)

拆開 system / user 之後,輸出格式指令在 user prompt、規則在 system prompt —— **Chief 還會不會回傳純 JSON,離線測試證明不了。** 過去 5 次執行的 JSON 解析成功率是 5/5,不驗證就不能宣稱維持。

`node test-chief-live.mjs`(只跑規劃階段,不執行任何 worker):

```
planning call: 25.1s, 641 chars
✓ returned bare JSON with no markdown fence
✓ complexity is one of the three levels
✓ listed required capabilities first
✓ every agentId is on the roster
✓ one mission per specialist
✓ every mission under 600 chars
✓ gave a rationale
```

---

# 五-F、一個提問者自己製造的比較謬誤

上面那次驗證回傳 `complexity: normal`,而 Run 4、Run 5 都是 `deep`。看起來像分類不穩。

**不是。那是驗證腳本自己造成的。**

腳本裡用的是這份公開文件的代稱「Studio X」,orchestrator harness 用的是真實公司名 —— 兩個不同的輸入,連冒號全形半形都不同。Chief 給的理由是「**基於一般化需求**,無須市場研究即可產出可執行方案」,它把代稱讀成了假設性案例,這完全合理。

**所以那個 `normal` 不能拿來跟 Run 4、5 比較。** 若不查證就當成「complexity 分類不穩」寫進報告,會產生一個純粹由測試設計製造、但看起來很像真發現的結論。

## 修法

基準任務抽成單一來源 `benchmark-task.mjs`,所有 harness 一律 import:

> 放在同一個地方,因為它是控制變因:跑次之間比較 complexity、專家數和成本,只有在輸入逐位元組相同時才有意義。各自 inline 一份的 harness 會悄悄變得不可比 —— 這已經發生過一次。

**因此第四節那張 5 次執行紀錄表仍然有效**(那 5 次用的都是同一個字串),而這次的 `normal` 不列入其中。

---

# 六、⚠️ rev. 1 的核心前提被推翻

## rev. 1 說了什麼

> Planning V1 上線後 **4 次執行**(3 次 normal + 1 次 deep),Chief **每一次都只選 business_strategist(Claude)+ brand_creative(GPT),完全沒有選 market_researcher(Gemini)**。
> **重點**:即使在 `deep`(允許 4 個 specialist)的情況下,Chief 仍只選 2 個。所以**這是 Chief 的實質判斷,不是被人數上限卡掉**。

> ⚠️ **rev. 4 補充:這一整節談的「Chief 與 Gemini 的關係」是個誤置的框架。** Chief 收到的名單裡沒有 provider 欄位 —— 它不知道 `market_researcher` 背後是 Gemini。它選或不選,依據的是 role 描述裡的能力,與模型品牌無關。見第五-E 節。

## Run 5 發生了什麼

**Chief 選了 Gemini。** 同一個 task、同一份名單、同一個 prompt。

| | Run 4 | Run 5 |
|---|---|---|
| complexity | deep | deep |
| missions | 2 | 3 |
| agents | BS + BC | **MR + BS + BC** |
| Evidence Label(依現行規則) | **HYPOTHESIS** | **EVIDENCE_BACKED** |

已確認**不是程式改動造成的**:planning prompt 只餵給 Chief `agentId` 與 `role` 兩個欄位,新增的 `evidenceCapable` 從來沒有進過那個字串。

## 所以正確的說法是

**在 `deep` 這一層是 1 排除 / 1 選用,n=2。** 那是擲硬幣,不是穩定模式。「每一次都排除」不成立。

## 這反而讓結構性標記更有必要

原本的論證是「Chief 系統性地不做研究,所以要強制」。現在的論證更強:

> 同一個 deep 任務,**有時候有實證、有時候沒有,而產出的文件長得一模一樣**。讀者無從分辨手上這份是哪一種。

Run 4 和 Run 5 產出的都是「Studio X 2027 成長策略」,一份有市場研究一份沒有 —— 在 label 存在之前,打開它們看不出差別。**系統性偏誤至少是可預期的,變異不是。**

## 但這削弱了兩位審查者的第 4 題答案

GPT 與 Gemini 在第 4 題都把 Chief 診斷為**系統性認知偏誤**:

> GPT:「用輸出的完整度代替 epistemic confidence」
> Gemini:「典型的 LLM 偏誤 —— 因為我自己能寫出一份看起來極為完整的文本,所以主觀認為不需要外部事實」

如果這是變異而非偏誤,**這兩個診斷是打偏的**。它們診斷的對象是一個穩定傾向,而資料現在顯示的是不穩定。

**未解**:n=2 太少,無法判斷 1:1 是隨機還是有其他因素。要補到 n=5 需在 deep 再跑 3 次(約 12 分鐘、15 次呼叫)。

---

# 七、GPT 與 Gemini 的審查結果

rev. 1 向兩者提出四個問題,**分開獨立提問,雙方都沒看過對方的答案**。

## 方法論警告:提問者引導了證人

rev. 1 只給了三個選項,而且文末直接建議了「方向 2 只套用在 deep」這個折衷做法。**兩邊提出的「過渡補丁」正是我遞給它們的。** 所以「兩邊都選方向 3」不能當成交叉驗證的證據。

有訊息量的是:它們**在框架之外**的收斂,以及它們的分歧。

## 框架外的收斂(獨立提問,因此是真訊號)

| 收斂點 | rev. 1 有無暗示 |
|---|---|
| 以同一診斷否決 Run 2 的理由:**可執行 ≠ 正確** | 無 |
| 驗證粒度選在 **claim / assumption 層級**,而非「叫一個模型評論整份答案」 | 無 |
| **「充分」必須先成立,「最小」才有意義** | 無 |
| Run 3 區分「能力重複」與「能力缺口」 | 無 |

## 唯一的分歧,精準地跟自身利益重合

兩邊都選方向 3,分歧全在**過渡期怎麼辦**:

| | 過渡補丁 | 成本 | 誰得利 |
|---|---|---|---|
| **GPT** | Chief 標記 `requiresEvidence`,沒有 evidence agent 就把輸出降級成 `HYPOTHESIS` / `CONDITIONAL` | **+0 calls** | 維持 GPT+Claude 陣容 |
| **Gemini** | deep 任務硬性規定至少一個 evidence-gathering **模型** | **+1 call(每次 deep)** | 保證 Gemini 出場 |

**兩個模型分開問,各自獨立提出了對自己有利的過渡方案。**

Gemini 這裡另有一處邏輯不一致:它先批評方向 2「在 Prompt 硬寫死規則違背 §4 動態調度的初衷,容易在不需要調研的 deep 任務上造成無謂的 API 成本浪費」,然後推薦的過渡補丁就是那個東西 —— 而不一致的方向正好是把自己放進去。

另外,GPT 明確把能力與模型脫鉤(`Gemini / GPT / DB / Web / Context`),承認 evidence 不一定要 Gemini 來做;**Gemini 全程沒有提過這個能力可由網路搜尋、資料庫或 GPT 滿足**,把「evidence capability」與「我」畫上了等號。這題 GPT 比較守規矩。

## 各自的實質貢獻(互補而非競爭)

**GPT —— 架構形狀:**
- **Critical Claims 抽取**:把「你需不需要研究」(模型很爛的自我評估)換成「你的建議依賴哪些斷言、各自拿什麼支持」(模型很強的抽取任務)
- `decisionSensitive` 閘門:不是每個未驗證假設都值得花錢查,防止 Validation Layer 膨脹成第二個 13-task 怪物
- 順序論證:先定 decision quality floor,再在達標方案裡找最便宜的

**Gemini —— 偵測器形狀,更可操作:**
- **定量錨點測試**:產出中若有定價、毛利率、市場規模、CAPEX 回本期、客單價,且無法由純數學推出 → 必須引進外部證據。**大部分可用啟發式規則完成,不必再燒一次 LLM 呼叫**
- 反事實敏感度:「若競品突然降價 30%,此策略是否直接失效?」
- schema 的 `researchQuery` 欄位:直接產出要給 researcher 的檢索指令(GPT 的 schema 只到 `recommendedCapability`)

## 兩邊都漏掉的問題

**誰來抽取 Critical Claims / 誰來當 Validation Guard?**

若由產出建議的同一個模型執行,就是同一個模型稽核自己的信心水準 —— 正是它們兩個都診斷出來的 Run 2 病灶。Gemini 的 prompt 寫了「你是一個嚴格的商業審計員」但沒說是誰;GPT 完全沒提。

**追加約束:validator 不得為產出者。** 目前 GPT 兼 Chief 與 synthesizer,因此 validator 只能是 Claude 或 Gemini。

## 已採行的決定

1. **方向 3(Validation Layer)為目標**,兩位審查者與實作者一致。
2. **過渡期採 GPT 的形狀(標記輸出),不採 Gemini 的(強制出場)** —— 理由不是誰比較可信,而是效果:每次 deep 硬塞一個研究員,連 Gemini 自己都承認會浪費;誠實標記成本為 0,且保住了真正重要的資訊。
3. **但不採用 GPT 的 `requiresEvidence` 由 Chief 自評** —— 這與 GPT 自己在第 2 題的建議互相矛盾:

   > 不要問 Chief:「你需不需要研究?」因為它很容易回答「不用」。

   而我們有實測資料證明這個 Chief 就是會回答「不用」。改為**結構判定**(見第五節)。
4. **Validation Layer(第 10 項)實作時**:用 Gemini 的定量錨點測試當便宜的第一道偵測 → GPT 的 `decisionSensitive` 閘門決定值不值得花錢 → Gemini 的 `researchQuery` 讓補研究可執行 → evidence mission 走 capability router 不綁定模型(GPT)→ **validator 不得為產出者**(本文追加)。
5. **不跑 `run_debate`** —— 兩者結論並不相反,唯一分歧已可診斷(各自提對自己有利的過渡方案),再花一次辯論成本沒有增益。

---

# 八、§25 驗收標準檢核

| 標準 | 狀態 |
|---|---|
| 同一 Task 重跑多次 | ✅ 已跑 5 次 |
| Complexity classification 大致穩定 | ⚠️ 校準後 2/2 判為 deep,但 n=2 |
| Required capabilities 大致穩定 | ⚠️ 語意方向一致,但 Run 5 明顯較廣(9 項 vs 3–7 項) |
| Agent 數量受限制 | ✅ 從未超過 cap |
| Subtask 數量受限制 | ✅ 2–3,遠離修正前的 6–13 |
| **計畫可重現** | ❌ **`normal` 3/3 一致;`deep` 2 次得到 2 個不同計畫** |
| Worker failure 可見 | ✅ **本次完成** — SUCCESS / DEGRADED / FAILED + 失敗清單 + synthesisAllowed |
| JSON planning 穩定 | ✅ 5/5 次解析成功,0 次 schema 失敗 |
| Cost 可追蹤 | ❌ 開發順序第 8 項,尚未做 |
| Latency 可追蹤 | ✅ 分階段 `timings` |
| Chief 可以清楚仲裁 disagreement | ❌ 開發順序第 10–11 項,尚未做 |
| 使用者收到 Executive Brief | ❌ 開發順序第 12 項,尚未做 |

---

# 九、目前程式碼狀態

| 檔案 | 內容 |
|---|---|
| `src/config.ts` | `DEFAULT_MAX_TOKENS = 16384`;Gemini 預設模型 `gemini-3.1-pro-preview` |
| `src/providers/claude.ts` | 共用額度;空輸出 throw(附 stop_reason + thinking tokens) |
| `src/providers/openai.ts` | `max_completion_tokens`;共用額度;空輸出 throw |
| `src/providers/gemini.ts` | 共用額度;空輸出 throw(附 finishReason) |
| `src/modes/orchestrator.ts` | Planning Protocol V1、zod schema、約束強制層、分階段計時、**Run Status / Evidence Label / 輸出標記** |
| `src/index.ts` | `budget` 參數、worker ref 的 `providesEvidence`、**`list_agents` / `list_models` 工具** |
| `src/agents/chief.ts` | **新增** — `CHIEF_SYSTEM_PROMPT`、`buildPlanningPrompt`、規劃常數 |
| `src/agents/registry.ts` | **新增** — Agent Registry、能力推導、`rosterWarnings` |
| `src/models/capabilities.ts` | **新增** — Model Capability Registry、`supportedByProvider` vs `enabledInRuntime`、定價留空 |
| `src/providers/types.ts` | **新增 retrieval 型別** — `RetrievalRequest` / `RetrievalStatus` / `RetrievalResult` |
| `src/providers/gemini.ts` | **Google Search grounding**,逐次掛載;metadata 正規化 |
| `src/providers/claude.ts`、`openai.ts` | 被要求檢索時回 `FAILED` 並說明,不假裝有做 |
| `README.md` | Runtime notes、Run status、Agents、Models、**Grounded retrieval 與實測 API 行為** |

## 測試腳本

- `npm test` — **離線 15 項,驗證 run status 與輸出標記規則,不花 API 額度**
- `check-providers.mjs` — 驗證三家 API Key
- `test-pipeline.mjs` — Pipeline 接力測試
- `test-orchestrator.mjs` — Orchestrator 穩定度測試(`node test-orchestrator.mjs 3`),輸出比較表與 `orchestrator-run-N.json`

---

# 十、實務提醒

### 1. 延遲仍是架構層級的問題

Planning V1 把 API 呼叫從 15 降到 4–5,但**總時間只從 309s 降到約 214–278s**。原因是 mission 變成一個大的 coherent mission 後,單一 worker 的執行時間拉長(115–184s),整合階段仍需 65–99s。

**降低 API 呼叫數 ≠ 等比降低延遲。** 真正的瓶頸是推理模型的單次思考時間,要靠 streaming 或更小的模型來解。

### 2. MCP client 預設 timeout 只有 60 秒

單次 orchestrator 要 4 分鐘以上,預設會被誤判成卡死(`-32001 Request timed out`,但流程其實還活著)。已寫進 README,呼叫時要帶 `{ timeout: 900000 }`。

### 3. 同一個 task 不會給出同一個計畫

Run 4 與 Run 5 證明了這件事。做效能或成本估算時,**不能假設同一個 task 的計畫可重現** —— 要用區間(2–3 missions / 4–5 calls),不要用點值。

---

# 十一、下一步(依 §23 開發順序)

```
✅ 1. Chief Planning Constraints
✅ 2. Structured Planning Output
✅ 3. Worker Failure / Run Status
✅ 4. Agent Registry
✅ 5. Model Capability Registry        ← runtime 事實 vs 廠商宣稱
✅ 5.1 Grounded Retrieval MVP          ← Gemini Google Search,實測通過
✅ 6.  Chief of Staff System Prompt     ← 常設簡報與單次任務分離
✓  6.1 Worker Context Propagation      ← DONE,worker input contract 已落地
✓  7.  Complexity Router V1            ← CODE + RUNTIME ACCEPTED,不回滾
✓  7.1 E2E Runtime Acceptance          ← DONE,Test A / Test B PASS
▶  M2. True Multi-Agent Collaboration  ← NEXT: scope + acceptance design,等 architecture review
-  8.  Cost / Token / Latency Tracking ← SCOPE ANALYSIS DONE,implementation 延後至 M2 後
   9.  Model Router
   10. Validation Layer
   11. Red Team
   12. Executive Brief Schema
   13. Automated Tests                 ← 已提前做了 run status 的部分
   14. Project Context
   15. Memory / Persistence
```

**明確不做**(§24):OpenClaw / Slack / Discord / Telegram / Web UI / Ollama / Long-term Memory / Complex Gateway。

## 一個仍然開放的問題

**deep 層的計畫變異要不要處理?** 目前 n=2 且結果相反。三個選項:

1. 補跑 3 次到 n=5,先確認變異的幅度再決定
2. 接受變異,理由是 evidence label 已經讓「這次有沒有做研究」變得可見 —— 變異不再是隱形的
3. 降低 Chief 的 temperature 或改用更確定性的規劃方式

第 2 個選項的論證最強:**我們原本擔心的不是「計畫會變」,而是「計畫變了但看不出來」。** 後者已經被第五節解決。

**rev.11 roadmap decision:** 此題保留為 deferred open question,不併入 Step 7.1。Step 7.1 的 DEEP case 只驗證一條有效 grounding E2E path,不補跑到 n=5 或估計 planning variance。

---

# 十二、SIMPLE Baseline 實測(n=1)

**這是第一次量測 simple 任務。** 先前 6 次量測全部是 deep 級的公司年度策略。

任務(§14 定義下毫無疑問的 `simple`:純計算與格式化,所有資訊都在題目裡):

```
以下三筆報價都是未稅總價，請換算成含稅（營業稅 5%）金額，並由低到高排序：
A 案 48,000 元   B 案 52,500 元   C 案 45,800 元
```

## 結果(實測 observation)

```
complexity   : simple          ← 分類正確
assignments  : 1 specialist
API calls    : 3
status       : SUCCESS
adjustments  : none

planning     : 16.2s  (63%)
worker       :  3.4s  (13%)
synthesis    :  6.2s  (24%)
total        : 25.8s
```

---

# 十二-B、Post-6.1 SIMPLE Live Regression(n=1)

**目的:** 驗證 Step 6.1 Worker Context Propagation 修好後,同一個 SIMPLE baseline 的 worker 是否仍需要 synthesis 做 correctness recovery。

**執行限制:** 本輪**沒有實作 Step 7**,也**沒有跳過 synthesis**。實際路徑仍是:

```
planning → worker → synthesis
```

任務與第十二節完全相同:

```
以下三筆報價都是未稅總價，請換算成含稅（營業稅 5%）金額，並由低到高排序：
A 案 48,000 元
B 案 52,500 元
C 案 45,800 元
```

## 結果(實測 observation)

```
complexity   : simple
assignments  : 1 specialist (business_strategist)
API calls    : 3
status       : SUCCESS
evidence     : NOT_APPLICABLE
adjustments  : none

planning     :  7.9s  (35%)
worker       :  4.1s  (19%)
synthesis    : 10.2s  (46%)
total        : 22.2s
```

## Chief mission(原文)

```
Compute 5% VAT-inclusive totals for A=48,000; B=52,500; C=45,800, then sort offers from lowest to highest. Return the inclusive amounts and the sorted ranking.
```

## Worker 原始輸出(原文,318 chars)

```markdown
# 含稅金額計算與排序結果

## 換算明細（未稅 × 1.05 = 含稅）

| 方案 | 未稅金額 | 含稅金額（5% 營業稅） |
|------|---------|---------------------|
| A 案 | 48,000 元 | **50,400 元** |
| B 案 | 52,500 元 | **55,125 元** |
| C 案 | 45,800 元 | **48,090 元** |

## 由低到高排序

1. **C 案：48,090 元**
2. **A 案：50,400 元**
3. **B 案：55,125 元**

---
以上為含稅金額計算與排序結果，僅涵蓋本任務指定之運算範圍。
```

## Synthesis 原始輸出(原文,118 chars)

```text
含稅金額（未稅 × 1.05）：
- A 案：50,400 元
- B 案：55,125 元
- C 案：48,090 元

由低到高排序：
1) C 案：48,090 元
2) A 案：50,400 元
3) B 案：55,125 元
```

## 觀察

| | Step 6.1 前 baseline | Step 6.1 後 regression |
|---|---|---|
| Chief mission | 英文 | 英文 |
| Worker 原始輸出 | 英文 | **中文** |
| Synthesis 原始輸出 | 中文 | 中文 |
| Worker chars | 460 | 318 |
| Synthesis chars | 112 | 118 |
| Total latency | 25.8s | 22.2s |

**結論:** Step 6.1 修掉了本次已知的 language/context recovery 缺陷:即使 Chief mission 仍是英文,worker 也能依 Original Task 的語言與範圍輸出中文。這支持「Worker Context Propagation 是必要前置修復」。

**但這仍不等於 Step 7 可以直接跳過 synthesis。** 本次 synthesis 仍做了可觀察的 user-facing compression / presentation normalization,只是它不再補救語言錯誤。是否足以移除,需要把「輸出品質差異」納入 Step 7 決策,而不是只看 latency。

## 第一次 baseline 的價值不是延遲分佈,而是推翻了一個架構假設

原本的假設:

```
1 specialist
→ synthesis 只是把一份答案重新整理成一份答案
→ 可以安全跳過
```

**實測證明這個假設目前不成立。**

## 第一次 baseline 中 Planning 佔 63%,是實際工作的 5 倍

Chief 花 **16.2 秒**判斷「這是算術,交給一個人」,真正算完只要 **3.4 秒**。

在第一次 baseline 中,SIMPLE workload 的主要 latency center 是 **planning**,不是 synthesis。Post-6.1 regression 的分佈已改變(見第十二-B節),所以不要把這個百分比當成通則。

> ⚠️ **但現在不要實作融合式 routing + answer。** 那會破壞 `PLAN → 可先被獨立稽核 → EXECUTION` 這個架構性質。是否值得用它換延遲,是 V2 的架構取捨,不是現在的 bug fix。

---

# 十二-C、SIMPLE-2 / SIMPLE-3 Worker Readiness Live Regression

> 本節為 rev.8 的歷史三階段測試紀錄。其當時的 `NOT IMPLEMENTED` 狀態與原始輸出保留不改;現行 Step 7 V1 implementation 見第十六節。

## 目的與方法

**問題:** 在 single-specialist SIMPLE 任務中,Worker Output 是否已能原樣作為 user-facing final answer? Synthesis 是否補上必要的正確性,或只改變長度/呈現?

本輪於 2026-09-05(Asia/Taipei)執行兩種新題型,**各 n=1,不重抽、不估計 latency distribution**。沿用 `BENCHMARK_ROSTER`: `business_strategist`、`market_researcher`、`brand_creative`;Chief 與 Synthesizer 皆 `openai / gpt-5`。未強制 complexity 或 assignment,未改角色、budget、prompt 或 execution policy。每題均透過既有 MCP `run_orchestrator` 完成:

```
planning → worker → synthesis
```

驗收條件在呼叫前固定於 [cases.json](regressions/simple-readiness/cases.json),未將參考答案或驗收說明額外送給模型。六項品質評估逐項檢視 Worker 原文;`SUCCESS` 僅表示 Worker 呼叫成功,**不是品質通過的替代指標**。user-facing readiness 的 PASS 要求無需刪除標題、內部交接語或補寫內容,即可把原文送給使用者。

**原文定義:** 保留現有 provider adapter 回傳的文字。`workerResults[].output` 為 Worker 原文;這兩題的 `SUCCESS + NOT_APPLICABLE` 不會產生 output banner,因此 `finalOutput` 就是 Synthesis 原文。現有 API 不公開 Chief 整份 raw planning response;下列 Chief mission 是 `plan.assignments[].mission`,兩題均無 planning adjustments。完整 MCP 回應另存,沒有截短、翻譯或潤飾。

## 執行結果與 Latency

| 欄位 | SIMPLE-2 | SIMPLE-3 |
|---|---|---|
| 題型 | 明確格式與 constraint preservation | 短摘要 |
| 開始時間(Asia/Taipei) | 2026-09-05 01:38:47.929 | 2026-09-05 01:39:09.360 |
| complexity | `simple` | `simple` |
| assignments | 1: `business_strategist` (high) | 1: `brand_creative` (high) |
| Worker provider / configured model | `claude / claude-sonnet-5` | `openai / gpt-5` |
| status | `SUCCESS` (1 成功 / 0 失敗) | `SUCCESS` (1 成功 / 0 失敗) |
| evidenceLabel | `NOT_APPLICABLE` | `NOT_APPLICABLE` |
| requiresRedTeam | `false` | `false` |
| planningAdjustments / rosterWarnings | 無 / 無 | 無 / 無 |
| synthesisAllowed / 已執行 | `true` / 是 | `true` / 是 |
| 邏輯模型呼叫數 | 3: planning + worker + synthesis | 3: planning + worker + synthesis |
| planning latency | 12,894 ms (12.894 s) | 10,071 ms (10.071 s) |
| worker latency | 2,565 ms (2.565 s) | 10,703 ms (10.703 s) |
| synthesis latency | 5,966 ms (5.966 s) | 8,428 ms (8.428 s) |
| total latency | 21,425 ms (21.425 s) | 29,202 ms (29.202 s) |

Latency 取自 orchestrator 的 `timings`,不包含 MCP 啟動/傳輸時間。這裡不計平均、百分位、加速比例或預測值;3 次是 code path 的邏輯模型呼叫數,不宣稱量測到 SDK 底層 HTTP 重試次數。

## SIMPLE-2: 明確格式與 Constraint Preservation

### Original Task

```text
請只依下列資料篩選工作坊場地。條件：位於臺北市、9 月 18 日可預訂、費用不超過 15,000 元；即使符合其他條件，也必須排除河畔館。
請以繁體中文回答，只輸出一個 Markdown 表格，不要標題、前言、結論、推薦或排除原因。欄位名稱與順序固定為「場地」「費用（元）」，費用只填整數，不加千分位或單位。只列符合全部條件的場地，按費用由低到高排序，不要加入未提供的場地或資料。

場地資料：
松山館｜臺北市｜9 月 18 日可預訂｜12,000 元
板橋館｜新北市｜9 月 18 日可預訂｜9,000 元
中山館｜臺北市｜9 月 18 日可預訂｜15,000 元
信義館｜臺北市｜9 月 18 日已額滿｜11,000 元
大安館｜臺北市｜9 月 18 日可預訂｜15,001 元
河畔館｜臺北市｜9 月 18 日可預訂｜8,000 元
```

### Chief Mission(原文)

```text
依提供的場地資料，篩選符合：位於臺北市、9 月 18 日可預訂、費用不超過 15000 元；即使符合也要排除「河畔館」。輸出僅一個 Markdown 表格（無標題/前言/結論），欄位依序為「場地」「費用（元）」，費用填整數不加千分位或單位。只列完全符合者，並依費用由低到高排序，不加入未提供的場地或資料。語言使用繁體中文。
```

### Worker Raw Output(原文,56 字元含空白/換行)

```markdown
| 場地 | 費用（元） |
|---|---|
| 松山館 | 12000 |
| 中山館 | 15000 |
```

### Synthesis Raw Output(原文,56 字元含空白/換行)

```markdown
| 場地 | 費用（元） |
|---|---|
| 松山館 | 12000 |
| 中山館 | 15000 |
```

### Worker 評估

| 維度 | 結果 | 依據 |
|---|---|---|
| correctness | PASS | 只有松山館 12000、中山館 15000,數值正確且升冪排序。 |
| language | PASS | 場地與欄名皆為要求的繁體中文。 |
| format | PASS | 僅一個 Markdown 表格;指定兩欄、兩筆資料;費用為純整數,無單位、千分位或額外說明。 |
| constraints | PASS | 保留剛好 15000 的中山館;排除新北市板橋館、已額滿信義館、超額 1 元的大安館及明確排除的河畔館;無新增資料。 |
| mission scope | PASS | 僅篩選、排序與格式化,未加推薦、排除原因或延伸分析。 |
| user-facing readiness | PASS | 可原樣交付,不需清除 wrapper、內部交接語或補正內容。 |

**Synthesis 增量:** 與 Worker 逐字相同,包含空白與換行。未觀察到 material correctness value,也沒有 compression / presentation 變更。這只描述輸出差異,不推測模型內部有無檢查。

## SIMPLE-3: 短摘要

### Original Task

```text
請用繁體中文將以下會議紀錄摘要成一段、最多兩句、總長不超過 100 個字（含標點，不含空白）。保留最終交付期限、負責人、交付項目及數量，並說明尚未確定的事項。只輸出摘要，不要標題、條列或建議；不要把被否決的提案寫成決議，也不要推測未定資訊。

會議紀錄：
原本提議 9 月 12 日交付五支 30 秒影片，但已否決。最終決議由林宜庭在 9 月 18 日前交付三支 15 秒直式短片，供秋季活動使用。投放平台與廣告預算尚未確定，下次會議再討論。
```

### Chief Mission(原文)

```text
將會議紀錄濃縮為繁體中文一段、最多兩句、總長不超過100字（含標點、不含空白），保留最終交付期限、負責人、交付項目與數量，並清楚說明未定事項；勿把被否決提案寫成決議，勿推測未定資訊；只輸出摘要，不要標題、條列或建議。
```

### Worker Raw Output(原文,54 字,含標點/不含空白)

```text
最終由林宜庭於9月18日前交付三支15秒直式短片，供秋季活動使用；投放平台與廣告預算未定，將於下次會議討論。
```

### Synthesis Raw Output(原文,54 字,含標點/不含空白)

```text
最終由林宜庭於9月18日前交付三支15秒直式短片，供秋季活動使用；投放平台與廣告預算未定，將於下次會議討論。
```

### Worker 評估

| 維度 | 結果 | 依據 |
|---|---|---|
| correctness | PASS | 正確保留林宜庭、9 月 18 日前、三支 15 秒直式短片、秋季活動用途,以及平台/廣告預算未定與下次討論。 |
| language | PASS | 全文為繁體中文,無語言修復需求。 |
| format | PASS | 一段、一句、54 字(Unicode code points,含標點/不含空白),符合最多兩句與 100 字上限;無標題或條列。 |
| constraints | PASS | 未把 9 月 12 日、五支 30 秒影片的被否決提案當成決議;未杜撰平台、預算、額外建議或來源外資訊。 |
| mission scope | PASS | 僅摘要既有決議與未定事項,未替會議做新決定。 |
| user-facing readiness | PASS | 已是可直接交付的短摘要,無內部交接語或多餘解說。 |

**Synthesis 增量:** 與 Worker 逐字相同,未新增、修正或壓縮任何內容。未觀察到 material correctness value,也沒有 compression / presentation 變更。Chief mission 未重述人名、日期或影片數量,Worker 仍從 Original Task 保留正確事實;這是 context 傳遞下的成功觀察,並非未做 ablation 即可宣稱的因果證明。

## 綜合判讀與限制

| 題型 | Worker 可否原樣交付 | Synthesis 可觀察增量 |
|---|---|---|
| SIMPLE-1: rev.7 原 baseline 計算/排序 | 數值、排序與中文已正確;帶有額外呈現與任務範圍說明 | compression / presentation,無已知 correctness recovery |
| SIMPLE-2: 本輪格式/條件篩選 | 是,六項評估皆 PASS | 無,逐字相同 |
| SIMPLE-3: 本輪短摘要 | 是,六項評估皆 PASS | 無,逐字相同 |

**目前支持的結論:** Step 6.1 後,本次兩個 single-specialist SIMPLE Worker Output 已可原樣作為 user-facing final answer;既有 synthesis 在這兩次未帶來可觀察的 correctness、compression 或 presentation 增量。相較 rev.7,這補上了嚴格格式/排除項與短摘要的品質證據。

**尚不能推出的結論:** 不能把三種不同題型各一次的觀察當成成功率或 latency distribution,也不能據此把 `assignments.length === 1` 視為充足的省略條件。本輪只涵蓋兩位專家/兩個 provider,未涵蓋檢索、失敗/空輸出、normal/deep 或其他語言。本輪 Chief mission 皆中文,未重新測試英文 mission 的 language drift;該例的既有觀察在第十二-B節。

這兩題的 mission 覆蓋整個小任務,因此 scope PASS 僅表示未超出本題責任,**不能證明多專家、部分委派任務下不會接管完整任務**。本輪是比較既有三階段的原始輸出,沒有執行或驗證尚未實作的 direct path。Step 7 仍為 **NOT IMPLEMENTED**;後續決策應把實際輸出是否符合原始 task 與可觀察的 synthesis 價值納入,而非只看 specialist 數量或 latency。

## 證據檔與驗證

- [固定題目與事前驗收條件](regressions/simple-readiness/cases.json)
- [Live harness](regressions/simple-readiness/run.mjs): 沿用 MCP 入口,每題一次,保留完整回應;拒絕覆寫既有證據目錄。
- [SIMPLE-2 結果](regressions/simple-readiness/2026-09-05/SIMPLE-2.json)、[原始 MCP 回應](regressions/simple-readiness/2026-09-05/SIMPLE-2-mcp.json)
- [SIMPLE-3 結果](regressions/simple-readiness/2026-09-05/SIMPLE-3.json)、[原始 MCP 回應](regressions/simple-readiness/2026-09-05/SIMPLE-3-mcp.json)
- [執行設定與事前雜湊](regressions/simple-readiness/2026-09-05/manifest.json)、[事後一致性紀錄](regressions/simple-readiness/2026-09-05/integrity.json): `src/`、`dist/`、原 `benchmark-task.mjs`、package files 均未變更;未記錄任何 API key。
- [離線證據驗證](regressions/simple-readiness/verify.mjs): fixture 雜湊、原始 MCP 與結果一致、三階段/單專家/狀態、表格資料與結構、摘要長度與關鍵事實、Worker/Synthesis 逐字一致皆 PASS。語意、語言及交付品質另外逐項人工檢視如上;不是產品的通用 Validation Layer。

已執行:

```sh
node regressions/simple-readiness/verify.mjs regressions/simple-readiness/2026-09-05
```

結果: SIMPLE-2 PASS; SIMPLE-3 PASS。測試結果與本文件會一起提交至 notes repo;產品 runtime 未修改。

---

# 十三、發現的正確性缺陷:Worker Context Loss

## 這次 synthesis 做了什麼

| | 內容 | 長度 |
|---|---|---|
| 專家產出 | **英文** markdown 表格 + 計算過程 | 460 字元 |
| synthesis 後 | **中文**,只有答案與排序 | 112 字元 |

原始 task 是中文。實際的執行鏈是:

```
Original User Task（中文）
        ↓
      Chief
        ↓
Assigned Mission（這次寫成純英文）
        ↓
      Worker  ← 只拿到 Mission,從未看過 Original Task
        ↓
Worker Output（英文）
        ↓
   Synthesizer  ← 重新取得 Original User Task
        ↓
Final Output（中文）
```

**synthesis 並非單純重複轉述。它補救了上游的 context loss** —— user language recovery、output formatting、original task reconciliation。

若照原提案直接實作 `assignments.length === 1 → synthesize: false`,這個中文任務最後會得到**英文的 Worker Output**。那是 output regression,不是 optimization。

## ⚠️ 不要把問題定義成「Mission Language Drift」

語言只是第一個被觀察到的**症狀**。真正的架構問題是:

> **Worker Context Loss** —— Original User Task 在 `Chief → Worker` 這個 delegation boundary 被丟失。

同一個缺陷未來同樣可能吃掉:輸出語言、格式要求、預算約束、地理範圍、時間範圍、明確排除項、要求的輸出結構、使用者特定需求、task 層級約束、原始意圖。

**這是 correctness / context propagation 問題,不是 prompt language 問題。**

## 發生率(實測 observation,樣本已標明)

比對所有已記錄的執行(task 皆為中文),用中日韓字元比例衡量:

| 執行 | mission | worker 產出 |
|---|---|---|
| deep run 1 | 68–74% | 44–48% |
| deep run 2 | 47–71% | 44–52% |
| deep run 3 | 66–68% | 44–49% |
| **simple baseline** | **0%** | **0%** |

deep 任務的 mission 都是中文,worker 也用中文回答。**只有這次 simple 任務,Chief 把 mission 寫成純英文。**

**偶發,不是系統性 —— 但偶發就足以讓「單一專家跳過 synthesis」不能無條件成立。**

## ⚠️ 24% 這個數字的正確寫法

**正確(實測 observation,n=1):**

> 在這一次 SIMPLE baseline 中,synthesis 佔了 6.2 秒 / 總時間的 24%。

**錯誤(把 n=1 當通則,且忽略 synthesis 本次確實有功能):**

> ~~Step 7 可以讓 SIMPLE 任務快 24%。~~

目前沒有證據支持這個推論。

---

# 十四、Step 6.1 — Worker Context Propagation(DONE)

## 核心原則(architecture decision)

> **Original Task 與 Assigned Mission 是兩種不同的資訊,兩者都必須存在於 Worker 的執行 context。**

| | 是什麼 |
|---|---|
| **Original User Task** | immutable task context —— 使用者真正要求什麼,以及 task 層級的約束 |
| **Assigned Mission** | delegated responsibility —— 這位專家負責哪一部分 |

**Mission 不得取代 Original Task。**

## 必須同時保證兩件事

修好 context 之後會冒出新的失敗模式:worker 拿到完整 task 後開始接管整件事。

```
Original Task: 制定完整公司成長策略,包含市場、財務、品牌
Assigned Mission: 分析市場競爭環境與外部證據
```

`market_researcher` **應該**知道完整 Original Task(那是 context),但**仍然只能**負責市場與證據,不能自己開始做品牌策略、財務模型或最終建議。

```
Context Preservation  +  Mission Scope Preservation
```

## ⚠️ 不得用 prompt calibration 修

**不要**在 Chief 常設簡報加「mission 一律用使用者的語言撰寫」這類句子。那會把**結構性的 context-loss 缺陷**降格成**prompt 行為校準**。

> **Structural mechanisms > prompt persuasion**

應該修的是 **Worker Input Contract**,而不是要求 Chief 更努力把 Original Task 壓縮進 Mission。

## 驗證方向(不要只測語言)

Language / Format / Constraint / Scope / Explicit Exclusion —— 五個維度的細節見 `STEP7_SCOPE_ANALYSIS.md` 第 10 節。

## ⚠️ 修好之後不要直接移除 synthesis

目前只能得到:

> **修復 Worker Context Propagation 是重新評估 single-specialist synthesis 的必要前提。**

**不能**得到:

> ~~修完之後 synthesis 就一定沒有價值。~~

synthesis 目前可能同時提供 language recovery、format normalization、task reconciliation、multi-agent synthesis、final answer compression、user-facing presentation。Step 6.1 後的原 SIMPLE baseline(第十二-B節)顯示 language recovery 缺陷已改善,synthesis 仍提供壓縮與呈現整理。rev.8 新增的兩題(第十二-C節)則皆已可原樣交付,Synthesis 與 Worker 逐字相同。這些品質證據應納入後續決策,但仍不能直接把 `single specialist → synthesize: false` 當成已普遍證明安全。

## 仍然成立的 Step 7 / Step 9 不變式

本次發現不影響:

```
ExecutionPolicy must not depend on ProviderName.
```

---

# 十五、本專案累積的工程原則

rev. 18 新增:

> **A call asked both to resolve a conflict and to report unresolved conflicts will resolve it. Doing the first job well destroys the reason to do the second.**

這條是實測換來的。Controlled replay 給 gate 一組明確的 B vs C 跨專家衝突,gate **認出來了** —— 回答裡有一段標題就叫「專家分歧與如何處理」—— 然後把它整合進答案,因此依附錄自己的規則(「只在解決它會改變答案裡的決策時才提報」)正確地省略了區塊。模型沒有失誤,是兩個責任互相抵消。

rev. 15 新增:

> **A rate is not an outcome. How often a mechanism fires says nothing about whether the times it fired were worth it.**

⚠️ **這條取代了 rev.14 我寫的「觸發率就是停止條件」。** 那個寫法是錯的:低觸發率同樣可以代表 gate 很精準 —— 只在真正有跨專家分歧時才啟動。把稀有當成無用,會把一個有鑑別力的機制當成失敗砍掉。觸發率降級為 **diagnostic metric**;真正要量的是 *triggered usefulness* —— Round 2 有沒有修正 material problem 或改變重要決策。

rev. 14 新增:

> **Never put the deliverable behind a parse that runs after the cost is already spent.**

rev. 6 新增:

> **Do not remove a stage merely because its nominal responsibility appears redundant. First verify what hidden corrective responsibilities that stage is actually performing in the current system.**

rev. 4:

> **Do not analyze why a model made a choice until you first verify exactly what the model actually saw.**

一貫原則:

> **Measurement overrides architecture speculation.**
> **Structural mechanisms > prompt persuasion.**
> **Runtime truth > architecture assumption.**

補充:

> **A single measurement is evidence of a failure mode, not a universal performance law.**

---

# 十六、Step 7 V1 — IMPLEMENTED

## Eligibility 與邊界

現行流程保留獨立 planning 與可稽核 structured plan。完成原有 constraints enforcement 與 Worker 執行後,由純函式 `deriveExecutionPolicy(facts)` 判斷:

```text
complexity === simple
AND enforced plan has exactly one assignment
AND run status === SUCCESS and the existing synthesis failure guard allows proceeding
AND exactly one matching Worker result, with no error
AND output is a string whose trimmed length is greater than zero
AND selected execution does not request retrieval
AND Worker result carries no retrieval metadata
    -> policy.synthesize = false
    -> finalOutput = exact Worker raw output
    -> synthesisMs = 0
```

`trim()` 只用於判斷有無文字,不替換輸出。`valid` 在 V1 指型別與非空檢查,不是語意正確性、格式或 claim-level validation;本輪未新增 Validation Layer。

Retrieval requirement 取自 **enforced assignments 中被選中的 Worker** 是否實際會收到 `retrieval: { enabled: true }`,不是看 roster 裡是否存在 researcher,也不解析 Chief 的自由文字或比對 provider/model。已要求 retrieval 的執行即使回傳 `UNGROUNDED`、`FAILED` 或沒有 metadata,仍排除 fast path;意外出現的 retrieval metadata 也保守排除。

| 執行情況 | 行為 |
|---|---|
| SIMPLE + 1 成功、非空、non-retrieval Worker | planning + worker,Worker 原文直接交付 |
| NORMAL / DEEP + 1 Worker | 保留 synthesis,即使由 budget cap 限制至 1 人 |
| SIMPLE + 多 assignments 的異常 policy input | 不走 direct;以純函式測試驗證,不繞過產品原有 cap |
| SIMPLE + retrieval required / metadata present | 保留 synthesis |
| 多人成功 / 部分失敗 | 保留 synthesis,原 SUCCESS / DEGRADED 與 banner 語意不變 |
| 全員失敗(包括單 Worker 失敗) | FAILED,finalOutput = null,無 synthesis |
| 未知 complexity/status/retrieval fact、缺少/多出/不匹配的 result、result 帶 error | 保守維持 synthesis,不推定 direct eligibility |
| 非字串、空字串、只有空白的異常 adapter 輸出 | 不走 direct,維持原本的 synthesis fallback;不重定義 Run Status |

現行 provider adapters 已會對空白文字丟錯,走既有 Worker failure 流程。異常 adapter 測試刻意模擬不遵守 adapter contract 的輸出,只驗證 policy 不會把它直接交付。

## Report 與 Timing

`buildRunReport()` 的 SUCCESS / DEGRADED / FAILED 判準未改。`runOrchestrator()` 回傳時一律附加 `report.policy`;原 standalone `buildRunReport()` 沒有完整 plan,不自行推導 policy。

Direct path 範例:

```json
{
  "status": "SUCCESS",
  "synthesisAllowed": true,
  "policy": {
    "topology": "single",
    "synthesize": false,
    "reason": "simple_single_specialist_direct_delivery"
  }
}
```

`topology` 表示 assigned specialist 數量,不是 stage 數量;NORMAL + 1 Worker 也可為 `single` 且 `synthesize: true`。`synthesisAllowed` 表示 Run Status 是否允許後續整合,**不再可用它單獨推斷 synthesis 是否執行**。既有呼叫端應優先讀取 `report.policy.synthesize`;舊報告沒有 policy 時才 fallback 至 `synthesisAllowed`。

| reason | synthesize | 意義 |
|---|---|---|
| `simple_single_specialist_direct_delivery` | false | 合格的有界 fast path |
| `no_successful_workers` | false | 原有全敗 guard,finalOutput 為 null |
| `non_simple_execution` | true | NORMAL / DEEP 保留原路徑 |
| `not_single_specialist` | true | 不符合單一 assignment |
| `retrieval_not_eligible` | true | retrieval required、未知或帶 retrieval metadata |
| `invalid_worker_output` | true | 非字串/空白文字 |
| `unsupported_execution_state` | true | 其他不明或不一致的 execution facts |

所有回傳路徑保留 `planningMs / workersMs / synthesisMs / totalMs`。兩種略過 synthesis 的情況都有明確 reason 與 notes,不再只以 `synthesisMs = 0` 猜測發生了什麼。本輪沒有新增其他 disable-synthesis 選項。

## 修改範圍

- `src/agents/policy.ts`: 純函式與只含 plan/execution facts 的輸入型別;沒有 provider/model identifier 或 runtime import。
- `src/modes/orchestrator.ts`: 可注入 dispatcher `call`(預設原 `callProvider`,不暴露於 MCP schema)、附加 policy、依 policy 略過 synthesis。
- `test-execution-policy.mjs` 與 `package.json`: 36 項 mock/policy/replay 測試納入 `npm test`。
- `test-simple-baseline.mjs`、`test-orchestrator.mjs`: 修正既有 API call count 與輸出標示,讀取 policy;題目、roster 與 sampling 未變,本輪未 live 執行。
- `README.md`、`.gitignore`: repository 的建置說明與本機設定/產物忽略規則。原本未追蹤的 source/既有測試/lockfile 另外以 baseline commit 納入,不屬於 Step 7 runtime 改寫。

Chief system prompt、Worker input contract、planning schema/cap、agent registry、provider adapters、retrieval wiring、evidence summary/banner、模型選擇皆保留。Synthesis 的原 prompt 與模型呼叫參數也保留,僅合格 fast path 不呼叫它。

## 驗證結果

| Test suite | 通過 |
|---|---:|
| `test-chief.mjs` | 11 |
| `test-run-status.mjs`(含 Step 6.1 三項) | 25 |
| `test-registry.mjs` | 20 |
| `test-mcp-smoke.mjs` | 7 |
| `test-execution-policy.mjs`(新增) | 36 |
| **合計** | **99,0 failed** |

新增測試直接計數 planning/worker/synthesis 的 dispatcher 呼叫;驗證 non-retrieval SIMPLE 僅 2 次、NORMAL/DEEP 單專家仍 3 次、多人/失敗邊界、raw text 與 UTF-8 bytes 等值、timing schema、可序列化的 policy/reason、retrieval metadata/source/count/banner 保留、變更模型身分不改 policy。SIMPLE-2/3 使用 rev.8 儲存的 Worker 輸出與 mission 離線 replay,不是新的 live 品質或 latency 樣本。

`npm ci` 使用既有 lockfile 完成獨立安裝,`npm test` 全數通過。沒有新增 dependency、沒有燒 live API,也未修改 rev.7/8 原始證據或宣稱新的 latency 分佈。

**Scope deviation: 無。** 附帶的 Git baseline import 依使用者明確選擇進行,兩個既有測試腳本的調整為 policy 稽核相容性。未開始 Step 8、Model Router、retrieval/normal/deep fast path、zero-specialist、fused planning、prompt recalibration、Validation Layer 或新的 benchmark expansion。完成本輪後停止。

---

# 十七、Step 8 — SCOPE ANALYSIS COMPLETE / NOT IMPLEMENTED

完整分析見 [`STEP8_SCOPE_ANALYSIS.md`](STEP8_SCOPE_ANALYSIS.md)。本輪以 baseline commit `d80416701690fc380a6aa160723ec71aa97419d6` 查核現行 code 與 pinned SDK,結論如下：

1. 三家 provider response 都有某種 usage metadata,但欄位語意不同,且現行 adapters 全部在 `CallResult` 邊界丟棄。
2. 現行 `planningMs / workersMs / synthesisMs / totalMs` 是 orchestrator phase wall time;沒有 per-call duration。平行 `workersMs` 不可當 worker call durations 總和。
3. 現行 optional `ModelPricing` 全部留空是正確狀態;兩個 token rates 不足以表示 cache、thinking/reasoning、tier、region、context band、modality 與 tools。
4. Runtime usage truth、pricing registry、cost calculation 與 run-level reporting 必須維持四層分離。Missing 不是 0;partial subtotal 不是 total;public list estimate 不是 invoice cost。
5. 建議 V1 先接 usage + call latency + coverage-aware reporting,並只定義 pricing/cost contracts。未經另一次價格資料審查,registry 維持空白、cost 明示 unavailable。

rev.10 的分析輪未修改 `src/`、`package.json` 或測試,未執行 live API,也未開始 Step 8 implementation。Step 8 分析保留為 review-ready input。rev.12 已完成 Step 7.1 E2E acceptance;下一步先做 Milestone 2 scope/acceptance design,經 architecture review 後才 implementation,再回到 Step 8 implementation。

---

# 十八、Step 7.1 — E2E RUNTIME ACCEPTANCE(DONE / A+B PASS)

## rev.12 Live 結果

2026-09-05(Asia/Taipei)經 MCP stdio consumer 執行實際專案的 `dist/index.js`,Chief/synthesizer 使用既有 `openai / gpt-5`,沿用固定 `BENCHMARK_ROSTER`。未修改 Chief prompt、Worker contract、runtime、roster、complexity definitions 或 ExecutionPolicy。

| 項目 | Test A | Test B attempt 1 | Test B corrected fixture |
|---|---|---|---|
| 最終驗收 | **PASS** | **TEST_NOT_EXERCISED** | **PASS** |
| complexity / assignments | simple / 1 | normal / 3 | deep / 3 |
| run status | SUCCESS | SUCCESS | SUCCESS |
| logical model calls | 2 | 5 | 5 |
| policy.synthesize | false | true | true |
| evidenceLabel | NOT_APPLICABLE | NOT_APPLICABLE | PARTIALLY_GROUNDED |
| queries / sources | 不適用 | 6 / 20 | 6 / 21 |
| planningMs | 7,318 | 27,570 | 18,854 |
| workersMs | 5,216 | 139,961 | 122,082 |
| synthesisMs | 0 | 77,889 | 110,377 |
| totalMs | 12,534 | 245,420 | 251,313 |

**A:** `simple_single_specialist_direct_delivery`,Worker raw text 與 `finalOutput` 完全相等。含稅金額、C→A→B 排序、繁中、constraints、format、mission scope 與 user-facing readability 逐項檢查通過。較長的計算說明與 mission-scope 結尾屬 cosmetic variance。初版 checker 因 Markdown emphasis/punctuation 誤判,只修 local harness 並重驗同一原文,沒有重跑 API。原 `normalized-result.json` 的 FAIL 保留,由 `evaluation.json` 明確記錄 `HARNESS_FALSE_NEGATIVE` 與最終 PASS。

**B attempt 1:** 有研究與 synthesis,但初版新服務提案未明示重大投資/stakes,Chief 依既有規則判 normal,未測到目標 DEEP banner branch。Observation、初步 root cause、affected layer(test fixture / planning input)與最小修正 scope 均保存於 evaluation。僅將 task 改為董事會重大投資、40% 預算與 6 名核心人員投入、現金流風險,沒有指定 agent/provider 或修改 runtime,只補跑一次。

**B corrected:** Chief 自然選出三種 capabilities,其中 evidence-capable Worker 回傳 `GROUNDED`、6 queries、21 sources,含 `webSearchQueries`、`groundingChunks`、`groundingSupports` 原始 metadata。Worker 與 report source/count 資料一致;三個 Worker 成功後 synthesis 執行,finalOutput 以現行 exact `PARTIALLY GROUNDED — claims not yet validated` banner 開頭,沒有宣稱 `EVIDENCE_BACKED`。這是 runtime chain acceptance,不是 final answer 所有商業主張/價格的 claim-level validation。

### 證據與量測界線

- [`regressions/step7-1-e2e/README.md`](regressions/step7-1-e2e/README.md) 為證據索引與離線重驗方式;三次 attempt 均保留 task、manifest、raw MCP response、normalized result、evaluation、timestamps 與 runtime fingerprints,另有全目錄 `hashes.json`。
- Chief mission 為 MCP `plan.assignments[].mission`;Worker 原文為 `workerResults[].output`。A 沒有 synthesis output;B 的 `finalOutput` 含 runtime banner,可依 normalized observation 保存的 exact `expectedBanner` 前綴取出未改寫的 synthesis 原文。未保存 provider HTTP response envelope 或 Chief 原始 planning envelope。
- Logical model call count 依成功 plan assignments 與實際 policy/report、未變的 production branches 及離線 dispatcher tests 核對,不是獨立 live HTTP trace,不含 SDK retry 次數。
- `retrieval: { enabled: true }` 的依據是 resolved `evidenceCapable` execution fact、orchestrator 的 capability-based dispatch branch、Gemini adapter 僅在此選項啟用時掛載 search/回傳 retrieval metadata,以及實際返回的 GROUNDED metadata。沒有另行攔截並記錄 CallOptions;不以 provider/agent 名稱推定。
- Timing 為 runtime `Date.now()` phase wall time,不含 MCP 啟動/傳輸;workersMs 是平行 span,不是各 Worker latency 的總和。本輪不估計 latency distribution、token 或 cost。

本輪 `npm test`: **99 passed / 0 failed**。Runtime source/build before-after fingerprints 一致,沒有 runtime code 修改;只有 local harness/fixture 修正。Step 7 現為 code + runtime accepted,但不保證所有未來 SIMPLE 答案 presentation 等質。到此停止,下一輪才做 Milestone 2 scope analysis。

## 為什麼需要 7.1

Step 7 的 36 項新增測試證明 policy、call count、raw-output equality、timing schema 與 failure/retrieval boundary 符合 specification;它們不驗證 live model behavior 或 MCP consumer integration。rev.11 時的鏈路缺口是:Gemini grounding、orchestrator deep run 與 evidence banner 各自測過,但以下完整 production path 尚未 live E2E 成立;rev.12 已以上述 Test B 補齊：

```text
DEEP task
→ Chief selects evidence-capable specialist
→ retrieval enabled
→ live Google Search
→ GROUNDED metadata/sources
→ synthesis
→ PARTIALLY_GROUNDED final banner/report
```

Step 7.1 只補這兩個具體缺口,不是重開 benchmark expansion。

## Test A — SIMPLE Direct Delivery E2E

必須從 MCP consumer 走完整 live path並保存原始回應。Pass conditions：

```text
planning → worker → direct delivery
model calls = 2
status = SUCCESS
report.policy.synthesize = false
report.policy.reason = simple_single_specialist_direct_delivery
timings.synthesisMs = 0
finalOutput === exact Worker raw output
MCP consumer 可讀取新的 policy/report semantics
```

內容驗收至少檢查 correctness、language、requested format/constraints、mission scope 與 user-facing acceptability。Presentation normalization 可能與舊 synthesis 版不同;純 cosmetic verbosity 不自動算 correctness failure,但結果不得被描述為「保證與 synthesis 等質」。

## Test B — DEEP Grounded Orchestrator E2E

Task 必須自然、明確需要最新外部 evidence,不可用測試 harness 強制指定 market researcher 來繞過 Chief planning。Pass conditions：

```text
complexity = deep
Chief naturally selects an evidence-capable specialist
retrieval is actually requested
live grounding occurs
retrieval.status = GROUNDED
sources and grounding metadata survive the worker boundary
synthesis runs
run status/evidence summary remain coherent
final output begins with the correct PARTIALLY_GROUNDED warning/banner
source information is preserved and inspectable
```

若 Chief 未選 evidence-capable specialist,該次只能記為「未測到目標鏈路 / inconclusive」,不能算 pass。這一輪只要求一條有效的 targeted E2E observation,不從單次 latency 推估 distribution,也不順便把 deep planning variance 擴成 n=5。

## Acceptance boundary

- A 與 B 都通過後,Step 7 才標記為 production E2E accepted。
- 任一失敗時先保存 raw evidence、分類是 policy、provider、retrieval、report 還是 consumer defect;不得悄悄跳過或直接進下一 milestone。
- Step 7.1 不加入 readability regex、不新增 LLM quality gate、不回滾 Step 7。
- 除非 live test 揭露實際 defect,本階段應只有 harness/evidence/HANDOFF 變更;任何 runtime fix 另行定義 scope 並重新驗證 99 項離線測試。

---

# 十九、Milestone 2 — ROADMAP DECISION(rev.11/13 原始方向,已被第二十節依 code reality 修正)

## Roadmap decision

Milestone 1 已證明三種基本模式可運作：Pipeline 會傳遞前一模型輸出,Orchestrator 會由 Chief 分工後平行執行並 synthesis,Debate 會互評再由 Judge 決定。這完成了「三個模型能接上並參與同一工作」,但現行 Orchestrator 主要仍是 fan-out / fan-in：

```text
Chief plan
→ specialists work independently in parallel
→ one final synthesis
```

使用者的產品北極星更進一步：不同模型要能利用彼此結果、指出分歧、針對分歧修正,最後形成比單一模型更好的決策。因此 roadmap 在 Step 7.1 後插入 Milestone 2,優先於 Step 8 implementation。

## Target collaboration shape

```text
Chief planning
→ Round 1: multiple specialists produce role-specific work
→ Chief identifies disagreements, unsupported assumptions and gaps
→ Round 2: targeted cross-critique / evidence challenge / revision
→ Chief Decision: resolves or explicitly preserves remaining disagreement
→ user-facing final answer with traceable contributions
```

rev.13 將這個方向縮成待分析候選,不是 implementation specification：

```text
Chief Planning → Round 1 Specialists → Synthesis Gate
                                           │
                              no issue ─────┴──── targeted issue
                                  ↓                    ↓
                                Final      Round 2(max 1 specialist)
                                                       ↓
                                               Decision Synthesis
                                                       ↓
                                                     Final
```

候選 hard boundaries:最多 2 rounds、Round 2 最多 1 assignment、不要獨立 Chief Review/Judge/autonomous loop/planning loop/full-output broadcast,Round 2 failure 回退 provisional answer,且 collaboration 不得提升 evidence label。這些邊界需由 `MILESTONE2_SCOPE_ANALYSIS.md` 依 code reality 挑戰或確認;未經 architecture review 不實作。

研究、商業/風險與品牌/創意等角色只是示例,不能硬編碼成 provider preference。Planning/execution 仍以 role/capability facts 為依據;Milestone 2 的 live acceptance 可以刻意配置三個不同 provider-backed agents來證明跨模型協作,但不改寫「Execution Policy 不依賴 ProviderName」與 Step 9 Model Router boundary。

## Milestone 2 要回答的問題

1. 至少兩個 specialist 是否實際讀取並引用另一人的產出,而非三份獨立答案並排？
2. Chief 是否能明確找出 material disagreement 或 unsupported assumption？
3. Round 2 是否因 cross-critique / evidence 而修正、收斂或合理保留分歧？
4. Final decision 是否能追溯哪些結論來自何種角色/evidence,且不把未解分歧藏掉？
5. 相對單一模型 baseline 是否有可觀察品質增量？此項需在測試前先定義 rubric 與 comparison protocol,不能只靠另一個模型說「比較好」。
6. 額外 rounds 的 latency/cost 是否值得品質增量？在 Step 8 尚未 implementation 前只能保存 call count 與現有 timing observations,不能填假 token/cost。

## Scope gate

Milestone 2 目前是 **roadmap decision,不是 implementation specification**。Step 7.1 通過後先做 code-reality scope analysis、state machine/data flow、停止條件、failure semantics 與 acceptance design,經 architecture review 才能開始 runtime implementation。

新的主線順序：

```text
Step 7.1 E2E Runtime Acceptance
→ Milestone 2 scope + architecture review
→ True Multi-Agent Collaboration implementation + real-work acceptance
→ Step 8 Cost / Token / Latency implementation
→ Step 9 Model Router
→ Step 10 Validation Layer
```

Step 8 並未取消;rev.10 的 usage/pricing/cost/reporting 分層仍是有效設計輸入,只是優先順序讓位給核心產品價值驗證。Claude Code 的完整下一棒說明見 [`CLAUDE_CODE_HANDOFF.md`](CLAUDE_CODE_HANDOFF.md)。

---

# 二十、Milestone 2 — SCOPE ANALYSIS COMPLETE / NOT IMPLEMENTED

完整文件:[`MILESTONE2_SCOPE_ANALYSIS.md`](MILESTONE2_SCOPE_ANALYSIS.md)(582 行,18 題全數回答)。本節只保留會影響決策的部分。

## 交接快照的兩處不一致(皆非 runtime 缺陷)

| 代號 | 內容 | 處置 |
|---|---|---|
| D1 | 本地工作目錄不是 git checkout,`git rev-parse` 直接 fatal | 改以逐位元組比對驗證,五個關鍵原始碼檔與遠端 `main`(HEAD `656d7b6`)相同。**本地修改不受版控,無法 diff 也無法 revert —— 實作 M2 的人應該用 clone,不要用這個目錄。** |
| D2 | `regressions/step7-1-e2e/SIMPLE-direct/normalized-result.json` 仍寫 `outcome: FAIL`,唯一 false 的是 `expectedArithmeticAndOrder` | rev.12 `evaluation.md` 已記錄為 harness false negative(checker 未移除 Markdown emphasis,把標籤與金額之間的強調符號當成不相鄰),`run-case.mjs` 已修但 artifact 未重跑。**不是 runtime 缺陷。** |

## 對 rev.13 候選邊界的兩處修正

**1. DEEP logical call ceiling 是 `N + 4`,不是「約 7」。**

`N` 是 Round 1 assignment 數。7 只對三專家計畫成立;`SPECIALIST_CAP.deep = 4`,所以上限是 8。Planning 是 bounded-not-deterministic —— 同一 DEEP task 實測出現過 2 與 3 個 mission。上限寫死成 7 會讓一次合法的四專家執行看起來像違規。

```text
1 planning + N workers + 1 gate/synthesis + (0 or 1) Round 2 + (0 or 1) decision synthesis
```

**2. synthesizer 目前收不到任何 retrieval metadata。**

synthesis prompt 只包含 original task,以及每個成功 worker 的 `agentId` / `mission` / `output`(加上 DEGRADED 註記)。**寫出最終答案的模型從來沒看過檢索到哪些來源。** source URL 只進到 `report` 與給人看的 banner。

因此:一個被要求判斷 `needs_evidence` 的 gate,會是在對它看不到的證據做推論。要 gate 這個維度,必須先把 retrieval status / query / source 摘要餵進 synthesis input —— 這是 M2 的**前置改動**,不是實作 gate 的附帶效果。

## 核心設計建議:不要把交付物押在 parse 上

目前 orchestrator 只有**一個** parse 依賴(Chief 的計畫 JSON),而它失敗在**任何 worker 花錢之前**,失敗成本是一次 planning 呼叫。

Synthesis gate 會加上**第二個** parse 依賴,位置在**所有 worker 成本都已付出之後**(實測 DEEP 為 232.9s),而且就在產生交付物的那一次呼叫上。

建議形狀:

```text
自由文字的 provisional answer(交付物本身)
[--- optional machine-readable block ---]
{ "issues": [ ... ] }   ← best-effort 解析,可以缺席
```

任何解析失敗都退回今天的行為(直接交付 synthesis 文字並記一條 note)。**最差情況等於現狀加一條註記,而不是交付物損毀。**

## 主要風險是 latency,不是 correctness

synthesis 已是最慢的單一階段:110.4s / 251.3s(44%)。觸發 Round 2 等於再加一次 synthesis 等級呼叫,DEEP 總時長可能從約 251s 推到 400s 以上。

新增一條 handoff 未列的停止條件:

> **若 gate 幾乎不觸發,C 就等於 B 再加一個浪費在關鍵路徑上的結構化輸出要求。觸發率本身就是 kill criterion,而且它比品質更早、更便宜就能量測。**

先量觸發率,不要先量品質。

## 實驗設計上的兩個 code-level 阻礙

| 代號 | 阻礙 | 影響 |
|---|---|---|
| E1 | 只有 `gemini-3.1-pro-preview` 的 `grounded_retrieval` 是 `enabledInRuntime: true` | arm A(強單模型)要與 B/C 檢索對等,目前**只能是 Gemini**;否則所有 arm 都得關掉檢索,證據維度整個離開實驗。見 Q-B。 |
| E2 | `buildOutputBanner` 會把 `PARTIALLY_GROUNDED` / `DEGRADED` 印在交付物第一行 | 評估者一眼就知道是哪個 arm,盲測失效。**必須比較去掉 banner 的文字。** |

## 一個會壞掉的測試基礎設施

`test-execution-policy.mjs:38`:

```js
const stage = calls.length === 0 ? 'planning' : options.system ? 'worker' : 'synthesis';
```

**synthesis 是靠「沒有 system prompt」辨識的。** M2 會引入第二個 synthesis 等級呼叫,任一個帶上 system prompt 就會被誤判成 worker。必須在寫 M2 測試**之前**換成明確的 stage 標籤,否則呼叫數斷言會安靜地量錯東西。

## 不變式:collaboration 不得提升 evidence label

今天這條由結構保證 —— evidence label 由 retrieval status 推導,collaboration 不觸碰該推導鏈。M2 必須維持:Round 2 只能**暴露**不確定性、衝突與 evidence gap,不能把 `UNGROUNDED` 升成 `PARTIALLY_GROUNDED`。claim-level evidence validation 仍屬 Step 10。

## 尚待 architecture review 拍板的問題

| # | 問題 |
|---|---|
| Q-A | Round 2 的 retrieval 算不算進 `evidenceLabel`?(**分析者傾向算,但需明確決定才能實作**) |
| Q-B | Arm A 的檢索對等:Gemini-only,還是所有 arm 關檢索? |
| Q-C | gate 該不該看到失敗 worker 的錯誤訊息?目前完全看不到,但失敗本身與決策相關 |
| Q-D | `normal` 會不會被 gate,還是 `deep`-only 是永久邊界? |
| Q-E | Round 2 timings 放哪裡?擴充 `timings` 會改動既有比較依賴的形狀 |
| Q-F | direct-delivery 路徑要不要防禦性地套用 `buildOutputBanner`,讓第 1 節的 latent coupling 不會咬到未來路徑? |
| Q-G | gate 產出 issue 但 Round 2 停用時,issue 要呈現給使用者還是只記錄? |

## Scope gate(未改變)

Milestone 2 仍是 **scope analysis,不是 implementation specification**。未經 architecture review 不進入 runtime implementation。本輪未修改 `src/`、prompts、tests、retrieval、Step 7/8/9/10 runtime,未執行 live benchmark;`npm test` 99 passed / 0 failed。

---

# 二十一、Experimental Milestone 2-A — IMPLEMENTED / DEFAULT OFF / NOT PRODUCTIONIZED

這是**為了量測而做的 prototype**,不是 production feature。它存在只為回答一個問題:**不同 AI 互相挑戰,是否真的比現有 Orchestrator、甚至比同一個模型自己再想一次更有價值?** 在那個問題被實測回答之前,這裡沒有任何東西算是已驗證。

## 執行形狀

```text
Chief Planning
→ Round 1 Specialists(平行)
→ Synthesis Gate  ── provisional answer(交付物)
                   └─ optional collaboration issue block(metadata)
      │
      ├─ 沒有 decision-sensitive peer_challenge → provisional answer = Final
      └─ 有 → Targeted Round 2(最多 1 位)→ Decision Synthesis → Final
```

## Logical call ceiling

```text
1 Chief + N Round-1 Workers + 1 Synthesis Gate + 1 Round-2 Worker + 1 Decision Synthesis = N + 4
```

`SPECIALIST_CAP.deep = 4`,所以 absolute ceiling 是 **8**。測試以精確等式斷言 N=3 → 7、N=4 → 8,並斷言 `round2_worker` 與 `decision_synthesis` 各只出現一次。這是 logical application calls;SDK / HTTP retry 不計入同一個 metric。

## Gate 啟動條件

| 條件 | 不符合時 |
|---|---|
| `experimental.collaboration.enabled === true` | 完全走舊路徑,回傳物件連 `collaboration` 這個 key 都沒有 |
| `complexity === 'deep'` | `NOT_TRIGGERED` / `complexity_not_deep (...)` |
| Round 1 `status === 'SUCCESS'` | `NOT_TRIGGERED` / `round1_status_degraded` |
| 成功的專家 ≥ 2 | `NOT_TRIGGERED` / `single_specialist_no_peer` |

Gate 沒啟動時,synthesis prompt 是既有那一份,一字未改 —— 不合格的執行不會偷偷變成另一個實驗。

DEGRADED 被排除是刻意的:gate 會在少了一位專家的情況下比較專家,這時候的挑戰量到的是那次失敗,不是協作。

## 交付物不押在 parse 上

現有 orchestrator 只有一個 parse 依賴(Chief 計畫),它失敗在任何 worker 花錢**之前**。Gate 的 parse 位置在**所有 Round 1 成本已付出之後**,而且就在產生交付物的那次呼叫上。因此:

| 情況 | 結果 |
|---|---|
| 沒有區塊 | `SKIPPED` / `no_issue_block` |
| JSON 壞掉 | `SKIPPED` / `block_malformed` |
| 不是物件 / 沒有 issues 陣列 | `SKIPPED` / `block_schema_invalid` |
| issue 全部無效 | `SKIPPED` / `no_valid_issue` |
| 有效但不合格 | `SKIPPED` / `no_decision_sensitive_peer_challenge` |
| Round 2 失敗 | `FAILED` / `round2_worker_failed` |
| Decision Synthesis 失敗 | `FAILED` / `decision_synthesis_failed` |

**全部七種都交付 provisional answer,`RunStatus` 保持 Round 1 語意。** 只有結尾、且內容含 `collaborationIssues` 的區塊會被當成 metadata —— 答案裡的 JSON 範例不會被誤吞。

## Issue schema 與 selection

```ts
interface CollaborationIssue {
  targetAgentId: string;   // 必須是成功的 Round 1 專家
  sourceRef: string;       // 必須是成功的、且不同的 Round 1 專家
  challenge: string;
  decisionSensitive: boolean;
  action: 'peer_challenge' | 'needs_evidence';
}
```

Round 2 資格:`decisionSensitive === true && action === 'peer_challenge'`。`needs_evidence` 只記錄。

**`sourceRef !== targetAgentId` 是硬性的。** 自己引用自己是 self-review,正是 arm D 要隔離的東西;放行等於讓 arm C 混進 arm D 的行為,實驗會用錯誤的方式回答自己的問題。

多個合格 issue 時的固定排序:**被挑戰者在 assignment order 的位置 → 挑戰來源的位置 → gate 產出順序**。不隨機、不再叫模型決定、不全部執行。重點不是這個排序最好,而是它固定 —— 同一份 gate 輸出永遠選到同一個 issue,行為改變就不能推給執行間的變異。

## Selective peer context

Round 2 只收到:original task、自己的 mission、自己的 Round 1 輸出、**一段** peer excerpt、**一條** challenge。測試明確斷言第三位專家的輸出**不在** prompt 內,provisional answer 也不在。沒有重用 `run_debate` 的 full-broadcast。

**rev.16 起改為 deterministic chunk reference。** Round 1 輸出由 runtime 依空白行切成 `p1`、`p2`…,`sourceRef` 寫成 `<agentId>:<chunkId>`(例:`market_researcher:p2`)。gate 的附錄會列出所有可用的 reference。

Runtime 負責四件事:deterministic segmentation、sourceRef validation、bounded chunk extraction、audit trail(`agentId` / `chunkId` / `chunkIndex` / `startChar` / `endChar` / `truncated` / `charLimit`,offsets 指向該專家的**完整**輸出,所以引文永遠可以回頭比對)。

不使用:model-generated character offsets、fuzzy quote matching、full worker output broadcast。

bare `<agentId>` 只在該專家的回答**只有一個 chunk** 時接受;多 chunk 時拒絕並回報可用清單 —— 用「取開頭」解歧義正是 rev.15 的缺陷。

Round 2 同時收到 original peer chunk **與** targeted challenge,不是 challenge-only。

`peerExcerptChars` 是 **configurable experimental parameter**,預設值沒有任何實測支持,每次執行都把實際用值寫進報告。

## Evidence 不變式(由結構保證,不是由 prompt 保證)

Round 2 的輸出**不進** `workerResults`、**不進** `summarizeRetrieval`、**不進** `deriveEvidenceLabel`。banner 一律由 Round 1 的 report 產生。因此 collaboration 在結構上碰不到 evidence label。

Round 2 **不掛 retrieval**,即使被挑戰的專家是 `evidenceCapable`。理由是隔離變因:同時加入 peer interaction 與新的外部檢索,之後無法分辨改善來自哪一個。

Decision synthesis 的 prompt 另外明寫「這一輪沒有取得新的外部證據,不得因為專家彼此同意就把任何東西描述成已驗證」—— 但這只是第二道防線,第一道是結構上它根本改不動 label。

測試斷言:開關兩種狀態下 `evidenceLabel` 與 banner 完全相同;任何路徑都不產生 `EVIDENCE_BACKED`。

## CollaborationReport

```text
status:       NOT_TRIGGERED | SKIPPED | COMPLETED | FAILED
reason:       機器可讀的原因字串
answerSource: round1_provisional | round2_decision_synthesis
parse:        { status: absent | parsed | malformed | schema_invalid, note? }
issues:       { emitted, valid, eligible, recorded[], rejected[{index, reason}] }
selectedIssue / round2 { agentId, provider, peerExcerpt, output|error }
timings:      { gateMs?, round2Ms?, decisionSynthesisMs?, totalMs? }
```

`timings.totalMs` **包含 gate**。不含的話,collaboration 會看起來剛好便宜了它所增加的最貴那一次呼叫。既有 `planningMs` / `workersMs` / `synthesisMs` / `totalMs` 的語意與形狀未動;M2 啟用時 `synthesisMs` 就是 gate 那次呼叫的時間,`gateMs` 與它相等,由測試斷言。

## 兩個刻意保留的不對稱

1. **SIMPLE direct-delivery 與 FAILED 執行不回傳 `collaboration` 物件**,即使開關打開。這兩條路徑在 policy 判定後就提前 return,屬於 Step 7 runtime;指令第 10、15 條要求本輪不改它們。deep 執行永遠不會走 direct delivery(policy 回 `non_simple_execution`),所以這不影響 M2 的量測範圍。
2. **direct-delivery 仍不套 `buildOutputBanner`。** 本輪沒有順手改 runtime,改為新增不變式測試:凡是 direct-delivery 合格的 report,`buildOutputBanner(report)` 必須是空字串。未來 policy 一旦放寬到會需要 banner 的情況,測試會先炸,而不是使用者先收到沒有警示的答案。

## Trigger rate 的正確定位

⚠️ 這推翻了 rev.14 我自己寫的一條原則。

觸發率**不是** kill criterion。低觸發率同樣可以代表 gate 很精準 —— 只在真正有跨專家分歧時才啟動。真正要量的是 **triggered usefulness**:Round 2 有沒有修正 material problem、有沒有改變重要決策。

報告因此記錄 `issues.emitted` / `issues.valid` / `issues.eligible` 與是否觸發,但這些是 **diagnostic metric**,不是判決。

## 這輪沒有做的事

independent Chief Review、Judge、`run_debate()` nesting、full peer broadcast、超過 1 位 Round-2 專家、超過 2 rounds、autonomous loop、planning loop、Round-2 retrieval、claim-level validation、`groundingSupports` consumer、Step 8/9/10、pricing、大型 live benchmark、default-on。

## ⚠️ 實作後才看清的一個 confound(指令未提及,尚無解法)

- **arm B**:synthesis prompt = `P` → 答案
- **arm C**:synthesis prompt = `P + 附錄` → provisional answer

**即使 C 完全沒有觸發 Round 2,C 的答案也是在一個和 B 不同的 prompt 下產生的。** 附錄要求模型去尋找跨專家分歧,這件事本身就可能改變答案 —— 更防禦性的措辭、注意力被分走,或反過來因為重讀各專家輸出而更完整。

所以 `C > B` 有可能**完全不是 peer interaction 造成的**,而是附錄造成的。

### ⚠️ 我 rev.15 提的拆法是錯的,已被推翻

rev.15 我提議用「C 執行中 SKIPPED 的那些」當天然的 arm B′,和 COMPLETED 的那些比。**架構審查否決了這個做法,理由是 selection bias,而那個理由是對的** —— 觸發與否不是隨機分派,而是與任務本身相關(有跨專家分歧的任務才會觸發)。拿兩群不同的任務相減,量到的是任務差異,不是 peer interaction。

我當時已經標注「可能不成立」,但仍然把它寫成主要方案。**正確的處理是:一個自己知道可能不成立的識別策略,不應該被寫成方案,應該被寫成待解問題。**

**rev.16 採用的正確做法是 frozen Round-1 replay:**

```text
凍結同一份 Round 1 outputs,只重跑 synthesis:

B   = 既有 synthesis prompt
B′  = gate synthesis prompt + Round 2 強制關閉

(B′ − B) = 附錄本身的效果,同一批任務、同一份 Round 1,沒有分組問題
```

peer interaction 的效果則用**同一次執行內**的配對比較:

```text
C_provisional  vs  C_final     ← 同一個任務、同一份 Round 1、同一次 gate 輸出
```

兩者都是 paired,不需要跨任務相減。`replaySynthesis()` 與 `CollaborationConfig.disableRound2` 就是為此而生。

## 是否已具備進入 A/B/C/D 評估的條件?

**Runtime 具備了,實驗協定還沒有。**

| 項目 | 狀態 |
|---|---|
| arm B vs arm C | ✅ 同一個 MCP 工具,單一 flag 切換,payload 在關閉時逐欄相同 |
| arm A(強單模型) | ✅ 用既有 `run_pipeline` 單步即可,不需要新程式 |
| arm D(單模型 + self-review) | ✅ `run_pipeline` 兩步,第二步用 `{{input}}` 自我檢視 |
| 盲測 | ✅ `finalOutput = banner + text` 且 `buildOutputBanner` 是純函式,`finalOutput.slice(banner.length)` 可精確還原無標籤答案。已加測試 —— 沒有這個,只有 B/C 帶 banner,評分者看第一行就知道是哪個 arm |
| Frozen Evidence Packet | ✅ 架構可支援:四個 arm 全部關檢索、把凍結證據放進 task 文字,即可得到 byte-identical evidence input。**未建置**,依指令第 18 條 |
| 檢索對等(E1) | ⚠️ 未解 —— 只有 Gemini 的 `grounded_retrieval` 是 `enabledInRuntime: true`。現階段唯一乾淨作法是四個 arm 全關檢索,證據維度暫時離開實驗 |
| 附錄效果隔離(B vs B′) | ✅ `replaySynthesis()` + `disableRound2`:凍結同一份 Round 1,只換 synthesis prompt |
| Peer interaction 配對比較 | ✅ `collaboration.provisionalAnswer` 與 `finalOutput` 同時保存,`C_provisional` vs `C_final` 是同一次執行內的配對 |
| 評分 rubric 與比較協定 | ❌ 不存在,依指令第 18 條本輪不建 |
| **Gate 在真實任務上是否會產出 issue** | ❌ **完全未知 —— 從未跑過一次 live gate** |

最後一項是最便宜也最該先做的:在寫任何評分系統之前,先確認 gate 在真實 DEEP 任務上到底會不會產出合格的 peer challenge,以及它產出的 `sourceRef` 是否真的用了 `<agentId>:<chunkId>` 形式。如果從不產出,C 與 B 在行為上就是同一個東西,後面的比較全部沒有意義 —— 但依第 14 條,那是**診斷結果**,不是自動的處決理由:也可能代表這批任務本來就沒有跨專家分歧。

## 首次 Live 應該先看什麼

一次 DEEP 執行(`enabled: true`)就足以回答三個目前完全未知的問題,不需要 benchmark:

1. gate 有沒有產出區塊?區塊有沒有通過 parse?
2. `sourceRef` 是不是 `<agentId>:<chunkId>` 形式、而且指得到存在的 passage?(`chunkMap` 與 `issues.rejected` 會直接說)
3. 模型有沒有遵守「最多一個」?(`issues.eligible > 1` 會留下 note)

這三題的答案決定接下來要不要調 prompt,而它們都不需要評分系統。

已停在此處,未自行開始任何 live 執行。

---

# 二十二、M2-A Diagnostic Live #1 / #2 —— 兩次皆 NOT EXERCISED

證據:[`diagnostics/m2a-live/`](diagnostics/m2a-live/),含每次呼叫的 prompt 原文與回應原文。

兩次執行的 commit 都是 `d1d1d28`,working tree 全程 clean,**沒有修改任何程式**。方法:注入一個 pass-through recorder 當 dispatcher,參數原封不動轉給真正的 `callProvider`,額外保存構建出來的 prompt —— 因此「Round 2 prompt 實際包含什麼」這類問題可以用 artifact 回答,不是靠讀原始碼推論。

## 一句話結論

**targeted peer challenge 機制到目前為止一次也沒有被真正執行過,而且兩次被擋下的原因不同。**

| | Fixture 性質 | complexity | N | 阻擋點 | logical calls |
|---|---|---|---|---|---|
| #1 | 五年租約 + 650 萬 capex 的重大投資決策 | `deep` | 1 | `single_specialist_no_peer` | 3 |
| #2 | 月訂閱新服務,含商業/市場/品牌三種決策資訊 | **`normal`** | 2 | `complexity_not_deep (normal)` | 4 |

**修掉其中一個不會讓另一個消失。** M2-A 的 gate 需要同時滿足 `deep` **且** 至少 2 位成功專家;兩次執行各自缺了其中一個條件。

## Diagnostic #1

Chief 正確判為 `deep`,列出 5 項 required capabilities,但只派 1 位 `business_strategist`。原文理由:

> Additional market/brand specialists would add detail but **not change the core decision under current data constraints**.

Fixture 裡寫了「虛擬製作的實際市場需求我們沒有數據」—— Chief 讀成「市場研究在這裡幫不上忙」。**這一半是任務設計造成的**,不是 planner 缺陷。

`RunStatus: SUCCESS`｜`EvidenceLabel: HYPOTHESIS`(deep 且無 evidence 專家)｜banner 正確附加｜總時長 273.4s。

## Diagnostic #2 —— Planning Reachability PASS

固定 fixture(逐字使用,sha256 `e8b6493d…`)刻意同時包含商業可行性、市場需求判讀、品牌定位三種不可互相取代的資訊。

```
complexity          : normal
requiredCapabilities: business strategy and unit economics
                      brand architecture and service design
assignment count    : 2  → business_strategist(high) + brand_creative(medium)
planningAdjustments : []
```

Chief 原文理由:

> Decision hinges on unit economics/operational risk and brand cannibalization. **No external research is needed.** … **Two specialists are sufficient.**

它排除 `market_researcher` 的理由與 fixture 明寫的「不需要進行外部搜尋」一致。**依既有標準這是 PASS** —— 第 5 節的判準是「>= 2 位」,而不是「一定要 3 位」;2 位若有合理理由,同樣是正確的 Minimum Sufficient Collaboration。

但 complexity 判成 `normal`,而 M2-A 是 DEEP-only,所以 gate 仍未執行。

**這次的材料本來是夠的。** 兩位專家都選 B,但論證基礎不同 —— strategist 從下檔風險與證據強度切入,brand_creative 從定價錨點與客群區隔切入。gate 從來沒有機會看到這組材料。

## 兩次都成立的 runtime 不變式

以實際 artifact 驗證,不是靠程式碼推論:

| 檢查 | #1 | #2 |
|---|---|---|
| gate 未啟動時 synthesis prompt 不含附錄 | ✅ | ✅ |
| 無 `synthesis_gate` / `round2_worker` / `decision_synthesis` stage | ✅ | ✅ |
| `finalOutput` 逐字元 == `banner + synthesis 原文` | ✅ | ✅ |
| evidence label 以 Round 1 獨立重算一致 | ✅ HYPOTHESIS | ✅ NOT_APPLICABLE |
| 所有呼叫皆無 retrieval request 與 result | ✅ | ✅ |
| call ceiling respected | ✅ 3 = 1+N+1 | ✅ 4 = 1+N+1 |
| `collaboration` 物件四態可分辨 | ✅ NOT_TRIGGERED | ✅ NOT_TRIGGERED |

**沒有發現任何 runtime defect。**

## Chunk 壓力觀察(僅觀察,未修改 Chunker)

```
#1  business_strategist : 36 chunks
#2  business_strategist : 23 chunks
    brand_creative      : 17 chunks
    total presented     : 40
```

若 gate 有跑,#2 會面對 40 個可選 reference。

低資訊 chunk 確實存在:#2 的 `business_strategist` 有 10 個少於 40 字元的 chunk,其中 4 個是孤立的 `---` 分隔線,其餘是 Markdown 標題行;`brand_creative` 只有 2 個。

**依指示未修改 Chunker。** 只有在真實 gate 選中無意義 chunk 並造成 peer challenge 錯位時,才構成修改依據 —— 目前沒有這個證據,現在改就是在對著猜測調整。

## Latency 觀察(單次,非平均值)

```
#1  planning 29.9s  | worker      178.6s | synthesis 65.0s  | total 273.4s
#2  planning 20.1s  | workers     572.1s | synthesis 122.3s | total 714.5s
```

#2 的 `brand_creative`(openai)單次 **572.1 秒**,比 #1 的整輪總時長還久。單次觀察,不是平均值、不是 SLA、不是 production performance —— 但值得記在案。

## 本輪不得宣稱的事

多 agent 比單 agent 好、peer challenge 改善答案、M2-A 已證明有產品價值、三位專家才是正確規劃、planner 必須固定招募三人。**兩次執行都沒有讓機制運作,因此對機制的價值一無所知。**

這兩次回答的只有:多 specialist path 在合理任務下是否 reachable(#2:是),以及機制是否按設計運作(仍未知)。

## 給下一輪 Architecture Review 的開放問題

| # | 問題 |
|---|---|
| R-1 | DEEP-only 是否過窄?#2 是一個有真實跨專家分歧的 `normal` 任務,卻不在範圍內 |
| R-2 | 兩次不同 fixture 分別收斂到 1 位與 2 位,是否需要研究 planner policy?(第一次的原因與任務設計有關,不宜單獨當證據) |
| R-3 | 要不要接受「diagnostic 只能靠碰運氣觸發」,還是需要一個能穩定觸發 gate 的方式來驗證機制本身? |
| R-4 | Chunk 切法在 40 個 reference 的規模下是否足夠精準?(目前無證據,不宜先改) |

**R-3 是關鍵。** 目前驗證機制的唯一辦法是不斷跑真實任務、等它自然觸發,而兩次都沒中。這既慢又貴,而且無法保證下一次會中。

---

# 二十三、M2-A Controlled Frozen Round-1 Replay(#3)—— gate 首次執行,仍 NOT EXERCISED

證據:[`diagnostics/m2a-live/controlled-replay/`](diagnostics/m2a-live/controlled-replay/),含逐字 fixture、fixture hash、harness 與完整 artifact(gate prompt 與回應原文)。

## 為什麼改用 replay

#1 與 #2 都被擋在 gate 之前(`single_specialist_no_peer`、`complexity_not_deep`),共花約 16.5 分鐘與 7 次 model call,換到的只有「還是沒觸發」。繼續跑自然任務,期望值不會更好。

改用 controlled frozen Round-1 replay:凍結一份**合法**的 snapshot(`deep` / `SUCCESS` / N=2 / 兩份來源不同、帶明確 B vs C 衝突的 Round 1 輸出),只讓 synthesis 之後的路徑走真實 live 呼叫。

**Planning 與 Round 1 是 synthetic fixture,不在測試範圍內;gate 之後全部是真實 provider call。** 這不是一次自然的 production run,文件與 artifact 都明確標記。

## 架構邊界:不需要 bypass flag

沒有新增 `forceCollaborationGate` / `forceRound2` / `diagnosticMode` 之類的 runtime trigger。既有的 `replaySynthesis()` 就足夠 —— 它委派給 `runSynthesisStage()`,也就是 live orchestrator 用的同一份實作。

harness 沒有自行重寫 gate、parser、chunk resolver、Round 2 builder 或 decision synthesis;重寫了就是在測第二份實作。

## Gate 確實執行了

以 captured prompt 驗證(非推論):

| 項目 | 結果 |
|---|---|
| 附錄實際送達 | ✅ `Optional collaboration block` 在 prompt 中 |
| chunk map 送達 | ✅ 40 個 reference:`business_strategist:p1…p18`、`brand_creative:p1…p22` |
| max-one 規則送達 | ✅ `At most one "peer_challenge" may be emitted.` |
| 保守措辭送達 | ✅ `Prefer omitting the block entirely to inventing a disagreement.` |

Gate prompt 4,513 字元,openai / gpt-5,耗時 68.2 秒。

## 結果:`SKIPPED / no_issue_block`

```
issues.emitted / valid / eligible / rejected : 0 / 0 / 0 / 0
parse.status : absent
```

## ⚠️ 但「gate 沒認出分歧」這個描述是錯的

Architecture Review 預設的失敗敘述是「gate failed to identify the fixture's explicit decision-sensitive disagreement」。**實測不是這樣。**

gate 的回答裡有一段標題明確寫著「**專家分歧與如何處理**」:

> 分歧焦點:是否應「暫不推出」(C)以避免產能/毛利風險,或以「品牌隔離+容量控制」先小規模推出(B)。
> 我們的處理:採 B 的同時,把 C 當成即刻可執行的 Kill Switch。

**它精準認出了 fixture 設計的那個衝突,點名雙方論據,然後在答案裡把它解決掉了。**

而依附錄自己的規則,省略區塊是**正確**的:

> Raise an issue only where … **resolving it would change a decision in the answer**.

分歧已在答案內解決,所以那個條件不成立。**模型遵守了指示,沒有失誤。**

## 這暴露的是責任對立,不是模型缺陷

同一次呼叫被交付兩個互相拉扯的責任:

```
產出一份完整可用的答案   →  必須把衝突處理掉
回報未解決的跨專家衝突   →  需要衝突還沒被處理掉
```

**做好第一件事,就消滅了做第二件事的理由。** 一個把分歧整合進答案的 synthesizer,依定義沒有 issue 可報。

這把 R-3 的問題重新定位:**不是「gate 找不到分歧」的 recall 問題,而是「gate 找到了卻沒有理由用機器可讀通道回報」的通道問題。** 兩者修法完全不同 —— recall 問題要調偵測靈敏度,通道問題要調責任分配。

依指示未修 prompt、未重跑、未人工插入 issue。這是給 Architecture Review 的材料,不是本輪的決定。

## 真實執行中再次成立的不變式

| 檢查 | 結果 |
|---|---|
| `collaboration.provisionalAnswer` 保存 | ✅ 2,565 字元,與 gate 回應逐字元相同 |
| `finalOutput == banner + gate 回應` | ✅ 逐字元相同 |
| EvidenceLabel before / after | ✅ HYPOTHESIS / HYPOTHESIS,以凍結 Round 1 獨立重算亦相同 |
| grounding banner before / after | ✅ 完全相同 |
| retrieval | ✅ 唯一一次呼叫 requested 與 result 皆為 null |
| RunStatus | ✅ SUCCESS |
| live call 數 | ✅ 1(gate 未觸發時的預期值) |

**無 runtime defect。**

## 仍然零次真實執行的部分

```
parser 成功路徑
sourceRef 解析
chunk 擷取
max-one deterministic selection
Round 2
Decision Synthesis
```

三次 live 之後,機制的後半段**一次也沒有被執行過**。

## 三次 live 的完整圖像

| | 性質 | complexity | N | 阻擋點 | live calls |
|---|---|---|---|---|---|
| #1 | 自然任務 | `deep` | 1 | `single_specialist_no_peer` | 3 |
| #2 | 自然任務 | `normal` | 2 | `complexity_not_deep` | 4 |
| #3 | **controlled replay** | `deep` | 2 | **`no_issue_block`(gate 已執行)** | 1 |

前兩次卡在 gate 之前,第三次卡在 gate 之內。**每一次的阻擋點都不同,而且修掉任何一個都不會讓其他兩個消失。**

## 本輪不宣稱

M2-A 比 baseline 好、peer challenge 提升品質、多模型優於單模型、B 比 C 正確、gate recall 不足、NORMAL 應啟用 M2-A、應 productionize、latency/cost 值得。

**#3 只證明了一件事:當合法前置條件存在時,gate 會執行,而它在這一次選擇不提報。**

---

## E0-R-C0 — Execution Runtime Contract Freeze (2026-09-26)

- Base SHA: `4d8ee2ba387570d789c2c21dde0a197f623d64f8` (`origin/main`).
- Work branch: `work/e0-r-c0-execution-runtime-contract`.
- Created `EXECUTION_RUNTIME_CONTRACT.md`; contract/documentation only, pending GPT independent acceptance. Completion is not acceptance.
- H1 formally carried into future capability/parameter reconciliation: globally expressible temperature is currently forwarded by Claude; repository history records a `claude-sonnet-5` HTTP 400 rejection and deliberate passthrough restoration pending redesign. No temperature hotfix or fresh vendor verification.
- Future execution runtime implementation has NOT started. Existing runtime, HumanAdjudication, RouteOutcome, and D1-A boundaries remain unchanged.
- Provider/model calls: 0. No CASE-001 access, review, or modification.
- Historical sections above and older reconciliation snapshots remain preserved; current code takes precedence over historical unimplemented-route descriptions.
- Validation: `npm run build` PASS; `npm test` PASS (853 passed, 0 failed across 9 offline suites). Historical HANDOFF prefix preserved byte-for-byte; `git diff --check` PASS. These checks do not establish live capability verification or architecture acceptance.
- Next planned slice: **E0-R1 — Capability / Parameter Model**. STOP for GPT independent acceptance; no automatic authorization to continue.

---

## E0-R1 — Capability / Parameter Model (2026-09-26)

- Base SHA: `41eaa1fcd86a0aa8ce93b9ed76a0667e7454c56d` (`main`).
- Work branch: `work/e0-r1-capability-parameter-model`.
- Implemented rich model-specific capability assessments with separate provider support, runtime enablement, readiness, and structured repository evidence. Legacy boolean fields/helpers remain as compatibility projections and continue to fail closed.
- Added `temperature` and `max_output_tokens` parameter assessments with explicit-transmission state and constraint variants; added read-only cloned lookup APIs distinguishing unknown model, missing assessment, and recorded assessment.
- H1 is represented for Claude temperature as WIRED_UNVERIFIED with UNKNOWN constraint/transmission, including current adapter source and both historical commits. It is NOT resolved; no fresh provider verification.
- Provider adapters, CallOptions, admission, reconciliation, routing, and execution behavior are unchanged. Provider/model calls: 0.
- Validation: `npm run build` PASS; `npm test` PASS (862 passed, 0 failed across 10 offline suites); `git diff --check` PASS.
- Next planned slice: **E0-R2 — Provider Execution Contract**. STOP for GPT independent acceptance; no automatic authorization to continue.

---

## E0-R2 — Provider Execution Contract (2026-09-26)

- Base SHA: `7c5d47112226a44d1fc3777f80bd0a60e3c993af` (`main`).
- Work branch: `work/e0-r2-provider-execution-contract`.
- Added provider-neutral `ExecutionRequest`, `ProviderBinding`, a future admission data contract, and `ProviderExecutor` under `src/execution/`. Explicit parameters retain normalized `temperature` and `max_output_tokens` names and preserve absent versus supplied values.
- Added `NormalizedExecutionResult` with distinct SUCCESS, KNOWN_FAILURE, and UNCERTAIN outcomes; requested/effective/reported model facts remain separate. Usage, retrieval, finish reason, request ID, and allowlisted metadata remain absent unless supplied by a transport. Unknown thrown errors are conservatively UNCERTAIN.
- Claude, OpenAI, and Gemini executor implementations accept injectable fake transports; their default transports delegate to existing provider functions. The existing adapters retain ownership of provider wire keys and message/tool translation.
- New executor path is NOT wired into canonical runtime. Legacy `callProvider()` and provider adapter behavior are unchanged. Admission evaluation and parameter reconciliation are NOT implemented. H1 remains unresolved.
- Provider/model calls: 0; no live tests or CASE-001 access.
- Validation: `npm run build` PASS; `npm test` PASS (874 passed, 0 failed across 11 offline suites); `git diff --check` PASS.
- Next planned slice: **E0-R3 — Execution Boundary / Admission**. STOP for GPT independent acceptance; no automatic authorization to continue.

---

## G1-C0 — Automation Governance Contract (2026-09-26)

- Base SHA: `9ad6dbbb7f318387e3a498fc91fae9910a37e638` (`origin/main`). Work branch: `work/g1-c0-automation-governance-contract`.
- Created `AUTOMATION_GOVERNANCE_CONTRACT.md` and non-executing reference `automation-governance.example.yaml`. **DEFAULT DENY** and **NO AGENT MAY EXPAND ITS OWN AUTHORITY** are frozen.
- The contract defines roles, authorization matrix, lifecycle states, exactly three operational stop classes, iteration budgets, Git/acceptance/promotion gates, network/secrets boundaries, audit fields, and fail-closed recovery. CASE-001 stays confidential and human-gated.
- Controller runtime, autonomous actions, and E0-R3 are NOT implemented. Provider/model calls: 0; GitHub fetch/protection verification and authorized work-branch push are repository network operations, not zero external network activity.
- Validation: `npm run build` PASS; `npm test` PASS (874 passed, 0 failed across 11 offline suites); `git diff --check` PASS. Completion is not GPT independent acceptance.
- Next planned slice: **G1-R1 — Controller Runtime Foundation**. STOP for GPT independent acceptance; no automatic authorization to continue.

---

## G1-R1 — Controller Runtime Foundation (2026-09-26)

- Base SHA: `d96b18e28110d33cdd5473bfb859ad969f1dff6f` (`origin/main`). Work branch: `work/g1-r1-controller-runtime-foundation`.
- Added isolated `src/automation/` deterministic controller core: G1-C0 state machine and operation policy, strict immutable implementation/correction packets with canonical SHA-256 hashes, SHA-bound remote acceptance, bounded iterations/runtime, action-specific authorization data, explicit stop/resume rules, defensive in-memory store, and append-only operational audit.
- Promotion is a facts-only eligibility/state evaluation; no GitHub push, CI polling, or other repository side effect is performed by the controller. External SHA/CI/authorization inputs are data contracts, **not authenticated** by R1. Human resume records that external preconditions need rechecking.
- GPT integration, Codex integration, GitHub adapter, durable persistence, E0-R3 integration, and unattended automation are NOT implemented or enabled. Provider/model calls: 0; no external runtime integration or CASE-001 access.
- Added 40 fully offline controller tests. Validation: `npm run build` PASS; `npm test` PASS (914 passed, 0 failed across 12 offline suites); `git diff --check` PASS. The 500-line diff warning threshold is exceeded, triggering independent scope review, not automatic rejection; all changed files remain inside the packet allowlist.
- Next planned slice: **G1-R2 — GitHub Reality + Durable State Boundary**. STOP for GPT independent acceptance; no automatic authorization to continue.

---

## G1-R1 — Acceptance Repair (2026-09-26)

- Rejected SHA: `ffb791a1b1eb3db38cda4d6a15a62c3906123ae2`. Base `origin/main` unchanged at `d96b18e28110d33cdd5473bfb859ad969f1dff6f`. Same work branch; normal commits only.
- Scope: GPT acceptance finding (provider/model/network separation) plus architecture-audit F01, F06, F07, F08, F09. F02–F05 and F10–F13 are not addressed here. Changes stay in `src/automation/**`, the two automation test files, `package.json`, and this handoff; the G1-C0 contract and example YAML are unchanged.
- New `src/automation/lifecycle.ts` is the single definition of a legal transition: allowed (action, role, from, to) moves, the fields each action may change, counter rules, and the evidence each state requires. The controller checks every commit against it, `InMemoryControllerStore.replace` enforces it again (and `create` accepts only an empty IDLE run), and `controller.get` re-checks loaded runs. Only `ACCEPT_EXACT_SHA` by `GPT_ARCHITECT` moves into ACCEPTED; resuming a stop re-enters ACCEPTED only when a bound GPT acceptance already exists.
- F01: `stop()` parses its class at runtime and accepts only SOFT_STOP / ARCHITECTURE_STOP / HUMAN_STOP; a refused stop changes nothing.
- F06: validation commands are `{commandId, executable, args, cwd, classification}` — exact argv, repository-relative cwd, issuer-declared `OFFLINE_VALIDATION` or `EXTERNAL_EFFECT`. `RUN_OFFLINE_VALIDATION` needs the commandId as target plus the exact argv/cwd, authorizes only OFFLINE_VALIDATION entries, and returns the bound command for argv execution without a shell. Packets refuse shell launchers (`sh`, `bash`, `env`, …); the classification is an issuer statement, not controller proof that a program is network-free.
- F07: `evaluatePolicy` strictly parses request, packet, actor, and authorization at runtime, refuses unexpected facts, and never throws; anything unrecognised is DENIED.
- F08: the policy authority is private, frozen, and null-prototype; exported `OPERATION_POLICY` is a frozen inspection copy it never reads. Exported vocabularies are frozen, schemas are no longer exported, and controller/store state lives in true `#private` fields on frozen instances and prototypes.
- F09: `time.ts` compares timestamps as epoch milliseconds (Z or ±HH:MM, ≤ ms precision). Promotion grants are re-checked when promotion begins and must be issued at or after the acceptance they promote. HUMAN_STOP resume grants target the stop occurrence (`stopId`, from the audit sequence) and exact run/packet; any authorization id is consumed at most once. Authorization remains a validated data contract — no authenticated identity is claimed.
- Provider calls: `LIVE_PROVIDER_MODEL_CALL` takes `providerCall {provider, model, destination}` as separate facts; each must be separately allowlisted (provider, model, network destination), the level must reach READ_EXTERNAL_API, and the human grant's `scope` must name all three exactly. Nothing is inferred from a model name; no wildcards.
- Added `test-automation-regression.mjs` (59 adversarial offline tests, synthetic data); existing controller tests keep their assertions with fixtures updated to the new command and resume-grant shapes. Mutation checks (each fix disabled in turn) are caught by the suite.
- Known limits for later slices: `externalRecheckRequired` is recorded but not yet consumed before resumed promotion; `evaluatePolicy` judges the packet it is given (active-packet provenance is the controller's); lifecycle-gated operations such as FAST_FORWARD_MAIN also need controller state, not a bare policy verdict; network destinations share one namespace; provider `maxCalls` is gated, not metered; a custom `ControllerStore` is trusted for evidence it fabricates, and direct store writers choose audit timestamps.
- Validation: `npm run build` PASS; `npm test` PASS (973 passed, 0 failed across 13 offline suites); `git diff --check` PASS.
- Provider/model calls: 0. CASE-001 access: 0. Diff warning thresholds (10 files / 500 lines) are exceeded; this triggers scope review, not automatic rejection. STOP for GPT independent acceptance; implementation completion is not acceptance.

---

## Domain Integrity Repair — F03 / F04 / F05 / F10 (2026-09-26)

- Stacked base: accepted G1-R1 SHA `8b1565376dec247c4649a40bdfed6e55847e2f39` (not yet on `main`); `origin/main` unchanged at `d96b18e28110d33cdd5473bfb859ad969f1dff6f`. Branch `work/domain-integrity-repair-f03-f05-f10`, created from that exact SHA; no rebase, no squash.
- Scope: architecture-audit F03, F04, F05, F10 only. F02 and F11–F13 are untouched. Changed production files: `src/agents/registry.ts`, `src/stress-test/session.ts`, `src/stress-test/deliberation.ts`, new internal `src/stress-test/reference.ts` (not re-exported from the package index).
- F03: `lookupExactRecord`/`resolveExactRecord` accept an id only when the map owns exactly that key, the stored value has the record's runtime shape, and its own `id` equals the key — never truthiness of `map[id]`. Applied to `validateRouteInputRef`, ADD_REVIEWER payload findings, the SemanticIssue evidence leaf, EvidenceSubject finding resolution, `createSemanticIssue`, `adjudicate`, `planRevisionAction`, revision status/verification lookups, and the canonical adjudication/revision/verification ledgers. Attempt provenance (shared by claims, outcomes, and the canonical outcome validator) now re-resolves the question's input refs against the session in hand. The agent registry resolves only owned entries whose id matches, is frozen, and `listAgents` returns copies.
- F04: `createInMemoryDeliberationStateAccessPort` owns its value: a `structuredClone` snapshot on initialization, commit, `resolveCurrentDeliberationState`, and `current()`. Mutating the original input, a committed object, or anything returned no longer changes budgets or lineage; the transaction callback receives a snapshot.
- F05: `recordQuestionDisposition` and `createCrossSessionTransition` (the only two QuestionDisposition writers) run the canonical `assertRouteOutcomeIntegrity` before any disposition-specific rule. No parallel validator was added and the canonical one is unchanged.
- F10: `adjudicate` validates judgment, actionChange, note, and the exact target against the same vocabularies the canonical ledger uses, before writing, and validates its result with `assertHumanAdjudicationLedgerIntegrity` before returning. Same write/read parity for `planRevisionAction`, implement/reject, and `recordRevisionVerification`; `addFinding`/`createSemanticIssue` refuse records exact resolution would later reject, and `createSemanticIssue` refuses repeated findingIds.
- Tests: new `test-domain-integrity.mjs` (31 offline tests: inherited ids, key/id mismatch, malformed records, duplicate identity, ownership at every port boundary, corruption tables asserting "canonical rejects ⇒ no disposition consumes", adjudication write/read sweep). Existing tests keep their assertions except: two TARGETED_PEER_CHALLENGE fixtures that stored a SemanticIssue under a key it did not name now carry the colliding id, and one SEEK_EVIDENCE assertion also accepts the earlier exact-reference rejection (the ledger's own message is covered in the new suite).
- Known limits: `generateIntegratedDecisionReport` in `decision-record.ts` (not authorized in this slice) still resolves `SemanticIssue.findingIds` by truthiness in a read-only projection; no canonical SemanticIssue ledger validator exists yet. Record shape checks cover field types, not value vocabularies such as `EvidenceState`.
- Validation: `npm run build` PASS; `npm test` PASS (1004 passed, 0 failed across 14 offline suites); `git diff --check` PASS. Provider/model calls: 0. CASE-001 access: 0. STOP for GPT independent acceptance; implementation completion is not acceptance.

### Correction #1 — Integrated report exact-reference parity (2026-09-26)

- Rejected SHA `90f81d77c79f15b4327cc653e953475a58e1e3aa`; same branch, normal commits on top of it.
- `generateIntegratedDecisionReport` resolved `SemanticIssue.findingIds` by truthiness, so an inherited key such as `constructor` projected as a finding. Fixed with one canonical validator, `assertSemanticIssueLedgerIntegrity(session)` in `session.ts`: every issue, selected by anything or not, must sit under its own id with the runtime SemanticIssue shape and a non-empty, non-repeating `findingIds` whose every entry passes the exact ReviewFinding resolver. The integrated report calls it immediately after the session/state binding check, before any validation or projection that trusts issue membership; the per-issue projection and `generateDecisionRecord`'s standalone-finding title now use `resolveExactRecord` (the latter fails closed instead of printing `(finding missing)`). `createSemanticIssue` checks the ledger before and after its write.
- The validator is deliberately not composed into the HumanAdjudication/RevisionAction ledgers or `generateDecisionRecord`: two existing `test-stress-test-mvp.mjs` fixtures (outside this correction's file scope) fabricate SemanticIssues with empty `findingIds`, a state no write API produces. Composing it there needs those fixtures corrected in a later packet.
- `test-domain-integrity.mjs` gains 10 tests (41 total), including an issue nothing references and a resolver/report meta-invariant.
- Validation: `npm run build` PASS; `npm test` PASS (1014 passed, 0 failed across 14 offline suites); `git diff --check` PASS. Provider/model calls: 0. CASE-001 access: 0. STOP for GPT re-acceptance.

### Correction #2 — One canonical SemanticIssue ledger (2026-09-26)

- Rejected SHA `e1b686cb1b899112cb461d15157934cf33f48716`; same branch, normal commit on top.
- `assertHumanAdjudicationLedgerIntegrity` now calls `assertSemanticIssueLedgerIntegrity` first, so the chain is SemanticIssue → HumanAdjudication → RevisionAction → RevisionVerification, and `generateDecisionRecord` (whose first ledger call is `assertRevisionActionLedgerIntegrity`) and `generateIntegratedDecisionReport` (explicit call plus the same chain) share one definition of a valid SemanticIssue ledger. A corrupt issue that nothing references now fails every canonical consumer and every ledger-backed public write (`adjudicate`, `planRevisionAction`, `createSemanticIssue`). The validator itself is unchanged.
- Legacy fixtures repaired in `test-stress-test-mvp.mjs` without changing what they prove: the DecisionRecord kind/id collision issue and the Hardening X issue now carry the colliding finding as a valid member instead of an empty `findingIds`, and both assert the fixture passes the canonical ledger; Hardening X also asserts the two distinct targets `SEMANTIC_ISSUE:<id>` and `FINDING:<id>`. Hardening S, T, and AE keep their corruptions and now assert the earlier canonical SemanticIssue rejection; the adjudication-level "unknown findingId" path stays covered in `test-domain-integrity.mjs`.
- `test-domain-integrity.mjs` (50 tests): cases A–G, a parity table (15 corruptions × 5 canonical consumers), and public writes refusing a corrupt ledger.
- Not changed (forbidden in this correction): deliberation-side single-reference reads (`validateRouteInputRef`, SemanticIssue evidence leaf) resolve the issue they use exactly but do not run the ledger-wide check.
- Validation: `npm run build` PASS; `npm test` PASS (1023 passed, 0 failed across 14 offline suites); `git diff --check` PASS. Provider/model calls: 0. CASE-001 access: 0. STOP for GPT re-acceptance.

---

## Execution Identity Repair — F02 (2026-09-26)

- Stacked base: accepted Domain Integrity SHA `26380f33c87de655ededa65421955bdd34239ca3` (not yet on `main`; it carries the unpromoted G1-R1 commits too). `origin/main` unchanged at `d96b18e28110d33cdd5473bfb859ad969f1dff6f`. Branch `work/execution-identity-repair-f02` from that exact SHA; no rebase, squash, or cherry-pick.
- F02 reproduced with a deferred fake transport: binding model-A, caller sets `binding.effectiveModel = model-B` while the transport is pending, transport returns model-B → the old executor returned SUCCESS while reporting model-A. It now returns UNCERTAIN / RESULT_MISMATCH with identity model-A.
- Fix, entirely in the shared `createExecutor` in `src/execution/executors.ts`, so Claude/OpenAI/Gemini executors inherit it: `snapshotExecutionInput` reads `request`, `binding`, and `authorization` once, synchronously, deep-copies them with `structuredClone` (parameters, retrieval, origin, and future nested fields included), and deep-freezes the copy. Binding checks, `CallOptions`, the dispatched prompt, success/known-failure/uncertain/thrown-error identity matching, and the result identity all read that snapshot; caller input is never read after dispatch. `CallOptions` are fresh objects (retrieval is cloned), so neither the caller nor the transport can alias the other or the snapshot. Transport responses are read once and copied before they are checked.
- Also fixed in the same boundary: `options.retrieval` was the caller's own object (caller mutation reached the transport, and transport mutation wrote back into the caller's request); a binding getter could validate one model and dispatch another; `usage.provider` could be validated as one provider and recorded as another.
- Public contract unchanged except two added exports, `snapshotExecutionInput` and `ExecutionSnapshot`, for testing. Input that is not plain cloneable data (functions, proxies) is refused before any transport call. No E0-R3 admission; the authorization is snapshotted, not evaluated. H1 unchanged: temperature is still forwarded.
- Tests: new `test-execution-identity.mjs` (18 deterministic barrier tests, all three executors, fake transports only), covering mutation of binding, request identity, ids, nested parameters, retrieval, origin, and authorization during await; zero reads of caller input after dispatch; transport-side option mutation; failure/uncertain/thrown matching; single-read response facts; returned-fact isolation. A mutation check (9 mutants, each reintroducing an F02-class defect) is fully caught.
- Validation: `npm run build` PASS; `npm test` PASS (1041 passed, 0 failed across 15 offline suites); `git diff --check` PASS. Provider/model calls: 0. CASE-001 access: 0. STOP for GPT independent acceptance.

---

## Legacy Delivery / Experiment Repair — F11 / F12 / F13 (2026-09-27)

- Stacked base: accepted F02 SHA `0c861fdcf080efbfac3b47be9c2df37e022bc7f6` (not yet on `main`; it carries the unpromoted G1-R1 and Domain Integrity commits). `origin/main` unchanged at `d96b18e28110d33cdd5473bfb859ad969f1dff6f`. Branch `work/legacy-delivery-experiment-repair-f11-f13` from that exact SHA; no rebase, squash, cherry-pick, or merge.
- Reproduced before the fix, offline: (F11) a replay of an all-failed Round 1 reported FAILED / `synthesisAllowed: false` yet made one synthesis call and returned its text; (F12) mutating the source run, worker, nested retrieval, or plan after `toRound1Snapshot` moved the snapshot, which was not frozen; (F13) SDK responses with non-empty text and `length` / `max_tokens` / `MAX_TOKENS` came back from the three adapters as a plain `{ provider, model, text }`.
- F11: `deriveRound1Report` in `src/modes/orchestrator.ts` is the one place a synthesis decision is made (run report plus the existing `deriveExecutionPolicy`). The live run and `replaySynthesis` both use it, share the no-synthesis delivery (direct worker text, or `null`), and so return identical reports and policies for the same Round 1. The exported `runSynthesisStage` fails closed before any call when its own facts do not allow synthesis under that policy, or when the supplied report disallows it or disagrees with the facts. Collaboration cannot run where the policy says no synthesis. An unknown agent in a replayed plan is refused.
- F12: `toRound1Snapshot` returns an independent `structuredClone`, deep-frozen. `replaySynthesis` takes its own detached copy of the supplied snapshot and of its synthesizer/collaboration settings before its first await, reading each snapshot field once. Non-cloneable facts (functions, proxies) are refused rather than dropped. In-process ownership only; no persistence, hashing, or sealing.
- F13: `CallResult.completion` (optional `{ state: COMPLETE | TRUNCATED | UNKNOWN, providerReason }`) is classified only from the provider's own reason, matched exactly, and bounded to 64 characters; no reason means no fact. Mappings: OpenAI `stop`/`length`; Claude `end_turn`/`max_tokens` and `model_context_window_exceeded` (a documented token-limit stop in the installed SDK); Gemini `STOP`/`MAX_TOKENS`; anything else UNKNOWN. A Round 1 worker whose provider proved truncation keeps its `completion`, moves its text to the new audit field `truncatedOutput`, and is recorded with an `error`, so it counts as failed: all truncated → FAILED and no synthesis; mixed → DEGRADED, synthesized only from complete workers. A replayed snapshot is settled the same way. A truncated plan, ordinary synthesis, or collaboration gate throws, as a failed call already does (the gate text is also the provisional answer, so nothing complete exists to fall back to); a truncated Round 2 or decision synthesis takes its existing provisional-answer fallback. UNKNOWN or absent completion keeps existing behavior. No retries, no substitution, no token-limit changes.
- E0-R2 bridge: the default Claude/OpenAI/Gemini transports now pass the adapter's `providerReason` as the existing `finishReason`. A truncated response stays SUCCESS at the execution layer; delivery policy is a separate layer. `NormalizedExecutionResult` and the Execution Runtime Contract are unchanged.
- Same-scope fixes: a failed Round 1 result that still carried `output` entered the synthesis prompt while the degraded note said it was missing; and a failed specialist's GROUNDED search counted toward the evidence label and retrieval summary. Both now require the specialist not to have failed.
- Tests: new `test-legacy-delivery-integrity.mjs` (43; live/replay parity across 11 scenarios, the exported stage's fail-closed boundary, snapshot cases A–H with a deterministic barrier and a read-count proxy, and every delivery stage under truncation) and `test-provider-completion.mjs` (27; the real SDKs against an in-memory fetch with placeholder keys and closed-port base URLs, plus the finishReason bridge through the default executors). One status test added to `test-run-status.mjs`. A mutation check of 24 mutants over the compiled output is fully caught.
- Not changed: the pipeline and debate modes (outside this packet's files) still deliver provider text without reading `completion`; SDK-internal transport retries are as documented in the Execution Runtime Contract §0; H1 and E0-R3 untouched.
- Validation: `npm run build` PASS; `npm test` PASS (1112 passed, 0 failed across 17 offline suites); `git diff --check` PASS. Provider/model calls: 0. CASE-001 access: 0. STOP for GPT independent acceptance.

---

## G1-R1 Canonical Promotion Closure (2026-09-27)

- Independently verified and CLOSED: canonical `main` advanced from `d96b18e28110d33cdd5473bfb859ad969f1dff6f` to `d01a1d356f28a7fb8dfe94a8f0a44580b5ab1542` by fast-forward only.
- Main CI run `36255866580` and its required test check succeeded; `main` remained protected. This closure precedes G1-R2 work and does not authorize another main promotion.

---

## G1-R2 Durable State and Repository Reality Boundary (2026-09-27)

- Work branch: `work/g1-r2-durable-state-repository-reality`, based exactly on `d01a1d356f28a7fb8dfe94a8f0a44580b5ab1542`. No main promotion is authorized in this slice.
- `FileControllerStore` persists a version-1 envelope containing the complete run and an integrity checksum. A write takes a per-run exclusive lock, validates against the current canonical file, writes and flushes a private temp file, atomically renames it, and flushes the directory. An orphan temp is ignored; an orphan lock stops writes instead of being removed. Every load checks the envelope and `assertRunInvariants`; structurally corrupt files are not repaired.
- The store gives one controller a private writer closure. Public `replace` cannot append repository-authority or recheck actions. Two controllers using separate store instances still serialize through the same per-run lock and reject a stale transition. Input and output objects are detached.
- `RepositoryRealityPort` is read-only and injected at composition. Its branch, comparison, exact-SHA CI/required-check, and protection observations are strictly parsed and checked against the requested repository/branch/SHA and controller time. The current model verifies exactly one required check; multiple required checks fail closed until a complete all-checks observation is designed. The four former caller-fact paths (`recordRemoteSha`, `requestPromotion`, `recordPromotedMain`, `close`) reject extra fact arguments and read only this port. No live GitHub adapter or GitHub write is included.
- Restart reconciliation reads current work/main state. PROMOTING plus accepted main records `RECOVER_PROMOTED_MAIN` and enters CANONICAL_CI; old main enters HUMAN_STOP with no retry; unrelated main enters ARCHITECTURE_STOP. CANONICAL_CI closes only on exact green CI/check and protection, stays open on pending, and stops on moved main, failure, missing check, or missing protection. A moved work branch stops stale SHA/acceptance from advancing.
- Human resume continues to set `externalRecheckRequired`; external-sensitive transitions now refuse it. Successful port recheck records `RECHECK_EXTERNAL_REALITY` and clears it through the shared lifecycle/store; mismatched facts stop without clearing it. The lifecycle also validates audit action chains, counters, and loaded optional evidence more strictly.
- Offline validation: `npm run build` PASS; `npm test` PASS (1,158 passed, 0 failed across 19 suites); `git diff --check` PASS. Provider/model calls: 0. CASE-001 access: 0. E0-R3: not implemented. Main: untouched.
- Boundary still to bind in a later slice: the injected port is a trusted composition dependency, not a live authenticated GitHub adapter; authorization issuer identity also remains outside G1-R2. The checksum detects unsealed/torn writes, not a malicious actor with filesystem write access who can reseal a file. No production/autonomous GitHub use should be inferred from offline fake-port tests.

---

## E0-R3 Execution Boundary / Admission (2026-09-27)

- Work branch `work/e0-r3-execution-boundary-admission` started from exact canonical base `d1752e495e5b097e6e4124cf39ca74aca2fee523`; no main write or legacy runtime wiring is part of this slice. Implementation is pending GPT independent acceptance.
- `createExecutionBoundary` captures composition-level model resolver, capability source, D1 authority port, and one executor. Per-call input contains only a strict `ExecutionRequest`: one synchronous, detached plain-data snapshot rejects accessors, unexpected/non-enumerable/symbol keys, non-plain objects, invalid ids/provider/stage/parameters/retrieval/origin, and non-finite values. No later read of caller request is needed.
- Explicit model remains exact; otherwise the configured default is resolved for the exact provider. Unknown model/default is NOT_ADMITTED before D1. Required capabilities derive only from explicit system instruction and enabled retrieval. Only VERIFIED required capabilities admit; UNSUPPORTED rejects; UNKNOWN and WIRED_UNVERIFIED remain unresolved. Every known parameter is recorded as FORWARD, OMIT, REJECT, or UNKNOWN with absent/present state, original value when supplied, readiness, reason, policy id `E0-R3_ADMISSION_V1`, and bounded evidence references. Explicit values are never clamped or silently omitted. Current Claude temperature remains UNKNOWN and causes no D1 claim or provider call.
- Local admission precedes the existing `claimRouteExecution` through a new thin `src/stress-test/execution-authority.ts` adapter. Only a canonical CLAIMED checkpoint mints a bound authorization; a D1 pre-call terminal returns PRE_CALL_TERMINAL without dispatch, and D1 refusal propagates. Authorization binds admission id, execution/attempt ids, provider, effective model, and a deterministic request/binding fingerprint. The executor checks this binding against its fixed snapshot before transport; the hash is an integrity check, not a secret credential or authentication of arbitrary direct executor callers.
- The boundary invokes the injected executor at most once, measures monotonic execution latency, detaches the returned result, and preserves SUCCESS, KNOWN_FAILURE, and UNCERTAIN as execution facts only. It creates no RouteOutcome or HumanAdjudication and does not retry, select, fall back, or substitute a provider/model. D1 terminal-result persistence, provider adapters, registry, pipeline, debate, orchestrator, and public MCP tools are untouched. The authority and capability ports are trusted composition dependencies; these offline tests do not establish live-provider readiness.
- Validation: `npm run build` PASS; `npm test` PASS (1,181 passed, 0 failed across 21 offline suites); `git diff --check` PASS. New suites cover schema, binding, capability/parameter matrix, H1, authorization, ownership, execution outcomes, and the actual D1-A claim API with in-memory stores. Provider/model calls: 0. CASE-001 access: 0. STOP for GPT independent acceptance; no automatic main promotion or E0-R4 work.

---

## E0-R4 Executor Registry / Runtime Composition (2026-09-27)

- Work branch `work/e0-r4-executor-registry-runtime-composition` starts from exact canonical `main` SHA `002aba6706f06a89d4d4d05c6a4d4447e656b5c5`. This branch is an implementation candidate for GPT independent acceptance, not a main promotion.
- `src/execution/registry.ts` adds an immutable, exact mechanism registry for `MODEL_PROVIDER`, `MCP`, `CLI_AGENT`, and `REMOTE_AGENT`. Only MODEL_PROVIDER executes in R4. Registration synchronously rejects malformed identity, duplicate executor IDs, duplicate model-provider registrations for the same provider, unknown kind, and provider/kind mismatch. Lookups never infer, rank, or fall back; list/get return defensive descriptors. Registered model executors capture their execution function at construction, so later mutation of caller registrations or executor fields does not replace a mechanism. Hidden mutable state inside a trusted executor closure is not claimed to be isolated.
- The canonical boundary now takes this registry rather than a directly injected ProviderExecutor. Ordering remains request snapshot → exact binding → R3 admission → exact registry resolution → D1-A claim → authorization bound to `executorId` → one registered execution → detached execution facts. Missing mechanism returns `EXECUTOR_UNAVAILABLE` with admission still `ADMITTED`, no D1 claim and no provider call. The registered wrapper rejects a stale/wrong executor ID before delegate execution. Existing provider-executor admission/fingerprint checks remain separate; a fabricated direct lower-level executor call is not a registry-authorized boundary call.
- `src/execution/runtime.ts` composes the resolver, capability source, registry, D1 authority, clock, and boundary. Configured default-model facts are snapshotted; an optional default-provider registry constructs the three model executors but makes no provider call. Legacy pipeline/orchestrator/provider entrypoints are not wired to this runtime.
- Adversarial offline coverage includes strict registration, inherited-key IDs, descriptor/input mutation, no cross-provider fallback, unresolved and WIRED_UNVERIFIED admission, H1 UNKNOWN, missing mechanism before D1, actual D1-A adapter cases, async mutation barriers, and SUCCESS / KNOWN_FAILURE / UNCERTAIN remaining execution facts. Six temporary compiled-output mutants were caught by the committed tests: duplicate-provider allowance, caller-method reread, omitted executorId check, first-provider fallback, D1 claim before registry resolution, and WIRED_UNVERIFIED admission. Mutants were restored by rebuilding; none are committed.
- `E0_R5_R6_ARCHITECTURE_RECON.md` is read-only architecture evidence for GPT: consultation provenance and authority boundaries, ContextPack candidate sources/integrity/freshness, explicit anti-reuse table, and advisory sequencing. R5 and R6 production implementation: 0. Their proposed types/ports and unresolved decisions are not approved contracts.
- Validation at handoff: `npm run build` PASS; `npm test` PASS (1,198 passed, 0 failed across 23 offline suites); `git diff --check` PASS. These are offline fake-transport checks, not live-provider readiness or product acceptance. Provider/model calls: 0; CASE-001 access: 0; main write: 0. No retry, fallback, ranking, model/provider substitution, RouteOutcome, or HumanAdjudication creation in the R4 runtime. STOP for GPT independent acceptance; no automatic main promotion or R5/R6 implementation.

---

## E0-R5 Independent Consultation Execution / Provenance (2026-09-27)

- Work branch `work/e0-r5-independent-consultation` starts from exact canonical `main` SHA `18f467b4e15a916b65288cb137bc5d2301106d90`. R5 is an implementation candidate, not GPT acceptance or main promotion.
- New `src/consultation/` coordinator accepts only strict caller intent (`attemptId`, consultant role, explicit provider/optional model, input/optional system instruction, parameters). It rejects caller-supplied consultation/execution/executor IDs, route/session/hash claims, peer-output fields, consensus/votes, retrieval, and unexpected or accessor fields. It mints separate random consultation/execution IDs, fingerprints input and exact route binding, and calls the existing R4 `ExecutionBoundary` once. It neither claims D1 itself nor executes a provider directly.
- New read-only `src/stress-test/consultation-binding.ts` resolves the current DeliberationState through the access port on every call, verifies its frozen-session binding first, then requires exactly one matching attempt, decision, and question with matching route/refs and current question status. It rejects stopped state, existing outcome, mismatched hashes, ambiguous identities, and every route except ADD_REVIEWER / REPLICATE. It writes no product record.
- After the R4 boundary returns, the coordinator resolves and compares the exact route binding again. If re-resolution fails or changes after an EXECUTED result, the immutable consultation record keeps the execution fact and marks `PROVENANCE_UNCERTAIN`; that is distinct from the provider result's SUCCESS / KNOWN_FAILURE / UNCERTAIN axis. A non-executed result with changed/unverifiable binding fails closed. The record has `structuredPeerContext: NONE` only in the narrow sense that R5 has no dedicated peer-output input field; arbitrary caller prompt text may still contain copied peer content.
- No ReviewFinding, ReplicationResult, RouteOutcome, QuestionDisposition, HumanAdjudication, RevisionAction, consensus score, or ContextPack is created. R5 does not parse provider text. One-attempt/one-provider-execution is enforced by the existing D1 checkpoint for actual domain composition, not by a new ledger. There is no persistent consultation ledger or legacy orchestrator wiring.
- Trusted assumptions and limits: the supplied ExecutionBoundary and route-binding port are composition dependencies; the canonical adapter validates current repository/domain provenance, but neither port cryptographically authenticates an issuer. R5's explicit prompt is not proven complete/current canonical context (E0-R6 remains unimplemented). If a trusted boundary throws without returning a normalized result after possible dispatch, R5 cannot manufacture a confirmed execution fact and does not retry; external reconciliation remains outside this slice.
- Offline tests: new `test-consultation-core.mjs` (8) and `test-consultation-domain.mjs` (9), including actual R4 + D1-A with fake OpenAI transport, route exclusion, second-claim refusal, non-executed gates, async state mutation, result/status isolation, and authority-negative source checks. Six temporary compiled-output mutants were caught: caller executionId allowance, skipped post-binding comparison, unsupported-route allowance, repeat boundary call on refusal, automatic REPLICATE classification, and false STABLE provenance. Each mutant was removed by rebuilding; none is committed.
- Validation at handoff: `npm run build` PASS; `npm test` PASS (1,215 passed, 0 failed across 25 offline suites); `git diff --check` PASS. Provider/model calls: 0; CASE-001 access: 0; main write: 0. STOP for GPT independent acceptance; no automatic R6 work or main promotion.

---

## E0-R6 Bounded Execution Context / ContextPack (2026-09-27)

- Work branch `work/e0-r6-bounded-context-pack` starts from exact canonical `main` SHA `8d5f40356b0e6f3b16407cb96f00d48d8813723b`. R6 is an implementation candidate, not GPT acceptance or main promotion.
- New `src/context/` (`types.ts`, `fingerprint.ts`, `pack.ts`) and one canonical adapter, `src/stress-test/context-source.ts`. A ContextPack (`E0-R6_CONTEXT_PACK_V1`) is a bounded, detached, deep-frozen, route-scoped view for ADD_REVIEWER / REPLICATE only. It claims only "this exact context was projected from these exact canonical sources under this exact binding": completeness, semantic correctness, evidence truth, and authority are not claimed; currentness holds only while `verifyCurrent` returns CURRENT.
- Caller intent is only `{ attemptId, artifactSelection?: { startChar, endChar } }`; any other field (hashes, ids, route, refs, excerpt text) is refused. Binding fields (state id, session id, both hashes, attempt, decision, question, route, ordered inputRefs) come from the current DeliberationState and session.
- Global before local, through existing public read boundaries only: `verifyDeliberationBinding`; `assertRevisionVerificationLedgerIntegrity` (SemanticIssue → HumanAdjudication → RevisionAction → RevisionVerification); `isQuestionCurrent` for every registered question (question identity, derived lineage, disposition ledger); `assertRouteOutcomeIntegrity` for every attempt and every outcome. Only then is the route bound, through `bindConsultationRoute`, a read-only helper extracted verbatim from the R5 port so R5 and R6 share one definition of route provenance (the port now calls it; check order and messages are unchanged).
- Sources: exact FINDING and SEMANTIC_ISSUE records (owned key, shape, id parity; the issue keeps `findingIds`, leaf findings are not merged or duplicated), and AUTHOR_CONTEXT_ITEM with its single category and recorded source type/status. Unknown, ambiguous (across or within categories), malformed, or inherited ids fail closed. The optional artifact excerpt is `session.artifactText.slice(startChar, endChar)` under `0 <= start < end <= length` (UTF-16 code units), labelled `selectionScope: EXCERPT`, never caller text.
- Budget: `ContextPackPolicy.maxSerializedChars` is a finite positive integer supplied and snapshotted at composition; there is no default or universal constant. Required context is atomic and an excerpt must fit whole; either overflow fails the build (`ContextPackBudgetError`). Nothing is dropped, truncated, reordered, or summarized.
- One canonical serialization (plain JSON data, object members in code-unit key order, arrays in order, undefined members treated as absent) drives both the size measurement and the SHA-256 `contextFingerprint`. `capturedAt` is outside the fingerprint, by choice: the same canonical context projected twice keeps one fingerprint, and a timestamp never proves currentness. The fingerprint is integrity, not authentication.
- `verifyCurrent(pack)`: a malformed pack or one whose payload does not match its stored fingerprint throws `InvalidContextPackError`, never STALE. A pack for another state or session throws (no rebinding and no successor follow). Current state is then resolved again and validated globally; corrupt or ambiguous state, or hash mismatch, throws. An intact pack is STALE for DELIBERATION_STOPPED, ROUTE_OUTCOME_RECORDED, QUESTION_NOT_CURRENT, or SOURCE_CHANGED (re-projection gives a different fingerprint); CURRENT only on exact equality. No TTL. The offered pack is never changed or refreshed.
- No product write, D1 claim, execution boundary, provider, consultation record, or persistence: R6 does not touch R5's `input`, prompt construction, or ExecutionRequest.
- Trusted assumptions and limits: there is no public read validator for the whole findings map (only issue members and selected refs are exact-resolved), for the evidence-subject and context-request ledgers outside outcomes that use them, or for RouteDecisions that no attempt references; those stay unvalidated by R6 rather than re-implemented. Because the fingerprint is recomputable, a tamperer who re-seals a changed pack gets STALE, never CURRENT. The pack's fixed metadata (fingerprint, `capturedAt`) sits outside the measured payload.
- Offline tests: `test-context-pack-core.mjs` (37), `test-context-pack-domain.mjs` (30), `test-context-pack-currentness.mjs` (19), on real sessions and states built through the accepted domain APIs. Fifteen temporary compiled-output mutants were caught, including skipped global validation, caller excerpt text, dropping a ref to fit, materialityReason outside the fingerprint, fingerprint mismatch as STALE, skipped re-projection, capturedAt inside the fingerprint, and a route binding that bypasses the shared R5 definition. None is committed.
- Validation at handoff: `npm run build` PASS; `npm test` PASS (1,301 passed, 0 failed across 28 offline suites); `git diff --check` PASS. Provider/model calls: 0; CASE-001 access: 0; main write: 0. STOP for GPT independent acceptance.

### Correction E0-R6-C1 — ContextPack runtime schema integrity (2026-09-27)

- Rejected SHA `a8d29e0fa0e300f233c1b4e63354c7ed2b9e3fa6`; same branch, normal commit on top. Canonical `main` unchanged at `8d5f403`.
- New `src/context/schema.ts` is the one runtime schema of a ContextPack payload. `readContextPack`, `sealContextPack`, and the stress-test projection all validate with it, so a record refused on read can never be sealed, and nothing is sealed that a read would refuse. Vocabularies are generated from the TypeScript unions (`Record<Union, true>`), so a missing or extra member fails to compile.
- Question: exactly `rootCause` and a non-empty `materialityReason`; the route must be the canonical route of the root cause (`routeForRootCause`: COVERAGE_GAP → ADD_REVIEWER, STABILITY_QUESTION → REPLICATE). ReviewFinding: exactly the ten required fields plus optional string `rawText`; string fields, FindingType and EvidenceState vocabularies, parseable `createdAt`, id equal to its ref. SemanticIssue: exactly its six fields; string title/description, non-empty distinct non-empty `findingIds` (leaf findings still not merged), EvidenceState and OPEN/ADJUDICATED. AuthorContextItem: exactly its five fields; string text, ARTIFACT/AUTHOR/EXTERNAL_SOURCE, CURRENT/RESOLVED/SUPERSEDED, parseable `createdAt`; category one of the four. Binding hashes must be 64-character lowercase SHA-256 hex, which is what `sha256Text` / `sha256AuthorContext` produce. Fields are read from descriptors: extra, symbol, inherited, and accessor fields fail, and no getter is run.
- `readContextPack` now refuses non-plain data before cloning (an accessor in an offered pack is never run), then applies the schema, then the fingerprint. `verifyCurrent` reads the pack first, so a malformed pack is INVALID before any stopped / outcome / question classification; a well-formed pack that was changed and re-sealed is still judged by facts (STALE, never CURRENT), because the fingerprint is not authentication.
- Projection admits each selected canonical record through the schema before copying it, and checks the whole projected payload; `verifyCurrent`'s re-projection goes through the same path, so a canonical record that became malformed fails verification closed instead of reading STALE. Note: the session write API itself does not check these vocabularies (`addFinding` accepts any string `type`/`evidenceState`, `createSemanticIssue` any `evidenceState`, `addAuthorContextItem` any `sourceType`); R6 now refuses such records, while E0-R5 still resolves routes over them.
- Unchanged: architecture, canonical serialization, fingerprint algorithm, capturedAt exclusion, budget semantics, CURRENT/STALE model, no TTL, no successor follow, R5 files and semantics, global-before-local, D1-A, product write boundaries.
- Tests: core 37 → 65 (26 self-consistent malformed payloads including the fourteen required, well-formed re-seal read as intact, accessor refused unrun, malformed payload cannot be sealed); domain 30 → 36 (real sessions written through the public API with coherent frozen hashes and an R5-resolvable route, refused before sealing under a one-character budget); currentness 19 → 24 (all fourteen through `verifyCurrent`, INVALID before STALE with a stopped state and with a recorded RouteOutcome, well-formed re-seal STALE, malformed current canonical record fails closed). Nine correction mutants caught (including rootCause accepting any string, FINDING and AUTHOR_CONTEXT_ITEM checking only the id, STALE classified before validity); the original fifteen R6 mutants still caught. None committed.
- Validation: `npm run build` PASS; `npm test` PASS (1,340 passed, 0 failed across 28 offline suites); `git diff --check` PASS. Provider/model calls: 0; CASE-001 access: 0. STOP for GPT independent re-acceptance.

---

## G1-R3A Automation Control Loop / Bridge Foundation (2026-09-27)

- Work branch `work/g1-r3a-automation-control-loop` starts from exact canonical `main` SHA `40e04ab48163e6a7ebe34a3e3d25113f8b3ace2f`. Implementation candidate for GPT independent acceptance; not acceptance or promotion.
- New `src/automation/bridge.ts` defines two narrow ports. `ImplementationAgentPort.execute` receives a detached, deeply frozen `{ runId, sliceId, implementationIteration, packet, packetHash, correction? }` (the correction only for the iteration it governs) and may return only `{ status: COMPLETED, validationEvidence[1..50] }` or `{ status: SOFT_STOP | ARCHITECTURE_STOP | HUMAN_STOP, reason }` (strict; text trimmed, non-empty, at most 2000 characters). A result stating a SHA, branch, main, CI, protection, acceptance, promotion, state, role, or human fact is refused, not ignored. `ArchitectReviewPort.review` receives the same frozen packet data plus the controller's own `remoteSha` evidence and `acceptanceFailures`, and returns `{ decision, correction? }` (strict envelope). The decision is read once with the controller's existing `parseAcceptanceDecision` and the plain copy is what the controller receives; an ACCEPT carrying a correction is refused; a correction is passed on unread to `issueCorrection` (`parseCorrection` / `validateCorrection`). Protocol actors are frozen composition constants (`CODEX_IMPLEMENTER`, `GPT_ARCHITECT`, `CONTROLLER`); callers never pass one and no port can choose one. The existing role vocabulary is unchanged; `CODEX_IMPLEMENTER` is the protocol implementation role, not a claim about which agent implements.
- New `src/automation/runner.ts`: `AutomationRunner(controller, implementationPort, reviewPort)` checks it was given a real `AutomationController`, captures port methods once, and is frozen. `step(runId)` makes at most one controller transition, or one actor call and the transition it reports, using only `get`, `beginImplementation`, `completeImplementation`, `recordRemoteSha`, `beginAcceptanceReview`, `decideAcceptance`, `issueCorrection`, and `stop`. `drive(runId, maxSteps)` requires a finite positive safe integer, has no default, stops at the first non-ADVANCED result, and reports `STEP_LIMIT_REACHED` when the budget runs out. Outcomes: ADVANCED, AWAITING_CORRECTION, EXTERNAL_RECHECK_REQUIRED, HUMAN_PROMOTION_REQUIRED, STOPPED, TERMINAL, OUT_OF_SCOPE, ACTOR_RESULT_DISCARDED, STEP_LIMIT_REACHED. It holds no counters, budgets, or state of its own beyond in-memory ownership.
- Ownership and restart: entering IMPLEMENTING or ACCEPTANCE_REVIEW is its own step; the runner records the exact audit entry it created (sequence, action, timestamp) and consumes it before its single actor call. An instance that did not create the current entry (a restarted runner, another runner, or a state reached by a resume) never calls the port and stops the run HUMAN_STOP ("uncertain implementation-agent / architect-review side effect after runner restart; not replayed"). After an actor returns, nothing is recorded unless the run is still at that exact entry; otherwise the result is discarded (ACTOR_RESULT_DISCARDED). One runner refuses a second concurrent step on the same run. There is no durable invocation journal.
- Failure mapping: a port that throws or rejects → HUMAN_STOP (no result; uncertain side effect; not replayed). An implementation result outside the contract, or one the controller refuses → HUMAN_STOP. Agent-reported SOFT_STOP / ARCHITECTURE_STOP / HUMAN_STOP → `controller.stop` with that exact class. A review outside the contract, or a decision the controller refuses (wrong packet id/hash, wrong reviewedSha, REJECT without findings, future issuedAt, non-architect actor) → ARCHITECTURE_STOP (ambiguous acceptance). A correction the controller refuses leaves the REJECT recorded and the run in CORRECTION_REQUIRED (AWAITING_CORRECTION); the runner never writes or repairs a decision or correction. Remote SHA comes only from `recordRemoteSha`, i.e. the controller's RepositoryRealityPort; a moved work branch stops as the controller already decides.
- Human gate: at ACCEPTED the runner returns HUMAN_PROMOTION_REQUIRED on every step with no port call, no controller write, and no repository read. The runner and bridge sources contain no promotion, close, resume, reconcile, fail-closed, packet-issue, or architecture method name, no `HUMAN` role literal, and import only `zod`, `./types.js`, `./lifecycle.js`, `./controller.js`, `./bridge.js` (source checks enforce this). PROMOTION_READY / PROMOTING / CANONICAL_CI / IDLE / ARCHITECTURE are OUT_OF_SCOPE; stops and terminals are returned as they are.
- Unchanged: controller, lifecycle, policy, packet, repository reality, durable store, types, governance contract, all domain modules. No live adapter, subprocess, provider/model, GitHub, or CLI call exists in the new code.
- Offline tests: `test-automation-bridge.mjs` (13: result/bundle contracts, authority-bearing fields, bounds, single read of a shifting decision, frozen inputs, correction scoping, actor constants, composition, source negatives and controller-method allowlist) and `test-automation-runner.mjs` (22: accept path with exact state/port-call sequence and work-branch-only reads, reject → correction → new SHA → accept, acceptance budget, missing and ten malformed corrections, seven non-binding decisions, nine unusable bundles, frozen-input mutation attempts, restart in IMPLEMENTING and ACCEPTANCE_REVIEW over `FileControllerStore`, restart at non-actor states, three stop classes, thrown/rejected ports, moved branch before/during review, human gate, bounded drive, out-of-scope states, pending recheck, late results after stop and after a human resume, concurrent step). Fourteen temporary compiled-output mutants were caught (automatic requestPromotion after ACCEPT, trusted agent SHA, implementation replay, review replay, repaired reviewedSha, repaired correction, implementation without current correction, unbounded drive default, late result recorded, stop classes collapsed, ACCEPT with correction, agent called in the entering step, concurrent same-run step, unfrozen input). None committed.
- Known limits: ownership is in memory, so a run resumed into IMPLEMENTING or ACCEPTANCE_REVIEW cannot be continued by any runner until a durable invocation journal exists (it stops HUMAN_STOP again). The post-call check and the following controller write are two calls; the controller has no expected-sequence precondition, so a concurrent writer in another process could interleave between them (the store's lock still serializes each write). When the implementation budget cannot admit another correction the run waits in CORRECTION_REQUIRED rather than HUMAN_STOP, because the controller converts that exhaustion only inside `beginImplementation`. A port that never settles blocks its step; timeouts belong to the live adapters.
- Validation: `npm run build` PASS; `npm test` PASS (1,375 passed, 0 failed across 30 offline suites); `git diff --check` PASS. Provider/model calls: 0; live Claude/GPT/Codex: 0; subprocess: 0; CASE-001: 0; main write: 0. STOP for GPT independent acceptance; no live adapter (G1-R3B) work.

### Amendment G1-R3A-A1 — Atomic actor-result occurrence guard (2026-09-27)

- Not-accepted SHA `2c664b032160e76107fd061cd22e95652db8b703`; same branch, normal commit on top. Canonical `main` unchanged at `40e04ab`. Finding: the runner's post-call "still the same entry" check and the following controller write were two calls, so a stale actor result could land on a later or resumed occurrence of the same state.
- `ControllerOccurrenceGuard { runId, sequence, action, timestamp }` (types.ts) names one exact audit entry of one run. Integrity and coordination data only: not a secret, credential, capability, or authority.
- Controller: four guarded entrypoints, each the existing operation with one extra precondition: `completeImplementationForOccurrence` (guard action must be BEGIN_IMPLEMENTATION), `decideAcceptanceForOccurrence` (BEGIN_REMOTE_ACCEPTANCE), `issueCorrectionForOccurrence` (REJECT_EXACT_SHA), and `stopForOccurrence` (any action). The guard is parsed strictly (exact strings, not trimmed; positive integer sequence; instant timestamp; this run; the required action) and compared with the last audit entry on the same read the transition is built from; a mismatch throws `StaleOccurrenceError` before anything is written. Every existing check then runs unchanged, and the write still goes through the lifecycle and the store's `assertTransition`, which accepts it only as the next entry after that read; a writer that gets in between makes the write fail. The unguarded methods keep their exact behavior (their bodies moved into private implementations with an optional guard). No lifecycle, policy, store, or authority rule changed.
- Runner: the owned occurrence is the entry the entering call appended right after the run as observed (if another writer got in first, nothing is owned). Every write that applies an actor result — completion, decision, the correction from the same review (bound to the REJECT entry that decision created), and every stop decided from an actor result — goes through a guarded entrypoint. The restart stop is bound to the occurrence the runner observed. When a guarded write fails, the run is read again: if it has left the occurrence (the audit is append-only, so it never returns), nothing was recorded and the result is `ACTOR_RESULT_DISCARDED` (or `STALE_OCCURRENCE` for a restart stop): no write, no stop of the new occurrence, no retry or replay of the actor. Any other failure keeps the existing mapping (implementation → HUMAN_STOP, review → ARCHITECTURE_STOP, refused correction → AWAITING_CORRECTION). The separate post-call check is gone; the guard replaces it.
- Tests: controller 40 → 46 (exact occurrence completes; stale implementation result after human resume + recheck and after soft resume, with the unguarded call shown to succeed on the same state; later iteration with identical action and timestamp; stale review cannot ACCEPT or REJECT a resumed or later review; guarded correction and stop; strict guard data and every existing check preserved, including runtime budget). Runner 22 → 28 (implementation race and acceptance race over four late result shapes each, with the new occurrence neither completed, decided, nor stopped; store race: a second FileControllerStore writer inside the controller's write window makes the guarded write fail with the store's append-only check, directly and through the runner; a review's correction cannot land on a resumed CORRECTION_REQUIRED; a restart stop never stops a later occurrence). Bridge controller-method allowlist now requires the guarded methods. Thirteen A1 mutants caught (guard ignored for completion, decision, correction, and stop; guard comparing only state or only action; runner applying stale implementation or review results; stale conflict replaying either actor; stale conflict stopping the new occurrence; unguarded review correction; unguarded restart stop), and thirteen G1-R3A mutants re-anchored and still caught. None committed.
- Resolved from the G1-R3A known limits: the check-then-write interleaving. Still open: in-memory ownership (a resumed actor state cannot be continued without a durable invocation journal); CORRECTION_REQUIRED waiting rather than HUMAN_STOP when the implementation budget cannot admit another correction; no port timeout in R3A (mandatory for R3B live adapters).
- Validation: `npm run build` PASS; `npm test` PASS (1,387 passed, 0 failed across 30 offline suites); `git diff --check` PASS. Provider/model calls: 0; live Claude/GPT/Codex: 0; CASE-001: 0; main write: 0. STOP for GPT independent re-acceptance.

---

## G1-R3B Live Adapters + Durable Invocation Journal (2026-09-28)

- Work branch `work/g1-r3b-live-adapters-journal` starts from exact canonical `main` SHA `d9310c3e2bb7fbbbd738eab2b39126f1212abbf1`. Implementation candidate for GPT independent acceptance. No live Claude, Codex/GPT, or provider call was made; every adapter test uses fake executors or local Node fixture processes. The first real model call needs acceptance, promotion, and a fresh exact Human authorization (Automation Pilot 1).
- Installed CLIs were probed with `--help` / `--version` only: Claude Code 2.1.283 supports `-p`, `--output-format json`, `--model`, `--restricted`, `--permission-prompts none`, `--no-session-persistence`, `--tools` / `--allowedTools`, `--strict-mcp-config`, and a hidden `--max-turns <turns>` (present in the binary with `.hideHelp()`). Codex CLI 0.154.0 supports `exec`, `--sandbox read-only`, `--output-schema`, `--output-last-message`, `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, `--disable <feature>`, and `-c` overrides. No ARCHITECTURE_STOP condition was hit.
- **Invocation journal** (`invocation-journal.ts`, `file-invocation-journal.ts`): operational coordination only, never authority. Identity = run, slice, packet id + hash, exact controller occurrence (sequence, action, timestamp), actor kind, provider, model, destination, authorization id; one identity per occurrence and actor kind (`invocationIdOf`), duplicates refused. States PREPARED → STARTED → COMPLETED → APPLIED, with UNCERTAIN (from STARTED) and ABANDONED (from PREPARED or COMPLETED) final. Durability mirrors FileControllerStore: strict schema, checksummed envelope, temp write + fsync + rename + directory fsync, one exclusive journal-wide lock (a leftover lock is never removed), append-only transition validation, full validation on every read; corrupt bytes throw `InvocationJournalIntegrityError`. COMPLETED stores the detached validated outcome as bounded canonical JSON (≤ 256 KiB) with its SHA-256, completion time, and non-secret metadata; the digest is checked again on every read. Only the authorization id is stored, never the grant, environment, or credentials. `start(id, maxCalls)` counts, under the lock, every invocation of the same run and packet that ever reached STARTED; PREPARED does not count, and nothing resets the count.
- **Runner** (optional 4th argument, journal options): without it, G1-R3A/A1 behavior is unchanged. With it, entering IMPLEMENTING / ACCEPTANCE_REVIEW prepares the invocation in the same step; the actor step then requires, in order, the exact current occurrence, the bound identity, PREPARED, the live-call gate (`authorizeLiveModelCall`, a helper over the existing `evaluatePolicy` LIVE_PROVIDER_MODEL_CALL: packet provider/model/destination/network level plus an exact, current HUMAN grant for this run, packet, provider, model, destination; the grant is evaluated as the role it states, so no role is upgraded), the call budget, and a durable STARTED, and only then calls the port with `invocationId`. The result is stored COMPLETED before it is applied through the A1 occurrence-guarded controller methods, then marked APPLIED (or ABANDONED if the occurrence moved). Restart: no record → HUMAN_STOP unless this live instance created the occurrence; PREPARED → dispatch once; STARTED / UNCERTAIN → HUMAN_STOP, never replayed; COMPLETED → the stored result is applied, the actor is not called; APPLIED / ABANDONED at the current occurrence → ARCHITECTURE_STOP (contradiction, not repaired). Each step first settles records of occurrences the run has left (PREPARED → ABANDONED, STARTED → UNCERTAIN, COMPLETED → APPLIED only if the entry right after the occurrence is that result's application, else ABANDONED); these are journal writes only. A runner that loses the PREPARED → STARTED race returns INVOCATION_CLAIMED and dispatches nothing.
- **Process executor** (`process-executor.ts`): executable + argv only (`shell: false`, shell launchers refused), absolute existing cwd, positive bounded timeout, stdout/stderr byte limits, optional bounded stdin, and a complete explicit environment; nothing is inherited, and credential-bearing or execution-altering names (`*TOKEN*`, `*SECRET*`, `*KEY*`, `*AUTH*`, `AWS_*`, `SSH_*`, `NODE_OPTIONS`, ...) are refused even when named. The async executor runs each child in its own process group: SIGTERM on timeout or output overrun, SIGKILL after a grace period, no retry. A synchronous variant (SIGKILL on timeout) serves the synchronous reality port.
- **Claude Code implementation adapter**: refuses unless the journal shows this exact invocation STARTED for its kind, provider, model, destination, run, and packet (so it cannot be driven outside the gated path). Packet grants for CREATE/COMMIT/PUSH_WORK_BRANCH are checked with the existing policy before any model call, and the remote branch must be absent (first iteration) or exactly the rejected SHA (correction). Detached worktree at the packet base or rejected SHA; Claude runs with `-p --output-format json --model <exact> --max-turns <n> --restricted --permission-prompts none --permission-mode acceptEdits --no-session-persistence --strict-mcp-config --disable-slash-commands --no-chrome`, `--tools` limited to Read/Glob/Grep/Edit/Write (+ Bash only with exact pre-approved packet OFFLINE_VALIDATION command lines), `--disallowedTools WebFetch,WebSearch`, and a JSON report schema; never a permission bypass or fallback model. Claude's report is advisory. The adapter then checks every changed path (allowed or correction areas, forbidden areas, protected metadata/workflow/credential paths → HUMAN_STOP), runs each validation command only as the policy-authorized RUN_OFFLINE_VALIDATION argv, stages, refuses symlinks/gitlinks, runs `git diff --cached --check`, commits with hooks disabled, re-checks the remote branch, pushes exactly `HEAD:refs/heads/<work branch>` without force, and reads the remote back. It returns only status and evidence, never the SHA; the controller records the SHA from GitHub. An unexplained remote state after push throws (uncertain → HUMAN_STOP).
- **Codex architect review adapter**: same STARTED requirement; detached read-only worktree at exactly `input.remoteSha.sha`; refuses to run if the reviewed tree contains `.codex` or `.agents`. Codex runs `exec --model <exact> --sandbox read-only -c approval_policy="never" -c web_search="disabled" -c project_doc_max_bytes=0 --disable {multi_agent, plugins, apps, hooks, browser_use, computer_use, in_app_browser, memories, remote_plugin, image_generation} --ignore-user-config --ignore-rules --ephemeral --output-schema <schema> --output-last-message <file>`; no full-auto, workspace write, search, or bypass. The model answers only decision, findings, evidence references, and optional correction areas/invariants; the adapter binds reviewId, actor, packet id/hash, reviewed SHA, issuedAt, and every correction binding field from the controller input. Malformed or contradictory answers and a changed workspace return an explicit review stop (bridge `ArchitectReviewBundle` gained `{ stop: ARCHITECTURE_STOP | HUMAN_STOP, reason }`, applied through the guarded stop); a failed run is HUMAN_STOP.
- **GitHub reality adapter**: one read-only `gh api --method GET --include <path>` per observation, for one configured repository. Branch via the exact `git/ref`; comparison proves the requested head from the answer; CI requires exactly one CI push run for the exact SHA and branch, and the required check from that run's check suite (and app); pending stays PENDING, any non-success conclusion is FAILURE, missing or ambiguous throws; protection 404 "Branch not protected" is `protected: false`, any other non-200 (403 included) throws. Because the controller refuses observations made after its decision instant, observations are primed immediately before the controller operation and served only if primed and younger than `maxObservationAgeMs`; the runner primes the work branch right before `recordRemoteSha`, `beginAcceptanceReview`, and the guarded decision.
- **Composition** (`live/composition.ts`): strict explicit configuration (exact models, aliases and "latest" refused, no fallback, bounded timeouts/outputs, absolute paths, environment allowlist with credential names refused, caller-supplied HUMAN grants per actor). Importing or composing starts no process (tested by counting child_process calls in a fresh process).
- Tests: `test-automation-invocation-journal.mjs` (13, including a three-process PREPARED → STARTED race with exactly one winner), `test-automation-process-executor.mjs` (12, local Node fixtures: argv, group kill, grace kill, no retry, limits, environment), `test-automation-live-adapters.mjs` (30, including an offline end-to-end run through the full live composition to ACCEPTED with the SHA from the GitHub fake, and a real local-git check that linked dependency directories stay out of status and staging), `test-automation-live-recovery.mjs` (15: every crash window, grant/budget gates, stale occurrences, corruption, two runners). Existing bridge test updated for the new constructor arity, imports, and journal identity field. Nineteen temporary compiled-output mutants were caught (see the completion report); none committed. Self-verification found one defect before handoff: a linked `node_modules` symlink is not matched by the directory-only `/node_modules/` ignore rule, so it would have appeared as an out-of-scope untracked path on every delivery; status and staging now exclude linked directories with a literal pathspec.
- Known limits: the reality port serves only primed facts, so human-driven controller operations (promotion preflight, reconcile) need a matching prime before they run in a live composition; this slice wires only the runner's path. Journal and store lock contention fail immediately (no waiting). Validation runs implementer-authored code in the worktree with the explicit environment but no network or filesystem sandbox. Worktrees are left in place for audit (no automatic removal). `providerCallAuthorization.budget` has no monetary semantics in the contract and is not mapped to `--max-budget-usd`; only `maxCalls` is enforced. Claude result field names (`structured_output`, `modelUsage`) and the Codex `web_search` / feature names are verified against the installed CLI's help and fixtures, not a live run; Pilot 1 confirms them. A REJECT whose correction was not yet issued when a crash hit leaves the run AWAITING_CORRECTION (the stored correction is not re-issued on restart).
- Validation: `npm run build` PASS; `npm test` PASS (1,457 passed, 0 failed across 34 offline suites); `git diff --check` PASS. Live Claude calls: 0; live Codex/GPT calls: 0; provider/model calls: 0; secrets accessed: 0; CASE-001: 0; main write: 0. STOP for GPT independent acceptance.

## G1-R3B-C1 Live Implementation Isolation Boundary (2026-09-29)

- Correction on `work/g1-r3b-live-adapters-journal` after `66f976c` was NOT ACCEPTED for two authority gaps: Claude file tools generically approved across the whole worktree, and OFFLINE_VALIDATION executing model-modified code without an enforceable network/filesystem boundary. No live Claude, Codex/GPT, or provider call was made. Journal semantics, call-budget accounting, the Human-only live-call gate, controller/Codex/GitHub authority, and CASE-001 policy are unchanged.
- Capability preflight (installed Claude Code 2.1.283, inspected via `--help` and its binary, no model call): reads inside the working directory are allowed in every permission mode (the `workingDir` allow in the read decision), and a deny rule overrides any allow; so a read scope cannot be expressed by allow rules alone. `--restricted` confines file tools to the working directories and ignores user/project/local settings (`--settings` still applies); `dontAsk` with `--permission-prompts none` denies anything no rule allows; `acceptEdits` auto-approves every edit in the working directory (the removed generic write approval). `CLAUDE_CODE_DISABLE_CLAUDE_MDS` short-circuits every CLAUDE.md load; `CLAUDE_CODE_DISABLE_AUTO_MEMORY` disables auto-memory. `--safe-mode` was not used: its interaction with `--settings` cannot be verified offline.
- **Model read/write scope** (`live/claude-code-implementation.ts`): the model runs in a fresh model workspace (`<worktree>.model`) holding only the base files inside `activePacket.allowedAreas` — no Git metadata, no protected path (`.git`, `.github`, `.env*`, keys, `.gitmodules`, `.gitattributes`, `.npmrc`, `.netrc`, ...), no CASE-001 path, no linked dependency directory. Claude runs `--restricted --permission-mode dontAsk --permission-prompts none`, `--tools Read,Glob,Grep,Edit,Write` (no Bash), `--disallowedTools Bash,WebFetch,WebSearch`, and `--settings` carrying only path rules: allow `Read(./<read area>[/**])` and `Edit(./<write area>[/**])` (write area = `allowedAreas`, or `allowedCorrectionAreas` on a correction); deny, for Read and Edit, every protected/confidential/linked pattern and every repository path outside the read scope (by its shortest prefix neither inside nor above a read area), and Edit for forbidden areas overlapping the write scope. No rule names a tool without a path (`claudeArguments` refuses one). Areas or out-of-scope paths that cannot be stated as plain rules, a write area outside the read scope, a write area inside a forbidden area, and a symlink/submodule inside the read scope fail closed (ARCHITECTURE_STOP) before any model call.
- **Carrying changes back**: after Claude exits, the model workspace is walked (any non-regular entry → HUMAN_STOP), diffed against the materialized manifest (content digest and executable bit), and scope-checked against the write scope, forbidden areas, protected paths (HUMAN_STOP), and CASE-001 (HUMAN_STOP); nothing is carried if any path fails. Accepted changes are written into the adapter-owned worktree through plain directories only. Git's status must then list exactly the carried paths (an ignored path is never validated or delivered unseen).
- **Validation isolation** (`offline-validation.ts` port, `live/seatbelt-validation.ts` production implementation): each packet OFFLINE_VALIDATION command runs on a disposable validation copy (`<worktree>.validation`, the worktree without `.git`, linked dependency directories symlinked in only now — after the model exited) under `/usr/bin/sandbox-exec` with a deny-by-default Seatbelt profile: process fork/exec, same-sandbox signals, and sysctl reads; read of the OS (`/usr`, `/bin`, `/System`, time zone data, device nodes), the validation copy, one temporary directory, the linked dependency sources, and configured runtime read paths (e.g. the Xcode developer directory); write of only the validation copy, the temporary directory, and `/dev/null`; metadata only on ancestors of those paths; no network operation and no Mach service lookup (so no DNS, keychain, or launch services). Paths are bound as profile parameters, never spliced into profile text. Configured paths may not be the root, contain the home directory, or overlap a credential location. The environment is the explicit allowlist with PATH set to the configured search path and HOME/TMPDIR set to the temporary directory. A probe (`/usr/bin/true` under the same profile) must pass before model-written code runs; otherwise UNAVAILABLE → HUMAN_STOP, nothing validated or delivered. Composition constructs the Seatbelt executor by default and refuses to compose on a host without it; there is no unsandboxed fallback. Validation output is kept in a local log (`<worktree>.logs`), not in the stop reason, because model-written code can print repository content outside the packet scope.
- Local capability: the repository's own `npm test` (34 suites, 1,457 tests) passes inside this profile when PATH resolves `git` to the developer directory's real binary (the `/usr/bin/git` xcrun shim needs broader Xcode access and is deliberately not allowed).
- Tests: `test-automation-live-adapters.mjs` 36 (rule-set semantics for every required allow/deny case, fail-closed scopes, model-workspace contents, carrying/deletion/exec bits, ignored paths, isolation-unavailable, and a real local-git end-to-end push to a bare repository); `test-automation-offline-validation.mjs` 8 (profile shape, parameter binding, path confinement, executor argv/environment/probe, and real Seatbelt runs: workspace/temp usable, outside sentinel read EPERM, dependency write EPERM, 127.0.0.1 connection EPERM with zero connections reaching the listener, no parent environment). The real Seatbelt tests are skipped on hosts without Seatbelt (CI runs Ubuntu). Two superseded tests were replaced (Bash validation-rule pre-approval and linked-directory pathspec exclusion; both mechanisms were removed).
- Known limits: Claude Code's own behavior under these flags (rule precedence, `--settings` in restricted mode, anything Claude writes into its working directory) is verified from its binary and help, not a live run; Pilot 1 confirms it, and a surprise fails closed (scope violation or no changes). Seatbelt (`sandbox-exec`) is deprecated by Apple though present and enforcing on macOS 26.6.2. Validation reads the whole repository copy by necessity; its output never returns to the model or the audit. `sysctl-read` and ancestor metadata reads remain allowed.

## G1-R3B-C2 Packet-Scoped Validation Repository View (2026-09-29)

- Correction after `28c4c1d` was NOT ACCEPTED: OFFLINE_VALIDATION received a full repository copy, so model-written code could read repository content outside the packet read scope during validation. Model workspace isolation and the Seatbelt host/network boundary were accepted and are unchanged.
- The validation view (`<worktree>.validation`) now holds only the adapter-owned worktree's regular files inside `activePacket.allowedAreas`, as they stand after the accepted changes were carried back (listed with `git ls-files -z --cached --others --exclude-standard`; deleted files skipped), with the same exclusions as the model workspace (protected paths, CASE-001, linked directory names). No Git metadata, `.github`, unrelated source, tests, or configuration. A non-regular entry in scope → ARCHITECTURE_STOP. Linked dependency directories are added as read-only links and are not repository read authority. Nothing is inferred from validation commands, cwd, imports, or package-manager behavior.
- Before any validation runs, every command is policy-authorized and its cwd must already exist in the view through plain directories; otherwise ARCHITECTURE_STOP with no dispatch. Missing structure is never recreated from outside the scope. A project-wide command that needs out-of-scope files fails (SOFT_STOP); the view is never widened and nothing is retried.
- The C1 output rule stands: validation stdout/stderr stay in the local log (`<worktree>.logs`); stop reasons carry only outcome and exit code. Because out-of-scope repository content is absent from the view and unreachable through Seatbelt, validation cannot copy it into the log.
- Tests: `test-automation-live-adapters.mjs` 39 (scoped view contents after additions and deletions, cwd outside scope refused before dispatch, project-wide failure without widening); `test-automation-offline-validation.mjs` 11, adding real local-Git iterations with `allowed/{code.js,input.txt,check.mjs}` and tracked `outside/secret.txt`, `outside/file.ts`, `.github/workflows/ci.yml`, `package.json` (whose test script prints the secret): the view is exactly `allowed/*` plus the linked dependency, the allowed read succeeds, `../outside/secret.txt` is ENOENT, and under Seatbelt the absolute worktree and clone paths are EPERM; `npm test` at the root fails without widening; the sentinel appears in no result, view, log, temp, or model workspace. The two Seatbelt runs are skipped on hosts without Seatbelt.
- Consequence (intended): validation commands must be runnable from the packet's own areas. A repository-wide `npm test` fails unless GPT deliberately broadens `allowedAreas`.

## G1-R3B-C3 Linked Dependency Provenance Guard (2026-09-29)

- Correction after `e3d8e3b` (C2 closed the scoped-validation gap): a configured `linkedDirectories.source` became a Seatbelt read-only capability without proof that it is independent of the repository, so a misconfiguration could expose the repository, a parent, a worktree, or out-of-scope content through `readOnlyPaths`.
- `independentDependencies` (`live/claude-code-implementation.ts`) resolves the repository path, the worktree root, and every linked source with `realpathSync.native` (unresolvable → refused) and requires each source to be filesystem-disjoint from both: not equal, not inside, not above. The comparison uses the device/inode identity of each path and of all its ancestors, not strings. Measured on this host: Node's JS `realpathSync` keeps a caller's letter case, and even the native realpath keeps the `/System/Volumes/Data/...` firmlink spelling, so a string comparison of resolved paths would miss both; identities do not. Contents are never inspected and there is no override: `<repo>/node_modules` is refused like any other repository subtree.
- The guard runs at adapter construction, hence at live composition (a dependent source composes nothing); again in `execute` before any process (HUMAN_STOP); and again when the validation view is built, where the view's link and the Seatbelt read-only path are bound to the canonical source just proven (HUMAN_STOP otherwise). A source retargeted after composition is therefore refused before the model call, or before validation.
- Tests (`test-automation-live-adapters.mjs`, 42): all ten required real-path cases (external allowed; source equal to, above, or inside the repository or the worktree root refused; symlink aliases to the repository, its `node_modules`, and worktree content refused; missing source refused), plus the letter-case and data-volume firmlink aliases where the host has them; composition and construction refuse with zero processes, model calls, or validations; retargeting before `execute` or during the model call is refused before the model call or before validation.
- Pilot consequence: linked dependencies must come from an external snapshot or cache outside the repository and the worktree root, or not at all. Full-repository `npm run build` / `npm test` remain exact-SHA GitHub CI evidence after the work branch is pushed.

## G1-R3C Egress-Bound Model Process (2026-09-29)

- Closes the gap PROBE-P0-A1 found: R3B's `destination` was one string compared across grant, packet, journal, and adapter, and nothing tied it to where a model CLI actually connected. Base URL settings and proxy variables cannot prove all process egress, and macOS Seatbelt cannot name a remote host (only `*` or `localhost`), so enforcement is Seatbelt-to-loopback plus a CHIEF broker.
- Authority model: `ProviderCallScope { provider, model, egressDestinations }`. One canonicalizer (`egress-destination.ts`) defines `hostname:port` (lower-case ASCII DNS name of ≥2 labels, IDNA already ASCII, explicit port without leading zeros; no scheme, path, query, fragment, userinfo, wildcard, IP literal, trailing dot, whitespace, or control character). Sets are stored strictly ascending and unique; nothing is normalized at any layer, so a non-canonical spelling is refused at ingress (packet, grant, config, runner scope, journals) and equality is array equality.
- Packet: `providerCallAuthorization.egressDestinations` is required (empty when calls are denied, non-empty when allowed). Policy for `LIVE_PROVIDER_MODEL_CALL`: target is the fixed `live-provider-model-call` (never a host); the call set must equal the packet set exactly; every destination must be in `networkAuthorization.destinations` (other targets such as the work branch may coexist); the Human grant's scope must bind the same provider, model, and set. Consequence: one packet binds one set, so both actors' scopes (and brokers) carry the same set.
- Invocation journal: identity and stored metadata hold the exact set; `FileInvocationJournal` is schema version 2. A version 1 record (single destination string) fails closed as unsupported and is never migrated, since turning it into a set would manufacture authority that was never proven. No live call ran under v1.
- Egress journal (`egress-journal.ts`, `file-egress-journal.ts`): one session per invocation (OPEN → CLOSED, final), append-only events `{ sequence, at, result: DENIED | CONNECTED | CONNECT_FAILED, reason code, requested canonical destination or null, address (CONNECTED only) }`. No header, body, credential, or free-text field is representable. Same durability as the invocation journal (checksum, exclusive lock, identity-safe cleanup, temp + fsync + rename + directory fsync, append-only transition checks, fail closed on corruption). Operational evidence only.
- Broker (`live/connect-broker.ts`): 127.0.0.1, OS-chosen port, one invocation. HTTP CONNECT to an exact allowlisted authority only; everything else (other methods, absolute-form, malformed, oversized, slow, over the connection limit, non-canonical, near misses) is refused. A refusal is fsynced before the client hears it; CONNECTED is recorded only once the upstream socket exists (a failed evidence write drops the connection and counts as a fault). TCP tunnel only: no TLS, certificates, header values, or credentials. The production resolver requires every answer to be public (loopback, private, CGNAT, link-local/metadata, multicast, reserved, and IPv6 local/mapped/NAT64/6to4 refused; one per-family BlockList, because a shared one matches all IPv4 against `::ffff:0:0/96`), and the dialer connects to the validated IP without resolving again. Tests inject a deterministic resolver through the constructor only; nothing in `LiveAutomationConfig` can.
- Model process boundary (`live/model-process-isolation.ts`, `live/seatbelt-model-process.ts`): per invocation, verify the executable pin and the exact scope and every path; open the egress session; start the broker; build the offline Seatbelt profile plus exactly `(allow network-outbound (remote tcp4 "localhost:<broker port>"))` (measured: `tcp4` excludes `[::1]`; other ports and every remote address are EPERM); probe it; verify the pin again; run the CLI with the broker as its only proxy (`HTTP(S)_PROXY`/`ALL_PROXY`, lower case too, `NO_PROXY` empty; a caller-supplied proxy, provider-routing, or TLS-trust variable refuses the run); stop the broker, close the session, and read the evidence back from disk. UNAVAILABLE means no CLI ran. No Mach service is allowed. The Claude workspace is read-write, Codex's worktree read-only with one writable answer directory and read-only access to the clone's object store.
- Adapters: the Claude and Codex CLIs run only through `LiveModelProcessExecutor` (the ordinary executor runs git only). Settings pin `executable` (absolute, not a script) and `executableSha256`, checked at construction and before dispatch. A result is used only with clean evidence: the invocation's own closed session, allowlist equal to the scope, no DENIED, and at least one CONNECTED when the process exited 0; anything else is HUMAN_STOP without retry or widening. Claude also gets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_AUTOUPDATER`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`. Codex additionally disables `multi_agent_v2`, `multi_agent_mode`, `enable_fanout` (present in the pinned 0.154.0 feature table); `respect_system_proxy` is not enabled.
- Composition: `egressJournalDirectory`, `modelProcess { runtimeReadPaths, searchPath }`, per-actor `executable`/`executableSha256`/`egressDestinations`; without Seatbelt nothing is composed.
- Tests: `test-automation-egress.mjs` (21: journal, broker protocol and evidence order, bounds, SSRF policy), `test-automation-model-process.mjs` (12; 6 need real Seatbelt: direct provider egress blocked, allowlisted tunnel end to end, unallowlisted and forward-proxy refused, workspace modes, caller overrides, pin change at dispatch, probe and broker failure, ambiguous evidence), plus new cases in the invocation journal, regression (policy matrix), live recovery, and live adapter suites. No real CLI, provider, or credential is used; the "provider" is a loopback echo server.
- Not decided here (P1 needs it): how a real CLI authenticates inside the boundary (HOME is a per-invocation temporary directory and no Keychain Mach service is allowed, so a real CLI will currently fail to authenticate and stop), which exact hosts each CLI needs (e.g. OAuth refresh), and whether per-actor egress sets should replace the one packet-level set.

## G1-R3C-C1 Actor-Scoped Egress Authority + CONNECT Header Contract (2026-09-29)

- Correction after `efb8700` was NOT ACCEPTED for two gaps: live-call egress authority was packet-wide (IMPLEMENTATION and ARCHITECT_REVIEW had to share one set, so each actor's broker admitted the union), and the governance contract said the broker reads no headers although it parses a bounded CONNECT head. The rest of R3C was accepted and is unchanged.
- Authority shape: `ProviderCallScope { actorKind, provider, model, egressDestinations }` (`ACTOR_KINDS` now lives in `types.ts`; `invocation-journal.ts` re-exports it). The packet's only live-call authority is `providerCallAuthorization { allowed, calls: ProviderCallScope[], maxCalls, budget }`: at most one entry per actor kind, in `ACTOR_KINDS` order, each with an exact provider/model (surrounding whitespace, `*`, and control characters refused, never trimmed) and a non-empty canonical set. The packet-wide `providers`, `models`, and `egressDestinations` fields are gone and are refused if present. Denied: `calls: []`, `maxCalls 0`, `budget 0`. Allowed: at least one entry; a one-actor packet is valid.
- Policy: for `LIVE_PROVIDER_MODEL_CALL` the call's `actorKind` selects the one packet entry for that actor (none → DENIED, no fallback, no search across entries); provider, model, and set must equal that entry exactly; every destination must be a packet network destination; the Human grant binds the scope including `actorKind`. A grant for one actor never authorizes the other, even when both entries name the same provider, model, and set (tested with twin entries).
- Runner: each configured scope must bind its own actor kind (`IMPLEMENTATION` scope → `actorKind: IMPLEMENTATION`, and likewise for review); a swapped, missing, or unknown kind fails composition with a TypeError. A swapped Human grant dispatches nothing (HUMAN_STOP). The call budget is unchanged and packet-wide: one implementation STARTED plus one review STARTED exhausts `maxCalls: 2`; switching actor kind does not reset it.
- Invocation journal: unchanged, still version 2. Its stored shape did not change; the actor kind is stored once, in the identity, and `requireStartedInvocation` requires the adapter's scope kind, the adapter's kind, and the journaled kind to agree. The model process boundary refuses (UNAVAILABLE, nothing opened) a request whose scope does not bind the requesting actor.
- Broker header contract: the broker parses only the bounded CONNECT head. `HeadAccumulator` never holds more than `maxHeaderBytes`, however large a single chunk is (bytes past the bound are never copied); bytes after the head go back onto the socket (`unshift`) and reach the provider unchanged after the 200. A head with a credential-shaped header (`Authorization`, `Proxy-Authorization`, `Cookie`, `X-Api-Key`, `Api-Key`, any case) is refused whole before any destination decision: DENIED, new reason `CREDENTIAL_HEADER`, requested `null`. No header name or value is stored, answered, or logged. Ordinary bounded headers (`Host`, `User-Agent`, `Proxy-Connection`) are accepted and stored nowhere. The egress journal file format is unchanged (one more reason code; an older reader fails closed on it).
- Governance: `AUTOMATION_GOVERNANCE_CONTRACT.md` §8.1 now states actor-scoped authority, the grant's actor binding, no cross-actor authority, the packet-wide budget, the bounded CONNECT-head parsing (the required wording), credential-header refusal, and that provider HTTPS headers stay inside the tunnel. §8.1 now has 12 rules (it was 10).
- Tests: regression +9 (actor-scope matrix 1-12, twin grants, one-actor packet, no legacy packet-wide fields); live recovery +4 (swapped scope at composition, swapped review grant, per-actor journal identities, packet-wide budget) plus cross-actor grant/entry cases in the no-dispatch table; live adapters (per-actor sets, cross-actor and union journal and allowlist cases); egress +5 (credential headers incl. mixed case, ordinary headers, head accumulator bound with a 1 MiB chunk, oversized write through the broker, pipelined bytes, per-actor brokers); model process (actor-mismatch refusals, Seatbelt-only).
- Not decided here: real CLI authentication inside the boundary (no `~/.claude`, `~/.codex`, Keychain, OAuth token, or API key was touched) and each CLI's exact host set remain the next architecture decision.

## WS-L1 Real Workspace Shell + Non-Authoritative Goal Queue (2026-10-01)

- Base: exact canonical `main` SHA `ec6a40adbba6806c041921513aede67b3e790d43`. Implementation candidate for Architect acceptance; not acceptance or promotion.
- Scope (Architect decision "WORKSPACE-LIVE-0 ACCEPTED WITH CORRECTIONS"): move the accepted Chief Workspace v3.1 into the repository and create the first genuine local path: Human types a goal → local Workspace server → durable non-authoritative goal record → SSE update → goal shown as 排隊中 / 尚未開始執行. No automation execution exists on this path.
- `src/workspace/config.ts`: explicit local project configuration (`schemaVersion: 1`, `dataDirectory`, `projects[] { projectId, displayName, repository }`), strict schema, unique ids, relative data directory resolved against the config file. Projects are never inferred from Controller storage. Example: `workspace.example.json`.
- `src/workspace/goal-store.ts` (`FileGoalStore`): one file per project, `<dataDirectory>/<projectId>.queue.json`. A goal is `{ goalId, projectId, text, createdAt, status: QUEUED, classification: LOCAL_OPERATOR_INPUT, authority: NON_AUTHORITATIVE, execution: NOT_STARTED }`, strict (no runId, changeId, packetId, authorizationId or any other authority identity can be stored). The queue is derived from an append-only history (`GOAL_ADDED`, `QUEUE_REORDERED`, `GOAL_REMOVED`); every read checks the checksum, schema, revision = history length, sequence, non-decreasing time, and that replaying the history yields exactly the stored queue. Writes reuse the Controller store's durability pattern (exclusive lock file never removed by others, checksummed envelope, temp write + fsync + rename + directory fsync). Separate directory and format from ControllerStore.
- `src/workspace/server.ts` + `main.ts` (bin `chief-workspace`, script `npm run workspace`): dependency-free `node:http`, listens on `127.0.0.1` only, serves the UI and API from one origin. Routes: `GET /api/v0/projects`, `GET|POST /api/v0/projects/:projectId/goals`, `POST /api/v0/projects/:projectId/goals/order` (exact permutation, optional `expectedRevision` → 409 when stale), `DELETE /api/v0/projects/:projectId/goals/:goalId` (never-started goals only), `GET /api/v0/stream` (SSE: `hello`, `goal.created`, `queue.reordered`, `goal.removed`). No start/run/execute/resume/promote route exists.
- Localhost request isolation (not Human authentication): Host must be `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding → 421); `Sec-Fetch-Site` other than same-origin/none → 403; mutations need the exact page Origin, `X-Chief-Workspace: 1`, and `application/json` bodies ≤ 16 KiB with known fields only; no CORS headers, OPTIONS → 405; strict CSP (`default-src 'none'`, `script-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`), so the UI uses no inline style or script and fetches no third-party fonts.
- `workspace-ui/`: LIVE shell (home, project selector, composer, conversation derived from the durable history, work list with reorder/remove-with-confirmation, project page, activity, Advanced placeholder stating that LIVE Console deep-linking is not available). Styles are the v3.1 prototype's, unchanged, plus a WS-L1 section; amber stays reserved for Human decisions. Demo mode only with `?demo=1`: separate in-memory module, labelled on screen, never loads the network module and never writes the LIVE queue.
- Boundary guard (`test-workspace-boundary.mjs`): the transitive import graph of `src/workspace` must stay inside `src/workspace` with only `zod` and named `node:` built-ins (dynamic import/require refused); no run-creation or execution API names in code; and at runtime a module-resolution hook records every module Node loads while the server starts, creates, and deletes a goal — any `dist/automation`, provider, execution, MCP SDK, or `child_process` load fails with "WS-L1 queue is non-authoritative and may not start execution". Verified by a temporary forbidden import (all three checks failed with that reason); not committed.
- Tests: `test-workspace-goal-store.mjs` (18), `test-workspace-server.mjs` (13), `test-workspace-ui.mjs` (5), `test-workspace-boundary.mjs` (4), added to `npm test`. Headless Chromium (outside the repository) drove the real bin: goal entry with Enter, SSE to a second window for create/reorder/remove, reload persistence, project switch, dark 390 px without horizontal overflow, demo isolation; 0 console errors, 0 non-local requests.
- Not implemented (out of scope by decision): Human authentication / D1, R4P, R4T, R4A0, R4L, any Controller read or write, run creation, goal → packet planning, Claude/Codex execution, subscription authentication, Human decision submission, automatic correction or continuation, queued-goal auto-start, remote access. Provider/model calls: 0. Controller runs created: 0.

### Correction WS-L1-C1 — Boundary hardening before promotion (2026-10-01)

- Base: WS-L1 candidate `db76ee3f45d9756b2b57a99558013625dc408495`. Scope limited to making the boundary claim match the machine-enforced guard; Workspace UX, goal schema, API routes, SSE contract, and queue persistence are unchanged.
- `src/workspace/server.ts` no longer imports `node:net`: the type-only `AddressInfo` import is replaced by narrowing `server.address()` (`string | AddressInfo | null`) locally; a non-TCP result fails startup.
- `test-workspace-boundary.mjs` now enforces a capability allowlist rather than module names alone. External imports must be named imports from: `node:crypto` (createHash, randomUUID), `node:fs` (the eleven sync file primitives the goal store uses), `node:path` (dirname, isAbsolute, join, resolve), `node:url` (fileURLToPath), `node:http` (createServer, IncomingMessage, Server, ServerResponse — inbound server only), `zod` (z). Default, namespace, bare, and `export *` imports of these are refused. Always refused: `node:net`, `node:tls`, `node:https`, `node:dgram`, `node:dns`, `node:child_process`, `node:worker_threads`, `node:http2`, `node:cluster`, `node:vm`, `node:inspector`, `undici` (also without the `node:` prefix), and the escape routes dynamic `import()`, `require`, `createRequire`, `process.getBuiltinModule`, `process.binding`, `globalThis`, global `fetch`, `WebSocket`, `XMLHttpRequest`, `EventSource`.
- The rule is one function applied to the real files and to 24 refused probes (net client and type-only import, bare `net`, http request/get/Agent/namespace/default/re-export, https, tls, dns, dgram, child_process, worker_threads, undici, fetch call and reference, globalThis.fetch, WebSocket, dynamic import, require, getBuiltinModule, an unlisted provider package) and 3 accepted probes (inbound createServer, the `sec-fetch-site` header name, a `.fetch` property). The runtime check now also wraps every outbound primitive (http/https request and get, net connect/createConnection/Socket.connect, tls.connect, dgram.createSocket, dns.lookup, every child_process launcher, global fetch) before the server loads and fails if any call has `dist/workspace` on its stack, while goal create (201) and delete (200) still succeed. Node's own `listen()` resolves its bind address through `dns.lookup` (`lookupAndListen`); that is recorded separately and must be exactly `127.0.0.1`. A temporary outbound `http.get` in server.ts failed the capability rule, the node:http limit, the real-file rule, and the runtime check; reverted, not committed.
- Claim, as stated in the test header. Machine-enforced in WS-L1: src/workspace module dependency isolation; no Controller / AutomationRunner / model or provider adapter dependency; no child process; no outbound Node network client path; no execution API route; loopback-only listener. Not proven by this guard: OS-level sandboxing; filesystem isolation from Controller authority storage; authenticated Human identity; R4T authority-store writable-root isolation. It is a source and module guard, not a security sandbox; workspace-ui browser code may fetch its own same-origin `/api/v0` routes.
- Provider/model calls: 0. Controller runs created: 0.

## WS-VIS1A Material System + Mainstream Conversation Convention (2026-10-01)

- Base: canonical `main` = `086a5f42161a507c08ec3df42d5bc9cd75fcf9ff` (WS-L1-C1, fast-forward promoted from `ec6a40a` on the Human's confirmation; `main` CI run #50 green). Implementation candidate for Architect review; not acceptance.
- Scope (Architect "WORKSPACE VISUAL v6 ACCEPTED" + "v7.3 CONVERSATION CONVENTION ACCEPTED"): the accepted material baseline on the existing WS-L1 layout, plus the canonical mainstream composer / bubble convention. No layout restructure (Stage / Correspondence is WS-VIS1B), no v7.x black material.
- `workspace-ui/styles.css`: rebuilt from the accepted materials on the v3.1 class structure: celadon desk with a faint seeded craquelure, one porcelain sheet (the main column), glass top chips, popovers and docked composer, the glaze bead for Chief (`.mark`, `.av`, `.pulse`), v6 colour tokens in light and dark, restrained depth (two shadow tokens), motion tokens. Type uses system stacks only: Human words in the Kai stack and Chief's in the Song stack (voice cue only, never authority), controls in the system sans, the wordmark in a local Baskerville-class serif. The WS-L1 rules (connection chip, demo banner, pills, work list, confirm, errors) are restated in the same material; the rail footer rule v5 had dropped is restored.
- Conversation convention: rounded field (24px docked, 28px and larger at home), context note bottom-left, round 40px send button with an up arrow bottom-right whose words 加入工作清單 stay for screen readers (and as its title); the Human's words are a right-aligned bubble with `你：` kept for screen readers and the time shown on hover/focus; Chief answers in plain text on the left beside its bead. No quotation marks, drawn lines or invite pulses.
- `workspace-ui/app.js` (presentation only): the send button markup, the bubble's screen-reader label, and `glaze()`: one seeded craquelure drawn once on a canvas after the first render and set as CSS custom properties through the CSSOM (allowed by the CSP; `img-src` already permits `data:`). Without a canvas the tokens keep a transparent default and the desk stays plain.
- Gold: none in LIVE (WS-L1 has no Human decision). Motion: the bead never animates in LIVE (`.pulse.idle`, `.av` static); the only motion is the one-time sheet settle and craquelure fade, both off under reduced motion.
- Unchanged: API routes, goal-store schema, queue semantics, SSE contract, project config, localhost isolation, CSP, LIVE/demo separation, copy, `src/workspace/*`, the WS-L1-C1 boundary guard (green, untouched).
- Tests: `test-workspace-ui.mjs` adds one check (stylesheet and page make no third-party request; transparent texture fallback; send words and Human identity kept for screen readers). `npm test` green.
- Not implemented: WS-VIS1B (Stage / Correspondence), any execution, D1, R4P, R4T, R4A0, R4L. Provider/model calls: 0. Controller runs created: 0.

### WS-VIS1A material changed to black (Human request "改成黑色", 2026-10-01)

- The Human (product owner) asked for the black material after reading the celadon port (`b88b377`). This replaces the celadon material in the same slice; it is a visual-layer change only and still awaits Architect review (the Architect's v7.3 decision accepted only the conversation convention, not the v7.x material, so this needs an explicit Architect decision).
- `styles.css`: the token block is the v7.3 black set (page `#030304`, sheet `#0B0B0D`, cards `#121215`; Chief ink blue `#9DB4F0`; gold `#CDA45C` / `#E2C07F` for Human attention only), always dark (WS-L1 has no theme setting). No background texture or light. Chief's glaze bead becomes the ink dot in a hairline ring (`.pulse`; still static in LIVE), the brand mark and Chief's avatar a Didot C in a hairline ring, the wordmark tracked Didot. Words in Avenir Next / PingFang (Human and Chief alike; the Kai/Song voice cue is dropped with the Chinese register). Structure, WS-L1 rules and the conversation convention are unchanged.
- `app.js`: the canvas craquelure (`glaze()`) is removed; nothing else changes. `test-workspace-ui.mjs`: the texture-fallback assertion becomes "no generated background texture".
- Checks rerun against the real server with its CSP (layout, axe, external requests, CSP, JS errors, running animations, gold) at 1440 / 1180 / 1000 / 720 / 390 / 360 / 320 and the view states; `npm test` green.

## WS-VIS1B Stage / Correspondence Structure (2026-10-01)

- Base: canonical `main` = `3331bc149d41a7717a6ad5cab634bd0fd0f22b5a` (WS-VIS1A accepted; fast-forward promoted from `086a5f4` after verifying main, the accepted head, a clean tree and ancestry; CI #52 green on 3331bc1). Implementation candidate for the Architect's visual freeze review.
- Scope (Architect "WS-VIS1A ACCEPTED" → WS-VIS1B): replace the chat-app page hierarchy with 此刻 (stage) + 往來 (correspondence) on the frozen black material, preserving every WS-L1 behaviour.
- 此刻 (stage, the lifted sheet): meta line (此刻 · project · 查看詳細監看), 你交辦的 + the first queued goal as the headline, Chief 現在 (尚未開始執行) and 需要你嗎 (不需要), then exactly one focal object: "已加入工作清單 · 排隊第 1 個 · 尚未開始執行" with the WS-L1 note (or "工作清單是空的" when the queue is empty). Below, the ledger: 工作順序 (the queue with reorder and remove-with-confirmation; the first row marked 目前) and the project facts. No metrics, ids, logs or execution states: WS-L1 has none.
- 往來 (correspondence, on the black beside the stage): the full history; Human = right-aligned bubble, Chief = plain text beside the C mark, the accepted composer docked under it. The goal on the stage is only pointed at (a 在「此刻」 pill), never repeated as a second card. The queue card that used to end the stream now lives only in the stage ledger. The right "目前工作" panel and the narrow status strip are gone: the stage answers their questions.
- Projects: spines in the left rail on layouts ≥760px (idle C-ring dot, name in normal horizontal text up to three lines, queue count; `aria-current`, screen-reader text "，N 個排隊"). Vertical type was tried and dropped: CJK fallback faces without vertical metrics collapse to zero advance (seen in the cloud), and the Architect ruled usability over vertical type. Views are text tabs in the top line; under 760px the views move to bottom tabs and the project switcher to the top line.
- Responsive: ≥1180 stage and correspondence side by side; under 1180 they become two panes (此刻 / 往來 toggle buttons with `aria-pressed`, default 此刻) with the composer always docked below, so a goal can be submitted from either pane. Nothing is compressed into two columns on phones.
- Motion: no Chief-mark animation rule exists; LIVE marks are the idle hollow ring. Only the sheet's one-time settle and the focal card's entrance remain, both removed under reduced motion.
- `styles.css` is now one canonical black stylesheet (≈26 KB, from ≈61 KB): only rules for classes the WS-L1 DOM renders, no celadon, v3.1-prototype or stacked override rules. Token values are the WS-VIS1A black values unchanged (the unused gold/human tokens are kept for future Human decisions).
- `app.js`: presentation only (stage, correspondence, spines, tabs, pane toggle; render keeps scroll positions and opens 往來 at its latest entry). Data loading, SSE handling, submit, reorder, remove, project switch and demo isolation are untouched. `index.html`: the panel aside is replaced by the bottom-tab nav; `color-scheme` dark.
- Tests: `test-workspace-ui.mjs` +1 check (labelled stage and correspondence, one focal card, every Chief mark idle, no mark animation, pointer instead of a duplicate). `npm test` green.
- Not implemented: execution, D1, R4P, R4T, R4A0, R4L. Provider/model calls: 0. Controller runs created: 0.

### WS-VIS1B amendment — attention-first entry and cross-project Home (Human product decision, 2026-10-01)

- Structure: Chief ├── Home └── Projects → each 此刻 / 往來. Home belongs to no project; the old per-project idle hero is gone (a project with no history shows its stage with "工作清單是空的" and an empty 往來).
- Entry resolver (`app.js`, a pure block between `// ---------- entry resolver` and `// ---------- end entry resolver`, no DOM/storage/network): `signalsOf(projects)` → `{ projectId, order, queued, working: false, humanRequired: false, humanRequiredSince: null }` (WS-L1 has no execution or Human-required signal; queued is never working); `resolveEntry(signals)` (root entry only, see C1): the oldest outstanding Human request (by its own time; missing time sorts last; ties by configured order) selects the project to open, marked `focal: human-required`, and the rest stay attention-marked; else Home. Working never bypasses Home. `homeProjects`: working first, then queued-only, last viewed preferred within a group, idle omitted. `defaultTarget`: working (last viewed if working) → last viewed if valid → first configured.
- Routing: `#/` Home, `#/p/<projectId>` a project, `#/projects|activity|advanced`. The resolver runs once at root entry (`replaceState`); clicks, deep links and back/forward are explicit and never redirected; SSE never changes the view. Last viewed project = `localStorage` UI preference only, written when the Human opens a project.
- Home: Chief's question, the larger composer with a visible "交給哪個專案" select (default from `defaultTarget`, changeable), submit → existing `POST /api/v0/projects/:projectId/goals` for the selected project; the Human stays on Home with "已加入「X」的工作清單 · 排隊中 · 尚未開始執行" and a link to open X; then the projects with relevant work, each "排隊中 · 尚未開始執行", each opening that project. Gold appears only on a spine whose signal is Human-required (`.pulse.need`), which WS-L1 never produces.
- Tests (+4 in `test-workspace-ui.mjs`, the resolver evaluated in isolation with fixtures): root → Home, queued not working, no LIVE gold; explicit Home target, selected-project write, no navigation on submit (mutation-checked: a temporary `go('project')` fails it); default target and fallbacks; Human-required beats Home, oldest wins, others marked, explicit navigation kept, working does not bypass Home, resolver runs once.
- No API, store, SSE, CSP, server or boundary change. Provider/model calls 0; Controller runs 0.

### Correction WS-VIS1B-C1 — Entry routing / Home default (2026-10-01)

- Base: `61ebe52bafc6dc47df7b0aba25d838f7e840f6a7`. Scope limited to entry routing and the Home target; black material, stage, correspondence, composer, spines, API, store, SSE, CSP, `src/workspace` and the boundary are unchanged.
- C1-A (root-only attention routing): the boot used to pass `#/projects`, `#/activity` and `#/advanced` to the resolver as "no explicit project", so a Human-required item could have replaced them. Now the pure block holds `parseRoute(hash)` (`''`, `#`, `#/` and unknown routes are the root; `#/p/<id>`, `#/projects|activity|advanced` are explicit) and `entryFor(route, signals)`: only the root calls `resolveEntry(signals)` (which no longer takes an explicit argument); explicit routes are returned unchanged. Back/forward (`popstate`) and clicks go straight to their route; `applyEvent` (SSE) never navigates.
- C1-B (Home target): `homeTarget({ entering, current }, signals, lastViewed)` recomputes the default (working → last viewed → first configured) only on an actual transition into Home (or the first entry); while the Human stays on Home their selector choice survives renders and SSE, unless it names a project that no longer exists.
- C1-C (wording): project-level Human-required signals are sufficient to choose the entry project and mark attention. The stage provides the primary focal slot; the Human Decision itself (question, options, content) will come later from the approved governed read model, and integrating it must not need another Workspace structural redesign. No Human Decision data is shown or faked in LIVE.
- Tests (`test-workspace-ui.mjs`, 13 checks): root + Human-required → oldest project for `''`, `#`, `#/` and unknown routes; explicit `#/p/…`, `#/projects`, `#/activity`, `#/advanced` kept; back/forward wired straight to the route; resolver called only from `entryFor`, `entryFor` only at boot; SSE handler contains no navigation; Home target: visit B → return Home → B, invalid last viewed → first configured, working beats last viewed, a manual choice survives render/SSE, entering again recomputes. Mutation-checked: treating only project routes as explicit fails C1-A; recomputing the target on every render fails C1-B. Browser run against the real server confirmed the same (entry per route, manual choice after an SSE goal, visit → Home → target, back/forward), 0 errors.
- Provider/model calls 0; Controller runs 0.

## G1-R4L-1 Change-Scoped ROOT Run Admission (2026-10-02)

- Base: canonical `main` = `80e5318e6a7592e99666685c95755bd9f84e22e6` (WS-VIS1B-C1), clean. Architect task "G1-R4L-1 — CHANGE-SCOPED ROOT RUN ADMISSION": the G1-R4L inventory accepted with canonical amendments. Implementation candidate for Architect acceptance; not acceptance.
- Invariant (CHIEF-GOV/1): one change, exactly one ROOT run, ever. Another runId cannot reset budget, authority, Human stop, lifecycle or governance state: a second ROOT for the same change fails before its run file exists, whatever the ROOT's state (IDLE through CLOSED and FAILED_CLOSED). A terminal change stays closed; redoing the work needs a new governed change identity. `AUTOMATION_GOVERNANCE_CONTRACT.md` §3 / §3.1 / §5 updated to match.
- Change identity: `ChangeRefV1 { kind: 'SLICE', changeId: sliceId }` in one repository. `sliceId` must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` exactly and is case-sensitive (`A` and `a` are two changes); the repository must be `owner/name` (`^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$`, the grammar the live config and the GitHub port already use), compared exactly. A non-canonical spelling (whitespace, Unicode, separators) is refused with `InvalidChangeIdentityError`, never trimmed or folded. `AutomationController.createRun` no longer trims sliceId or repository (runId handling unchanged). `changeKey = sha256("chief.change.v1\0" + repository + "\0" + sliceId)`.
- `src/automation/admission.ts` (new): identity parser, `changeKeyOf`, strict admission and refusal records in checksummed envelopes, `admissionDecision`, `refuseSecondRun`, `RunAdmissionRefusedError` (`SECOND_RUN_FOR_CHANGE` with ruleset, changeKey, repository, sliceId, existingRootRunId, requestedRunId, evidenceRecorded) and `RunAdmissionIntegrityError` (`LEGACY_UNINDEXED_RUN`, `ADMISSION_REGISTRY_MISMATCH`, `ADMISSION_RECORD_INVALID`, `ADMISSION_CLAIM_UNAVAILABLE`).
- Admission record (governance integrity state of the OPERATIONAL_RECORD class; not authority, not an AUTHORITY_ARCHIVE entry; written once): `{ schemaVersion: 1, kind: 'CHANGE_ADMISSION', recordClass: 'OPERATIONAL_RECORD', ruleset: 'CHIEF-GOV/1', changeKey, repository, sliceId, rootRunId, admittedAt, lineage: [{ runId: rootRunId, relation: 'ROOT' }], reserved: { continuations: [] } }`. Strict: unknown fields, a second lineage entry, any relation but ROOT, a non-empty continuation list, or a changeKey not derived from the record's own identity are refused.
- Boundary: `ControllerStore.create` in both stores; `createRun` only delegates. `FileControllerStore.create`: fresh-run check → identity → per-runId lock → duplicate runId → admission (absent: claim; claim lost with EEXIST: re-read the winner; present with rootRunId = runId, same identity and no run file: ROOT_PENDING completion; anything else: `SECOND_RUN_FOR_CHANGE`) → the existing durable run write.
- Claim: the complete sealed record is written to `changes/<changeKey>.<uuid>.tmp`, fsynced, published with `link()` as `changes/<changeKey>.json`, and `changes/` is fsynced before the run is written; the temp name is then removed (one left by a crash is never read). No change lock exists, so admission has no stale lock. A link failure other than EEXIST raises `ADMISSION_CLAIM_UNAVAILABLE`: no check-then-write, rename-over or lock fallback.
- Integrity: a store opens only when every run file in it is its change's admitted ROOT (constructor scan), and every load checks this again. A pre-R4L run (no record, or a non-canonical identity) raises `LEGACY_UNINDEXED_RUN` and is never backfilled; a record filed under another key or naming another ROOT raises `ADMISSION_REGISTRY_MISMATCH`; corrupt JSON, checksum or schema raises `ADMISSION_RECORD_INVALID`. `UNLINKED_SIBLING_RUN` is not defined or redefined here (R4A0). A controllerStoreDirectory written before R4L-1 will not open; there are no production runs.
- Refusal evidence: best-effort, append-only `changes/refusals/<changeKey>/<uuid>.json` (`CHANGE_ADMISSION_REFUSAL`, OPERATIONAL_RECORD). The refusal is decided before evidence is attempted; an evidence failure still refuses (`evidenceRecorded: false`).
- `InMemoryControllerStore`: the same parser, records, decision and errors, with one synchronous check-and-set per change and refusal evidence kept in memory. Both stores expose read-only `admissionRecord(change)` and `admissionRefusals(change)` for diagnostics (not a read model). Store clocks are optional (wall clock by default); the controller's default store and the live composition pass their clock.
- Filesystem contract: `controllerStoreDirectory` must be on a local filesystem with atomic, exclusive link(2) publication and durable directory fsync. Network, sync and remote filesystems are unsupported until a later slice proves them safe. Where link publication is unavailable, admission fails closed.
- Activation prerequisite (R4L-1 does not close it): admission cannot tell whether two different sliceIds are the same work. Before any T1–T4 run-creation surface (Workspace, API, agent, executor) goes live, new change identities must come from a governed change-mint / adoption process (Workspace: NON_AUTHORITATIVE Goal → governed adoption → governed Change identity → ROOT admission → execution), and who may request a start is enforced at the governed authorization boundary. No createRun actor was added: no D1 identity exists, and caller-supplied actor text would not be authentication.
- Tests: `test-automation-run-admission.mjs` (33 checks, added to `npm test`): the conformance checks run against both stores (ROOT admission, refusal through the controller and the store directly in all ten ROOT states, exact case, invalid and whitespace identities, duplicate runId, refusal evidence and its failure), then file-store checks (second instance, CLOSED / FAILED_CLOSED after restart, claim-before-run crash in process and as a killed child process with its stale lock, temp artifacts, legacy runs, corrupt / mismatched / extra-ROOT / continuation records, link unavailable, evidence write failure), concurrency in separate processes (3 rounds of 12 creators of one change: exactly one ROOT each, 11 refusals recorded; 8 creators of 8 changes all admitted; one runId from 2 processes yields one run), and a no-continuation / no-grant check. Child processes and fs fault injection are test machinery only. Existing tests unchanged and green.
- Local note: `test-workspace-boundary.mjs`'s runtime check fails when the checkout path contains a space (it takes `new URL(url).pathname`, which stays percent-encoded); identical on base `80e5318`, and CI paths have no space. Not changed in this slice.
- Not implemented: continuation (reserved; no API, no lineage append), R4P, R4T, R4A0, D1, Goal adoption or Goal → Change binding, Workspace Start button, /run API, automatic queued-goal start, execution driver, Claude / Codex calls. Provider/model calls 0. Controller runs created outside tests 0.

### Correction G1-R4L-1-C1 — runId / admission bijection (2026-10-03)

- Base: `f0be1ba8edfd9ae65c89bd467baebee67f88916b` (R4L-1 core design accepted by the Architect; not redesigned). Closes one reverse-integrity gap before promotion.
- Invariant added: under CHIEF-GOV/1 a change has exactly one ROOT run, and a runId is the ROOT of at most one change. The gap: change A / run X claimed, run write failed (ROOT_PENDING, lock released); change B / run X then saw no run file and could publish a second claim naming X and write run X as B.
- C1-A (create): before a new claim, and before finishing a ROOT_PENDING, the file store reads every canonical claim (`changes/<64 hex>.json`; temp names and `changes/refusals/` take no part) and refuses with `ADMISSION_REGISTRY_MISMATCH` when the runId is already the ROOT of another change. Nothing is claimed, no run is written, no refusal evidence is recorded (it is not `SECOND_RUN_FOR_CHANGE`). This runs under the existing per-runId lock, and only a holder of that lock can publish a claim naming the runId, so no second lock is needed. The same change can still finish its pending ROOT.
- C1-B (open): the constructor validates both directions. For every claim: filed under its own key, its rootRunId named by no other claim, and an existing run file for it carries exactly the claim's repository and sliceId (no run file = ROOT_PENDING, valid). For every run file: its change's claim exists and names that runId. Contradictions → `ADMISSION_REGISTRY_MISMATCH`, store fails closed, no repair or backfill. Each load still checks the forward direction; claims forged around an open store are R4T territory.
- C1-D (memory): `InMemoryControllerStore` keeps a runId → changeKey ROOT map and refuses reuse for another change with the same error.
- Tests: +5 in `test-automation-run-admission.mjs` (38 checks): the exact A/X → B/X sequence (fails closed; no B claim, no run file, no refusal, A claim byte-identical; A/X then completes; X after completion → Duplicate runId), two claims with one ROOT runId, a claim whose run file belongs to another change, a valid pending ROOT beside a foreign temp, and the in-memory map. Removing the reverse check makes the first test fail.
- Unchanged: identity grammar, case semantics, changeKey, SECOND_RUN_FOR_CHANGE, refusal evidence, continuation, the link claim design, Workspace, R4P, R4T, R4A0, D1, Goal adoption. Provider/model calls 0; Controller runs created outside tests 0.

## G1-R4P-1 Direct Authority Archive (2026-10-05)

- Promotion first: `main` fast-forwarded `80e5318` → `8f5206a` (R4L-1 + C1, accepted). Preconditions verified (merge base `80e5318`, ahead 2 / behind 0, no remote movement); the Human ran the non-force push after the local permission check refused it for the implementer; `origin/main` re-fetched = `8f5206a592b501d2deecc4d287e25a346f4d01ff`.
- Base: `8f5206a`, branch `work/g1-r4p-authority-archive`. Implementation candidate for Architect review; not promoted.
- `src/automation/authority/document.ts`: `AuthorityDocumentV1` (`schemaVersion: 1`, `recordClass: 'DIRECT_AUTHORITY'`, `kind`, `authorityId`, `version`, `issuedAt`, `issuer { role: HUMAN | GPT_ARCHITECT, principalRef }`, `subject { repository, sliceId? }`, `supersedes: AuthorityRefV1 | null`, `body`), `AuthorityRefV1 { kind, authorityId, version, recordHash }`, strict validation, hashing, `AuthorityArchiveError` (`INVALID_DOCUMENT`, `INVALID_SUPERSESSION`, `VERSION_GAP`, `VERSION_CONFLICT`, `REF_MISMATCH`, `ARCHIVE_INTEGRITY`, `PUBLICATION_UNAVAILABLE`).
- Bodies reuse the existing parsers, no competing definitions: IMPLEMENTATION_PACKET `parsePacket`, CORRECTION_PACKET `parseCorrection`, ACCEPTANCE_DECISION `parseAcceptanceDecision`, AUTHORIZATION `parseAuthorization`; the body must already be canonical (a parser that would trim or strip is a refusal, never a rewrite). Bindings: `authorityId` = the body's own id (`packetId` / `correctionPacketId` / `reviewId` / `authorizationId`); issuer role = the lifecycle's (`GPT_ARCHITECT` issues packets and corrections and decides acceptance; an authorization's `actorRole`); `issuedAt` = the body's for decisions and authorizations; `subject.sliceId` = the packet's slice (required for packets). Repository and slice grammars are R4L's `REPOSITORY_PATTERN` / `SLICE_ID_PATTERN`, exact.
- Version semantics: archive revisions of one document, 1..n without gaps, vN supersedes vN-1's exact ref (same kind, same id, previous recordHash). The packet's `packetVersion` (run-scoped, new packetId each time, gaps allowed by the controller) is NOT reused as the archive version; it stays in the body. Architect question recorded in the report.
- Hashes: `bodyHash = SHA256(canonicalJson(body))`, `recordHash = SHA256(canonicalJson(record without recordHash))` with the existing `canonicalJson`. Integrity only: not a signature, not Human authentication, not writer authenticity (a test forges a verifying record).
- `src/automation/authority/file-archive.ts`: `<root>/records/<SHA256("chief.authority.v1\0" + kind + "\0" + authorityId)>/<version, 8 digits>.json`. Append: validate → seal → read and validate the chain → identical existing version returns its ref; different → `VERSION_CONFLICT`; gap → `VERSION_GAP`; wrong predecessor → `INVALID_SUPERSESSION` → temp (wx, 0600) + fsync → `link()` to the version name (EEXIST: the concurrent winner decides; identical → same ref, else `VERSION_CONFLICT`) → directory fsync → temp unlinked. Any other link failure → `PUBLICATION_UNAVAILABLE`, no fallback. No rename-over, no lock, no rewrite, no delete.
- Open / read: every open replays every chain (canonical bytes, strict schema, body rules, both hashes, logical directory, version file name, versions 1..n, supersession chain); unknown entries fail closed, temp names and dot entries are ignored. Each read re-validates the chain it reads. Nothing is repaired or backfilled.
- Capabilities: `openAuthorityArchiveReader(root)` → frozen `{ get, listVersions, latest }` (a missing archive reads as empty; nothing is created); `openAuthorityArchiveAppender(root)` → frozen `{ append }`. The archive class is module-private; no update / replace / delete / truncate / rewrite / setLatest / import / promote API. Wired into nothing (no Workspace, runner, adapter, model process, MCP, connector or provider); R4T will govern who holds the appender.
- Storage separation: the root is the archive's own and holds only `records/`, so pointing it at a controller store (with `changes/` and runs) fails closed. Not R4T: a process with write access to the directory is outside R4P's protection model.
- Tests: `test-automation-authority-archive.mjs` (44 checks, added to `npm test`): the 36 required conformance checks plus extra integrity cases (non-canonical bytes, invalid timestamp, wrong kind, fork, gap, unknown entry), publication unavailable, storage separation, and no runtime wiring. Separate processes: 12 identical v1 appenders → one record, one ref; 12 conflicting v1 → one winner, 11 `VERSION_CONFLICT`; 12 concurrent v2 → one v2, no branch. Crash: a writer killed before `link()` leaves no authority; one killed after publication leaves exactly one record and a retry returns the same ref. Mutation check: removing the supersession checks fails the corresponding tests.
- Not implemented: R4T, R4A0, D1, Goal adoption / Change mint, Workspace Start, /run API, queue advancement, execution driver, connectors, live OpenAI / Claude / Codex calls, provider credentials or subscription auth, continuation, successor runs, automatic correction / retry. R4L unchanged. Provider/model calls 0; Controller runs created outside tests 0; Workspace execution calls 0.

### Correction G1-R4P-1-C1 — Fail-closed archive root ownership (2026-10-05)

- Base: `1b7292e531e55fa114fcb665c2c7234ac7393a3b` on `work/g1-r4p-authority-archive`; `main` = `8f5206a` (unchanged). R4P design accepted otherwise; not redesigned.
- Defect: opening an appender created and fsynced `<root>/records/` before checking whether `<root>` belonged to another store, so `openAuthorityArchiveAppender(controllerStoreRoot)` changed that root and only then threw `ARCHIVE_INTEGRITY`.
- Corrected open order (`file-archive.ts` only): resolve root → read-only inspection (lstat; an existing root must be a real directory holding only `records/` and dot entries; an existing `records` must be a real directory) → refuse with zero archive mutation → only for an absent root or a compatible one, create what is missing (parents, the root without following an existing entry, `records/`), re-inspecting after creating the root → fsync → full chain replay. A reader still creates nothing.
- Alias safety: the root, `records`, key directories and canonical `<version>.json` files are checked with lstat and never followed; record files are opened with `O_NOFOLLOW` and must be regular files. A symlink at any of them → `ARCHIVE_INTEGRITY`. Temps remain non-authority. This is not malicious-writer resistance; the hashes are still not authenticity.
- Architect decisions recorded: Q1 confirmed (archive `version` is the gap-free revision sequence of one `(kind, authorityId)`, independent of `packetVersion`); Q2 confirmed (archived documents must already carry a canonical authorityId; the archive never normalises; existing packet / policy / controller issuer schemas unchanged; future governed issuance must produce archiveable ids before live activation).
- Tests: `test-automation-authority-archive.mjs` 49 checks (44 → 49; the old storage-separation check is replaced by stricter non-mutation checks): Controller store root refused with byte-identical root contents, no `records/`, store still readable and its R4L admission unchanged; foreign non-empty root and a regular-file root refused without mutation; symlinked root (to an empty directory and to a valid archive), symlinked `records`, symlinked canonical record and key directory refused without touching their targets; valid archive, absent nested root created by an appender, reader of an absent root creating nothing. Run against `1b7292e`, the five non-mutation / alias checks fail; on C1 all pass. Idempotency, concurrency and crash checks unchanged and green.
- Unchanged: `document.ts`, kinds, versions, ids, parsers, R4L, lifecycle, Workspace, runner, adapters, providers, R4T, R4A0, D1, Goal adoption, Change mint, continuation; no runtime wiring. Provider/model calls 0; Controller runs outside tests 0; Workspace execution calls 0.

## G1-R4T-1 Governance Store / Agent Isolation Tripwire (2026-10-05)

- Base: canonical `main` = `d6579a41cecd0141cc187ce33671174d09213510` (R4P + C1 promoted by the Human's fast-forward push from `8f5206a`), clean; R4L 38/0 and R4P 49/0 at base. Branch `work/g1-r4t-governance-isolation`. Implementation candidate for Architect review; not promoted.
- Protected roots: `CONTROLLER_STORE` (`controllerStoreDirectory`; runs and R4L admission) and `AUTHORITY_ARCHIVE` (new required live config field `authorityArchiveDirectory`, named only so it can be protected: no reader or appender is opened, nothing is appended).
- `src/automation/governance-store-isolation.ts`: `GovernanceStoreIsolation.forLiveRoots` (each root absolute and normalised, existing, a real directory not a symlink, owned by the host uid where `process.getuid` exists, mode without group/other write; never created or chmodded; roots mutually disjoint), `assertDisjoint(label, path)` (re-establishes both roots on every call: a root moved away, swapped or removed after composition fails closed; identity is device + inode + birth time, because Linux can reuse an inode number for a directory recreated in place, which CI run #65 exposed in the first candidate), `assertNotRoot`, and `GovernanceStoreIsolationError` (`code: 'GOVERNANCE_STORE_ISOLATION'`). It holds no capability to either store.
- Identity rules: a path must be absolute and normalised (no `.`/`..`/`//`/trailing `/`); it is resolved through its nearest existing ancestor with `realpath`, and overlap is equal / inside / containing decided by (a) device+inode of every existing ancestor (symlink, firmlink and other aliases cannot hide containment) and (b) component-wise canonical paths (`/a/store` never overlaps `/a/store-old`). Any path whose identity cannot be established fails closed. Seatbelt itself was probed on this Mac: it matches canonical paths (`/System/Volumes/Data/...` spellings reach nothing not granted), so the `/System` read tree does not expose the data volume.
- Composition tripwire (`live/composition.ts`, before anything is constructed): roots checked, then disjoint from `git.repositoryPath`, `git.worktreeRoot`, each `git.linkedDirectories[].source`, `offlineValidation.runtimeReadPaths[]` and search-path directories, `modelProcess.runtimeReadPaths[]` and search-path directories, `claude.executable`, `codex.executable`, `journalDirectory`, `egressJournalDirectory`, and the fixed Seatbelt trees (`/usr`, `/bin`, `/System`, `/private/var/db/timezone`; fixed literal entries may not be a root). A refused composition creates and changes nothing (tests compare the trees).
- Dynamic tripwires: `assertInvocationIsolated` (`seatbelt-validation.ts`) checks every readable and writable tree of the invocation's Seatbelt policy, its cwd, its search path and an absolute executable. `SeatbeltModelProcessExecutor` calls it after the workspace, executable, paths and temporary directory are resolved and before the egress session, broker, probe or CLI exist; `SeatbeltOfflineValidationExecutor` calls it before the profile probe or the generated code. Overlap → `UNAVAILABLE` with `GOVERNANCE_STORE_ISOLATION` in the reason (the adapters already turn that into `HUMAN_STOP`, never `SOFT_STOP`). Both executors require a real `GovernanceStoreIsolation` and refuse construction when their runtime or search paths, or the fixed trees, reach a root.
- Capability topology: authority appender production holders 0, archive reader holders 0 (source check over `src/`); no raw Controller store getter; `createLiveAutomation` still returns only `{ controller, runner, journal, egressJournal, reality }`; no `createRun` caller, `/run` or start route outside the controller; Workspace sources reference no automation, store, archive, runner, model or isolation capability. Observation: `createLiveAutomation(…, dependencies)` still accepts injected validation / model boundaries (test seam); it has no production caller, so only the trusted host could use it, and the static composition check runs regardless.
- Tests: `test-automation-governance-isolation.mjs` (39 checks on macOS; added to `npm test`): root identity, static composition (refusals with no injection), per-invocation unit check, real Seatbelt model and validation executors with a counted real process executor (no process, no egress session, no resolution on refusal; disjoint requests ENFORCED as before), capability topology. The 15 Seatbelt-backed checks need macOS and are reported as skipped on the Linux CI runner. Mutation proof: removing the model executor's `assertInvocationIsolated` call fails checks 21-24 and 26 (processes start); removing the validation executor's call fails 28-33. Existing suites updated only to supply the roots (model process 12, offline validation 11, live adapters 48; composition fixtures place the roots beside the fixture directory).
- Unchanged: R4L, R4P (`document.ts`, `file-archive.ts`), controller lifecycle, packet and policy semantics, Workspace (`src/workspace`, `workspace-ui`), Goal store. Not implemented: R4A0, CHIEF-GOV/2, D1, Goal adoption / Change mint, Workspace Start, /run, queue advancement, continuation, provider activation. Chief provider/model calls 0; Controller runs outside tests 0; Workspace execution calls 0; authority documents appended outside tests 0.

### G1-R4T-1-CI1 — macOS isolation acceptance gate (2026-10-06)

- Base: `84377a632b78c55a6e4a4eb91ef8990c9edc12ac` on `work/g1-r4t-governance-isolation`; `main` = `d6579a4` (unchanged). Architect decision on Q1: a macOS CI gate is required before R4T promotion. Evidence infrastructure only: no production source, R4T semantics, package.json or contract change.
- `.github/workflows/ci.yml`: the Ubuntu `test` job is unchanged (full `npm test`; it still skips the Seatbelt-backed checks). New job `r4t-macos` on `macos-latest`, Node 24.15.0, `actions/checkout@v7` (no persisted credentials), `actions/setup-node@v7`, `npm ci`, `npm run build`. It first requires a working Seatbelt (`/usr/bin/sandbox-exec` present and applying a profile; otherwise the job fails), then runs `test-automation-governance-isolation.mjs`, `test-automation-model-process.mjs`, `test-automation-offline-validation.mjs`, `test-automation-run-admission.mjs` and `test-automation-authority-archive.mjs`, failing if any suite prints a `SKIP` line or its final line is not `N passed, 0 failed` (a skip is never a pass; nothing is mocked or injected for the dynamic proof).
- Local run of the same gate script on this Mac: R4T 39/0, model process 12/0, offline validation 11/0, R4L 38/0, R4P 49/0, no skips; a log with a `SKIP` line and a `, 1 skipped` summary is refused.
- Provider/model calls 0; Controller runs outside tests 0; Workspace execution calls 0; authority documents appended outside tests 0.

## WS-P1 Primary Workspace + 協作室 (2026-10-06)

- Base: canonical `main` = `482052801f2f8a460db8de4aa5a17e9b50bfffc1` (G1-R4T-1-CI1, promoted). Branch `work/ws-p1-primary-workspace`. Workspace operational view only: no governance, Controller, R4L, R4P, R4T, R4A0, D1, execution or provider change.
- Project views: 此刻 / 往來 / 協作室, each its own address (`#/p/<id>/now`, `/conversation`, `/collaboration`; `#/p/<id>` is 此刻; anything else is the root), switched by links in a view bar at every width. The WS-VIS1B ≥1180px side-by-side stage + correspondence became exclusive views (the accepted <1180px pane model, generalised): 往來 is a 760px reading column on the black page, the composer docks under 此刻 and 往來, and 協作室 has no composer. Clicks, deep links and back/forward go through one `go()`; a new project opens on 此刻 and closes a sheet that belonged to the old one.
- 此刻: "Chief 現在" reads 排隊中 · 尚未開始執行 (or 沒有工作). One focal object: the oldest open escalation (gold, 需要你, with 查看協作室) when there is one, else the queue card, else empty. 正在處理 / 等待 AI 驗證 / 完成 / 失敗 are never shown: they need execution facts that do not exist. 查看協作室 appears when the room has records.
- Home: 需要你 (gold, oldest first, a link into that project's 協作室; never a redirect), Chief's question, the composer with its explicit 交給哪個專案 target (existing default rule unchanged), then 目前的工作 (none without execution), 排隊中, 最近開啟 (a local UI preference, known projects only, at most four). Root entry still opens the oldest Human-required project (WS-VIS1B-C1); in LIVE there is none.
- `workspace-ui/collaboration.js` (pure, no imports): CollaborationEventV1 `{ id, projectId, goalId?, actor, role?, runtime?, type, body, timestamp, evidence? }` with types PROPOSAL / QUESTION / CHALLENGE / RESPONSE / HANDOFF / EVIDENCE / AGREEMENT / ESCALATION / SYSTEM (runtime-neutral; the actor is a display name). Strict: an unknown field (e.g. `reasoning`), type, evidence kind, foreign project, bad time, control character or duplicate id refuses that event, which is counted ("N 則事件格式不正確") and never shown. Evidence: FILE `{ path, lines? }`, TESTS `{ passed, failed?, label? }`, COMMIT `{ sha }` (shown as 7 characters), display only. CollaborationSummaryV1 `{ projectId, activeParticipants, consensus, disagreements, needsHuman }` is derived from the events alone: participants = actors of non-system events; consensus = AGREEMENT events verbatim; a CHALLENGE stays a disagreement until its own author later agrees within the same goal; every ESCALATION needs the Human (no decision backend exists, so none is resolved). No model writes anything.
- 協作室: summary panel, then 需要你, then the record oldest first on one hairline thread (node shape and word per type; gold only for ESCALATION; challenge coral `#D99A8B`, agreement sage `#93BFA4`, both new tokens on the frozen black material). 查看決策 opens a read-only sheet whose only control closes it: "Workspace 不能在這裡做決定，也不會記錄任何決定或授權". Empty state: 目前沒有 AI 協作紀錄 / 這個專案尚未開始執行，或目前沒有可顯示的協作事件。
- Fixture boundary: LIVE has no collaboration source; `live.collaboration()` answers `{ provenance: 'NONE', events: [] }` without a request, so LIVE always shows the empty state and never a Human-required signal. No API route was added (still 6); the server only serves `collaboration.js` as a static file. The demo fixture (`demo.js`, `?demo=1` only, ids `demo-…`, provenance DEMO_SAMPLE) passes the same projection and is labelled 示範資料 in the room, on 此刻, on Home and in the sheet; one demo project has no record so the empty state shows too.
- SSE: unchanged contract; queue events update data only; loading, rooms and SSE never navigate (static check). Browser run against the real server (scratch config): Home submit to a chosen project stays on Home, survives reload, `#/p/chief` → `/now`, 往來 history, LIVE 協作室 empty, a goal POSTed from outside while on 協作室 updated the spine without moving the view; demo root → the escalated project, 協作室 record, read-only sheet (focus on close, Escape), Home 需要你; no horizontal overflow at 1440, 820 and 390 px; 0 console errors.
- Tests: `test-workspace-ui.mjs` 13 → 27 (routes, switching, Home sections, signals, model strictness, summary, event / evidence / escalation rendering, empty state, 往來, fixture isolation, SSE, responsive CSS); `test-workspace-server.mjs` serves `collaboration.js`. Mutation-checked (SSE navigating, unknown-field refusal off, LIVE returning an event, an approve button in the sheet, challenges settled by anyone, project switch keeping the view, 此刻 saying 正在處理): each fails a check.
- Architecture note (deferred): Seat ≠ Session ≠ Invocation ≠ Run. OpenRig is only a future untrusted execution-backend candidate; no dependency, no execution change.
- Not implemented: R4A0, governance read model, D1, Goal → Change, Change mint, ROOT run creation, execution driver, Claude / Codex execution, provider activation or switching, OpenRig, AgentSeatV1, RuntimeSessionV1, persistent sessions, auto review / correction, Human authority actions. Console unchanged. Provider/model calls 0; Controller runs outside tests 0; Workspace execution calls 0; authority documents appended outside tests 0.

## WS-P2 Collaboration Room Product Refinement (2026-10-06)

- Base: canonical `main` = `e5053f72c0cb86769cb118bf4d39ac448ad142ad` (WS-P1, promoted). Branch `work/ws-p2-collab-room`. Workspace UI only (`workspace-ui/collaboration.js`, `app.js`, `styles.css`, `test-workspace-ui.mjs`); no server, API, store, SSE, governance, execution or provider change.
- Layout: AI 協作摘要 across the top, then two areas: AI 討論 and a 需要你 rail. A container query on the room (not the window, so the project spines count) puts them side by side when the room is ≥760px (rail 240–300px, sticky in the room's scroll) and one at a time behind [ 討論 ] [ 需要你 ] below that; never two squeezed columns. Each area has its own address: `#/p/<id>/collaboration` (討論) and `#/p/<id>/collaboration/needs` (需要你); back/forward, the 此刻 需要你 focal and Home 需要你 land on the 需要你 area; choosing an area moves focus to its heading.
- 討論: who took part (actor, role, how many entries, when last: from the record, never a live state), then the record read as exchanges. A PROPOSAL, HANDOFF, CHALLENGE or ESCALATION (or a change of goal) opens an exchange; later questions, responses, evidence and agreements follow on its thread; SYSTEM stands alone. The opener leads typographically; the type word leads each event header. An outcome line appears only when the record shows one: a CHALLENGE settled when its author later agrees within the goal (the summary's rule) or 仍有分歧; an ESCALATION 需要你決定 with a link to the rail; otherwise 已同意 when someone other than the opener agreed inside it, else nothing. Grouping follows order and type and does not claim a reply answers its opener.
- 需要你: each open ESCALATION shows only the question, who raised it, when, optional evidence and 查看決策 (the same read-only sheet: no approve, reject, answer or record). With none, the rail keeps its place with 目前沒有需要你決定的事。AI 之間無法自行決定的事，會出現在這裡。
- Summary (CollaborationSummaryV1 unchanged, deterministic): four facts (參與的 AI with names, 尚未解決的分歧, 需要你決定, 已記錄的共識), then the recorded agreements and any open disagreements.
- Evidence (FILE / TESTS / COMMIT, display only) hangs off the event that attached it: a left rule in that event's colour (`--tone`), captioned 附上的證據; gold only on the 需要你 rail.
- Chain-of-thought boundary (correction of WS-P1 wording): WS-P1 said the absence of a reasoning field meant no source could put chain-of-thought into the room; that overstated what the code proves. Canonical rule, now in the module header: CollaborationEventV1 represents only explicitly emitted collaboration artifacts (agent message, review comment, hand-off, evidence, operational event, decision-rationale summary); a future execution source MUST NOT put hidden or private model reasoning into `body`. The projection still refuses unknown fields, but it cannot tell what text a source puts into `body`; that is the source's obligation. The room's line now reads 參與工作的 AI 明確送出的提案、審查意見、交接、證據與決策理由摘要。這是工作紀錄，不是 AI 的思考過程。 Contract/comment/UI clarification only; no execution plumbing.
- Identity: actor / role / runtime stay display metadata; no AgentSeatV1, RuntimeSessionV1 or persistent session; neither module names a particular agent in code (tested with other actor names). No per-agent composer or "說給 …" control; Human ↔ Chief stays in 往來.
- Fixture / LIVE: unchanged. LIVE has no collaboration source: an empty room shows both areas empty (no summary, no events, no demo label). Demo only with `?demo=1`, labelled 示範資料. No API route added (still 6).
- A first build reused the page shell's `.rail` class for the 需要你 rail (the project spines' nav); it is now `.nrail`, and a test refuses any shell class inside the room.
- Tests: `test-workspace-ui.mjs` 27 → 35 (two areas and container query, area addresses and focus, empty 需要你, exchanges and outcomes, identity as metadata, evidence relation, no per-agent control, chain-of-thought wording, shell class collision); WS-P1 checks updated to the new structure. Mutation-checked (both areas shown when narrow, self-agreement as an outcome, an approve button in the rail, the rail's empty state removed, the rail not sticky, the escalation outcome pointing at 討論, a live-presence word): each fails a check. Browser run against the real server: 1440 two areas (discussion 717px, rail 300px sticky), 820 and 390 one area at a time with the address and focus following, LIVE empty room with both areas, an outside goal via SSE did not move the view, the sheet still read-only, no horizontal overflow, 0 console errors.
- Unchanged: R4A0, D1, Goal → Change, Change mint, Controller lifecycle, R4L, R4P, R4T, execution driver, Claude / Codex execution, OpenRig, provider switching, persistent sessions, auto review / correction, Human authority backend. Provider/model calls 0; Controller runs outside tests 0; Workspace execution calls 0; authority documents appended outside tests 0.

## G1-R4A0 Governed Read Model V1 (2026-10-06)

- Base: canonical `main` = `04be4f84eded425bf57fd729dce55ae2173ee429` (WS-P2, promoted by the Human's non-force fast-forward from `e5053f7` before this slice; the first precondition check found `e5053f7` and stopped). Branch `work/g1-r4a0-governed-read-model`. Implementation candidate for Architect review; not promoted.
- `src/automation/read-model/governed-read-model.ts`: `readGovernedModel({ controllerStoreDirectory, authorityArchiveDirectory }, clock?)` → deep-frozen `GovernedReadModelV1` { schema `chief.governed-read-model`, schemaVersion 1, rulesetRef `CHIEF-GOV/1`, observedAt, snapshot { id, controllerStore / authorityArchive PRESENT | ABSENT }, continuation `NOT_IMPLEMENTED`, runs[], changes[], authority[], anomalies[] }; `GovernedReadError` (`INVALID_ROOTS`, `SOURCE_INTEGRITY`, `CONTROLLER_RUN_INVALID`, `AUTHORITY_ARCHIVE_INVALID`, `SNAPSHOT_INCONSISTENT`). Roots must be absolute, normalised and disjoint. Wired into nothing.
- `src/automation/read-model/source-snapshot.ts`: the read-only scanner. Only lstat, readdir and open(O_RDONLY | O_NOFOLLOW) + fstat + read; never constructs `FileControllerStore` (its constructor mkdirs and fsyncs); a missing root stays missing and reads as empty; symlinked roots, `changes/` or records fail closed. Consistency: a fingerprint of every relevant entry (dev, inode, size, mtime/ctime ns, SHA-256 of bytes; directories by dev + inode; locks, temps and refusal evidence excluded) is taken before and after the projection; any difference → `SNAPSHOT_INCONSISTENT`. The Controller runs and claims are projected from the first pass's bytes; the archive is read through the R4P reader between the passes. `snapshot.id` = content address (paths + byte hashes).
- `durable-store.ts`: the run-envelope check moved verbatim into exported pure `openStoredRun(text, owns)` (and `storedRunFileName`), used by the store and the read model, so one definition validates runs (envelope, schema version, checksum, filename identity binding, `assertRunInvariants`). Store behaviour unchanged (R4L 38/0, store 18/0, controller 46/0).
- Runs: discovered from the store's run files only; a file failing those checks fails the whole read (`CONTROLLER_RUN_INVALID`): its change, state and authority are unknown. The R4L registry is never the source of existence. Change = R4L exact identity (`ChangeRefV1 { kind: 'SLICE', changeId: sliceId }` + repository + `changeKeyOf`); a non-canonical identity gets `change: null` and is never normalised.
- Anomalies (reported, never repaired; mirrors `FileControllerStore#assertIndexed` in both directions): `LEGACY_UNINDEXED_RUN` (no claim, or no canonical identity), `ADMISSION_REGISTRY_MISMATCH` (claim under another key, a runId claimed by two changes, a claim's run of another change, a run that is not its change's ROOT), `ADMISSION_RECORD_INVALID` (unreadable/invalid claim, e.g. one carrying a continuation), `UNLINKED_SIBLING_RUN` (more than one valid run for one exact repository + sliceId). Per run: `admission { recordClass: OPERATIONAL_RECORD, status ROOT | NOT_ROOT | NO_RECORD | RECORD_INVALID | NO_CANONICAL_IDENTITY, rootRunId, admittedAt }`.
- Authority: the read model is the only holder of `openAuthorityArchiveReader` (no appender). Every archived version is listed as `AuthorityFactV1` (DIRECT_AUTHORITY, issuer as stated, subject, bodyHash). A run's references: retained bodies (`activePacket`, `correctionPacket`, `acceptance`, `promotionAuthorization`, `humanResumeAuthorization`; `required: true`) and audit references (packets by id + hash, grants by id). Each resolves to the one archived version whose bodyHash equals the hash the run records (the Controller `packetHash` and R4P `bodyHash` are the same canonical hash; a test asserts it), checked against the run's repository and slice: `RESOLVED` | `NOT_ARCHIVED` | `VERSION_NOT_FOUND` | `SUBJECT_MISMATCH` | `AMBIGUOUS` | `HASH_NOT_RECORDED`. Never the latest. The Controller copies and any journal entry stay operational; journals are not an input.
- NextAction (`changes[].nextAction`, `ruleId: null`): `moves` = the lifecycle moves the recorded facts allow, each with the one role that may take it, as the controller applies `lifecycle.ts` (pending external recheck blocks evidence-bearing actions; a spent iteration budget at PACKET_READY / CORRECTION_REQUIRED is the controller's `STOP` → HUMAN_STOP; a missing current correction → `ISSUE_CORRECTION_PACKET`; SOFT_STOP resume vs budget exhaustion; several moves of one role where unrecorded facts decide); STOP / FAIL_CLOSED exits are not listed; terminal → no moves. INDETERMINATE when the change has an anomaly, when the store has any anomaly elsewhere (scope `CONTROLLER_STORE`: such a store does not open, so no run in it can move), or when a retained authority body of a non-terminal run does not resolve (scope `AUTHORITY`). HUMAN_STOP: only `RESUME_HUMAN_STOP` (HUMAN) to the interrupted state, with capabilityGaps `CHANGE_ABANDONMENT_NOT_IMPLEMENTED`, `CONTINUATION_NOT_IN_RULESET`. Lineage `{ kind: UNAVAILABLE, admission: NOT_IMPLEMENTED, predecessor: null, successor: null }`; `ChangeViewV1.head = null`.
- R4T delta (narrow): `test-automation-governance-isolation.mjs` #35 now allows the reader in `src/automation/read-model/governed-read-model.ts` only, requires zero appender holders outside the archive, and requires that nothing imports the read model; `test-automation-authority-archive.mjs`'s wiring check allows that one reader import and refuses any appender mention. `AUTOMATION_GOVERNANCE_CONTRACT.md` §6.2 added, §8.2 items 6 and 10 updated.
- Tests: `test-automation-governed-read-model.mjs` (20 checks, added to `npm test`): scenarios A–O of the packet, plus a conformance run that drives a real `AutomationController` on a `FileControllerStore` through the lifecycle (architecture stop, soft stop, rejection, correction, Human stop and resume, recheck, acceptance, promotion, close) and requires every recorded transition to be one the read model predicted, and the spent-budget halt. Read-only proof: every mutating fs call and every write-mode open is made to throw during a read, and full trees (mode, inode, size, mtime, ctime, bytes) are compared before and after successful and failed reads. Mutation-checked: no second snapshot (L fails), resolve to latest (D, F), unresolved authority ignored (E, F), no sibling anomaly (G), store-level anomalies ignored (K), subject unchecked (F), HUMAN_STOP move removed (O, conformance), budget halt unpredicted (conformance), runs not scanned (most), symlinks followed (C).
- Not implemented: Workspace wiring or API routes, UI, D1, Goal → Change, Change mint, run creation, Controller / R4L mutation, R4P append, execution driver, Claude / Codex execution, provider/model calls, OpenRig, AgentSeatV1, RuntimeSessionV1, persistent sessions, automatic correction / retry, Human decision backend, CHIEF-GOV/2, continuation. CI workflow unchanged (the new suite runs in the Ubuntu `test` job; the macOS r4t-macos gate runs the amended R4T and R4P suites). Provider/model calls 0; Controller runs created outside tests 0; authority documents appended outside tests 0.
