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
stateVerifiedThrough  730d35037db23c49a17ccf4b98e7c79fc6a9e35b
production            src/** 停在 d01043b（accepted pre-synthesis boundary）
main                  未 merge，且本階段不打算 merge
```

**production boundary 未移動。** `CWP-1` / `CWP-2` / `CWP-3` / `CWP-3R` / `P-1` 全部只動
`experiments/m2b/**` 的 acquisition / experiment tooling,**沒有任何一個進入 `src/**`**。
production Round 1 邊界仍然是 `d01043b` 的 `runRound1Stage()`。

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

處理方向的草案(**未接受、未預先登記、未授權**):
`experiments/m2b/census/CHIEF_NATURAL_COLLABORATION_CENSUS_DRAFT.md`

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

DRAFTED, NOT ACCEPTED     Chief Natural Collaboration Census
                          experiments/m2b/census/CHIEF_NATURAL_COLLABORATION_CENSUS_DRAFT.md
                          DRAFT ｜ NOT PREREGISTERED ｜ NOT AUTHORIZED

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
| production Round 1 邊界 | `src/modes/orchestrator.ts` `runRound1Stage()` @ `d01043b`;`experiments/m2b/test-round1-boundary.mjs` |
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
CENSUS DRAFTED, NOT ACCEPTED, NOT AUTHORIZED /
LIVE = NONE / EXECUTION AUTHORIZATION: NOT GRANTED
```
