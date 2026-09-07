# CURRENT_STATE — ai-collab-mcp

> **這是「目前仍有效狀態」的短版 materialized view,不是歷史紀錄。**
>
> | 文件 | 角色 |
> |---|---|
> | `CURRENT_STATE.md` | 本檔。優先讀。只寫現在仍然成立的事 |
> | `HANDOFF.md` | 完整歷史 / provenance。需要證據時再精準查對應節次 |
> | `M2_EFFECTIVENESS_EXPERIMENT.md` | 正式 methodology / protocol source |
>
> 本檔**不取代**上面兩份。衝突時以 protocol 文件與 committed artifact 為準。

---

## 1. Branch / snapshot

```
repository            qqqq8413-cyber/ai-collab-mcp-notes
branch                experimental/m2a-peer-challenge
stateVerifiedThrough  8d8b686c3bd5ed18d904941d440124a781b6b706
production            src/** 最新 accepted 變更 = 1e182f6（runPlanningStage 抽取）
main                  未 merge，且本階段不打算 merge
```

**production source 的歷史,精確版:**

```
d01043b   runRound1Stage 抽取 —— accepted pre-synthesis boundary，Wave 1/2/3 皆在此邊界上執行
1e182f6   runPlanningStage 抽取 —— 目前 src/** 的最新 accepted 變更（CWP-6A）
```

`CWP-1` / `CWP-2` / `CWP-3` / `CWP-3R` / `P-1` / `CWP-4A` / `CWP-4B` / `CWP-4B-R` /
`CWP-5A` / `CWP-5B-X` / `CWP-7A` / `CWP-7B` / `CWP-7C` 全部只動
`experiments/m2b/**`,**沒有任何一個進入 `src/**`**。
`CWP-6A` 是**唯一**動到 production source 的一輪:把 planning 半段抽成
`runPlanningStage()`,並以確定性測試證明 Round 1 行為與五次時鐘讀取皆未位移。

**Wave 1 / 2 / 3 的 capture 都是在 `d01043b` 邊界上執行的**,`1e182f6` 在它們之後,
不影響任何已凍結的證據。

> ⚠️ **`stateVerifiedThrough` 是本檔內容被核對到的那個 commit,不是目前的 branch HEAD。**
> 本檔一被 commit,任何寫死在裡面的 HEAD 就已經過期 —— 包含這一行。
>
> **CURRENT_STATE.md 對 live branch HEAD 不具權威性。**
> 做任何 architecture 或 execution 決策之前,一律先從 git / GitHub 取得當前 HEAD:
>
> ```bash
> git fetch origin && git rev-parse origin/experimental/m2a-peer-challenge
> ```
>
> 本檔以下所有內容,是在 `stateVerifiedThrough` 那個 commit 上核對過的;
> 若其後有新 commit,以 repo 為準。

---

## 2. Product

MCP server,讓 Claude / GPT / Gemini 協作。TypeScript ESM(`type: module`、NodeNext、import 帶 `.js`),測試是 `.mjs` 直接 import `dist/`。

**三種模式**:`pipeline` / `orchestrator` / `debate`。M2 的全部工作都在 orchestrator。

**Chief(`src/agents/chief.ts`)** —— 專案的 Decision Engine。收到任務後決定:

```
complexity ∈ { simple, normal, deep }     ← 分類，不是分數
選哪幾位 specialist、各自的 mission、priority
requiresRedTeam
```

Chief 的 brief 是 **minimum sufficient collaboration**:用最少的人達成高品質決策。
`SPECIALIST_CAP`(`src/agents/chief.ts`):**`simple = 1`、`normal = 3`、`deep = 4`。**

關鍵性質(R2/R3 都撞到):**`deep` 的 specialist cap 是「至多 4 位」的上限,
不是「至少 2 位」的下限。** Chief 的第一條 planning rule 就是先判斷這題是否真的需要超過一位,
所以 `deep` 完全可能只配到一位 —— R2 的 `fxr-05` / `fxr-07` 就是這樣 FAIL F2 的。

⚠️ **不要把 specialist count 和 logical call ceiling 混為一談**(這是本檔前一版的錯誤):

```
deep specialist cap           = 4          ← 人數上限
M2-A DEEP logical-call ceiling = N + 4     ← 呼叫數上限，N = 實際 specialist 數
                                 N ≤ 4  ⇒  最多 8 次 logical call
```

「最多 8」講的是**呼叫數**,不是人數。

**Registry(`src/agents/registry.ts`)** 三位 registered specialist:

```
business_strategist   商業模式 / 財務邏輯 / 風險 / 反方觀點
market_researcher     市場情報 / 競品 / 客群 / 證據蒐集   （providesEvidence: true）
brand_creative        品牌策略 / Creative Direction / 差異化
```

`providesEvidence` 只是意圖;能不能真的檢索由 model capability 決定(`resolveWorker`),
specialist 無法靠自稱取得 EVIDENCE_BACKED。

**Round 1 邊界(`src/modes/orchestrator.ts`)** —— `runRound1Stage()` 已抽出並 ACCEPTED。
它做完 planning + Round 1 + report 後停住,不進 synthesis。
capture 一律直接呼叫它,**不得呼叫 `runOrchestrator()`**(後者在合法情況下會繼續 synthesis)。

**CallStage**:`planning | round1_worker | synthesis | synthesis_gate | round2_worker | decision_synthesis`。

---

## 3. Governance

```
GPT           Architecture / Decision Owner —— 唯一能批准階段推進的角色
Claude Code   long-context engineering executor —— 設計、實作、red-team、報告
Codex         narrow implementation executor
Gemini        methodology second opinion / clean-room annotator
HANDOFF.md    historical engineering source of truth
```

硬規則(仍有效):

- 每個階段都要有 GPT 的明確書面授權才能開始
- Claude **不負責** final architecture decision,不得自行延伸 scope
- 看到可以改善的地方**不等於**可以直接 implement
- 所有報告用繁體中文
- 不得把單次 observation 寫成普遍結論
- 不得把「機制能運作」寫成「產品價值已證明」

---

## 4. Evidence

**這一節有兩個不同的東西,不要合併:** 一個是「這句話是什麼性質的主張」,
另一個是「這個主張的來源可信到什麼程度」。

### 4.1 Evidence classification —— 標記主張的性質

```
[FACT]      committed artifact 可重算出來的事
[SIGNAL]    觀察到、但樣本或設計不足以支撐因果宣稱
[DESIGN]    設計選擇與理由
[DECISION]  GPT 已裁決
[OPEN]      待 GPT 裁決
```

### 4.2 Evidence source hierarchy —— 來源強度，由強到弱

```
Runtime Measurement
  >
Repository Code / Deterministic Tests
  >
Reproducible Artifacts（captured prompt / hash）
  >
HANDOFF factual record
  >
Independent external evidence
  >
Multi-model critique
  >
Single-model reasoning
```

下層不得推翻上層。特別是:**多個模型都同意,排在倒數第二 —— 它不會升級成 runtime 證據。**

### 4.3 另外三條長期有效的判準

```
structural determination > prompt persuasion
runtime truth > architecture assumption
peer agreement ≠ evidence
```

---

## 5. M2 architecture

**M2-A(peer challenge 機制)** —— `STOPPED / AWAITING ARCHITECTURE REVIEW / default OFF`。
機制本身已在 Replay #4 跑通一次完整鏈路(valid issue → Round 2 → Decision Synthesis)。
`[FACT]` 那是 **mechanism runtime pass**,不是品質或產品價值的證據。

**M2-B(effectiveness experiment)** —— 目的是回答:
**targeted peer challenge 是否真的讓最終決策變好**,而不是只是讓輸出變長。

四個 arm:

```
B    現行 orchestrator（無 gate 附錄）
B′   有 gate 附錄但關閉 Round 2（disableRound2）——  用來排除「附錄本身」的效果
C    targeted peer challenge：gate 選一個跨專家分歧，請 target 回應
D₁   matched self-review：同一位 target 自己挑戰自己（harness only）
```

`B′` 的存在是為了讓 `C > B` 不會被「附錄改變了 synthesis 行為」解釋掉。
`D₁` 的存在是為了讓 `C > D₁` 不會被「多一輪修訂本來就會變好」解釋掉。

**`C − D₁` 量到的是 Targeted Peer-Challenge Package 的增量,不是「純粹的 peer information」。**
package 有五個成分(peer 段落、gate 選題、gate 撰寫的挑戰、外部挑戰的框架、target 修訂),
Phase 1 不拆解。

省錢的結構:B′/C/D₁ 共用**同一次** gate 呼叫 → 觸發時每次 repetition 是 6 次計費呼叫,不是 8 次。

---

## 6. Accepted protocol — `M2B-PROTOCOL-0.3`

ACCEPTED @ `1354863`。v0.2 全文保留在 protocol 文件內,未刪除。
可執行常數:`experiments/m2b/protocol/amendment-0-3.mjs`(由 `test-m2b-protocol-0-3.mjs` 雙向斷言)。

### Option 3′-H — Heterogeneous Round1

provider 綁 **role**,全局固定,**不依 fixture 變動**:

```
business_strategist  →  claude / claude-sonnet-5
market_researcher    →  gemini / gemini-3.1-pro-preview
brand_creative       →  openai / gpt-5
Chief planning       →  openai / gpt-5
```

Planner 仍自由決定 specialist 數量、選誰、mission 內容。Task 文字不得知道這個 mapping。

### C/D₁ target invariant（不可放寬）

```
同一 fixture、同一 selected target：C 的 target provider/model === D₁ 的
```

在 3′-H 下**由結構自動成立**:routing 是 `agentId` 的函數,不吃 fixture 也不吃 arm。
代價是 **target provider 不再事前可知** —— 由 Gate 選中誰決定。
因此 target-provider rotation 已降級為 **secondary observed execution coverage**,
且**不得為 provider coverage 選擇、保留或剔除 fixture**。

### F1–F7（未改,F4 不得放寬）

```
F1  complexity = deep
F2  Round 1 成功的 specialist ≥ 2
F3  RunStatus = SUCCESS
F4  Round 1 文本中存在可辨識的跨專家、會影響決策的分歧
F5  fixture 自身資訊足以判斷答案好壞
F6  不依賴即時網路資料（retrieval 全關）
F7  核心決策不依賴大量 deterministic arithmetic
```

明文規則:**相同決策 + 不同推理,不自動構成 material conflict。**

