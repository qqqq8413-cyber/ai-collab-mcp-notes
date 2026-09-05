# Replay #4 驗收紀錄

## 結果與範圍

**M2-A Full Mechanism Runtime PASS。完成後 STOPPED / AWAITING ARCHITECTURE REVIEW。**

本輪由使用者批准 Gate eligibility 的 specification correction,之後只執行一次
controlled replay。Planning 與 Round 1 都是 Replay #3 的 synthetic snapshot;
Gate、Targeted Round 2、Decision Synthesis 是三次真實 provider dispatcher calls。
三次皆為 openai / gpt-5。這次沒有驗證跨 provider 的即時合作。

Baseline commit: `aedc9efe0ff1f4acf7d5a36d9a1b3ab87e5b9af8` (rev.19)。
Runtime/prompt + tests commit: `267ecffb2eebbb8fe4d42333469ad8d10b0362f4`。
執行時間:2026-09-06 00:40:12.093 至 00:42:50.502 (Asia/Taipei)。
執行前 tracked working tree clean;只有本輪 diagnostic 目錄 untracked。

## Specification Correction

Production diff 僅 `src/agents/collaboration.ts::buildGateAppendix()` 的 eligibility 文字。
原規則問 synthesis 形成答案後,解決分歧是否還會改變決策;新規則先檢查原始 Round 1
是否有 material、cross-agent、decision-sensitive disagreement,以及直接 peer response
是否可能 materially change/strengthen/falsify/qualify 決策。Provisional 能提出折衷、
條件方案或 Kill Switch,不再自動取消提報資格。

這是經批准的設計語義修正,不是把 rev.18 observation 重新定義成 parser/runtime bug。
仍排除 wording/style/minor emphasis/equivalent recommendations/不影響決策的細節,
仍可不輸出 issue,保留 at-most-one 與不得捏造分歧的原規則。
沒有 force flag、detector call、Judge 或獨立 Chief Review。

## Offline Tests 與 Control

- Baseline `npm test`:208 passed / 0 failed。
- 修改後 `npm test`:212 passed / 0 failed。既有 assertions 未放寬。
- 新增四項 `test-collaboration.mjs` 測試:折衷仍可提報、非 material 排除、max-one、
  disabled 的 payload/prompt/stage/finalOutput parity。
- Prompt assertions 鎖住 contract;mocked responses 驗證 runtime 分支,不代表 LLM 判斷已被離線證明。
- 額外 16 組修改前/後 control capture:omitted/disabled、SIMPLE/NORMAL/DEEP、
  SUCCESS/DEGRADED/FAILED(略過單人不可能的 DEGRADED)。
- 為比較完整 payload,offline clock 固定;真實 live clock 未修改。
- `control-before.json` 與 `control-after.json` byte-identical:
  `f50a7b2ee2a8b7f896dc6a6b88692d612281553011a1de685b2e39c9a567c698`。
- 原有 failure fallback、needs_evidence record-only、retrieval/evidence 隔離、
  N+4 ceiling 與 default-OFF 測試均通過。

## Fixture 完整性

直接讀取 `../controlled-replay/` 的五份 fixture,未另建或修改輸入。
`preflight.json` 與 artifact 保存逐檔 SHA-256;每檔皆與 Replay #3 的
`fixture-hashes.json` 及 baseline Git bytes 相等。

Replay #3 snapshot hash 與 Replay #4 snapshot hash 都是:

`cb5e9c309a8b64cac1b688d9de4ff4a9b26fc504d40d3ccb5ff412bcb4965a4b`

定義:`SHA256(JSON.stringify(snapshot))`,沿用 #3 的 key/array order,
包括 task、complexity、agentOrder、Worker missions/outputs/provider。
Status 由原 runtime 重算,與 #3 完全相同。Roster、40 chunks 也逐欄相等。
Replay #3 artifact 本體 hash:
`e184ab46be33f2df72ed096d146938a143a2d1197ac4e308c182ce3d7844a878`。

rev.19 的 BENCHMARK RESET 仍有效。本輪不用 BENCHMARK_TASK,不將舊年度策略 benchmark
與新佔位名稱執行比較。唯一受控修改是 Gate eligibility;不宣稱單次輸出差異足以排除
模型隨機性或服務端變動,也不從 #3/#4 推論品質或 latency 增益。

## 分層判定

| 項目 | 結果 | 依據 |
|---|---|---|
| Gate Live Reachability | PASS | captured synthesis_gate prompt 含新語義及原 40 references |
| Gate Disagreement Recognition | PASS | 正文明示品牌支持 B、營運支持 C,且 machine-readable issue 指向產能衝突 |
| Valid Issue Block Parsing | PASS | parse.status=parsed; emitted=1, valid=1, rejected=0, eligible=1 |
| SourceRef Resolution | PASS | 既有 resolver 精確解出 business_strategist:p5 |
| Deterministic Selection | PASS | selected=1;離線以原 selectIssue 重算相同;無 ranking call |
| Targeted R2 | PASS | brand_creative 收到指定 selective context,真實回應 challenge |
| Decision Synthesis | PASS | 真實執行;neutrality contract 保留;provisional/R2/final 都保存 |
| Evidence Invariants | PASS | report、banner、retrieval summary、RunStatus 與凍結 Round 1 一致 |

## Issue 與 SourceRef