正式 F4 由 **fresh clean-room Gemini A2** 在 acquisition 過程中 author,不由 Claude 判定。
A2 可見 task / missions / actual Round1 / passage IDs / schema;
**不可見** intended archetype / Gate / arms / gold。
填 slot 需 `materialConflict=true` **且** `conflictArchetype` 等於該 slot 預先登記的 archetype。

### Confound register（本階段最相關的兩條）

```
X11  D₁ 被 peer 資訊汙染 —— 極高風險，且無法用 lexical matching 證明不存在（未解決）
X14  provider 與 fixture 共線 —— 3′-H 已把 fixture 層級共線性 reduced，
     但 role-provider coupling 仍為 residual confound，未消除
X18  Heterogeneous Prior Friction —— plausible contributor / methodology motivation only，
     尚未證實。不得宣稱 heterogeneous allocation 造成 F4 failure
```

### Claim boundary

```
Fixture acquisition   不產生任何 effectiveness claim
Pilot                 仍然不回答 effectiveness
正式 C > D₁ 宣稱       只能在後續 formal study 之後，
                      且只適用 preregistered heterogeneous fixture population
```

四項**禁止宣稱**:

```
pure peer-information value
homogeneous deployment generalization
cross-provider generalization
provider heterogeneity caused the observed conflict
```

---

## 7. Pre-live engineering state（M2-B acquisition tooling）

`M2B-PROTOCOL-0.3` —— **ACCEPTED**。以下五個 work packet 依序把它變成可執行的 acquisition 路徑,
全部落在 `experiments/m2b/**`:

| packet | 內容 | 狀態 | commit |
|---|---|---|---|
| **CWP-1** | Option 3′-H capture routing / per-agent pin provenance | ACCEPTED | `656f75c75bf0e8b2f9f359446822dab27773f5db` |
| **CWP-2** | P03 candidate pool 註冊 / wave gating / one-attempt / wave budget | ACCEPTED | `5d92a34333dab522885ef88a48889680079f6594` |
| **CWP-3** | real capture → clean-room A2 packet builder + annotation validator | ACCEPTED | `5a2bb5e5b1871e3ce55a6770a0a786018c5d65e1` |
| **CWP-3R** | fatal capture handling ＋ prior A2 provenance continuity validation | ACCEPTED | `183b88669edaf46a634efd5d6c67d9194cb7c7b1` |
| **P-1** | request-side provider/model pin mismatch 的 pre-call guard | CLOSED / ACCEPTED | `a275d010703bf382dcccf1b621607b4eac582c97` |
| **CWP-4A** | journal↔raw-call seq 相等、gapless sequence、P03 wave-order 驗證 | ACCEPTED | `732d567fddf03cd3964dbd483defd112227e5922` |
| **CWP-4B** | capture-scoped transport no-retry ＋ CAPTURE-3 schema | ACCEPTED | `9a6e7150baccf9a76cd60e9ea99d8264409e9634` |
| **CWP-4B-R** | dependency byte-provenance ＋ 已提交 baseline 的強制比對 | ACCEPTED | `3b79da52c733ef67a8012939e35e113d574f5c10` |

### PRE-LIVE BLOCKER LEDGER

歷史 ID 沿用 `WAVE1_PREFLIGHT_REVIEW.md` 的原始命名,**不重新命名**。

| ID | 內容 | 狀態 |
|---|---|---|
| **B-01** | 0.3 candidate pool 未註冊為 candidate set,`sourceTaskPath('S1')` 直接拋錯 | CLOSED by **CWP-2** |
| **B-02** | `buildWorkerRefs` 用 per-fixture pin,不是 role pin | CLOSED by **CWP-1** |
| **B-03** | recorder 的 `pins[stage]` 無法表達 per-agent pin | CLOSED by **CWP-1** |
| **B-04** | verifier check 17/18 寫死 `providerAllocation[fixtureId]` | CLOSED by **CWP-1** |
| **B-05** | 綠燈測試守著已被取代的 Option 3′ allocation | CLOSED by **CWP-1** |
| **B-06** | manifest 只記單一 `providerAllocation` | CLOSED by **CWP-1** |
| **N-03** | `slotsForWave` 未接進 session driver | CLOSED by **CWP-2** |
| **N-05** | call budget 仍是 16,不是 per-wave | CLOSED by **CWP-2**（`waveCallBudget` = 選中 slot × 4) |
| **N-04** | 沒有 real capture → clean-room A2 的可執行路徑 | CLOSED by **CWP-3** |
| **C-01** | 合法的 pre-Round1 fatal capture 會讓 A2 loader crash | CLOSED by **CWP-3R** |
| **C-02** | prior A2 provenance 未經連續性驗證就被信任 | CLOSED by **CWP-3R** |
| **P-1** | request-side provider/model 不符只在 provider call 之後才被發現 | CLOSED by **P-1** @ `a275d01` |
| **D-01** | 本檔未記錄 harness 尚不支援 0.3 | CLOSED by `bb2214f` 的更新 |
| **M-ACQ-01** | **NATURAL ELIGIBILITY BASE-RATE UNKNOWN** —— 不知道未修改的 production Chief 在更廣的 production-like task population 中，多常自然產生 `deep` **且** multi-specialist assignment | **OPEN** |
| **T-RETRY-01** | SDK transport retry accounting gap —— 一次 logical dispatch 可能是多次 HTTP attempt | **CLOSED FOR FUTURE CAPTURES** by **CWP-4B ＋ CWP-4B-R** @ `3b79da5` |

未關閉、但**不是** engineering blocker 的兩項,列出以免被誤讀成已消失:

```
N-01  session 的 fresh:true 會 rmSync capture root
      → live entry point 不可達：run-live.mjs 拒絕 --fresh / --overwrite / --delete-existing，
        且 realRoot 已存在就拒絕啟動。僅離線 stub session 用得到。狀態：MITIGATED，非 CLOSED
N-02  3′-H 把唯一 providesEvidence 的 role（market_researcher）綁到 gemini，
      而該 role 在目前已觀察的十六題中被指派 0 次 → gemini worker coverage 仍是零。
      這是合法的 observed result，不是缺陷。詳見第 8 節
```

仍待 GPT 裁決的 architecture 開放項(非 blocker,但**不得在 reconciliation 時遺漏**):

```
A2 prior provenance 的 on-disk 儲存位置與命名        未定
A2 identity scanner 的 fail-closed 行為（真實 Round1 若含 S1/E1/I1 字樣會擋下整批)  未裁決
CWP-2 wave gating 與 A2 resolveAnnotations().filledArchetypes 尚未接線          未接
session.mjs 的 ROUND_ENDING class 清單未含 RequestPinMismatch（該路徑對它不可達)  名義不一致
```

### M-ACQ-01 —— NATURAL ELIGIBILITY BASE-RATE UNKNOWN（OPEN)

P03 假設「`deep` + multi-specialist 的案例可以被取得」,但**從未先建立這種案例的自然發生率**。
九題之後,`deep ∧ assigned ≥ 2` 出現 **0 次**。

`[FACT]` 九次觀察、零事件,對真實發生率的單尾 95% 上界只約束到 **≈ 28%** ——
這同時相容於「其實常見但運氣不好」與「真的罕見」。P03 是關於 **P03 自己**的強證據,
不足以估計 production-wide 的頻率。

**這不是**:runtime blocker、程式缺陷、Chief 缺陷,也**不是**「F1/F2 應該被改」的證據。
**這是** methodology knowledge gap。

`[DECISION]` **在這個 base-rate 問題被 characterize 之前,不得重新設計或執行
M2-B effectiveness experiment。**

處理方向的草案(**未接受、未預先登記、未授權**),共九份,經 Gemini census 方法學審查
(NEEDS REVISION)與 GPT 裁定(ACCEPT WITH CORRECTIONS)後修訂:

```
experiments/m2b/census/CHIEF_NATURAL_COLLABORATION_CENSUS_DRAFT.md   方法學本體
experiments/m2b/census/CBRP_AUTHORING_AND_REVIEW_DRAFT.md            出題與結構審查控制
experiments/m2b/census/CBRP_AUTHORING_BRIEF_PREREG_DRAFT.md          凍結出題 brief（可直接貼入）
experiments/m2b/census/CBRP_STRUCTURAL_REVIEW_RUBRIC_DRAFT.md        逐題結構審查 rubric
experiments/m2b/census/CBRP_CORPUS_DUPLICATE_AUDIT_DRAFT.md          全 corpus 重複稽核（分輪）
experiments/m2b/census/CBRP_SESSION_PROVENANCE_SCHEMA_DRAFT.md       出題／審查／稽核 session provenance
experiments/m2b/census/CBRP_MODEL_PINS_PREREG_DRAFT.md               **唯一** exact model pin 表 ＋ CBRP-D3-v1
experiments/m2b/census/CBRP_POOL_MANIFEST_SCHEMA_DRAFT.md            pool manifest 與 CBRP-ORDER-v1
experiments/m2b/census/CBRP_PREREGISTRATION_CHECKLIST_DRAFT.md       preregistration 就緒清單
```

**CBRP —— Chief Balanced Reference Population**(DRAFT / METHODOLOGY REVISION):
一個**合成、預先登記、等權重**的參照框架,六個 primary-intent strata、每組十題。

```
primary estimand   P( complexity = deep AND assigned specialist count >= 2 | CBRP )
名稱               reference-population assignment rate

N = 60             [ARCHITECTURE DESIGN DECISION]  由 theta 反推，不由成本或 wall-clock 決定
theta_feas = 5%    [ARCHITECTURE DESIGN DECISION]  operational feasibility threshold，
                                                   不是「罕見」的科學定義，也不是普遍門檻
decision rule      VIABLE 單尾 95% 下界 > 5% ｜ TOO_SPARSE 單尾 95% 上界 ≤ 5% ｜ 其餘 INCONCLUSIVE
                   point estimate 只作描述性報告，不得單獨決定架構決策
                   明確拒絕「point estimate ≥ 10%」這種決策規則
```

`[DECISION]` **CBRP 是受控的科學參照母體,不是 production telemetry。**
所有結論必須限定在「within the preregistered CBRP reference frame」;
**不得**宣稱 production-wide prevalence、actual user rate、real-world prevalence,
也不得寫「Chief usually…」「Chief rarely…」。等權重 1/6 是設計選擇,
**絕不可**被讀成 production 的實際使用頻率。