`action=peer_challenge`; `decisionSensitive=true`;
`targetAgentId=brand_creative`; `sourceRef=business_strategist:p5`。
target/source 皆存在、成功且不同。
Selection fallback used: **false**; selection note: **無,只有一個 eligible issue**。
模型輸出多個 issue 時的固定排序與最多一個 R2 由既有及新增 offline tests 驗證,
本次沒有 live exercised 多 issue 分支。

Challenge 原文:

> 即使建立副品牌，如何在現有資源不足的條件下，保證不動用核心剪輯/導演/PM 的瓶頸資源？請提出可運行的人力結構（外包比例、審片權限、返工處理）、SLA 與收費機制，證明在客戶修改需求升高時仍能維持目標毛利且不擠壓主業；否則品牌隔離不足以成為現在就選 B 的依據。

Resolved agent: `business_strategist`; chunk id: `p5`; chunk index:4。
Offsets:[175,215),40 個字元;charLimit=1000;truncated=false。
Exact chunk text:

> 在公司沒有足夠資源同時擴編兩條產品線的條件下，我不建議現在投入新的固定服務承諾。

**Chunk relevance:YES。** 該段直接提出資源不足下不宜新增固定承諾的理由,與 challenge
要求回應瓶頸產能及履約風險直接相關。不是標題或分隔線,沒有 fuzzy match 或 answer-head fallback。

## R2 結構檢查

Actual prompt、system、model、response 原文見 `artifact.json.calls[1]`。
Original Task、Target Mission、Own Round 1、Exact Peer Chunk、Challenge 全部逐字核對通過;
未廣播完整 peer output。R2 retrievalRequested=null、retrievalResult=null。

| 問題 | 判定 |
|---|---|
| Target 是否直接回應 challenge? | YES。開頭回應「僅有品牌隔離不足」,後續提出人力、SLA/收費與風險條件 |
| 是否使用 peer argument? | YES。以核心瓶頸資源不足作為原 B 建議的新條件 |
| 是否允許維持原立場? | YES。actual contract 明示 challenge 錯時可反駁且不必讓步 |
| 是否被 prompt 強迫 consensus? | NO。明示 Do not concede in order to agree |
| 本次 response 形態 | partially revise:符合資源隔離條件才 B,否則 C |

這些判定只涉及 response 結構與引用關係,不評估 B/C 商業正確性或假設可行性。

## Decision Synthesis 與 Evidence

Actual prompt 保留 `Revision, recency, or agreement between specialists is not evidence`,
要求按原推理、challenge、task constraints 評估;未解分歧可明示,不要求 consensus。
Final 正文仍列出待管理的分歧,且附原有 HYPOTHESIS warning。

- provisionalAnswer:2757 字元,與原 parser 從 Gate response 取出的 answer 相同。
- R2 output:2260 字元,與 captured response 相同。
- finalOutput:3617 字元(含 banner),等於 Round 1 banner + captured decision response。
- EvidenceLabel before/after:`HYPOTHESIS / HYPOTHESIS`。
- RunStatus before/after:`SUCCESS / SUCCESS`。
- Retrieval summary before/after:absent;所有三次 call 的 retrieval request/result 都是 null。
- Frozen snapshot 未變;R2 未進入 Round 1 report derivation。live report 一致,
  `workerResults` 隔離及 failure semantics 另由未放寬的 offline tests 支持。
- 本次走成功路徑,沒有 live 注入 R2/decision failure。兩種 fallback 仍由 offline 測試驗證。

## Calls 與 Timings

| Stage | Runtime phase ms | Pass-through call ms |
|---|---:|---:|
| synthesis_gate | 46729 | 46728 |
| round2_worker | 42713 | 42711 |
| decision_synthesis | 68965 | 68961 |

Replay totalMs=158408;collaboration.totalMs=158407。
差異包含 runtime 與紀錄器邊界/寫檔 overhead。這是單次 wall time,不是分佈。
實際 live logical calls=3;Planning/Workers 未重跑。N=2 完整 orchestrator
的設計上限仍是 N+4=6,不能把本次稱為實際執行了六次。
SDK/HTTP retries 未計量,token/cost 未取得也不填數字。

## Observation 與停止點

本輪未確認需修復的 production runtime defect。Chunk relevance 通過,不改 Chunker。
離線 verifier 首次因 runtime 的 `retrieval:undefined` 在 JSON 儲存後被省略而失敗;
只將比較值轉成 JSON 可表示的同一形狀後重驗,artifact 原文未改、live 未重跑。

Gate 在 provisional 已選 C 後仍輸出 peer_challenge,符合此次 eligibility specification。
#3 provisional 選 B、#4 provisional 選 C 是觀察,不能歸因成 peer interaction 效果,
因 #4 provisional 產生時 R2 尚未執行。

輸出包含模型提出的工時、價格與毛利等假設;未納入 pricing registry 或當成測量數據。
本輪沒有做這些商業主張的 claim validation,也不把模型的認同當成實證。

PASS 僅表示完整 downstream mechanism 在真實 provider calls 下跑通一次。
不宣稱優於 baseline、品質提高、多模型優於單模型或應 productionize。
到此停止,等待 Architecture Review;未開始 B vs B′、self-review、A/B/C/D、
NORMAL eligibility、Finance Layer 或後續 implementation。