`[DECISION]` **Phase 1 量的是 `assigned ≥ 2`,不是 F2。** F2 要求 *successful* specialist,
planning-only 觀察不到。禁止寫成「F2 pass」「F2 rate」「successful collaboration rate」。
Phase 2:**NOT DESIGNED / NOT PREREGISTERED / NOT AUTHORIZED。**

`[DESIGN]` blinded authoring **降低**出題者偏誤,**不消除**它。

`[DECISION]` **統計模型已更正為 heterogeneous(CWP-6A)。** 六十個觀察不是同分佈的
Bernoulli trial:每個 task 有自己的 `pi`,estimand 是平均值 `p̄ = (1/N)Σpi`,
計數 `K` 是 **Poisson-binomial**,**不得**稱為 ordinary Binomial。
區間方法為 **heterogeneous-Bernoulli-valid Buehler-optimal one-sided bounds**
(Mattner–Tasto),β = 0.95;內部端點多半與 ordinary one-sided CP 重合,
差異只在 `k = 1`(lower `(1−β)/N`)與 `k = N−1`(upper `1−(1−β)/N`)。
**決策分區未因此更動**:`k = 0` TOO_SPARSE ｜ `k = 1..6` INCONCLUSIVE ｜ `k ≥ 7` VIABLE。

`[FACT]` **N = 59 才是滿足零事件條件的最小整數**(4.951% ≤ 5%,N = 58 為 5.034%)。
N = 60 是**滿足該條件的最小「六層等量平衡設計」**(6 × 10) —— 不得寫成「最小的 N」。

`[DESIGN]` **independence 是模型假設,不是被證明的性質。** runtime fingerprint、
model pin、provider pin、dependency provenance 都**不**證明 backend 的統計獨立性;
執行控制只降低可避免的 nonstationarity。

`[FACT]` **formal event source 是 post-enforcement 的
`runPlanningStage().plan.assignments.length`**,絕不是 Chief 的原始 JSON 數量。

**`runPlanningStage()` 已抽出(CENSUS-REQ-01,IMPLEMENTED)** ——
production 的 planning 半段現在可單獨呼叫、零 worker call,
`runRound1Stage()` 改為呼叫它,行為與五次時鐘讀取皆經確定性測試證明未位移。
`planSchema` / `extractJsonObject` / `enforceConstraints` **維持 private**,無重複實作。

**census 的執行基礎設施已全部離線關閉(CWP-7A + CWP-7B,零 provider call):**

```
CENSUS-REQ-01  runPlanningStage parity                      CLOSED / VERIFIED
CENSUS-REQ-02  post-enforcement event source                ARCHITECTURE-DECIDED（驗證器重算）
CENSUS-REQ-03  durable pre-dispatch attempt reservation     CLOSED
CENSUS-REQ-04  source ↔ dist execution binding              CLOSED / VERIFIED OFFLINE
CENSUS-REQ-05  Zod installed-byte provenance                CLOSED
CENSUS-REQ-06  census recorder / session / verifier          CLOSED OFFLINE（已排演）
CENSUS-REQ-07  build toolchain provenance                   CLOSED / VERIFIED OFFLINE
CENSUS-REQ-08  node runtime pin                             CLOSED / VERIFIED OFFLINE
CENSUS-REQ-09  runtime drift enforcement                    CLOSED / VERIFIED OFFLINE
CENSUS-REQ-10  pre-call provenance revalidation             CLOSED / VERIFIED OFFLINE
```

`[FACT]` **CENSUS-REQ-09 —— runtime fingerprint 由「證據」升級為「強制」。**
語意完全沿用歷史合約(`src/**` 與 `dist/**` 的 file → sha256 map、`fingerprintDiff`),
**未重新定義**。session 開始前若沒有有效的 start fingerprint →
`RUNTIME_FINGERPRINT_MISSING`,pre-dispatch 停止、0 reservation、0 call。
結束時 start ≠ end → `RUNTIME_DRIFT` → `INCOMPLETE` → `NO_STATISTICAL_VERDICT`,
**即使六十次 planning 全部成功也一樣**。

`[DESIGN]` 另加一道**每題邊界的重採樣**:成本是約三十個檔案雜湊,相對於一次 planning call
可忽略。它把宣稱從「兩端之間沒有淨漂移」升級為「任一 task 邊界上都沒有觀察到漂移」。
**它仍然不能證明單次 call 內部沒有改了又改回去的暫態修改** —— 這一點明文寫在程式碼與文件中,不得誇大。

`[FACT]` **CENSUS-REQ-10 —— preflight 改為重算,不再相信旗標。**
先前的版本檢查 `buildBinding.match === true` 與 `dependencyProvenance.problems.length === 0`,
那是別人下的結論;拿著 `{ match: true }` 配一個錯誤的編譯器就能開始花掉 attempt。
現在 session 呼叫**與 verifier 完全相同的純函式**(`toolchainProblems`、`matchesCensusBaseline`)
對實際記錄重算,因此 preflight 與 verification 不可能漂移成兩套政策,偽造的摘要欄位也買不到任何東西。

`[FACT]` **CENSUS-REQ-07 —— TypeScript 7 是 native port。** `node_modules/.bin/tsc`
是指向兩行 shim 的符號連結,該 shim 解析並 exec
`@typescript/typescript-darwin-arm64` 內的原生執行檔。**真正編譯出 `dist/` 的位元組是那個
23 MB 的原生二進位檔,不是 `typescript` 套件的 JavaScript** —— 只證明後者等於只證明了一個啟動器。
兩個套件現在都在 census baseline 內;執行檔的身分是**問啟動器它會 exec 什麼**得到的,
不是讀路徑字串,且必須落在核准套件之內。

```
typescript                           locked/installed 7.0.2 ｜ digest 2681b5b2… ｜ 416 files
@typescript/typescript-darwin-arm64  locked/installed 7.0.2 ｜ digest 119d596e… ｜ 113 files
compiler executable                  node_modules/@typescript/typescript-darwin-arm64/lib/tsc
                                     sha256 a82f7313…
```

`[FACT]` **CENSUS-REQ-08 —— Node runtime pin `v24.15.0`,fail-closed。**
`[DESIGN]` 這個 pin 刻意狹窄:**相同 Node 版本並不保證跨機器 bit-identical 行為**,
platform / arch / 其他 `process.versions` 欄位只作 recorded context,**不參與比對**。
它唯一的用途是:census 不得在未經審查的另一個 runtime 世代下被靜默執行。

toolchain 與 Node 的檢查都在 **reference build 之前**執行 —— 編譯器若未經核准,
那次重建本身就不構成證據,不值得產生。相關證據隨 build binding 進入 artifact,
因此驗證器可以在不重建的情況下判定,**且「兩個 digest 相符」不再足以讓竄改過的 artifact 通過**。

**以上一律不改動歷史 `runtimeFingerprint`、CAPTURE-2、CAPTURE-3 或任何 Wave 主張。**
Wave 3 的 compiler identity **並未**由此機制證明 —— 當時它還不存在。

`[FACT]` **統計方法已實作並驗證:`CBRP-MT-BUEHLER-1`**
(`experiments/m2b/census/statistics.mjs`,31 項確定性測試)。
八組 pinned vector、`beta_60 = 0.7357675420279305` 支援守衛、單調性、
`L(k) = 1 − U(N−k)` 對稱性、分區轉折全部通過;並有測試**拒絕**在
`k = 1` 與 `k = N−1` 使用 ordinary CP 的值。數值合約固定:bracket `[0,1]`、
tolerance 1e-14、200 次固定 bisection、無隨機、決策比較**不四捨五入**、顯示 6 位。

```
M-CBRP-STAT-01   SPECIFICATION CLOSED ｜ IMPLEMENTATION VERIFIED
                 ｜ INDEPENDENT REPRODUCTION VERIFIED
decision 不對稱   ARCHITECTURE-DECIDED / ACCEPTED FOR PHASE 1
                  —— 只有 k=0 能得 TOO_SPARSE；INCONCLUSIVE 是合法的預先登記結果
```

`[FACT]` **獨立統計重現:VERIFIED。** Codex 的獨立稽核從頭重推並相符 ——
模型(`Yi ~ Bernoulli(pi)`,獨立、不必同分佈;`K` 為 Poisson-binomial;
estimand `p̄ = mean(pi)`)、適用條件 `beta_60 = 0.7357675420279305` 且 β = .95 通過、
八組 pinned vector、`k = 0 / 1..6 / 7..60` 的分區轉折,以及
「59 是數學最小值、60 是最小的六層平衡設計」。**該次稽核未修改本 repository。**
interval formula 上已無方法學阻塞。

`[FACT]` **durable one-attempt registry**:append-only NDJSON + 每筆 fsync,
reservation 在 provider 邊界**之前**落盤。重啟後可分辨三種狀態;
`reserved 但未 settled` = **AMBIGUOUS ATTEMPT CONSUMED** → session `INCOMPLETE`、
**不重試、不替換、不跳過**、不再發任何 call。

`[FACT]` **source ↔ dist binding**:以 `git archive` 取出授權 commit 的 `src/` 與 build config,
用倉庫自己釘住的編譯器在暫存目錄重建,對輸出取確定性 digest 後與執行用 `dist/` 比對。
**歷史 `runtimeFingerprint` 的定義未被改動** —— 這是另一份獨立記錄。

`[FACT]` **census dependency baseline `CBRP-CENSUS-DEPS-1` 含 Zod**
(`plan.assignments` 由 `planSchema.parse()` 產生,Zod 就在事件的產生路徑上)。
census 有**自己的** baseline 物件,不與 capture 共用;未改任何套件版本,
**歷史 CAPTURE-2 / CAPTURE-3 主張不受影響**。

`[FACT]` **session 格式為 `CBRP-CENSUS-1`,不是 CAPTURE-3。** planning-only:

```
allowed stage             planning（round1_worker / synthesis / gate / round2 / decision 全部拒絕）
global logical budget     60          per-task budget   1        （無 slots×4 語意）
planning pin              openai / gpt-5，無 fallback、無替代
transport                 explicit-no-retry
失敗處理                   provider / parse / schema / constraint / resolved-pin 失敗
                          → 保存證據、STOP、sessionStatus = INCOMPLETE、無統計判定
                          **失敗絕不轉成 Y = 0**
verdict gate              僅在 COMPLETE 且恰好 60 筆有效 settled、每題各一次時才產生判定，
                          否則 NO_STATISTICAL_VERDICT
```

離線 rehearsal 88 項測試涵蓋 k=0 / k=6 / k=7、六十次成功、各類失敗路徑、
budget 第 61 次、worker-stage 拒絕、重複 attempt、未 settle 的復原、
依賴與 build 不符、以及 12 種 artifact 竄改。
**測試用 fixture 全部標記 TEST-ONLY / NOT CBRP CANDIDATES,永不得升格為真實題目。**

```
真實 CBRP 題目已出       0        live provider call   0
census 已執行            NO       study 仍為 NOT PREREGISTERED / NOT AUTHORIZED
```

### CWP-8A / 8B / 8C / 8D —— preregistration 程序凍結（內容未凍結)

`[ARCHITECTURE-DECIDED]` 剩下的方法學程序已全部裁定,文件共九份於 `experiments/m2b/census/`:

```
authoring     5 個 quota BLOCK（AUTHOR-B01…B05），每 block × 每 stratum = 2 題入池
              每個 block 以一個 fresh session（-S00）起始；被拒則在同 block 內
              新增 fresh replacement session（-R01…）
              → 每個 stratum 的十題都來自全部五個 block
              目的：作者身分絕不與 stratum 結構性共線 —— 否則 per-stratum 差異
              與作者差異會是同一個觀察，兩者都讀不出來
              **block 固定五個，session 不固定** —— 不得宣稱「五個 session 產出六十題」
author model  fresh session = fresh model context，不要求每個 session 換模型
              被測的 Chief 模型 openai/gpt-5 **禁止**擔任出題模型（去除直接耦合）
              五個 block 至少涵蓋兩個非 Chief 模型家族；每個 block 跨全部六層
              → author-model family 亦不與 stratum 共線
              model pin（CWP-8D 凍結，CBRP-SESSION-MODEL-PINS-1）：
                  AUTHOR-B01 / B03 / B05 → claude / claude-sonnet-5   CLAUDE_FAMILY
                  AUTHOR-B02 / B04       → gemini / gemini-3.7-flash  GEMINI_FAMILY
              3:2 的不平均是「五個 block、兩個 family」所必然；但因每 block × 每 stratum
              = 2 題，**每一層都恰好是 6 CLAUDE ＋ 4 GEMINI**，六層完全相同
              → family 與 stratum 嚴格正交（這才是分層估計量在意的性質）
              block 的 replacement session 沿用該 block 的 exact model，不因被拒而換模型
              —— model identity 屬於 block，不屬於「前一題有沒有過」
reviewer      R1 = D1 = claude / claude-opus-5     CLAUDE_FAMILY
              R2 = D2 = gemini / gemini-3.8-flash  GEMINI_FAMILY
              每題各得一份 CLAUDE 與一份 GEMINI 判斷；每輪稽核亦然
              被測 Chief 模型 openai/gpt-5 **禁止**出現在全部五個成員資格角色：
              出題、結構審查、結構 tie-break、重複稽核、重複 tie-break
              理由：被測模型不得決定「它稍後將被測量的那個池」的成員資格
              **這不消除 shared-prior bias**；fresh context 只降低對話污染，
              不使模型輸出在統計上獨立
brief         單一凍結 brief，逐位元組相同地交給每個 session
              CBRP_AUTHORING_BRIEF_PREREG_DRAFT.md（可直接貼入，無需補充說明）
gate 1        逐題結構盲審：兩份獨立、不一致交第三位、三取二定案
              CBRP_STRUCTURAL_REVIEW_RUBRIC_DRAFT.md
gate 2        全 corpus 重複稽核，**分輪進行**，在 gate 1 全過之後
              DUP-R00（FULL）：初始六十題的全部 1770 個配對
              DUP-R01+（INCREMENTAL）：只審「至少一端屬於該輪 replacement」的配對
              **old-old 配對永不重審（forbidden）**
              每輪兩位 fresh 盲審稽核者，爭議配對交第三位 fresh 盲審
              CBRP_CORPUS_DUPLICATE_AUDIT_DRAFT.md
diversity     僅產出描述性報告，**不是入池關卡**、無硬性配額
              只有結構審查失敗或確認重複才會造成凍結前替換
invalid task  凍結前：丟棄並在同 block 內以 fresh replacement session 補題，
              **provenance 誠實記錄**（replacement 絕不記成原始 session）
              凍結後、首次 call 前：只能整池重新凍結，不得單題修補
              首次 call 之後：STOP / INCOMPLETE / 回 GPT —— 絕不因結果把題目移出分母
ordering      CBRP-ORDER-v1（已凍結、逐位元組定義、無 PRNG）
manifest      CBRP_POOL_MANIFEST_SCHEMA_DRAFT.md
              **不含自我指涉的 commit SHA** —— commit 無法包含自己的 SHA；
              該 commit 由 Git 從外部識別，下游稱為 POOL_FREEZE_COMMIT
```

`[DECISION]` **GPT 不擔任個別 task 的盲審仲裁。** GPT 知道被測事件、θ 與完整 P03 歷史;
從那個位置做 tie-break,等於在一套盲化程序中唯一一次以知情狀態決定題目能否入池。
GPT 事後稽核程序與彙總證據,**tie-break 交給第三位盲審**。

`[ARCHITECTURE-DECIDED]` **CBRP-ORDER-v1 已完全凍結**,無 PRNG、無任何裁量:

```
seed            = SHA256( POOL_FREEZE_COMMIT + "\n" + "CBRP-ORDER-v1" )
taskOrderKey    = SHA256( seed + "\nTASK\n"  + taskId + "\n" + taskSha256 )
roundStratumKey = SHA256( seed + "\nROUND\n" + decimal(r) + "\n" + stratumCode )
排序一律為小寫十六進位的字典序遞增
stratum codes   SC / OP / BC / EI / PS / FR（無別名）
發射            第 r 輪取每層已排序清單的第 r 題，依該輪的 stratum 順序輸出
                10 輪 × 6 = 60
```

`[DESIGN]` **seed shopping 不只是被禁止,而是結構上不可能** —— 種子是一個
**在計算時已經存在的 commit** 的純函數,因此只有一個值,沒有可試的東西。
分隔字串 `CBRP-ORDER-v1` 已預先登記,derivation 無法悄悄換一個字串重跑。

凍結順序:`pool manifest ＋ 60 題 ＋ 審查 ＋ 重複稽核證據 ＋ diversity 報告 → commit/push
→ 該 commit 即 POOL_FREEZE_COMMIT → 之後才可導出順序`。

```
study status:  PRE-AUTHORING METHODOLOGY FREEZE COMPLETE —— 但 study 仍 NOT PREREGISTERED
理由：程序已完備到「可貼上的 brief ＋ 逐位元組的排序演算法」，但內容不存在 ——
      60 題未寫、0 份審查、0 次重複稽核、0 次凍結、0 個 seed
checklist:     103 項 —— 61 ARCHITECTURE-DECIDED / 12 IMPLEMENTED / 9 VERIFIED
               / 4 CLOSED-VERIFIED-OFFLINE / 1 IMPL-VERIFIED-OFFLINE
               / 6 DRAFT / 2 PROPOSED / 8 OPEN
**已知的方法學決策全部關閉。** 剩下的 8 個 OPEN 全是「必須由一次未授權的執行
才會產生的紀錄」—— C-8 六十題、D-12 稽核輪次、E-2/E-3 manifest 與凍結、
F-1 census harness、A-9/B-7 artifact 版本字串、H-3 外部重現：
**naturally unexecuted，不是 undecided。**
唯一例外是 A-8（PROPOSED）：routing rubric 的可操作性目前只是「主張」，
要等真實審查跑出 inter-reviewer disagreement rate 才會變成數字 ——
缺的是證據，不是決策。
```

### CWP-8C —— incremental duplicate audit 與 session provenance

`[ARCHITECTURE-DECIDED]` 重複稽核不是單一事件。被拒 → 產生空缺 → 補題 → 補題也要被稽核。

```
DUP-R00      FULL          初始六十題的全部 1770 個配對
DUP-R01+     INCREMENTAL   focusSet_j = 該輪「通過結構審查」的全部 replacement
                           in scope     ：至少一端在 focusSet_j 的所有配對
                           out of scope ：兩端都是 incumbent 的配對 —— 永不重審
```

`[DESIGN]` **維持的不變式:任一輪完成後,現行 corpus 中的每個配對,都恰好被一個
已完成的稽核輪次篩過一次。** round 0 是基底;之後 incumbent 帶著「彼此已篩完」進入,
該輪再篩掉 incumbent×replacement 與 replacement×replacement,存活者即完整篩過。
是 **exactly one**,不是 at least one —— 後續輪次的 focusSet 只含尚不存在的題目,
存活配對不可能重新進入 scope。

`[DESIGN]` **為何要 incremental。** 若每次補題都重跑 old-old,一道題被篩的次數會取決於
「這次流程剛好需要幾輪補題」—— 補了四輪的 corpus 中,同一道題會被五組不同稽核者看五次,
就有五次被誤判為重複的機會。**成員資格會變成流程運氣的函數。** incremental 讓每個配對
都只被篩一次。

`[DESIGN]` **代價是真實的、且已接受:round 0 的 false negative 是永久的。** 兩位稽核者在
round 0 一起漏掉的配對,之後不會再被看第二次。設計選擇是:固定「每配對一次」可以預先登記,
「次數由運氣決定」不能。公平的單位是**配對,不是題目**。

`[ARCHITECTURE-DECIDED]` **保留規則:一條規則涵蓋所有輪次。** 取該輪 confirmed pair 構成的圖,
對每個連通元件 `C`,令 `I = C ∩ incumbents`、`R = C ∩ focusSet`:

```
I 非空   →  保留 I 全部           拒絕 R 全部
I 為空   →  保留 R 中字典序最小    拒絕 R 其餘
```

round 0 沒有 incumbent,`I` 恆為空,即化約成原本的「字典序最小」規則 —— 不是第二條規則。
`[DECISION]` **incumbent 永不被後到的 replacement 擠掉。** 否則池的成員資格就能靠
「多生幾個 replacement」來改變,而生幾個正是流程自己決定的 —— 那是一個 outcome-shaped 槓桿。

`[DESIGN]` 元件的**遞移性只用於拒絕,永不用於移除 incumbent**:`{r1,r2,i}` 中即使 `r1`
未與 `i` 直接確認,仍一併拒絕(保守方向,代價只是一次補題);但由 `i1~r`、`r~i2`
**不得**推出 `i1~i2` —— 重複狀態是配對專屬的。

`[ARCHITECTURE-DECIDED]` **輪次先決條件與終止:**

```
前一輪未完成（含空缺補滿、且補題已通過結構審查）→ 下一輪不得開始
空缺一次批次決定、批次補齊；補題若結構審查失敗，先補到通過才進下一輪
   → 結構審查被拒的補題，永遠不會送到重複稽核者面前
無輪次上限；補不到合格題目 → STOP、回 GPT
**絕不為了讓流程收斂而放寬 rubric** —— 收斂由 STOP 保證，不由規則保證
```

`[ARCHITECTURE-DECIDED]` **每輪使用全新 fresh 稽核 context**(`DUP-R00-D1`、`DUP-R01-D1`…);
沿用舊 context 等於把上一輪的結果帶進來。D3 的 id 為
`DUP-R0j-D3-<idA>__<idB>`,兩個 id **依字典序**排列而非依「誰標記的」——
後者會把「哪一位持異議」寫進被保存的識別碼裡。

`[DECISION]` **rubric 在所有輪次逐位元組相同**,scope 以資料欄位 `auditScopeIds` 傳遞
(round 0 = 全部六十個 id,scope 條款自然落空)。因此 `duplicateAuditRubricSha256`
在整個研究中只有一個值 —— 每輪改 rubric 等於每輪換一把尺,「大家用同一份 rubric」
就不再可查。

`[DRAFT]` **session provenance schema** 已建立
(`CBRP_SESSION_PROVENANCE_SCHEMA_DRAFT.md`):出題／結構審查／重複稽核三種 session,
各記 provider、model、modelFamily、rubric 或 brief 的 SHA-256、以及
`freshContextConfirmed`。
`[DESIGN]` **`freshContextConfirmed` 是 operator attestation,不是可驗證事實** ——
沒有任何 artifact 能證明一段對話開始時是空的。schema 讓這個宣稱變成明確、可歸屬、
可被反駁的紀錄;它不會讓宣稱自我證明,**任何結果都不得把它寫成 verified**。

### CWP-8D —— exact model pin 凍結（CBRP-SESSION-MODEL-PINS-1）

`[ARCHITECTURE-DECIDED]` **唯一一份 exact model 表在
`CBRP_MODEL_PINS_PREREG_DRAFT.md`,其餘方法學文件一律以版本號引用。**
一張表被抄進六份文件,到第三次編輯就會自相矛盾。
本檔(以及 checklist 的 D-20/D-21)為了讓 paste-based 審查可獨立閱讀而引述字串;
**任何不一致以 pin 表為準。**

```
出題    B01 / B03 / B05   claude / claude-sonnet-5      CLAUDE_FAMILY
        B02 / B04         gemini / gemini-3.7-flash     GEMINI_FAMILY
審查    R1                claude / claude-opus-5        CLAUDE_FAMILY
        R2                gemini / gemini-3.8-flash     GEMINI_FAMILY
稽核    D1                claude / claude-opus-5        CLAUDE_FAMILY
        D2                gemini / gemini-3.8-flash     GEMINI_FAMILY
```

`[DESIGN]` **作者與審查者在同一 family 內永不共用 exact model**
(`claude-sonnet-5` 出題 / `claude-opus-5` 審查;`gemini-3.7-flash` 出題 /
`gemini-3.8-flash` 審查)。因此**沒有任何一題是被「寫它的那個 exact model」放行的**。

`[DECISION]` **審查者可以與作者同 family —— 這是允許的,但它不是 independence。**
每題都拿到一份 CLAUDE 判斷與一份 GEMINI 判斷,而同 family 內模型不同;
被關掉的是 exact-model self-screening 這一個迴路。
**shared family priors、vendor priors、correlated training data、model dependence
一項都沒有被消除,任何結果都不得寫成「審查者獨立」。**

`[ARCHITECTURE-DECIDED]` **CBRP-D3-v1 —— tie-break 由雜湊決定,不由人選:**

```
structural  selectorInput = "CBRP-D3-v1\nSTRUCTURAL\n" + taskCandidateId
duplicate   selectorInput = "CBRP-D3-v1\nDUPLICATE\n" + a + "\n" + b
            a / b = 該配對兩個 immutable candidate ID，依字典序升冪
            → 路由屬於「配對」，不屬於「誰先回報」
selector    = SHA256(selectorInput)，小寫十六進位，只看第一個字元
            0-7 → claude / claude-opus-5      8-f → gemini / gemini-3.8-flash
\n 為單一 LF (0x0A)；無結尾換行；除所示外無任何分隔符
```

固定用 Claude 當 D3,等於在每次不一致時給 Claude family 一張系統性的第三票;固定 Gemini
則對稱地相同。雜湊移除裁量,且**不讀題目內容、不讀作者 family、不讀前兩份審查結果**。

`[DESIGN]` **但它不保證實際 50/50,任何結果都不得如此宣稱。** 它只保證每個
immutable adjudication key 有唯一一條確定性路由。實測:六十個 canonical task ID 的
structural selector 是 **27 Claude / 33 Gemini**;1770 個 canonical pair 的
duplicate selector 是 **911 / 859** —— 而且那是「全部都進 D3」才會出現的分佈,實際不會。

`[ARCHITECTURE-DECIDED]` **不得替代:** alias、自動升版、fallback、provider substitution、
同 family 換模型、換模型重試 —— 全部禁止。
**pinned model 在該 session 到期時不可用 → STOP、保存證據、回 GPT Architecture Review。**
不得繞過該模型繼續研究:一半由 A 審、一半由 A 的替身審的池,裡面有兩套標準,
而 artifact 不會記錄哪一半是哪一套。

`[FACT]` 本次凍結的六個字串中,**只有 `claude-sonnet-5` 曾出現在本 repository**
(`src/config.ts`、`src/models/capabilities.ts`)。
`claude-opus-5`、`gemini-3.7-flash`、`gemini-3.8-flash` 從未被本專案引用,
**也從未被本專案對任何 live provider 解析過**。這不是對 pin 的異議 —— 選擇權在 GPT
Architecture,而上述 STOP 正是為此而設;記下來是為了讓第一次不可用被讀成
**預先登記的 STOP 正常觸發**,而不是意外。

`[DRAFT]` **每個 session 記錄** `modelPinVersion` / `providerRequested` /
`modelRequested` / `providerResolved` / `modelResolved` / `modelFamily`;
D3 另記 selector 的輸入位元組與 digest,使其模型**可重算而非可信任**。
可觀察到的 requested ≠ resolved → **STOP,該產出不入池,不得換模型重試**。
`[DESIGN]` **但 resolved 身分在 paste-based session 中通常不可觀察** ——
聊天介面一般不會回報是哪一個 build 回答的。不可觀察時該欄位為 `null`,
pin 就退化為**帶 attestation 的 operator instruction**,與 `freshContextConfirmed`
同一種認識論地位。**任何結果都不得把 model pin 寫成 verified。**

**在 GPT 完成下一次 Architecture Review 之前,不得撰寫任何真實 CBRP 題目。**

`[DESIGN]` 出題與審查程序**降低**以結果為導向的選擇偏誤,**不消除**它。
CBRP 仍是**平衡的合成參照框架**,不得升級為 production-wide、real-user prevalence
或 natural production distribution。

```
study status              NOT PREREGISTERED ｜ NOT AUTHORIZED
planning-only harness     PARTIAL（未實作；runPlanningStage() 抽取僅為概念，未授權）
task pool                 不存在 —— 0 題已出
provider calls            0
M-ACQ-01                  仍 OPEN —— CBRP 只刻畫 balanced-reference precursor rate，
                          不會單憑自身確立 production telemetry prevalence
```

### 目前的 M2-B 狀態（不得混淆 acquisition 與 effectiveness)

```
M2B-PROTOCOL-0.3            completed through P03 acquisition
P03                         CLOSED
next P03 wave               NONE
tenth candidate             NONE

A2                          NO_A2_BATCH
A2 authorization            NOT GRANTED

effectiveness experiment    NOT EXECUTED
C vs D₁                     UNANSWERED
peer-challenge 有效性        UNANSWERED
M2-A mechanism evidence     unchanged（見第 5 節，未因 P03 而改變）
```

`[DECISION]` **acquisition 失敗不是 effectiveness 的證據。**
P03 沒有回答 C > D₁,也沒有回答 peer challenge 有沒有用 —— 它從未執行到那一步。

### ⚠️ CRITICAL GOVERNANCE GATE

```
Known engineering blockers:
none currently known from the materialized ledger above
```

**THIS DOES NOT MEAN PRE-LIVE READY.**

```
FINAL PRE-LIVE BLOCKER RECONCILIATION
STATUS: PASS — 已於 P03 Wave 1 之前完成，且該次授權已 CONSUMED / CLOSED
```

**該次 PASS 只涵蓋 Wave 1,不自動延伸到 Wave 2 或 A2。**
每一個新的 live boundary 都必須重跑一次下列 reconciliation:

```
fresh-fetch HEAD
reconcile CURRENT_STATE 與實際 repo
reconcile 完整歷史 blocker ledger（含 HANDOFF）
逐項確認每個 CLOSED blocker 都有 source / test / commit 證據
實際檢視 live path
才做 readiness 判定
```

**不得**把「no known engineering blockers」寫成「Wave 1 ready」或「PRE-LIVE PASS」。

### Pin validation 是兩層,語意不可合併（P-1)

```
Request-side pin mismatch          call 之前就可知
  → RequestPinMismatch
  → provider NOT called
  → 不 reserve budget
  → 不寫 live-call journal

Resolved-side model/provider drift  只有 call 之後才可知
  → ModelPinMismatch
  → raw response 保留
  → call 計入
  → 標記 invalid
  → 不 retry、不 fallback
```

這個區分必須留在 current state ——**它正是上一輪 pre-live review 漏判的原因之一**。

### T-RETRY-01 —— transport retry accounting（CWP-4B)

`[FACT]` recorder 記的是 **logical dispatch**。OpenAI 與 Anthropic SDK 的 client 預設
`maxRetries = 2`,所以在 CWP-4B 之前,**一次 logical dispatch 最多可能是三次 HTTP attempt**,
而 artifact 只會記下較小的那個數字。這個落差由 Codex 的獨立稽核指出。

**修正方式是 capture-scoped,不是全域的:**

```
CallOptions.transportMaxRetries?: 0      新欄位，只有 0
recorder 對每一個 planning / round1_worker call 注入 transportMaxRetries: 0
OpenAI / Anthropic adapter 以 per-request option 遵守它
沒有帶這個欄位的呼叫 → 保留 SDK 預設重試（一般產品路徑不受影響，有測試釘住）
```

`[FACT]` **Gemini 沒有這個旋鈕,因為它沒有重試。** 已安裝的
`@google/generative-ai@0.24.1` 的 `makeRequest` 只 `await fetchFn(url, fetchOptions)` 一次,
非 ok 就直接拋。這是**已安裝位元組的性質**,不是我們設定的選項,所以
`test-m2b-transport-policy.mjs` 以 stubbed fetch 對真實 adapter＋真實 SDK 實測(500 → 恰好 1 次 fetch),
而不是引用文件。

**歷史宣稱的正確措辭(只此一句,不得延伸):**

```
CWP-4B 之前，一次 logical OpenAI / Anthropic dispatch 在 SDK 內部
最多可能產生三次 transport attempt。

Wave 1 / Wave 2 的實際 transport retry 次數 —— UNKNOWN。
```

**不得**由此推算任何歷史或未來的 HTTP 請求總數:Wave 3 的 role 指派尚未觀察,
而歷史 artifact 中的 attempt 次數不可觀測。

**Closure 是 prospective 的。** 它**不會**回溯替 Wave 1 / Wave 2 補上 transport-attempt 證據。

#### Dependency byte-provenance（CWP-4B-R)

版本字串是標籤,本機修改不會改變它;entrypoint 雜湊也不夠 ——
OpenAI 與 Anthropic 決定是否重試的程式碼在 `client.js`,不在 `index.mjs`。
因此身分的單位是**整個已安裝套件的 deterministic digest**:

```
排序後的 package-relative 路徑 → 每個檔案自身的 sha256
→ 對這份 canonical 文字再取一次 sha256
不跟隨 symlink（套件內的連結可以指向任何地方）
只涵蓋 node_modules/{openai, @anthropic-ai/sdk, @google/generative-ai}
```

`APPROVED_DEPENDENCY_BASELINE` 是**已提交的**基準,即 transport 證明實際跑過的那棵樹:

```
packageLockSha256
每個 SDK：lockedVersion ｜ lockIntegrity ｜ transportProvenVersion
          ｜ installedManifestSha256 ｜ runtimeEntrypointRelative
          ｜ runtimePackageDigest ｜ runtimePackageFileCount
```

**記錄不等於強制。** live preflight 與 CAPTURE-3 verifier 透過**同一個比較函式**
對這份 baseline 做等值比對,任一欄位不符即在第一個 provider call 之前停止。
拒絕訊息刻意不提供修法 —— 新的樹是否仍滿足 transport 證明,是要有人拿著測試去判斷的問題,
preflight 若自行 `npm install` 等於用假設回答它。

### 歷史 retry 語意（不得寫錯)

```
可以說：Wave 1 / Wave 2 沒有 orchestration-level 的 retry 或 fallback（已觀察）
不可說：Wave 1 / Wave 2 證明了沒有 SDK retry
        —— transport-level retry 次數在歷史 artifact 中不可觀測
```

### Runtime fingerprint 的真實邊界

```
runtimeFingerprint 只涵蓋   src/**/*.ts 與 dist/**/*.js
它不涵蓋                    package-lock、已安裝的 SDK 位元組
```

**不得**把「runtime fingerprint unchanged」擴張成「整個依賴環境 byte-identical」。
CWP-4B 的作法是**另外新增** dependency provenance(package-lock SHA-256、三個 provider SDK 的
locked/installed 版本、已安裝 manifest 與 resolved entrypoint 的雜湊),
而**不是**改變 fingerprint 的既有含義 —— 那會靜默地重新描述每一份已存在的 artifact。

live 前的 fail-closed preflight 逐項比對 package-lock sha256、locked version、lock integrity、
installed version、installed manifest 雜湊、runtime package digest、package-relative entrypoint,
任一不符一律在**第一個 provider call 之前**停止。不自動 `npm install`,不自動修復依賴樹。

### Capture schema 版本

```
M2B-REAL-ROUND1-CAPTURE-2   Wave 1 / Wave 2（無 transport provenance）
M2B-REAL-ROUND1-CAPTURE-3   CWP-4B 之後（必須有 transport + dependency provenance）
protocol 仍是 M2B-PROTOCOL-0.3 —— 這是 evidence schema 硬化，不是 methodology 修訂
```

verifier 依 capture 自己宣告的版本分流:CAPTURE-2 **不得**被以 transport provenance 評判
(把「沒記錄」讀成「合規」等於捏造它從未擁有的證據);CAPTURE-3 則強制要求。

### Governance invariant

```
No blocker observed  ≠  all known blockers have closure evidence.
```

OFFLINE → LIVE 之前,必須 reconcile 完整的已知 blocker ledger,
而不是只確認「最近幾輪沒有再出現 blocker」。

---

## 8. Real Round1 capture history（壓縮版）

累計 live call:

```
R1 = 10   R2 = 10   R3 = 9
P03 Wave 1 = 6   P03 Wave 2 = 8   P03 Wave 3 = 6        TOTAL = 49
A2 acquisition live calls = 0
```

Wave 3 是第一份 **CAPTURE-3** artifact:六次 logical call **同時就是六次 HTTP attempt**
(每筆記錄 `explicit-no-retry` / `transportMaxRetriesRequested = 0`,依賴樹與已核准 baseline 位元組相符)。
Wave 1 / Wave 2 為 CAPTURE-2,**transport-level attempt 次數不可觀測**。

以上是 **recorded logical provider invocations**。Wave 1 / Wave 2 屬 CAPTURE-2,
**transport-level HTTP attempt 次數在那些 artifact 中不可觀測**(見第 7 節)。

全部只用 `planning` 與 `round1_worker`。四輪都沒有 synthesis / Gate / Round 2 /
Decision Synthesis / temperature probe / pilot。
離線 stub session 的 call **不計入** live history,任何時候都不得混算。

| set | 結論 | evidence commit |
|---|---|---|
| **R1** `fxr-01…04` | **四題全 FAIL F1** —— production Chief 把四題都判 `normal`。這四題重用了舊 synthetic fixture 的 task 文字,而那批 fixture 的 `deep` 是 loader 寫死的,從來沒有 planner 指派過 | `81ac330` |
| **R2** `fxr-05…08` | **F1 全過(`deep`)**;`fxr-05`/`fxr-07` 各只獲派一位 specialist 而 **FAIL F2**;`fxr-06`/`fxr-08` CAPTURED | `7af382d` |
| **R3** `fxr-09…11` | **F1/F2/F3 全過,capture 3/3 成功**;但三題在 pre-Gate screen 都是 substantive agreement → **F4 未取得** | `6aee7b0` |

`[FACT]` **`fxr-09` / `fxr-10` / `fxr-11` 在 F1/F2/F3 上是 3/3 PASS。**

`[INTERPRETATION]` **R3 這一輪**,F1/F2/F3 全過,該輪 observed acquisition bottleneck 是 **F4**。
這是對 R3 樣本的描述,**不表示未來的 candidate 不會再 FAIL F1/F2/F3**。
其後 P03 Wave 1 的 observed bottleneck 又回到 **F2** —— 見下一小節。
F1–F7 一律不變,F4 不放寬。

### P03 Wave 1 —— EXECUTED / PRESERVED NEGATIVE ACQUISITION EVIDENCE

`516d838` ｜ 授權 base `bb2214f` ｜ evidence root `experiments/m2b/fixtures-real-0-3/wave-1/`

```
S1  deep / 1 specialist / SUCCESS / F1 PASS / F2 FAIL / F3 PASS / FAILED   live calls = 2
E1  deep / 1 specialist / SUCCESS / F1 PASS / F2 FAIL / F3 PASS / FAILED   live calls = 2
I1  deep / 1 specialist / SUCCESS / F1 PASS / F2 FAIL / F3 PASS / FAILED   live calls = 2

Wave 1 live calls = 6      ceiling = 12
roundEndingViolation = null
runtime fingerprint drift = none
```

`[FACT]` 三題**全部**被判為 `deep`。
`[FACT]` 三題 Round 1 **RunStatus 全部 SUCCESS**,沒有任何 worker 失敗。
`[FACT]` 三題**各只被指派一位 specialist**,且三次都是 `business_strategist`。
`[FACT]` 因此三題**全部 FAIL F2**,對 A2 不具 eligibility。

`[INTERPRETATION]` **在已觀察到的 P03 Wave 1 樣本中,acquisition 的 active bottleneck 是 F2。**

以下都**未被證實,不得寫入任何報告**:

```
F2 永遠無法滿足
Chief 一定只會選一位 specialist
剩下的 candidate 也會 FAIL F2
Option 3′-H 導致 one-specialist planning
heterogeneous routing 失敗
```

**Option 3′-H 的精確措辭** —— role-based heterogeneous routing 在**結構上是啟用的**,
verifier 的 check 17/18 在三題上都把 snapshot / request / resolution 綁在一起:

```
Chief planning              openai / gpt-5
business_strategist worker  claude / claude-sonnet-5   （requested == resolved）
```

但 `market_researcher` 與 `brand_creative` 在 Wave 1 **獲得 0 次指派**,
所以 **Wave 1 並未提供 observed multi-provider worker collaboration**。
這是 production planner 的行為,**不是 engineering defect**。

**Wave 1 A2 狀態**(以 committed 的 `buildA2AcquisitionBatch()` 離線重算,0 provider call):

```
status  = NO_A2_BATCH
reason  = NO_F4_ELIGIBLE_CANDIDATES
admitted = []          rejected = S1, E1, I1（皆 F2 = false）
packet = null          provenance = null

negativeControlIncluded = false   → fxr-08 未送出
Gemini A2 calls = 0    F4 judgments = 0    filled archetypes = none
```

Wave 1 **從未到達 F4**。唯一的 eligibility 失敗是 **F2**。
不得據此宣稱 M2 無效、peer challenge 無效、heterogeneous provider 無效、
F4 失敗、Gemini 失敗、Claude 比較好,或 Chief routing 有缺陷。

### P03 Wave 2 —— EXECUTED / PRESERVED NEGATIVE ACQUISITION EVIDENCE

evidence commit `781ade9062b69f5aa120f59f1e80b3ba9b138493` ｜ 授權 base `b8479a9`
｜ evidence root `experiments/m2b/fixtures-real-0-3/wave-2/`

```
S2  normal / 2 specialists / SUCCESS / F1 FAIL / F2 PASS / F3 PASS / FAILED   live calls = 3
E2  normal / 2 specialists / SUCCESS / F1 FAIL / F2 PASS / F3 PASS / FAILED   live calls = 3
I2  deep   / 1 specialist  / SUCCESS / F1 PASS / F2 FAIL / F3 PASS / FAILED   live calls = 2

Wave 2 = 8 recorded logical provider invocations      ceiling = 12
roundEndingViolation = null ｜ runtime fingerprint drift = none

A2 admissions = 0 ｜ A2 calls = 0 ｜ filled archetypes = 0
```

`[FACT]` **Wave 1 與 Wave 2 的 acquisition failure mode 不同,不存在單一全域 blocker:**

```
Wave 1   三題 F1/F3 過、F2 全 FAIL
Wave 2   兩題 F1 FAIL（被判 normal）、一題 F2 FAIL
```

**不得**把「複雜度判定 ↔ specialist 數量」的這個形態寫成 correlation,
也**不得**寫成一個穩定的 Chief 機制。目前只有六題觀察,沒有對照設計。

#### Provider coverage

`[FACT]` S2 與 E2 各獲派兩位 specialist,實際執行為:

```
business_strategist  →  claude / claude-sonnet-5
brand_creative       →  openai / gpt-5
```

verifier 的 check 17/18 對全部五筆 worker call 綁定 snapshot / request / resolution。

`[FACT]` **因此 multi-provider Round1 worker execution 現在是 observed 的。**
這是 Option 3′-H 上線以來第一次有第二個 provider 真正跑 worker。

`[FACT]` `market_researcher` 在相關的歷史 acquisition 樣本中仍是 **0 次指派**,
gemini 至今未執行過任何 worker call。
**不得**把 retrieval-off 寫成造成這件事的原因 —— 那是未證實的因果宣稱。

#### 外部審查（本輪的兩份，強度不同）

`[SIGNAL]` **Gemini nine-candidate methodology review（P03 完成後)—— ACCEPT WITH CORRECTIONS。**
接受的方向:在**已觀察的 P03 task population** 與 production Chief 的
minimum-sufficient-collaboration 行為之下,`F1 = deep` 與 `F2 = ≥2 successful specialists`
之間存在 **sample-level tension**。措辭邊界見第 8 節 P03 closure 小節的允許/禁止清單。
model 同意不構成證據;該 session 對正式 A2 已汙染,永遠不得充當 A2。

`[SIGNAL]` **Gemini methodology review（Wave 2 當時)—— lower-tier external methodology review。**

```
結論                PASS WITH CORRECTIONS
new methodology blocker  none
Wave 3 methodology       READY
```

model 同意**不構成證據**。該 Gemini session 已因看過實驗結構而**對正式 A2 汙染,
永遠不得充當 A2**。

`[FACT]` **Codex independent audit —— 獨立確認 Wave 2 candidate / evidence 完整性。**
它發現四項:

```
journal 相等性 verifier 弱點            → CLOSED by CWP-4A @ 732d567
wave-order verifier 弱點                → CLOSED by CWP-4A @ 732d567
SDK transport retry accounting gap       → CLOSED FOR FUTURE CAPTURES by CWP-4B @ 9a6e715
runtime fingerprint 依賴涵蓋範圍限制      → 以獨立的 dependency provenance 處理（見第 7 節）
```

### P03 Wave 3 —— EXECUTED / 最後一輪 / PRESERVED NEGATIVE ACQUISITION EVIDENCE

evidence commit `730d35037db23c49a17ccf4b98e7c79fc6a9e35b` ｜ 授權 base `57f8586`
｜ evidence root `experiments/m2b/fixtures-real-0-3/wave-3/`

```
S3  normal / 1 specialist / SUCCESS / F1 FAIL / F2 FAIL / F3 PASS / FAILED   live calls = 2
E3  deep   / 1 specialist / SUCCESS / F1 PASS / F2 FAIL / F3 PASS / FAILED   live calls = 2
I3  deep   / 1 specialist / SUCCESS / F1 PASS / F2 FAIL / F3 PASS / FAILED   live calls = 2

Wave 3 = 6 logical calls = 6 HTTP attempts      ceiling = 12
roundEndingViolation = null ｜ runtime fingerprint drift = []
CAPTURE-3 首次 live 使用：transport（34/34b/34c）與 dependency（35/35b/35c/35d）全數 PASS
verifier 135/139，四項失敗全部是 eligibility gate（S3/10b、S3/12b、E3/12b、I3/12b）
```

**架構裁定:ACCEPT —— VALID NEGATIVE ACQUISITION RESULT。**
`[DECISION]` **eligibility failure 不得被重新解讀為 execution failure。**

---

### P03 —— COMPLETE / EXHAUSTED / CLOSED

```
attempted            9 / 9
F1-F3 admitted       0 / 9
A2 executions        0
formal F4 judgments  0
filled archetypes    0 / 3

F1 failures          3 / 9      F2 failures  7 / 9      F3 failures  0 / 9
恰好一位 specialist   7 / 9      兩位以上      2 / 9

role assignments     business_strategist 9/9 ｜ brand_creative 2/9 ｜ market_researcher 0/9

next P03 wave        NONE
tenth candidate      NONE
```

| | complexity | specialists | F1 | F2 | F3 |
|---|---|---|---|---|---|
| S1 / E1 / I1 | deep | 1 | PASS | FAIL | PASS |
| S2 / E2 | normal | 2 | FAIL | PASS | PASS |
| I2 | deep | 1 | PASS | FAIL | PASS |
| S3 | normal | 1 | FAIL | FAIL | PASS |
| E3 / I3 | deep | 1 | PASS | FAIL | PASS |

#### 允許與禁止的措辭（架構已裁定)

`[FACT]` **P03 之內,全部六題 `deep` candidate 都只獲派一位 specialist。**
`[FACT]` **兩題獲派兩位 specialist 的 candidate 都被判為 `normal`。**

`[SIGNAL]` 已觀察的 P03 樣本顯示,對 production Chief 而言
**task complexity classification 與 specialist necessity 是兩個不同的 planning 維度**。

`[INFERENCE]` P03 的 task population **可能沒有取樣到**那種自然同時滿足
`deep` + multi-specialist collaboration 的案例。

以下**全部未被確立,不得寫成事實**:

```
複雜度與 specialist 數量呈反相關      複雜度與 specialist 數量不相關
Chief 系統性地迴避 multi-specialist deep task
Chief 有設計缺陷                      F2 有缺陷
market_researcher 缺席是因為 retrieval 被關閉
provider mapping 造成了 role selection
M2-B 不可行                           peer challenge 無效
P03 證明了 production-wide 的協作行為
```

`[FACT]` `market_researcher` 在 R2 四題 + R3 三題 + P03 九題,**合計十六題中被指派 0 次**。
retrieval 釘在 all-off、task 又要求只根據題目事實判斷,消掉了該 role 的存在理由。

`[SIGNAL]` 這對 3′-H 的 observed coverage 有後果:R3 在同質配置下 gemini 確實跑過 Round 1
(扮演 strategist / creative);改成 3′-H 後 gemini 綁 `market_researcher`,
而該 role 在目前已觀察的十六題中一次都沒被指派。**gemini 的 worker coverage 可能是零,而那是合法的 observed result。**

`[SIGNAL]` 這只是對已觀察樣本的描述。**不得**升級成:`market_researcher` 永遠不會被選、
gemini 永遠拿不到 worker call、retrieval-off **必然**導致 zero `market_researcher` selection,
或 Option 3′-H 造成了這個 planner 行為。以上皆未被證實。

歷史細節見 `HANDOFF.md` 第 27–29 節,不在此重述。

---

## 9. Fixture state

### 已凍結、不得修改

```
experiments/m2b/fixtures/           R1 synthetic —— PRE-FLIGHT SYNTHETIC CANDIDATE MATERIAL，archival only
experiments/m2b/fixtures-real/      R1 capture（四次失敗，保存為證據）
experiments/m2b/fixtures-real-r2/   R2 capture，含 fxr-08
experiments/m2b/fixtures-real-r3/   R3 capture
experiments/m2b/fixtures-real-0-3/  P03 Wave 1 / 2 / 3 全部九題，0 admitted
                                    保存為 negative acquisition evidence —— READ-ONLY
diagnostics/m2a-live/               Replay #3 / #4
```

**`fxr-08`** —— provisional **negative control** candidate。不重跑、不修改。
未來與 positive candidates 一起交同一位 fresh A2,**A2 不得知道哪一題是負控**。

### Preregistered candidate pool（本階段的主體）

```
目錄        experiments/m2b/candidates-0-3/
freeze      ab893c14f19ab8d04fe44d64421a2123e7627efd
provenance  candidates-0-3/freeze-provenance.json   （兩段式，非自我雜湊）
manifest    candidates-0-3/candidate-set-manifest.json
liveCallsAtFreeze = 0
```

九題,三個 archetype 各三題,各自第三題為 reserve:

| id | archetype | 產業 |
|---|---|---|
| S1 / S2 / **S3** | Strategy Conflict | 專業影像後製軟體 / 手工調味醬料 / 連鎖物理治療 |
| E1 / E2 / **E3** | Execution Constraint | 獨立遊戲工作室 / 建築師事務所 / 生技檢測實驗室 |
| I1 / I2 / **I3** | Evidence Interpretation | 線上語言學習 / 訂閱制數位媒體 / 連鎖眼鏡零售 |

**Wave order（已凍結,不得重排）**

```
Wave 1   S1  E1  I1
Wave 2   只跑仍未填滿的 archetype：S2  E2  I2
Wave 3   只跑仍未填滿的 archetype：S3  E3  I3
```

**Task hashes 以 `candidate-set-manifest.json` 的 `taskSha256` 與 `freeze-provenance.json` 為權威來源,不在本檔重複抄錄。**
(補記:先前一份 completion report 的 S1 值有轉錄錯誤;凍結的 artifact 本身一直是正確的,未被修改。)

archetype 標籤是 experiment-internal,**絕不可出現在任何 clean-room packet 或 mission 裡**。

---

## 10. Current authorization

```
LIVE                    NONE
EXECUTION AUTHORIZATION NOT GRANTED

Wave 1                  CONSUMED / CLOSED   ← 已於 516d838 執行完畢，該授權不延續
Wave 2                  CONSUMED / CLOSED   ← 已於 781ade9 執行完畢，該授權不延續
Wave 3                  CONSUMED / CLOSED   ← 已於 730d350 執行完畢，P03 池已用盡
Census（新研究）          NOT AUTHORIZED（草案，未預先登記）
Gemini A2               NOT AUTHORIZED
Gate                    NOT AUTHORIZED
Synthesis               NOT AUTHORIZED
Round 2                 NOT AUTHORIZED
Decision Synthesis      NOT AUTHORIZED
Pilot                   NOT AUTHORIZED
temperature probe       NOT AUTHORIZED
main merge              NOT AUTHORIZED
src/** 修改             NOT AUTHORIZED（發現需要改 → STOP，回 GPT）
```

**Wave 1 / 2 / 3 的 live authorization 都已 CONSUMED。P03 已關閉,不存在可延續的授權。**
每一個新的 live boundary 需要一份新的、明寫 base SHA 的授權。

硬性 invariant,不得軟化:

```
NEXT STEP  ≠  EXECUTION AUTHORIZATION
READY      ≠  AUTHORIZATION
```

「next step」「ready」「architecture-ready」「execution-ready」「可以進入」
都**不構成** execution authorization。沒有明寫 `EXECUTION AUTHORIZATION: GRANTED`,
一律視為 `NOT GRANTED`。

---

## 11. Next exact step

```
P03 ACQUISITION           CLOSED —— 9/9 attempted, 0 admitted, 0 archetypes filled
NEXT P03 WAVE             NONE（池已用盡；不得新增第十題）

BLOCKING QUESTION         M-ACQ-01 —— natural eligibility base rate UNKNOWN

DRAFTED, NOT ACCEPTED     CBRP Natural Collaboration Census（七份文件）
                          experiments/m2b/census/
                          CBRP ｜ N=60 ｜ 6 strata x 10 ｜ theta_feas=5%
                          PRE-AUTHORING METHODOLOGY FREEZE COMPLETE
                          study 仍 NOT PREREGISTERED ｜ NOT AUTHORIZED
                          **這不是 task-content freeze —— 內容不存在**
                          0 tasks authored ｜ 0 reviews ｜ 0 duplicate audit rounds
                          0 pools frozen ｜ 0 seeds materialized
                          census harness NOT implemented

STATUS                    等待 GPT architecture interpretation
```

**沒有已定義的下一個 live 步驟。** P03 已用盡,而 M-ACQ-01 未解決之前
不得重新設計或執行 effectiveness experiment。以下保留原本的 acquisition 執行規則,
供未來任何新的 acquisition population 參考 —— **但目前沒有任何 wave 被授權**:

```
1. （歷史）acquisition wave = 三題一輪
   每題 exactly one attempt
   只允許 planning 與 round1_worker
   直接呼叫 runRound1Stage()，不得用 runOrchestrator()
   retrieval all-off；temperature provider-default-unprobed

2. 只有在出現 F1/F2/F3 全過的 candidate 時，才交 fresh clean-room Gemini A2 做正式 F4 annotation
   （零 eligible candidate → NO_A2_BATCH，負控 fxr-08 不得單獨送出）
   （A2 不得看到 intended archetype / Gate / arms / gold）

3. Stopping rule（protocol 0.3）：
   某 archetype 一旦填滿 → 後續 wave 不再執行該 archetype
   九題用盡仍不足三個 positive slot → STOP，回 GPT review
```

---

## 12. Active forbidden actions

```
不得新增第十題
不得修改已凍結的 task 文字
不得在看到輸出後 retry —— 每題 exactly one attempt，失敗就是永久失敗證據
不得用 Gate 觸發與否來挑 fixture
不得為了 specialist / provider coverage 選題或改題
不得放寬 F4
不得修改任何 historical artifact（R1 / R2 / R3 / synthetic / Replay #3 / #4）
不得修改 src/** 或 dist/**
不得 force-push、不得改寫已發布歷史
```

---

## 13. Current interpretation（措辭邊界)

`[FACT]` **`fxr-09` / `fxr-10` / `fxr-11` 在 F1/F2/F3 上是 3/3 PASS,F4 在這三題上未取得。**

`[FACT]` **P03 Wave 1 的 `S1` / `E1` / `I1`,F1 與 F3 全過,F2 三題全部 FAIL(各只有一位 specialist)。**

`[INTERPRETATION]` **observed bottleneck 是逐輪的,不是全域的:**

```
R3           F1/F2/F3 全過   → 該輪 observed acquisition bottleneck = F4
P03 Wave 1   F1/F3 全過、F2 三題全 FAIL → 該輪 observed acquisition bottleneck = F2
```

以下**皆未被確立**,不得寫入任何報告:

```
F2 已永久取代 F4 成為 active blocker
F4 已解決
F2 是普遍性的 blocker
Chief 無法產生 multi-specialist run
剩下的 candidate 也會 FAIL F2
```

未來的 candidate **仍可能 FAIL F1、F2、F3 或 F4 中的任何一項**。

`[FACT]` **R2 與 R3 中,五個「有兩位 specialist」的案例全部收斂**
(`fxr-06`、`fxr-08`、`fxr-09`、`fxr-10`、`fxr-11`)。

`[SIGNAL]` **那些題目都含有低成本的 hedge / 分階段選項。**

`[INFERENCE]` **free-hedge structure 是 plausible contributor,也是 pool 設計的動機。**
**不得寫成「已被證明會造成收斂」。** 這是 n=5 的觀察,沒有對照設計。

同樣不得宣稱:

```
provider diversity ≠ 自動比較好
role diversity     ≠ 已證明的 epistemic diversity
homogeneous allocation 已被證明是 R3 F4 failure 的原因   ← 未證實
pilot 回答了 effectiveness                              ← 不回答
```

pool 設計上做了什麼:九題的選項 C 一律帶有取自該題自身事實的具體代價
(不可分割的合約量體、單次且不保留的檔期、無法重現的量測條件),讓等待不再免費。
`[DESIGN]` 這是**針對假說的設計回應**,不是對假說的驗證。是否有效由 acquisition 的結果決定。

---

## 14. Evidence pointers

| 主張 | 去哪裡查 |
|---|---|
| production Round 1 邊界 | `src/modes/orchestrator.ts` `runRound1Stage()` @ `d01043b`(Wave 1/2/3 執行時的邊界);`experiments/m2b/test-round1-boundary.mjs` |
| production planning 邊界 | `src/modes/orchestrator.ts` `runPlanningStage()` @ `1e182f6`;`test-planning-stage.mjs`(32 項)|
| protocol 0.3 常數 | `experiments/m2b/protocol/amendment-0-3.mjs` @ `1354863` |
| protocol 0.3 敘述 + v0.2 全文 | `M2_EFFECTIVENESS_EXPERIMENT.md`「v0.3 Amendment」節 |
| F1–F7 定義 | `M2_EFFECTIVENESS_EXPERIMENT.md` §13.1 |
| Confound register X1–X18 | `M2_EFFECTIVENESS_EXPERIMENT.md` §19 |
| R1 capture 證據 | `experiments/m2b/fixtures-real/` @ `81ac330`;`HANDOFF.md` §27 |
| R2 capture 證據 | `experiments/m2b/fixtures-real-r2/` @ `7af382d`;`HANDOFF.md` §28 |
| R3 capture 證據 + pre-Gate screen | `experiments/m2b/fixtures-real-r3/` @ `6aee7b0`(含 `pre-gate-screen.json`、`evaluation.md`);`HANDOFF.md` §29 |
| candidate pool 凍結 | `experiments/m2b/candidates-0-3/` @ `ab893c1`;`HANDOFF.md` §31 |
| capture harness + verifier | `experiments/m2b/capture/` @ `c5a4a37`(後續擴充見 git log) |
| Option 3′-H routing 落地 | `experiments/m2b/capture/runner.mjs`、`recorder.mjs` @ `656f75c` |
| P03 wave gating / one-attempt | `experiments/m2b/capture/session.mjs`、`runner.mjs` @ `5d92a34` |
| A2 acquisition packet + validator | `experiments/m2b/harness/a2-acquisition.mjs` @ `5a2bb5e`,fatal/provenance 修正 @ `183b886` |
| request-side pin guard（P-1) | `experiments/m2b/capture/recorder.mjs` @ `a275d01`;測試見 `test-m2b-capture.mjs` T-P1-1…10 |
| Replay #4 三分法狀態 | `diagnostics/m2a-live/controlled-replay-4/`;`HANDOFF.md` rev.30 起每輪重述 |

### Replay #4 —— 固定用三分法陳述,不得只寫 VERIFIED

```
artifact seal ......................... INTACT
historical runtime fingerprint ........ MISMATCH — EXPECTED AFTER APPROVED d01043b REFACTOR
behavioral control recheck ............ PASS（16 組 → f50a7b2e…，無 drift）
```

不得建 allowlist,不得讓歷史 fingerprint 變成 PASS,不得重新封印。

### 離線測試現況

```
production            212
harness               110
synthetic fixtures     44
round1 boundary        15
capture               115   （含 P-1 的 11 項 request-side guard 測試）
protocol 0.3           29
candidate pool         27
A2 acquisition         76   （CWP-3 56 ＋ CWP-3R 20）
capture verifier      R1 174/180 ｜ R2 178/180 ｜ R3 149/149
synthetic integrity   36/36
```

合計 **628 passed, 0 failed**（核對於 `stateVerifiedThrough`）。
capture verifier 的失敗項與失敗 identity 自 R1/R2 凍結以來未變動。

R1 / R2 verifier 的失敗項**全部是 F1/F2 eligibility gate 本身**,不是完整性問題;
那是保存下來的失敗證據應有的樣子。

---

```
STATE ALIGNED THROUGH 730d350 /
P03 CLOSED — 9/9 ATTEMPTED, 0 ADMITTED, 0 ARCHETYPES FILLED /
F1 FAIL 3/9 ｜ F2 FAIL 7/9 ｜ F3 FAIL 0/9 ｜ ONE SPECIALIST 7/9 /
A2 = 0 EXECUTIONS ｜ EFFECTIVENESS EXPERIMENT NOT EXECUTED ｜ C vs D₁ UNANSWERED /
NEW OPEN BLOCKER M-ACQ-01 — NATURAL ELIGIBILITY BASE RATE UNKNOWN /
CBRP CENSUS METHODOLOGY REVISED — N=60 / 6 STRATA / theta=5% —
DRAFT, NOT PREREGISTERED, NOT AUTHORIZED, 0 TASKS AUTHORED /
LIVE = NONE / EXECUTION AUTHORIZATION: NOT GRANTED
```
