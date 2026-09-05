# GEMINI M2-B REVIEW PACKET

> **這份 packet 是給 Gemini 做 Independent Research / Methodology Second Opinion 用的傳輸件。**
> 它把審查所需的全部原文集中在一個檔案裡,因為 Gemini 沒有 repository 存取權。

---

# PACKET SOURCE MANIFEST

```
packetVersion                        : GEMINI-M2B-PACKET-1
generatedAt                          : 2026-09-05T18:03:39Z
branch                               : experimental/m2a-peer-challenge
branch HEAD                          : 339d700201ee493f592b6a9a56b3e96248bd6f8d

HANDOFF revision                     : rev. 22
HANDOFF source commit                : 339d700201ee493f592b6a9a56b3e96248bd6f8d
HANDOFF SHA-256                      : f83caa5e6dada8de303b9901172a791a2702765521cf3c996dd3482781567523
HANDOFF size                         : 169363 bytes / 2674 lines

M2_EFFECTIVENESS_EXPERIMENT commit   : 734ad8e1e7f681c6e3d4548383a267ca624304a0
M2_EFFECTIVENESS_EXPERIMENT SHA-256  : 1f9cd428251b014384019833c1c2cc51e85d9946b281684da4c956298c2a10c7
M2_EFFECTIVENESS_EXPERIMENT size     : 90991 bytes / 1993 lines
```

**Generation-order preconditions(全部已驗證):**

```
[✓] M2_EFFECTIVENESS_EXPERIMENT.md 已 commit          734ad8e
[✓] HANDOFF.md 的 M2-B status indicator 已 commit      339d700
[✓] working tree 與兩份 source 逐位元組相同，無未提交漂移
[✓] 本 packet 的所有引用均取自上述 commit，未引用任何 uncommitted source
```

> ## This packet is a transport/review artifact.
> ## It is not a source of truth.
>
> 若本 packet 與 repository code / runtime evidence 衝突,**以 code / runtime 為準**。
> 若本 packet 與 `HANDOFF.md` 衝突,**以上述 commit 的 `HANDOFF.md` 原文為準**。
> Packet 的編排、Review Map 與 Known-Issue Register 由 editor 撰寫,
> **不是 source fact**,審查時請以其後的逐字原文為依據。

---

# REVIEW MAP(導航用,不取代原文)

> ⚠️ 本節只是索引。**任何審查判斷都必須回到 Part 2 的原文**,
> 不得以本節的一句話描述當作被審內容。

Gemini 最應集中火力的 M2-B 區域,依方法學重要性排序:

| 優先 | M2-B 章節 | 為什麼是重點 |
|---|---|---|
| ★★★ | **§4 Causal Identification** | 四臂差分是否真能分離 peer information |
| ★★★ | **§3.2 / §3.3 / §3.4 Matched Self-Review(arm D)** | D 是否真的 matched;D₁ vs D₀ 的選擇是否正當 |
| ★★★ | **§5 Arm Matching(尤其 §5.1 共用 gate 呼叫)** | 共用 gate 是否引入新的 confound |
| ★★★ | **§19 Bias / Confound Register(X1–X15)** | 有沒有漏掉的 confound |
| ★★ | **§3.1 Experimental Arms / §4.3 B′ 是否必要** | 四臂 vs 三臂 |
| ★★ | **§6 Frozen Round-1 / §13.3 未觸發不剔除** | selection bias 是否真被消除 |
| ★★ | **§7 Repetition / Variance** | n=1 問題的處理是否足夠;pilot 規模是否合理 |
| ★★ | **§10 Blind Evaluation / §20.3 order bias** | evaluator bias 控制是否足夠 |
| ★★ | **§13 Fixture Selection / §14 Negative Controls** | cherry-picking 防線是否有效 |
| ★★ | **§22 Claims Ladder** | 哪些結論仍然太強 |
| ★ | **§8 Model Pinning** | preview model 漂移的緩解是否足夠 |
| ★ | **§11 Quality Rubric / §12 Decision-Structure Metrics** | 維度是否可被穩定判斷;長度混淆控制 |
| ★ | **§16 Gate Precision / Trigger Metrics** | 能否在不調 prompt 的前提下量到 over-triggering |
| ★ | **§21 Stopping Rules** | 停止條件是否可操作 |

---

# KNOWN / ALREADY ACKNOWLEDGED

> 以下八項**已被記錄在 HANDOFF rev.21 / rev.22,並已在 M2-B 文件中處理或明確標為限制**。
>
> **Gemini 可以重新評估這些問題的嚴重度** —— 這是有價值的。
> 但**若只是把已知 concern 重述一次,不應算成新的 finding**,
> 請列在 `KNOWN ISSUE REASSESSMENTS`,不要列在 `NEWLY DISCOVERED ISSUES`。
>
> **若認為某項仍是 BLOCKER,必須具體指出 `M2_EFFECTIVENESS_EXPERIMENT.md` 的哪一節、
> 哪一段沒有充分處理它。** 只說「這仍是風險」不構成 blocker 論證。

| ID | 內容 | 目前 disposition | M2-B 中的處理位置 |
|---|---|---|---|
| **A1** | Gate eligibility 的 `strengthening` 使判準接近恆真 | **MONITOR**(不改 Gate) | §13.5 negative control;§16.2 independent conflict labelling |
| **A2** | `material` / `decision-sensitive` 由同一句定義而重疊 | **MONITOR** | §26.1 分類為 Specification Defect |
| **A3** | 限制語氣 `only` 在 eligibility 段落消失 | **MONITOR** | 同上 |
| **E1** | 模型隨機性使 n=1 vs n=1 無法 causal attribution | **REQUIRED BEFORE PILOT** | §5.1 共用 gate 呼叫;§7 repetition;§7.4 變異抑制 |
| **E2** | R2 model 未 pin,落到 adapter default | **REQUIRED BEFORE PILOT** | §8 全節(結論:protocol 修正,**不需改 code**) |
| **E3** | cross-provider peer interaction 零 live 證據 | **KNOWN LIMITATION**(Phase 1 只取覆蓋,不取泛化) | §15.3 Option 3′;§24 Non-Goals |
| **E4** | `noRound2Leak` 在 replay path 恆真,是弱代理 | **FUTURE HARNESS FIX**(舊 artifact 已 seal,不得回改) | §14 NC-2 取代方案;§24.1 |
| **E5** | chunk precision 未證明 universal optimal | **KNOWN LIMITATION**(chunker 凍結) | §16.3 frozen parameter + 免費訊號 |

---

# ⚠️ RESIDUAL-CONFOUND QUESTION(本輪最重要的方法學問題之一)

> **請務必正面回答這一題:**
>
> ## 假設依此 protocol 最後觀察到:
> ## `C > B` **AND** `C > D`
> ##
> ## 還有哪些合理的替代解釋,會阻止我們宣稱
> ## 「peer information 具有 incremental value」?

請具體到機制層級,而不是泛泛的「樣本不夠」。例如(僅為提示,不是清單上限):
挑戰文字的作者身分、挑戰的措辭品質、decision synthesis 對「外部意見」的偏好、
target 對「被別人挑戰」與「自我懷疑」的反應差異、prompt 長度、
以及任何 §19 Confound Register 沒有列到的東西。

---

# GEMINI OUTPUT DISCIPLINE(請嚴格依此格式輸出)

```
OVERALL:
  ACCEPT / ACCEPT WITH CONCERNS / REVISE / DEFER / REJECT

TOP FINDINGS:（最多 5 項）

  ID:
  Severity:          SIGNAL / CONCERN / BLOCKER
  Claim challenged:
  Packet evidence:   （引用本 packet 的哪一節／哪一段原文）
  Why it matters:
  Minimal correction:
  Blocks pilot:      YES / NO

KNOWN ISSUE REASSESSMENTS:
  （A1–A3 / E1–E5 的嚴重度重評。這裡不算新 finding。）

NEWLY DISCOVERED ISSUES:
  （只有 Known-Issue Register 沒涵蓋的才放這裡。）

最後必須明確回答五題：
  1. 是否存在 pilot blocker？
  2. 若有，最小修正是什麼？
  3. 修正後是否可進 small-N pilot？
  4. 若 pilot 得到 C > B && C > D，還剩哪些 residual confounds？
  5. 哪些 claims 即使 pilot 成功仍不能說？
```

**角色邊界(依 `AI_COLLAB_WORKFLOW_RULES.md` §3.3、§8):**

```
Gemini = Independent Research / Methodology Second Opinion
       ≠ Architecture Owner
       ≠ 工程實作者

不要修改原文件。
不要開始 implementation。
不要預設 Claude / GPT 的方案正確。
你的分析是 Second Opinion / Review Signal，不是 Source of Truth。
```

---

# PACKET IMMUTABILITY

```
本 packet 一經 commit，即視為該次 Gemini review 的 FROZEN INPUT。

Gemini review 完成後：不回頭修改同一份 packet。

若 source documents 後續改版：
  → 建立新的 packet version（GEMINI-M2B-PACKET-2 …）
  → 不覆寫舊的 reviewer input
```

理由與 `AI_COLLAB_WORKFLOW_RULES.md` §23 的 seal 規則相同:
覆寫舊的 reviewer input 會讓「Gemini 當時看到的是什麼」變成不可考,
之後就無法判斷它的 finding 是否已被後續版本回應。

---
---

# PART 1 — M2_EFFECTIVENESS_EXPERIMENT.md(逐字全文)

```
source commit : 734ad8e1e7f681c6e3d4548383a267ca624304a0
sha256        : 1f9cd428251b014384019833c1c2cc51e85d9946b281684da4c956298c2a10c7
```

> 以下為該檔案的**完整逐字內容**,未經摘要、未經改寫。

---

# M2-B EFFECTIVENESS EXPERIMENT DESIGN

> **本文件只設計實驗,不實作。** 未修改 `src/`、prompts、tests、runtime,未執行任何 live call,
> 未跑 B/C/D,未 merge main。完成後停止,交回 GPT Architecture Review。
>
> | | |
> |---|---|
> | Protocol version | `M2B-PROTOCOL-0.1 (DRAFT)` |
> | 撰寫依據 | `HANDOFF.md` rev.21 @ `16b6fb011d8678a6f74f015675fb056f95b19008` |
| 治理依據 | `AI_COLLAB_WORKFLOW_RULES.md`(rev.21 基準版) |
| 角色 | Claude — Experiment Design Mode(規則 §3.2) |
> | Runtime 依據 | `experimental/m2a-peer-challenge` @ `4e34d89`(rev.20 production code) |
> | 狀態 | **DESIGN ONLY / AWAITING ARCHITECTURE REVIEW** |

## 證據標記

| 標記 | 意義 |
|---|---|
| `[FACT]` | 可由 committed code / artifact / test 直接驗證。本文所有 `[FACT]` 我都實際查過原始碼或 artifact,不是引述 HANDOFF 的敘述。 |
| `[DESIGN]` | 本文提出的設計選擇。是主張,不是事實。 |
| `[SIGNAL]` | 來自 n=1 或極小樣本的觀察。**不足以支撐因果宣稱**,只用來標定風險方向。 |
| `[DECISION]` | 需要 Architecture Owner 拍板的項目,本文給出明確推薦。 |
| `[OPEN]` | 本文無法解決、需要更多資訊或 pilot 才能回答。 |

## ⚠️ 兩個命名衝突,先釐清

閱讀本文前必須注意,HANDOFF 裡有**兩組不同的 E1/E2**:

| 代號 | 出處 | 意義 |
|---|---|---|
| `§20-E1` | 第二十節 | 只有 Gemini 的 `grounded_retrieval` 是 `enabledInRuntime: true` |
| `§20-E2` | 第二十節 | `buildOutputBanner` 會洩漏 arm 身分 |
| `§25-E1` | 第二十五節 | 模型隨機性使 n=1 vs n=1 無法做 causal attribution |
| `§25-E2` | 第二十五節 | Round 2 model 未 pin |
| `§25-E3` | 第二十五節 | 三次 live call 全是 OpenAI,cross-provider 未驗 |
| `§25-E5` | 第二十五節 | chunk precision 未驗 |

本任務指令書用的是 `§25` 那一組。本文一律加前綴。

## ⚠️ 第二十節有一句已被推翻的話,不要跟著走

`[FACT]` 第二十節仍寫著:

> 「觸發率本身就是 kill criterion,而且它比品質更早、更便宜就能量測。先量觸發率,不要先量品質。」

**這句在 rev.15 已被明確推翻**(第十五節、第二十一節「Trigger rate 的正確定位」):
低觸發率同樣可以代表 gate 精準。第二十節那段文字沒有被回頭改掉,是歷史殘留。
本 protocol 依 rev.15 之後的立場設計 —— **trigger rate 是 diagnostic,不是判決**(見第 16 節)。

---

# 1. Research Question

## 1.1 已回答的問題

`[FACT]` M2-A 回答的是 **mechanism reachability**:

```
Does the mechanism run?  →  YES(Replay #4,一次完整 Gate → R2 → Decision Synthesis)
```

`[FACT]` 這**不**回答 quality improvement、causal value 或 product value。
rev.20 審查(第二十五節)明確記錄:`M2-A Effectiveness = NOT PROVEN`。

## 1.2 本輪要回答的問題

**Primary Question**

```
C(Targeted Peer Challenge)是否比 B(Existing Orchestrator)產生 material improvement?
```

**Causal Question(更重要)**

```
即使 C > B,提升是否來自「peer information」,
還是可以被「多一次 reasoning」與「gate 附錄本身」完全解釋?
```

`[DESIGN]` 本 protocol 認為 **Causal Question 才是真正的產品問題**。理由:
若 `C ≈ D`,那麼正確的產品決策不是「上 M2-A」,而是「上一個便宜得多的 self-review」。
把 Primary Question 單獨回答完就宣布勝利,會做出昂貴且錯誤的產品決策。

## 1.3 本輪明確不回答

```
should M2-A ship?
```

只回答:**what evidence would justify shipping?**(見第 22 節 Claims Ladder)

---

# 2. Current Evidence Boundary

## 2.1 已建立的事實

`[FACT]` 以下皆可由 committed artifact 重算(我在 rev.20 審查中已獨立重現):

| 事實 | 證據 |
|---|---|
| 完整 mechanism 在真實 provider call 下跑通一次 | `controlled-replay-4/artifact.json`,3 次 live call |
| Gate 收到新語義與 40 個確定性引用 | 我從 frozen snapshot 重建 gate prompt,byte-identical,`sha256 a64cd320…` |
| sourceRef 精確解析,無 fuzzy、無 head fallback | `resolveSourceRef` 是 `chunks.find(c => c.id === chunkId)` |
| R2 是 selective context,非 full broadcast | R2 prompt 2188 chars,只含 1 段 peer chunk;另 17 個 chunk 未進入 |
| disabled path 未漂移 | 16 組 control capture,rev.19/rev.20 兩邊 rebuild 後同一 `sha256 f50a7b2e…` |
| Evidence label 由結構隔離 | `buildRunReport` 只在 orchestrator 的 line 491 / 951 被呼叫,兩處都只吃 Round 1 |

## 2.2 尚未建立的事實 —— 本實驗要處理的缺口

| 缺口 | 目前狀態 |
|---|---|
| C 是否優於 B | **完全未知** |
| C 的提升是否超過 D | **完全未知** |
| gate 附錄本身的效果(B′ − B) | **完全未知,且已知是 confound** |
| Gate precision(提報的 issue 是否真的 decision-sensitive) | **完全未知** |
| chunk granularity 是否恰當(`§25-E5`) | **完全未知** |
| cross-provider peer interaction(`§25-E3`) | **完全未 live 驗證** |

## 2.3 三個已知會污染實驗的問題

**(1) 模型隨機性(`§25-E1`)** `[FACT]`

同一份 byte-identical frozen fixture:

```
Replay #3 provisional headline = B
Replay #4 provisional headline = C
```

我在審查時已從兩份 artifact 逐字確認。這代表**同一 stage 在同一輸入下會產出不同的 headline decision**。
因此 `n=1 vs n=1` 的任何 attribution 都不成立 —— 包含「rev.20 的 wording 修正造成了 #4 觸發」這個說法本身。

**(2) Gate 附錄 confound** `[FACT]`,已記於第二十一節

```
arm B:  synthesis prompt = P            → 答案
arm C:  synthesis prompt = P + 附錄     → provisional answer
```

即使 C 完全沒觸發 Round 2,它的答案也是在**不同 prompt** 下產生的。
所以 `C > B` 有可能完全不是 peer interaction 造成的。

**(3) 第二次 synthesis confound** `[FACT]`

`C_final` 來自 `decision_synthesis`,是**第二次** synthesis 級呼叫;
`C_provisional` 來自一次。兩者相減同時包含「peer 資訊」與「再合成一次」。
這正是 arm D 存在的理由。

---

# 3. Experimental Arms

## 3.1 四個 arm 的精確 stage 結構

`[DESIGN]` 所有 arm 共用**同一份 frozen Round 1 snapshot**,Planning 與 Workers **永不重跑**。

| Arm | 名稱 | Stage 結構 | Live calls |
|---|---|---|---|
| **B** | Existing Orchestrator | `synthesis` | 1 |
| **B′** | Gate Appendix, no Round 2 | `synthesis_gate` | 1 |
| **C** | Targeted Peer Challenge | `synthesis_gate` → `round2_worker` → `decision_synthesis` | 3 |
| **D** | Matched Self-Review | `synthesis_gate` → `self_review` → `decision_synthesis` | 3 |

`[FACT]` B、B′、C 三者**現在就能跑,不需要任何 src 變更**:

```ts
replaySynthesis(snapshot, { synthesizer, collaboration })
// B  : collaboration 不傳（omitted）        → stage 'synthesis'
// B′ : { enabled: true, disableRound2: true } → stage 'synthesis_gate'，記錄 selectedIssue 但不執行
// C  : { enabled: true }                      → 完整三段
```

`disableRound2` 走的是 `runCollaboration` 裡的專屬分支,回傳
`SKIPPED / round2_disabled`,並且**保留 `selectedIssue`** —— 這一點對 Gate precision 分析很重要(見第 16 節)。

`[DESIGN]` **D 需要新程式,但不需要碰 `src/`。** 見第 23 節。

## 3.2 Arm D 的設計 —— 本 protocol 最關鍵的決定

`[DECISION]` D 有兩種可能形狀,必須選一個:

| | D₀ — Generic Self-Review | **D₁ — Self-Targeted Challenge(推薦)** |
|---|---|---|
| 指令 | 「重讀你的答案,找出最弱的假設並視情況修正」 | 「找出對你自己論證**最強的一個反對意見**,然後回答它」 |
| 隔離的東西 | peer 資訊 **+ 針對性** 兩者一起 | **只隔離 peer 資訊的來源** |
| 與 C 的形狀匹配 | 較鬆 | 緊(同樣是「面對一個具體挑戰並回應」) |
| 風險 | targeting effect 會被誤算成 peer effect | 較貴一點的 prompt 設計工作 |

`[DESIGN]` **推薦 D₁ 為主要 D。**

理由:研究問題是「peer information 是否有 incremental value」。
若用 D₀,C 與 D 之間差了**兩件事**(資訊來自誰、以及有沒有具體標的)。
一旦 `C > D₀`,我們無法分辨那是「peer 的資訊有價值」還是「有一個具體標的就有價值」。
**D₁ 讓 C 與 D 只差一件事:那個具體挑戰是別人提的,還是自己提的。**

`[DESIGN]` D₀ 保留為 **Phase 2 的選配 arm**。它回答的是另一個合法但次要的產品問題:
「一個便宜的通用 self-review 是不是就夠了」。Phase 1 不跑。

## 3.3 D 必須匹配 C 的哪些欄位

`[DESIGN]` 硬性匹配清單:

```
same frozen Round1 snapshot        （逐位元組）
same target specialist agentId     （即 C 的 selectedIssue.targetAgentId）
same provider                       （targetWorker.provider）
same exact pinned model             （targetWorker.model，明確指定，見第 8 節）
same system prompt                  （targetWorker.role）
same call count                     （3）
same stage 順序                     （provisional → 中間輪 → decision synthesis）
same decision-synthesis 合成器       （同 provider + 同 pinned model）
```

**不匹配、且必須不匹配的唯一一件事:**

```
C 的中間輪收到  → 另一位 specialist 的 exact chunk + 該 specialist 提的 challenge
D 的中間輪收到  → 無任何 peer 資訊
```

## 3.4 ⚠️ D 的資訊洩漏防線

`[DESIGN]` 這是最容易做錯的地方。D 的中間輪 prompt **絕對不得**包含:

- peer 的 chunk 文字(明顯)
- peer 提的 challenge 文字(明顯)
- **挑戰的主題**(不明顯但同樣致命)—— 若我們把 C 選中的 issue 主題翻譯成
  「請重新檢視你關於產能瓶頸的假設」,那 D 就拿到了 peer 的**判斷**,只是換了措辭。

正確作法:D 的中間輪只知道 **original task、自己的 mission、自己的 Round 1 輸出**,
以及一條與 fixture 無關的通用指令。**由 D 自己決定要挑戰什麼。**

`[DESIGN]` 這會讓 D 有時挑到與 C 不同的主題 —— **那是對的,不是缺陷**。
若強迫 D 挑同一個主題,我們就把 peer 的貢獻(「指出該看哪裡」)偷偷送給了 D,
於是 `C ≈ D` 會是設計造成的,而不是量到的。

---

# 4. Causal Identification

## 4.1 分解式

`[DESIGN]` 四個 arm 提供一組乾淨的差分:

```
B′ − B   =  Gate 附錄效果
            （要求模型去找跨專家分歧，這件事本身如何改變答案）

D  − B′  =  額外 reasoning 效果
            （再想一次 + 第二次 synthesis，無 peer 資訊）

C  − D   =  ★ PEER INFORMATION 的 incremental value ★
            （唯一變動：挑戰來自另一位 specialist 而非自己）

C  − B′  =  整個第二輪的效果（peer + 額外 reasoning，合計）

C  − B   =  對「今天出貨的東西」的總產品增量 = (B′−B) + (C−B′)
```

`[DESIGN]` **`C − D` 是本實驗的主要估計量。** 其餘四項是解釋它所需的支撐。

## 4.2 為什麼不能只跑 B/C/D

`[FACT]` 若拿掉 B′:

```
C − B = Gate 附錄效果 + 額外 reasoning 效果 + peer 資訊效果
```

三項綁在一起。而第二十一節已經記錄附錄效果**可能為正也可能為負**
(更防禦性的措辭 / 注意力被分走 / 因重讀各專家輸出而更完整)。
沒有 B′,`C > B` 這個結果**在因果上是不可解釋的**。

`[FACT]` B′ 的成本是**一次 synthesis 呼叫** —— 與 B 相同,是四個 arm 裡最便宜的。

`[DESIGN]` **用最便宜的 arm 解決最大的 confound,是明確划算的。**
省掉 B′ 省下 1/8 的呼叫,卻讓主結果無法解釋。

## 4.3 Q1 的答案

`[DECISION]` **Q1: 第一階段跑 `B / B′ / C / D`(指令書第二十三節的 Option B)。**

- 否決 Option A(B′ 只做 diagnostic):附錄 confound 是**主要**識別障礙,不是診斷細節。
- 否決 Option C(B 做 secondary):B 是現況基準,產品問題就是「比今天出貨的好嗎」,
  它必須在主實驗裡。

---

# 5. Arm Matching

## 5.1 共享 Gate 呼叫 —— 消除 C vs D 的最大變異來源

`[DESIGN]` 這是本 protocol 的核心技巧。

`§25-E1` 證明 gate 呼叫本身會產出不同的 headline decision。
若 C 與 D 各自跑一次 gate,`C − D` 就包含了兩次 gate 抽樣的差異 —— 而那個差異
**已被證實大到足以翻轉 headline**(#3=B / #4=C)。

`[FACT]` `replaySynthesis` 接受 `options.call`(型別 `typeof callProvider`)。
因此 harness 可以注入一個 dispatcher:

```
stage === 'synthesis_gate'  →  回傳「本 repetition 已錄下的 gate 回應」，不發 API
其他 stage                   →  轉發給真實 callProvider
```

`[FACT]` 這正是 diagnostics 已在用的 pass-through recording dispatcher 模式。
**因此 C 與 D 共用同一次 gate 呼叫,不需要任何 `src/` 變更。**

效果:

```
C 與 D 的 provisional answer      逐位元組相同
C 與 D 的 selectedIssue           相同（D 不使用它，只記錄）
C − D 只剩下：中間輪 + decision synthesis 的差異
```

`[DESIGN]` 每個 repetition 跑一次真實 gate,B′ 也共用它 —— B′ 就是「這次 gate 的 provisional」。

於是每個 fixture-repetition 的實際 live call 數:

```
B    : 1  （獨立的 synthesis 呼叫，prompt 不同，不能共用）
gate : 1  （B′ / C / D 三者共用)
C    : 2  （round2_worker + decision_synthesis）
D    : 2  （self_review + decision_synthesis）
────────────────────────────
合計 : 6  （而非 naive 的 1+1+3+3 = 8）
```

`[DESIGN]` 這同時省了 25% 的成本**並且**提高了統計效力。兩者不衝突。

## 5.2 Decision Synthesis 的匹配

`[DESIGN]` C 與 D 的第三段必須用**結構等價**的 prompt。

`[FACT]` C 用的是 `buildDecisionSynthesisPrompt`,其 peer-specific 段落為:

```
A cross-specialist challenge was raised and answered in a second round:
- Challenged specialist: <targetAgentId>
- Challenge raised from: <sourceRef>
- The challenge: <challenge>
- <targetAgentId>'s revised answer after the challenge: <revisedOutput>
```

`[DESIGN]` D 的對應段落應為:

```
<targetAgentId> reconsidered its own answer in a second round:
- Reconsidering specialist: <targetAgentId>
- The objection it raised against itself: <selfObjection>
- <targetAgentId>'s revised answer after that reconsideration: <revisedOutput>
```

其後的 **Decision contract 五條必須逐字相同**,包括 neutrality guard
(`Revision, recency, or agreement between specialists is not evidence`)。
`[DESIGN]` 這條在 D 裡同樣需要 —— 否則 D 的合成器會比 C 更容易採納修正版,
`C − D` 就混進了合成器偏好的差異。

## 5.3 Q2 的答案

`[DECISION]` **Q2: D 透過三件事匹配 C 並避免 extra-reasoning confound:**

1. **共用同一次 gate 呼叫** → provisional 逐位元組相同,gate 抽樣變異歸零
2. **同 target / provider / pinned model / system prompt / call count / stage 形狀**
3. **D₁ 的中間輪同樣是「回應一個具體挑戰」**,只是挑戰由自己提出 → 只剩來源不同

殘留未匹配項(必須誠實記錄,見第 19 節):C 的挑戰由 gate(合成器模型)撰寫,
D 的挑戰由 target specialist 自己撰寫。兩者的**作者不同**。這是無法消除的,
因為「挑戰由別人提」正是被測變數本身。

---

# 6. Frozen Fixture Strategy

## 6.1 為什麼 frozen Round 1 是唯一乾淨作法

`[FACT]` 第二十一節已記錄:rev.15 提議用「同一次 C 執行中 SKIPPED 的那些當 B′」
**被 architecture review 以 selection bias 否決,而該理由是對的** ——
觸發與否不是隨機分派,而是與任務相關。

`[DESIGN]` frozen Round-1 replay 讓**每個 fixture 都接受全部四個 arm**,
arm 分派因此與任務完全無關。這從結構上消滅 selection bias,而不是事後統計調整。

## 6.2 Fixture 的組成

`[DESIGN]` 一個 Effectiveness Fixture 是一個凍結的 `Round1Snapshot` 加上評估用附件:

```
fixtures/<fixtureId>/
  task.txt                    原題（逐字）
  mission-<agentId>.txt        每位 specialist 的 mission
  round1-<agentId>.md          每位 specialist 的 Round 1 輸出（逐字）
  roster.json                  agentId / provider / pinned model / role / evidenceCapable
  snapshot.json                組裝好的 Round1Snapshot
  gold-issues.json             預先登記的 must-address 項目（見第 11 節）
  fixture.sha256               上述所有檔案的逐檔 hash
```

`[FACT]` `Round1Snapshot` 的既有型別是
`{ task, complexity, agentOrder, workers, workerResults }`,
`toRound1Snapshot()` 可從一次真實執行凍結出來。**這部分不需要新程式。**

## 6.3 Q3 的答案

`[DECISION]` **Q3: 用同一份 frozen Round 1,對四個 arm 做 within-fixture paired comparison。**

```
for each fixture:
  for each repetition r:
      gate_r        = 一次真實 synthesis_gate 呼叫
      B_r           = 一次真實 synthesis 呼叫（不同 prompt，無法共用）
      B′_r          = gate_r 的 provisional（零額外呼叫）
      C_r           = gate_r → round2_worker → decision_synthesis
      D_r           = gate_r → self_review   → decision_synthesis
```

所有比較都是 **paired within (fixture, repetition)**。
不做跨任務相減,不做跨 arm 的組間比較。

---

# 7. Repetition / Variance Strategy

## 7.1 為什麼不能先決定 N

`[DESIGN]` 誠實的答案:**在觀察到 within-arm 變異之前,無法知道需要多少 repetition。**
任何現在寫下的 N 都是捏造的。指令書第七節第 4 問要求回答「需要多少 repetitions」——
本文的回答是:**先用 pilot 量變異,再從觀察到的變異決定 N。**

## 7.2 Pilot 設計

`[DESIGN]`

```
fixtures      : 4   （3 positive + 1 negative control，見第 13 節）
repetitions   : 5   （每 fixture 每 arm）
live calls    : 4 fixtures × 5 reps × 6 calls = 120
```

`[SIGNAL]` 依 Replay #4 的單次觀察(gate 46.7s / R2 42.7s / decision 69.0s),
120 次呼叫的 wall time 量級約 1.5–3 小時,序列執行。**這是單次觀察外推的量級估計,不是預測。**

`[DESIGN]` 每 (fixture, repetition) 的 6 次呼叫來自第 5.1 節的共用設計:
`B` 1 次 + 共用 `gate` 1 次 + `C` 2 次 + `D` 2 次。

Pilot 的**交付物不是效果量**,而是四件事:

1. **within-arm variance** —— 同 fixture 同 arm 跑 5 次,headline 翻轉幾次?rubric 分數散布多大?
2. **judge reliability** —— 兩位 judge 的一致率;order bias 的大小
3. **leakage rate** —— 盲評稽核能否猜出 arm(見第 10.4 節)
4. **gate trigger rate** —— 5 次裡 gate 觸發幾次(這是 diagnostic,不是判決)

## 7.3 從 pilot 推正式 N

`[DESIGN]` 方向性規則,不做偽統計:

> 正式 N 應大到「within-arm 的散布明顯小於 between-arm 的差距」。
> 若在 pilot 的變異水準下,任何合理的 N 都無法讓兩者分離,
> **那本身就是結論**:此設計下的效果量小於雜訊,應報告「在此 N 下無可偵測差異」。

`[DESIGN]` **明令禁止**:不得計算 p-value、不得宣稱 significance、
不得在每格 n < 10 時報告任何統計檢定。報告形式為
**paired win / loss / tie 計數 + 完整分布**,不是平均值加星號。

## 7.4 沒有 seed 時的變異抑制

`[DESIGN]` provider 不提供可靠的 seed。可用的替代手段,依效力排序:

| 手段 | 消除的變異 | 成本 |
|---|---|---|
| **fixture 層配對**(所有 arm 共用同一 frozen Round 1) | 任務變異、Round 1 變異、Planning 變異 | 零(設計即得) |
| **共用 gate 呼叫**(第 5.1 節) | C vs D 之間的 gate 抽樣變異 | **負成本**(省呼叫) |
| **pin temperature** | 解碼抽樣變異 | 零(見下) |
| **時間上交錯執行 arm** | 服務端漂移 | 零(只是執行順序) |
| **同一 repetition index 跨 arm 對齊** | 讓漂移平均影響所有 arm | 零 |

`[FACT]` **temperature 是可設的,而且不需要改 `src/`:**
`CallOptions.temperature` 存在,三個 adapter(`openai.ts:25`、`claude.ts:21`、`gemini.ts:78`)
都會轉發它。orchestrator 本身**從不設定它**(我 grep 過整個 `src/`,只有 providers 出現),
所以目前所有呼叫都跑在 provider 預設值。
Harness 注入的 dispatcher 可以 `callProvider(provider, prompt, { ...options, temperature: 0 })`。

`[OPEN]` gpt-5 這類 reasoning model 是否接受 `temperature` 參數、以及設 0 是否真的降低變異,
**必須在 pilot 第一步實測確認**,不得假設。若被拒絕,記錄下來並改以「增加 repetition」補償。

## 7.5 執行順序

`[DESIGN]` **必須 round-robin,不得 arm-by-arm。**

```
✅ 正確：fixture1-rep1-{B, gate, C, D} → fixture1-rep2-{...} → fixture2-rep1-{...}
❌ 錯誤：所有 B 跑完 → 所有 C 跑完 → 所有 D 跑完
```

`[DESIGN]` 理由與第 8 節的 preview model 漂移同源:若 arm 之間隔了數小時或數天,
服務端模型更新會變成 arm 的系統性差異,而且**事後無法偵測**。
交錯執行讓漂移成為所有 arm 共同的雜訊,而不是某個 arm 的效果。

## 7.6 Q4 的答案

`[DECISION]` **Q4: 先跑 4 fixtures × 4 arms × 5 repetitions 的 pilot(120 live calls),
交付變異估計與 judge 信度;正式 N 由 pilot 觀察到的變異決定,現在不指定。**
`[DESIGN]` 若要一個規劃用的量級錨點:正式研究預期落在
**6–8 fixtures × 8–12 repetitions**,但這是**排程用的粗估,不是統計論證**,
必須被 pilot 結果覆寫。

---

# 8. Model Pinning

## 8.1 現況

`[FACT]` `§25-E2` 的根因我已查到,而且比 HANDOFF 記的更具體:

```ts
// src/modes/orchestrator.ts:833
{ model: targetWorker.model, system: targetWorker.role, stage: 'round2_worker' }
```

`Worker.model` 是 **optional**(`src/modes/orchestrator.ts:32`)。Replay #4 的 snapshot
兩位 worker 的 `model` 都是 `null`,所以落到 adapter 預設:

```ts
// src/providers/openai.ts:17
const model = options.model || PROVIDERS.openai.defaultModel;
```

`[FACT]` 而 `PROVIDERS.<p>.defaultModel` 本身又有兩層可變性(`src/config.ts:22-32`):

```ts
claude : process.env.CLAUDE_MODEL || 'claude-sonnet-5'
openai : process.env.OPENAI_MODEL || 'gpt-5'
gemini : process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview'
```

**所以模型可以從三個地方靜默漂移:`Worker.model` 未設、環境變數被改、程式碼預設被改。**

## 8.2 結論:pinning 不需要改 `src/`

`[FACT]` **這是一個 protocol 缺陷,不是 code 缺陷。** 修法是在 manifest 裡明確指定:

```
snapshot.workers[].model    ← 明確寫死，不留 null
ReplayOptions.synthesizer.model  ← 明確寫死
```

`[FACT]` 且驗證是現成的:adapter 回傳的 `result.model` 就是**實際使用的**模型
(`openai.ts:39-41` 回傳 `{ provider, model, text }`)。Replay #4 的 artifact 正是靠這個
記下 `responseModel: gpt-5`。因此 harness 可以直接斷言:

```
assert(result.model === manifest.pin[stage].model)   ← 每一次呼叫都驗
```

## 8.3 必須 pin 的五個位置

`[DESIGN]`

| Stage | Arm | 來源欄位 |
|---|---|---|
| `synthesis` | B | `ReplayOptions.synthesizer.model` |
| `synthesis_gate` | B′ / C / D(共用) | `ReplayOptions.synthesizer.model` |
| `round2_worker` | C | `snapshot.workers[target].model` |
| `self_review` | D | 同上(必須是**同一個值**) |
| `decision_synthesis` | C / D | `ReplayOptions.synthesizer.model` |

`[DESIGN]` **B 與 gate 必須用同一個 synthesizer model** —— 否則 `B′ − B` 混進模型差異。

## 8.4 Preview model 的無解部分

`[FACT]` `gemini-3.1-pro-preview` 是 preview 通道。**preview 的模型 ID 不等於模型版本** ——
服務端可以在不改 ID 的情況下換掉後面的 snapshot。

`[DESIGN]` 因此誠實的處置是分成「能 pin 的」與「只能記錄的」:

| 能 pin | 只能記錄 |
|---|---|
| provider | 服務端實際 snapshot 版本(通常不可得) |
| model ID | 每次呼叫的 UTC timestamp |
| temperature(若支援) | provider 回傳的任何 version metadata |

`[DESIGN]` 緩解措施只有兩個,都不是技術性的:

1. **交錯執行**(第 7.5 節)—— 讓漂移平均落在所有 arm 上
2. **時間窗紀律** —— 同一 fixture 的所有 arm 必須在**同一個連續執行區段**內完成。
   `[DESIGN]` 建議硬性規則:**同一 (fixture, repetition) 的 6 次呼叫若跨越超過 2 小時,
   該 repetition 作廢重跑**,並記錄作廢事實(不是靜默丟棄)。

`[OPEN]` 是否應在 Phase 1 避開 preview model?若 fixture 需要 Gemini target,
就一定會用到 preview 通道。本文傾向**接受並記錄**,而非為了 pinning 純度排除 Gemini ——
排除它會讓 `§25-E3`(cross-provider)永遠無法驗。留給 Architecture Review 拍板。

## 8.5 Manifest 中的 model 欄位是否需要 hash

`[DECISION]` **需要,但 hash 的對象是整份 manifest,不是模型字串本身。**

`[DESIGN]` 對單一模型字串做 hash 沒有意義(它就是明文)。有意義的是:

```
manifest.sha256  = SHA256(canonical JSON of the whole manifest)
```

並讓每個 run artifact 記錄它所依據的 `manifestSha256`。
這樣「某次 run 用的是哪一組 pin」變成可重算的事實,而不是敘述。
`[DESIGN]` 沿用 Replay #4 已證明有效的作法:artifact 記 hash,`verify.mjs` 重算比對。

## 8.6 Q5 的答案

`[DECISION]` **Q5:**
1. **model identity 寫入 frozen experiment manifest** —— 是,五個位置全部明寫,不留 `null`
2. **hash** —— hash 整份 manifest,不是單獨 hash 模型字串
3. **provider/model/version fingerprint** —— provider + model ID 可 pin 並**逐呼叫斷言**
   (`result.model === pin`);version 不可得,改以 timestamp + 交錯執行 + 2 小時時間窗紀律緩解
4. **preview model 更新** —— 無法從 client 端解決。接受、記錄、用時間窗紀律限制暴露;
   若 pilot 期間偵測到同一 fixture 的答案分布發生階梯式變化,視為 model drift 並觸發
   stopping rule(第 21 節)

**本項不需要任何 `src/` 變更。**

---

# 9. Evidence Parity

## 9.1 全部 arm 共用 frozen Round 1 即已凍結證據

`[DESIGN]` 由於四個 arm 共用同一份 `Round1Snapshot`,以下全部自動凍結且逐位元組相同:

```
retrieval status      （凍結在 workerResults[].retrieval 裡）
sources               （同上）
evidence label        （由 buildRunReport 從凍結的 Round 1 重算）
worker outputs        （snapshot 的一部分）
banner                （buildOutputBanner(report) 是純函式）
```

`[FACT]` 我在 rev.20 審查中已驗證這條鏈:`buildRunReport` 只在
`orchestrator.ts:491`(production)與 `:951`(replay)被呼叫,兩處都只吃 Round 1;
`summarizeRetrieval` / `deriveEvidenceLabel` 只能從 `buildRunReport` 內部到達。
**Round 2 / self-review 的輸出在結構上碰不到 evidence label。**

## 9.2 Evidence Parity 規則(硬性)

`[DESIGN]`

```
EP-1  四個 arm 使用逐位元組相同的 Round1Snapshot。
EP-2  所有 arm 的所有 stage：retrieval 全關。
      C 的 round2_worker 本來就不掛 retrieval（既有設計，故意的）；
      D 的 self_review 必須同樣不掛。
EP-3  任何 arm 都不得取得 fixture 之外的資訊。
      gold-issues.json 絕不進入任何 runtime prompt（見第 11.4 節）。
EP-4  evidenceLabel 與 banner 在四個 arm 必須完全相同；
      不同即為 protocol 缺陷，該 repetition 作廢。
EP-5  Phase 1 不研究 retrieval 的效果。retrieval 是被凍結的常數，不是變數。
```

## 9.3 為什麼 Phase 1 必須全關 retrieval

`[FACT]` `§20-E1`:只有 `gemini-3.1-pro-preview` 的 `grounded_retrieval` 是
`enabledInRuntime: true`(`src/models/capabilities.ts`)。

`[DESIGN]` 因此若開啟 retrieval,「有檢索」就等於「是 Gemini」,
provider 與 evidence 兩個變因**完全共線**,無法分離。
全關 retrieval 是目前唯一能做到 evidence parity 的作法。

`[DESIGN]` 代價要講清楚:**Phase 1 因此不能對「有外部證據時 peer challenge 是否更有價值」
說任何話。** 這是刻意接受的範圍限制,寫進 Non-Goals(第 24 節)。

---

# 10. Blind Evaluation

## 10.1 Normalization —— 只移除 runtime metadata

`[FACT]` `§20-E2` 已指出 banner 會洩漏 arm。
`[FACT]` 且第二十一節已記錄並測試:`finalOutput = banner + text`,
`buildOutputBanner` 是純函式,`finalOutput.slice(banner.length)` **可精確還原無標籤答案**。

`[DESIGN]` **允許移除**(全部是 runtime metadata,不是內容):

```
evidence banner        （由 buildOutputBanner 產生的前綴，逐字切除，不改動後續文字）
collaboration metadata （本來就在獨立欄位，不在 finalOutput 裡）
arm 名稱 / provider / model 名稱
runtime timing / call count / token count
檔名、路徑、run id
```

`[DESIGN]` **明令禁止**(這些會改變被評估的內容):

```
❌ 改寫答案            ❌ 縮短答案
❌ 修正文法            ❌ 移除 caveat / 不確定性敘述
❌ 統一格式或標題      ❌ 「正規化」推理
❌ 截斷到相同字數
```

`[DESIGN]` 分界線的判準:**移除的東西是否由 runtime 產生而非由模型寫出?**
banner 是 runtime 產生的 → 可移。答案裡「我無法驗證這個數字」是模型寫的 → **不可移**。

## 10.2 Normalization 必須是 deterministic 且可重算

`[DESIGN]` normalization 是純函式,輸入 raw artifact,輸出 normalized answer,
兩者都 commit,`verify.mjs` 能重跑並比對 hash。
**任何需要人為判斷的「清理」都不允許進入這一層。**

## 10.3 ⚠️ 一個 stripping 解決不了的洩漏

`[SIGNAL]` 我在 Replay #4 的 artifact 上做了實測掃描,結果與直覺相反:

| 文本 | 含 arm 辨識語句(挑戰/專家/第二輪/另一位…) |
|---|---|
| arm C 的 **final answer**(decision synthesis 產出) | **0 處** |
| arm B′ 的 **provisional**(gate 產出) | **2 處**(「驗證品牌方的核心主張」「一旦數據證實品牌方主張」) |

`[SIGNAL]` 也就是說:**洩漏風險不是單向的,而且不在我們預期的那一邊。**
gate 的 provisional 反而更常提到「品牌方」「營運方」這類角色詞。

`[DESIGN]` 這類洩漏**在答案內容裡**,依第 10.1 節不得編輯。
因此正確處置是**量測它,而不是修掉它**:

> **Leakage Audit(第 10.4 節)**:一位與 judge 分離的稽核者,
> 只看 normalized answer,被問「這份答案出自哪個實驗條件?」
> 若辨識率顯著高於機率水準,那是**要報告的 protocol 發現**,不是要改寫答案的理由。

## 10.4 Blind Evaluation 協定

`[DESIGN]`

```
角色分離：
  Judge        只看兩份 normalized answer，輸出偏好與 rubric 分數
  Leakage Auditor  只看單份 normalized answer，猜測 arm（與 judge 不同的 session/模型）
  兩者不得共享上下文

Judge 不得知道：
  arm 名稱 / provider / model / run order / repetition index
  另一份答案的來源
  gold issues 以外的任何 fixture 後設資訊
```

## 10.5 Pairwise 還是 Absolute?

`[DECISION]` **兩者都要,但角色不同。**

| | Pairwise(主) | Absolute rubric(輔) |
|---|---|---|
| 優點 | 對「好」的絕對標準不敏感;LLM judge 在相對判斷上遠比絕對打分穩定 | 可跨 fixture 聚合;可看出**哪個維度**改善 |
| 缺點 | 不可跨 pair 聚合成「好多少」;易受 order/verbosity bias | 分數校準會漂;易製造假精度 |

`[DESIGN]` **主要結論用 pairwise**;absolute rubric 只用來回答
「若 C 贏了,它贏在哪個維度」。**absolute 分數不得單獨用來宣稱 C > B。**

`[DESIGN]` 需要的 pairwise 比較(每個 fixture-repetition):

```
必要： B  vs B′     → 附錄效果
       B′ vs C      → 整個第二輪效果
       C  vs D      → ★ peer information ★
選配： B  vs C      → 總產品增量（可由前兩項推得方向，但直接比更可信）
```

`[DESIGN]` Phase 1 跑**三組必要比較**。`B vs C` 列為選配,
因為它的方向已被前兩組決定,而它會讓 judge 成本增加 33%。

## 10.6 Q6 的答案

`[DECISION]` **Q6: judge 只收到兩份經 deterministic normalization 的答案本文
(banner 與 runtime metadata 已切除、內容一字未改),標示為 Answer X / Answer Y,
順序隨機化,不知 arm、provider、model、run order。
另設獨立的 Leakage Auditor 量測盲化是否實際成立。**

---

# 11. Quality Rubric

## 11.1 為什麼不用指令書列的十個維度

`[DESIGN]` 指令書第十三節列了 10 個候選維度,並要求我不要照單全收。分析如下:

| 候選維度 | 判定 | 理由 |
|---|---|---|
| Decision correctness | ❌ 剔除 | 商業策略題**沒有 ground truth**。judge 只會投射自己的偏好 |
| Critical assumption handling | ✅ **保留** | 可對照 fixture 明列的條件客觀判斷 |
| Contradiction handling | ✅ **保留** | 這是 M2-A 的**核心宣稱**,必須直接測 |
| Risk identification | ❌ 併入 | 與 assumption / contradiction 高度重疊,拆開只會製造相關分數 |
| Use of provided evidence | ✅ **併入 unsupported-claim control** | 「用了給定事實」與「沒有捏造」是同一枚硬幣兩面 |
| Decision sensitivity | ✅ 併入 assumption handling | 「哪個假設錯了會改變決策」本來就是 assumption handling 的核心 |
| Actionability | ✅ **保留**(改造) | 但必須改成**可檢核承諾**,否則會退化成「寫得多」 |
| Internal consistency | ❌ 剔除 | 實測罕見違反;近乎全體滿分的維度不提供鑑別力 |
| Calibration / uncertainty | ❌ 剔除 | judge 無法穩定判斷校準;需要結果資料才談得上校準 |
| Unsupported claim control | ✅ **保留** | 可對照 fixture 事實客觀判斷,且是 LLM 輸出的已知失效模式 |

## 11.2 推薦的 rubric —— 四維 + 一個客觀層

`[DECISION]` **Phase 1 rubric:**

**Layer 0 — Gold Issue Coverage(客觀,非評分)**

```
對每個 fixture 預先登記的 must-address issue，binary 判定：
  addressed / not addressed / addressed-but-wrong
```

`[DESIGN]` 這是**最客觀的一層**,不涉及品味。它直接回答
「peer challenge 是否讓答案處理了它本來會漏掉的東西」。

**Layer 1 — 四個評分維度**(pairwise:X better / Y better / tie)

```
R1  Contradiction handling
    是否辨識並實質處理 Round 1 之間會改變決策的分歧，
    而不是用一句合併語掩蓋？

R2  Critical assumption & falsifier quality
    是否指出哪個假設一旦錯誤會改變決策，
    並說明那要如何被偵測？

R3  Unsupported-claim control
    是否有超出 fixture 所給事實的斷言被當成已知？
    （越少越好；此維度方向與其他三項相反，判分時須明示）

R4  Checkable commitment quality
    決策附帶的條件／門檻／kill switch，
    是否具備可被檢核的觸發條件，而不只是措辭？
```

**Layer 2 — 全局偏好**

```
整體而言，哪一份是更好的決策文件？（X / Y / tie）
```

`[DESIGN]` 四維 + 一個全局,合計五個判斷。
**拒絕 10–15 維**:那會製造假精度,且維度間高度相關,加總只是把同一個判斷數了五次。

## 11.3 R4 為什麼要寫成「可檢核承諾」

`[DESIGN]` 這是本 rubric 最重要的設計細節。

若 R4 寫成「actionability」,judge 會獎勵**更多條目**,而 C/D 天然更長(第 20 節)。
改寫成「**可檢核**承諾」後,一條承諾只有在**具備可判定的觸發條件**時才計入:

```
✅ 計入：「毛利連續兩月低於 45% 即自動縮容」   （有門檻、有動作、可判定）
❌ 不計入：「需密切監控毛利表現」               （無門檻、不可判定）
```

`[SIGNAL]` Replay #4 的 arm-C 最終答案含
「毛利跌破 45% 連兩月即自動縮容」「零共享瓶頸:禁止動用核心導演/剪輯/PM」等條目 ——
這類敘述可被此判準客觀計數。**這把「變長」轉成「變得更可檢核」,而後者不能靠灌水取得。**

## 11.4 Gold Issues 的隔離

`[DECISION]` **採用 Gold Issues,但必須嚴格隔離。**

`[DESIGN]` 隔離規則:

```
GI-1  gold-issues.json 在**任何 arm 執行之前**寫定並 hash。
GI-2  它**絕不**進入任何 runtime prompt。Gate 看不到、R2 看不到、
      self-review 看不到、decision synthesis 看不到。
GI-3  它由「只讀 Round 1 輸出與原題」的人／模型撰寫，
      撰寫者**不得**看過任何 arm 的答案。
GI-4  撰寫完成後 commit + hash；事後新增 gold issue 一律無效。
GI-5  gold issues 只交給 evaluator，不交給 runtime harness。
      建議在檔案系統層分離：fixtures/ 進 runtime，
      gold-issues 另放 evaluation/ 並由不同的載入路徑讀取。
```

`[DESIGN]` GI-5 不只是紀律,是**結構性**防護:若 gold issues 與 snapshot 放在同一個
被 runtime 載入的目錄,總有一天會有人把整個目錄塞進 prompt。

## 11.5 Q7 的答案

`[DECISION]` **Q7: 最少需要「四個評分維度 + 一個全局偏好 + 一層客觀的 Gold Issue Coverage」。**
四維為 contradiction handling、critical assumption & falsifier、unsupported-claim control、
checkable commitment quality。剔除 decision correctness(無 ground truth)、
calibration(judge 不可靠)、internal consistency(無鑑別力),
其餘併入以避免相關維度重複計分。

---

# 12. Decision-Structure Metrics

## 12.1 為什麼不能只問「答案變了嗎」

`[FACT]` 我在 rev.20 審查中確認:Replay #4 的

```
provisional headline = C
final       headline = C     ← 沒有翻轉
```

改變的是**條件結構** —— final 新增了「封閉艙驗證 → 90 天後轉 B」的門檻,
並吸收了 target specialist 從無條件 B 退到條件 B/否則 C 的修正。

`[DESIGN]` 因此 `did the answer change?` 是錯的 success metric ——
它會把這次觀察判成「無效果」,而實際上輸出的可執行性有實質差異。

## 12.2 兩層 outcome

`[DESIGN]`

**Level 1 — Headline Decision**

```
從 normalized answer 抽出 headline choice（A / B / C ...）
抽取方式：先以 deterministic 規則嘗試（找「結論」「建議」「選」等錨點），
          再由 judge 以單一封閉問題確認。兩者不一致時記為 ambiguous，不強行歸類。

指標：  flip rate（相對於同 repetition 的 B′ provisional）
        cross-arm agreement（四個 arm 是否同意）
```

`[DESIGN]` Level 1 **不是**品質指標。翻轉不等於變好,不翻轉不等於無效果。
它的用途是:**若某個 arm 頻繁翻轉 headline,那是不穩定性的警訊,不是價值的證據。**

**Level 2 — Decision Structure**

```
可檢核承諾盤點（每項需有可判定的觸發條件才計入）：
  conditions        條件式決策
  thresholds        數值／狀態門檻
  falsifiers        「什麼結果會推翻這個決定」
  kill switches     停止／回退條件
  experiments       90 天內的驗證動作
  uncertainty qualification   明確標示為假設而非已知的敘述
```

## 12.3 如何避免「變長」被誤認成「變好」

`[DESIGN]` 三道防線,**都不動答案本身**:

1. **計數判準本身抗灌水** —— 見 11.3,無觸發條件的敘述不計入
2. **同時報告長度** —— 每個 arm 的字元數與可檢核承諾數**並列呈現**,
   並額外報告 **density = 可檢核承諾 / 千字元**。
   `[DESIGN]` 若 C 的承諾數上升但 density 不變,那就是變長,不是變好。
   **這個判別必須寫進報告模板,不能留給讀者自己算。**
3. **長度條件化結果** —— 額外報告「在 C 不比對手長的那些配對中,C 是否仍勝出」

`[SIGNAL]` Replay #4 的長度數據:provisional 2757 字元 → final 3383 字元,**+22.7%**。
這與「C/D 天然更長」的預期一致,是需要控制的真實效應,不是理論顧慮。

## 12.4 Q8 的答案

`[DECISION]` **Q8: 分兩層量 —— Level 1 headline flip(穩定性診斷,非品質指標)、
Level 2 可檢核承諾盤點(品質指標)。以「必須具備可判定觸發條件」的計數判準、
density 並列報告、以及長度條件化的子分析,三者共同阻止「更長」被讀成「更好」。**

---

# 13. Fixture Selection

## 13.1 準入條件

`[DESIGN]` 一個 fixture 必須全部滿足:

```
F1  complexity = deep                    （gate 資格條件，不可協商）
F2  Round 1 成功的 specialist ≥ 2        （同上）
F3  RunStatus = SUCCESS                  （DEGRADED 被 gate 排除，且會混入失敗變異）
F4  Round 1 文本中存在可辨識的跨專家、會影響決策的分歧
F5  fixture 自身提供足夠資訊，讓評估者能判斷答案好壞
F6  不依賴即時網路資料（因為 EP-2 全關 retrieval）
F7  核心決策不依賴大量 deterministic arithmetic（見第 17 節）
```

## 13.2 F4 的判定必須在 gate 之前、且與 gate 無關

`[DECISION]` **這是避免 cherry-picking 的關鍵設計。**

`[DESIGN]` **F4 由「只讀 Round 1 文本」的人／模型判定,
絕不以「gate 有沒有觸發」作為納入條件。**

理由:以 gate 觸發與否選 fixture,等於**在 gate 的輸出上做條件化**。
而 gate 輸出是隨機的(`§25-E1`)。這會系統性地只留下「gate 剛好表現好」的樣本,
是 rev.16 已否決的 selection bias 換了個包裝重新出現。

## 13.3 ⚠️ 硬性規則:不得因 C 未觸發而剔除 fixture

`[DESIGN]`

> **一個通過 F1–F7 的 fixture,若在 k 次 repetition 中 gate 從未觸發,
> 它不會被剔除。它成為 Gate Recall 的負面證據,照常出現在報告裡。**

`[DESIGN]` 此時該 fixture 的 C 退化成 B′(答案即 provisional),
這在分析上完全可用:`C = B′` 就是「peer 機制在此題無貢獻」的觀察值,
而不是缺失資料。**把它丟掉才會製造偏誤。**

## 13.3.1 Q9 的答案

`[DECISION]` **Q9: 用三層結構性防護避免 trigger selection bias ——**

1. **arm 分派與任務完全無關** —— 每個 fixture 都接受全部四個 arm(第 6.3 節)。
   不存在「觸發的任務進 C 組、沒觸發的進 B 組」這種分組,因為根本沒有分組。
2. **納入條件不看 gate** —— F4 由只讀 Round 1 文本的標註者判定(第 13.2 節),
   絕不以 gate 是否觸發作為 fixture 準入條件。
3. **未觸發不剔除** —— gate 未觸發時 `C = B′`,這是有效觀察值而非缺失資料(第 13.3 節)。

`[FACT]` 這三層合起來,結構性地避開了 rev.16 被 architecture review 否決的
「SKIPPED vs COMPLETED」作法。差別在於:那個作法是**事後**用 gate 的輸出分組,
本設計是**事前**讓每個任務都跑完所有 arm ——
**分組偏誤不是被統計調整掉的,是被設計消除的。**

## 13.4 Minimum Viable Fixture Set

`[DECISION]` Phase 1 pilot 用 **3 個 fixture**,涵蓋三種 conflict archetype:

| # | Archetype | 分歧的本質 | 備註 |
|---|---|---|---|
| 1 | **Strategy conflict** | 兩位專家對**該做什麼**給出不同建議 | 可直接沿用 Replay #3/#4 的 frozen fixture |
| 2 | **Execution constraint conflict** | 同意方向,但對**做不做得到**判斷相反 | 產能／人力／時程類 |
| 3 | **Evidence interpretation conflict** | 看同一組事實,得出相反推論 | 測「peer 能否指出對方誤讀」 |

`[DESIGN]` **暫不建立完整 taxonomy。** 指令書要求 minimum viable set,
上表即是。第四類(risk conflict)`[DESIGN]` 判定為與 #2 高度重疊,Phase 1 不單列。

`[DESIGN]` **Fixture #1 建議直接重用 Replay #3/#4 的 frozen fixture**,理由:
它已被 hash 封存、已知能通過 F1–F6、且已有 #3(gate 未提報)與 #4(gate 提報)
兩種行為的歷史紀錄 —— **這本身就是 gate 隨機性的既有證據**,對變異估計有價值。

## 13.5 Negative Controls

`[DECISION]` **需要,且必須在 Phase 1 就有。**

`[DESIGN]` 加入 **1 個 negative-control fixture**:通過 F1、F2、F3、F5、F6,
但 **Round 1 之間沒有 material 分歧**(兩位專家實質同意,只在措辭與強調上不同)。

預期:gate 應該 **SKIP**。
- 若 gate 在 negative control 上頻繁提報 → 這是 `§25-A1`(`strengthening` 過寬)的**直接證據**
- 若 gate 正確 SKIP → 支持目前 eligibility 語義的精準度

`[DESIGN]` 這是**唯一**能在不調 prompt 的前提下,取得 gate over-triggering 證據的設計。
沒有 negative control,`§25-A1` 永遠只能停在理論顧慮。

`[DESIGN]` 因此 pilot 的 fixture 總數是 **3 positive + 1 negative = 4**。

## 13.6 Q11 的答案

`[DECISION]` **Q11: 用四道防線避免 cherry-picking ——
(1) fixture 集合在任何 arm 執行前凍結並 hash;
(2) F4 由只讀 Round 1 的人判定,絕不用 gate 觸發與否當納入條件;
(3) 硬性規則:C 未觸發的 fixture 不得剔除,退化成 B′ 照常入報告;
(4) 納入 negative control,讓「M2-A 應該輸」的情況也在樣本裡。**

---

# 14. Negative Controls

`[DESIGN]` 除 13.5 的 negative-control fixture 外,protocol 還需要三個 sanity control:

| Control | 內容 | 預期 | 失敗的意義 |
|---|---|---|---|
| **NC-1 Disabled parity** | 每次 pilot 執行前跑一次既有的 16 組 control capture | `sha256 f50a7b2e…` | runtime 漂移,實驗全部作廢 |
| **NC-2 Snapshot 不變** | 每個 repetition 後重算 snapshot hash | 與 manifest 相同 | harness 汙染了 frozen 輸入 |
| **NC-3 Self-review 洩漏檢查** | 掃描 D 的 self_review prompt | 不含 peer chunk / challenge / sourceRef | D 被汙染成 C,`C − D` 歸零且無法察覺 |

`[DESIGN]` **NC-3 是自動化的、逐次執行的斷言,不是人工審閱。**
它保護的是本實驗最核心的識別假設,不能靠自律。
建議實作成 harness 的硬性 assert:D 的 prompt 必須不包含 peer chunk 文字的任何
連續 20 字元子字串,也不包含 challenge 文字的任何連續 20 字元子字串。

---

# 15. Cross-Provider Coverage

## 15.1 現況

`[FACT]` `§25-E3`:Replay #4 的三次 live call 全是 `openai / gpt-5`。
target 恰好是 `brand_creative`(openai),而 `business_strategist`(claude)的 R2 路徑
**從未執行過**。cross-provider peer interaction 目前是**零 live 證據**。

## 15.2 三個選項的分析

`[DESIGN]`

| | Option 1(不要求覆蓋) | Option 2(強制 Claude/Gemini target) | Option 3(分成兩個研究) |
|---|---|---|---|
| 因果乾淨度 | 高 | **低** —— provider 變成第二個變因 | 高 |
| 泛化證據 | 無 | 有,但與效果混淆 | 有,且分離 |
| 成本 | 低 | 中 | 高(兩輪) |
| 風險 | `§25-E3` 永遠不解 | 無法分辨「peer 有用」與「跨模型有用」 | Phase 2 可能永遠不做 |

`[DESIGN]` **三個都不理想。** Option 2 的問題最嚴重:若 fixture A 用 Claude target、
fixture B 用 OpenAI target,而 C 在 A 上贏得多 —— 那是 peer 效果還是 Claude 比較會回應挑戰?
在 fixture 數只有 3–4 時,provider 與 fixture 完全共線,**無法分離**。

## 15.3 推薦:Option 3′

`[DECISION]` **推薦 Option 3 的修正版,本文稱 Option 3′:**

```
Phase 1 = within-provider causal study，但刻意取得 cross-provider R2 覆蓋

  ★ 共用基礎設施固定：synthesis / gate / decision_synthesis
    在所有 arm、所有 fixture 一律 pin 同一個 provider + model

  ★ target specialist 隨 fixture 而異：
    fixture #1 → OpenAI target
    fixture #2 → Claude target
    fixture #3 → Gemini target
    （negative control 不限）

  ★ 關鍵：在同一個 fixture 內，C 與 D 使用完全相同的 target model
    → provider 在「C − D」這個主要估計量裡被完全消去
```

`[DESIGN]` 為什麼這比三個原選項都好:

1. **主估計量乾淨** —— `C − D` 是 within-fixture 配對,provider 在配對內是常數,
   因此 provider **不進入** peer-information 的估計
2. **同時取得 cross-provider 的 live 覆蓋** —— 三個 provider 都真的跑過 `round2_worker`,
   `§25-E3` 從「零證據」變成「已 live 執行」
3. **不宣稱泛化** —— 每個 provider 只有 1 個 fixture,**不足以宣稱跨 provider 泛化**,
   只能宣稱「機制在三個 provider 上都能執行」。這個界線必須寫進 claims ladder(Level 4)

`[DESIGN]` 不接受「產品有三模型所以每題都要三模型」。
Minimum Sufficient Collaboration 仍有效:每個 fixture 的 N 由該 fixture 的
frozen Round 1 決定,不為了展示而膨脹。

## 15.4 Q14 的答案

`[DECISION]` **Q14: Phase 1 做 within-provider 因果研究,
但用「固定合成器 + fixture 間輪換 target provider」取得 cross-provider 的 R2 live 覆蓋。
真正的 cross-provider generalization study 留到 Phase 2,
且只有在 Phase 1 已顯示 `C > D` 之後才值得做** —— 若 peer information 本身沒有增量價值,
研究它在哪些 provider 組合下泛化是沒有意義的。

---

# 16. Gate Precision / Trigger Metrics

## 16.1 五個必須分開的指標

`[DECISION]` 指令書第二十節要求正式定義。本文的定義:

| 指標 | 定義 | 資料來源 | 是不是判決? |
|---|---|---|---|
| **Trigger frequency** | gate 提報合格 issue 的 repetition 比例 | `collaboration.status === 'COMPLETED'` | ❌ **診斷** |
| **Gate precision** | 提報的 issue 中,被獨立盲評判定為「確實 material、cross-agent、decision-sensitive」的比例 | 提報的 issue vs 獨立 conflict labelling | ⚠️ 品質訊號 |
| **Gate recall** | 獨立盲評認定存在 material 分歧的 repetition 中,gate 提報的比例 | 同上 | ⚠️ 品質訊號 |
| **Triggered usefulness** | 在有觸發的 repetition 中,R2 回應帶入 provisional 所無之實質資訊的比例 | 盲評判斷 | ✅ 品質訊號 |
| **Incremental quality** | `C − D` 的 pairwise 勝率 | 主評估 | ✅ **主結果** |
| **Incremental cost** | C 相對 B 的額外 logical call 數與 wall time | 第 17 節遙測 | ✅ 產品決策輸入 |

`[DESIGN]` **Trigger frequency 明確不是產品價值指標。**
低觸發率可以代表 gate 精準(只在真有分歧時啟動);高觸發率可以代表過度觸發。
**必須搭配 precision 才有意義,單看是誤導。**

## 16.2 如何從 effectiveness artifact 取得 Gate precision —— 不做 prompt tuning

`[DECISION]` 這是指令書第十九節的核心要求:觀察 over-triggering,但**現在不改 Gate**。

`[DESIGN]` 設計:**Independent Conflict Labelling**,在任何 arm 執行前完成。

```
步驟 1（arm 執行前，一次性）
  標註者只看：original task + 每位 specialist 的 Round 1 輸出
  不看：任何 arm 的答案、任何 gate 輸出、gold issues
  回答：
    (a) 這裡是否存在 material、cross-agent、decision-sensitive 的分歧？(是/否)
    (b) 若是，用一句話描述該分歧
    (c) 若是，指出它主要出現在哪些 passage id
  → 寫入 conflict-labels.json，commit + hash
  → 此後不得修改

步驟 2（arm 執行後，離線比對）
  對每個有觸發的 repetition：
    gate 提報的 issue 是否對應到步驟 1 標註的分歧？
      對應      → true positive
      不對應    → false positive（over-trigger 證據）
    步驟 1 說「有分歧」但 gate 未提報 → false negative（recall 缺口）
    negative control fixture 上的任何提報 → false positive（強證據）
```

`[DESIGN]` 關鍵在**步驟 1 必須早於步驟 2 且不可見任何 gate 輸出**。
否則標註會被 gate 的判斷帶著走,precision 會被高估。

`[DESIGN]` 額外免費訊號:**B′ 的 `selectedIssue` 也會被記錄**
(`disableRound2` 分支保留 `selectedIssue`,我已在 code 中確認)。
因此每個 repetition 都有 gate 的判斷紀錄,即使 R2 沒跑。

## 16.3 chunk precision(`§25-E5`)

`[DECISION]` **Phase 1 不測 chunker,把它當 frozen parameter。**

`[DESIGN]` 同意指令書第十八節的偏好。理由:chunk granularity 是一個獨立變因,
把它加進來會讓 `C − D` 的解釋多一個維度,而 fixture 數只有 3–4。

`[DESIGN]` 凍結方式(不是「忽略」,是「記錄成常數」):

```
manifest 記錄：
  chunkerVersion       = src/agents/collaboration.ts 的檔案 sha256
  chunkSeparator       = "\\r?\\n[ \\t]*\\r?\\n"（原始碼中的常數，逐字記錄）
  peerExcerptChars     = 明確設定的值（不留預設）
  每個 fixture 的 chunkMap 與 chunk 總數
```

`[DESIGN]` **免費的 chunk precision 訊號:** 步驟 1 的標註已含「分歧主要出現在哪些 passage id」。
把它與 gate 實際選的 `sourceRef` 比對,就得到
「gate 是否選到最相關的 chunk」的**觀察資料**,不需要額外實驗、不需要改 chunker。

`[SIGNAL]` Replay #4 的既有觀察:gate 選了 `business_strategist:p5`(結論段),
而更貼近 challenge 的論證在 p7/p8。這在上述設計下會被自動記成一次
「resolvable but not tightest」。累積幾次之後,`§25-E5` 才會有實質資料。

## 16.4 Q13 的答案

`[DECISION]` **Q13: 用「執行前凍結的 Independent Conflict Labelling」+「negative control fixture」
從既有 effectiveness artifact 離線算出 gate precision / recall,
不需要額外的 prompt tuning 輪次,也不需要現在修改 Gate。**

---

# 17. Cost / Latency Minimum Telemetry

## 17.1 Phase 1 需要記什麼

`[DECISION]` **Phase 1 的最小成本記帳就是:logical call count、wall time、provider、model。**
不因為缺 Step 8 就停止實驗,也不捏造美元金額。

`[DESIGN]` 每次呼叫必記:

```
seq / stage / provider / requestedModel / resolvedModel
promptChars / responseChars
startedAt (UTC ISO) / ms
retrievalRequested / retrievalResult   （EP-2 下應恆為 null，記錄用於稽核）
```

每個 repetition 必記:

```
armCallCounts   { B: 1, gate: 1, C: 2, D: 2 }
armWallTimeMs   每個 arm 的端到端時間（含共用 gate 的分攤說明）
```

`[DESIGN]` **`promptChars` / `responseChars` 不是 token,不得被當成 token 使用。**
它們的用途只有兩個:長度分析(第 20 節)與異常偵測。

## 17.2 明確不做

`[DESIGN]`

```
❌ token 計數        （Step 8 尚未實作，沒有可信來源）
❌ 美元成本          （沒有 pricing registry；捏造金額會汙染產品決策）
❌ p50 / p95 / 平均   （單次 replay 觀察不構成分布，rev.21 已明確禁止）
❌ SLA 推導
```

`[DESIGN]` **可以說的**:「C 相對 B 多 2 次 logical call」——
這是**結構事實**,由 stage 序列決定,不需要統計。

## 17.3 Wall time 怎麼報告

`[DESIGN]` 只報告**觀察到的分布本身**(全部原始值列出),不報告摘要統計量。
在 pilot 的 n=5/cell 下,列出五個數字比列一個平均值誠實得多。

`[SIGNAL]` 已知的單次量級(Replay #4):gate 46.7s、R2 42.7s、decision 69.0s、
total 158.4s。**這是一筆觀察,不是預期值。**

## 17.4 Step 8 之後

`[DESIGN]` Step 8 實作後追加:token in/out、pricing、currency cost、
以及「每次品質提升的邊際成本」。**在那之前,claims ladder 的 Level 5 無法達成**
(見第 22 節)—— 這是刻意的:沒有成本資料就不該做 productionization 決策。

---

# 18. Artifact & Hash Protocol

## 18.1 目錄結構(spec,本輪不建立)

`[DESIGN]`

```
experiments/m2b/
  PROTOCOL.md                     本文件的凍結版本 + protocolVersion
  fixtures/
    <fixtureId>/
      task.txt  mission-*.txt  round1-*.md  roster.json  snapshot.json
  evaluation/                     ← 與 runtime 分離的載入路徑（GI-5）
    <fixtureId>/
      gold-issues.json
      conflict-labels.json
  manifests/
    <experimentId>.json           凍結的 arm / model / temperature / fixture 清單
  raw-calls/
    <experimentId>/<fixtureId>/rep<N>/<arm>/calls.json
  normalized-answers/
    <experimentId>/<fixtureId>/rep<N>/<arm>.txt
  blind-evaluation/
    <experimentId>/pairs.json         去識別化的配對（judge 的輸入）
    <experimentId>/assignments.json   pairId → (arm, order) 的對照表（judge 看不到）
  evaluation-results/
    <experimentId>/judgements.json
    <experimentId>/leakage-audit.json
  hashes.json
  verify.mjs
```

## 18.2 核心要求

`[DESIGN]` 沿用 Replay #4 已證明有效的作法(我在 rev.20 審查中獨立重現過它,確認可行):

```
A1  每個 artifact claim 都必須能由 committed raw data 重算。
    verify.mjs 必須用 production function 重推，而不是比對自報欄位。
A2  hashes.json 以 wx 旗標寫入，不可覆寫。
A3  normalized-answers 必須能由 raw-calls 以 deterministic 函式重生成。
A4  blind-evaluation/assignments.json 在 judge 完成前不得被讀取；
    verify.mjs 應驗證 pairs.json 不含任何 arm 標記。
A5  runtime fingerprint（src/ + dist/ + package-lock 的逐檔 sha256）
    在每個 experimentId 的開始與結束各記一次，兩者必須相同。
```

`[DESIGN]` A1 是最重要的一條。Replay #4 的 `verify.mjs` 做到了
(它用 `parseGateOutput` / `validateIssues` / `selectIssue` / `buildRunReport` 重推),
本 protocol 必須維持同一標準。

## 18.3 Experiment Manifest 必要欄位

`[DECISION]` 指令書第二十七節要求定義哪些是必要的。本文判定:

**必要(缺一則該 run 無效):**

```
experimentId              protocolVersion
fixtureId                 fixtureSha256          snapshotSha256
arm                       runIndex               startedAt (UTC)
pin.synthesis   { provider, model }
pin.gate        { provider, model }
pin.round2      { provider, model }          （D 為 self_review，同一組值）
pin.decision    { provider, model }
temperature（或明確記為 unsupported）
retrievalPolicy = "all-off"
evidenceLabelBaseline     （由 frozen Round 1 重算的值）
runtimeCommit             promptSourceCommit
chunkerVersion            peerExcerptChars
manifestSha256
```

**選配(有用但缺了不致命):**

```
nodeVersion   hostTimezone   operatorNote   env 快照（CLAUDE_MODEL / OPENAI_MODEL / GEMINI_MODEL）
```

`[DESIGN]` `env 快照`列為選配是因為有明確 pin 之後 env 已被繞過;
但**記下來很便宜**,而且能在事後解釋「為什麼那天的預設不一樣」。建議記。

`[DESIGN]` `promptSourceCommit` 與 `runtimeCommit` **必須分開**。
Replay #4 就是這樣:runtime 是 `267ecff`,而 artifact 提交在 `4e34d89`。
混成一個欄位會讓「哪個 commit 產生了這個答案」無法回答。

---

# 19. Bias / Confound Register

`[DESIGN]` 所有已知威脅集中列管。**未列入此表的威脅視為未被考慮過**,
新發現者必須追加,不得靜默處理。

| ID | 威脅 | 嚴重度 | 處置 | 殘留風險 |
|---|---|---|---|---|
| **X1** | Gate 附錄 confound(`C − B` 含附錄效果) | 高 | 加入 arm B′ | 無 |
| **X2** | 第二次 synthesis confound(`C` 多一次合成) | 高 | 加入 arm D,stage 形狀匹配 | 合成器 prompt 仍有微小結構差異(5.2 節已逐字對齊 contract) |
| **X3** | 模型隨機性(`§25-E1`) | 高 | 多 repetition + 共用 gate + pin temperature | temperature 可能不被支援(7.4 節 `[OPEN]`) |
| **X4** | Trigger selection bias | 高 | 所有 arm 共用 frozen Round 1;未觸發不剔除 | 無 |
| **X5** | Fixture cherry-picking | 高 | 執行前凍結 + F4 與 gate 無關 + negative control | fixture 數少,archetype 覆蓋有限 |
| **X6** | Judge verbosity bias | 中高 | 可檢核承諾判準 + density + 長度條件化子分析 | 無法完全消除 |
| **X7** | Judge order bias | 中高 | pilot 全 counterbalance;正式研究隨機 + 20% 重複稽核 | 見 20.3 |
| **X8** | Judge model-family affinity | 中 | 兩個不同家族的 judge;主 judge 與合成器不同家族 | judge 池本身有限 |
| **X9** | Arm leakage(答案內容自曝) | 中 | Leakage Audit 量測(不得編輯內容) | **已 `[SIGNAL]` 觀察到,無法根除** |
| **X10** | Model drift / preview 通道 | 中 | 交錯執行 + 2 小時時間窗 + 逐呼叫 `resolvedModel` 斷言 | 服務端版本不可得 |
| **X11** | D 被 peer 資訊汙染 | **極高** | NC-3 自動斷言(20 字元子字串檢查) | 主題層級的間接洩漏難以自動偵測 |
| **X12** | Gold issue 洩漏進 runtime | 高 | GI-1..GI-5,檔案系統層分離 | 需人為紀律維持 |
| **X13** | Arithmetic 變異淹沒 peer 效果 | 中高 | F7 排除算術重的 fixture(第 17 節下方) | 見 X13 說明 |
| **X14** | Provider 與 fixture 共線 | 中 | Option 3′:合成器固定,provider 只在 target 輪換,且 C/D 配對內為常數 | 不足以宣稱泛化(已寫入 claims ladder) |
| **X15** | 評估者疲勞 / 前後不一致 | 低中 | 每個 judge session 的配對數設上限;重複稽核偵測漂移 | — |

`[DESIGN]` **X11 是本實驗最致命的威脅。** 若 D 拿到了 peer 的判斷,
`C − D` 會趨近於零,而報告會說「peer information 沒有價值」——
一個**由設計缺陷造成的、方向確定的錯誤結論**。
NC-3 的自動斷言不可省略,且應在每次 D 執行**之前**跑,失敗即中止該 repetition。

---

# 20. Pilot Design

## 20.1 規格

`[DESIGN]`

```
fixtures        : 3 positive + 1 negative control = 4
repetitions     : 5
arms            : B / B′ / C / D
live calls      : 4 fixtures × 5 reps × 6 calls = 120
judge 配對      : 4 × 5 × 3 必要比較 = 60 pairs
                  pilot 全 counterbalance → 120 judge 判斷 × 2 judges = 240
```

`[SIGNAL]` wall time 量級估計(由 Replay #4 單次觀察外推,**不是預測**):
120 次 provider 呼叫 ≈ 1.5–3 小時序列執行。

## 20.2 Pilot 的交付物

`[DESIGN]` **Pilot 不回答 effectiveness 問題。** 它交付五樣東西:

1. **within-arm 變異估計** —— 決定正式 N 的唯一依據
2. **judge 信度** —— 兩位 judge 的一致率;若一致率低,先修 judge protocol,不看 arm 結果
3. **order bias 大小** —— 全 counterbalance 下,同一配對兩種順序的翻轉率
4. **leakage rate** —— Leakage Auditor 的辨識率是否高於機率
5. **protocol 缺陷清單** —— 任何在執行中發現的設計問題

`[DESIGN]` **紀律要求:pilot 的 arm 比較結果在前四項通過之前不得被解讀。**
若 judge 一致率低,arm 差異就沒有意義 —— 先修工具,不要先看答案。

## 20.3 Order bias 的最小可接受作法

`[DECISION]` 指令書第三十一節要求不要不必要地讓成本翻倍。本文的分層作法:

```
Pilot        ：全 counterbalance（每對判兩次，順序互換）
               → 這是唯一能量到 order bias 大小的方法，而 pilot 規模小，負擔得起

正式研究     ：隨機順序 + 20% 配對重複稽核（順序互換）
               → 成本增加 20% 而非 100%
               → 若稽核顯示 order bias 明顯，該批結果降級為「需全 counterbalance 重評」
```

`[DESIGN]` 直接在正式研究就只做隨機化是不夠的:隨機化讓 order bias 變成雜訊,
但**無法告訴你雜訊有多大**。pilot 的 counterbalance 就是為了得到那個數字。

## 20.4 Q10 的答案

`[DECISION]` **Q10: 最小 bias 控制組合 ——
(a) verbosity:可檢核承諾判準 + density 並列 + 長度條件化子分析,不截斷不改寫;
(b) order:pilot 全 counterbalance 取得 bias 估計,正式研究隨機 + 20% 稽核;
(c) model-family:兩個不同家族的 judge,主 judge 與 decision synthesizer 不同家族,
    只在兩者一致時計入強結論,不一致計為 tie 並單獨報告不一致率;
(d) provider identity:normalization 移除所有 provider/model 標記,並由 Leakage Audit 驗證盲化成立。**

---

# 21. Stopping Rules

`[DESIGN]` 全部為 qualitative / directional。**不設偽統計門檻,不寫「至少提升 20%」這類數字。**

## 21.1 Pilot Stopping —— 立即中止並修正 protocol

```
S1  Protocol defect      NC-1/NC-2/NC-3 任一失敗
S2  Evaluator unreliable judge 一致率不足以支撐比較（先修 judge，不解讀 arm）
S3  Arm leakage          Leakage Auditor 辨識率明顯高於機率
S4  Model drift          任一呼叫的 resolvedModel ≠ pin，或答案分布出現階梯式變化
S5  Cost runaway         實際呼叫數超出 manifest 預期的合理範圍
S6  Fixture 不合格       執行後才發現 fixture 違反 F1–F7
```

`[DESIGN]` S1–S6 觸發時,**該批資料作廢並記錄作廢事實**,不得挑選可用的部分保留。

## 21.2 Product Stopping —— 停止 M2-A 這條路

```
P1  C 在多數配對上無法勝過 B′
    → peer 機制在此設計下沒有可觀察的產品增量

P2  C 的提升可被 D 完全解釋（C ≈ D）
    → ★ 最重要的一條 ★
    → 正確結論不是「M2-A 沒用」，而是「應該做便宜得多的 self-review，
       而不是多模型 peer challenge」
    → 這會改變產品方向，不只是砍掉一個 feature

P3  Gate precision 過低且 negative control 頻繁誤觸發
    → 支持 §25-A1（strengthening 過寬），觸發 Gate semantics 的重新設計
    → 注意：這是「修 Gate」的理由，不是「砍 M2-A」的理由

P4  在合理 N 下無可偵測差異
    → 誠實結論：效果量小於此設計的解析度
    → 不得改寫成「M2-A 有效但需要更多樣本」
```

## 21.3 允許的結論

`[DESIGN]` 明確聲明:**「在此 N 下無可偵測差異」是一個合法且完整的結果。**
它不是實驗失敗,不需要補樣本直到出現差異。
`[DESIGN]` 反覆加樣本直到看見想要的差異,是本 protocol 明令禁止的行為。

## 21.4 Q15 的答案

`[DECISION]` **Q15: Phase 1 的 pass 條件是「C 在配對比較中同時勝過 B′ 與 D,
且差距明顯大於 pilot 觀察到的 within-arm 散布」;
fail 條件是 P1–P4;stop 條件是 S1–S6。全部為方向性判準,不含捏造的統計門檻。**

---

# 22. Claims Ladder

`[DECISION]` 每一層明確規定**該層證據允許說什麼、不允許說什麼**。

| Level | 內容 | 狀態 | 允許宣稱 | **不允許宣稱** |
|---|---|---|---|---|
| **L0** | Mechanism runs | ✅ **已達成**(Replay #4) | 「完整機制在真實 provider call 下跑通一次」 | 任何品質相關的話 |
| **L1** | Triggered outputs differ | 未達成 | 「C 的輸出與 B/B′ 不同」 | 「不同 = 更好」 |
| **L2** | `C > B′` on matched fixtures | 未達成 | 「第二輪整體帶來可觀察的改善」 | 「改善來自 peer」(還沒排除 D) |
| **L3** | `C > D` | 未達成 | 「peer information 具有超過 extra reasoning 的增量價值」 | 「多模型優於單模型」(D 也是同一模型) |
| **L3.5** | `C > D` 且 Gate precision 可接受 | 未達成 | 「機制在該觸發時觸發,且觸發時有用」 | 「應該預設開啟」 |
| **L4** | 跨 task type / provider 一致 | 未達成 | 「效果在多種衝突類型與 provider 上重現」 | 「對所有任務有效」 |
| **L5** | Cost / latency tradeoff 可接受 | **被 Step 8 阻擋** | 「增量成本相對增量品質是划算的」 | 任何美元數字(無 pricing registry) |
| **L6** | Productionization 決策 | 未達成 | 「應以 X 條件預設開啟」 | — |

`[DESIGN]` **目前所有公開陳述必須停在 L0。**

`[DESIGN]` 兩個特別容易被跨越的界線:

1. **L2 → L3 不可跳。** `C > B′` 很可能會成立(多一輪推理通常會讓答案更完整),
   但那不支持任何關於 peer 的宣稱。**這是本實驗最可能被誤讀的地方。**
2. **L3 ≠ 「多模型優於單模型」。** D 用的是同一個 target model。
   `C > D` 支持的是「挑戰來自另一個 agent 比來自自己更有價值」,
   **不是**「三個模型比一個模型好」—— 後者需要 arm A,而 arm A 不在 Phase 1。

## 22.1 Q16 的答案

`[DECISION]` **Q16: 見上表。核心規則是
「L2 的證據不得用來說 L3 的話」與「L3 不等於多模型優越性」。**

---

# 23. Minimal Required Code Changes

## 23.1 令人意外的結論:核心不需要改 `src/`

`[FACT]` 我逐項查證後的結果:

| 需求 | 是否需要改 `src/` | 依據 |
|---|---|---|
| arm B | ❌ 不需要 | `replaySynthesis(snapshot, { synthesizer })`,`collaboration` 不傳 |
| arm B′ | ❌ 不需要 | `{ enabled: true, disableRound2: true }`,既有分支,保留 `selectedIssue` |
| arm C | ❌ 不需要 | `{ enabled: true }` |
| **C 與 D 共用 gate 呼叫** | ❌ **不需要** | `ReplayOptions.call` 可注入;stage 已明確標記,可依 `synthesis_gate` 回放錄音 |
| **pin 所有 model** | ❌ **不需要** | `Worker.model` 與 `synthesizer.model` 明確設定即可;`result.model` 可逐呼叫斷言 |
| **pin temperature** | ❌ **不需要** | 注入的 dispatcher 轉發 `{ ...options, temperature }`;三個 adapter 都支援 |
| Round 1 凍結 | ❌ 不需要 | `toRound1Snapshot()` 已存在 |
| 盲評去 banner | ❌ 不需要 | `finalOutput.slice(banner.length)`,已有測試保證精確還原 |
| **arm D** | ⚠️ **需要新程式,但可在 `src/` 之外** | 見 23.2 |

`[DESIGN]` 這是好消息:**`§25-E2`(model pinning)是 protocol 缺陷,不是 code 缺陷**,
不需要動 production code 就能修好。

## 23.2 arm D 需要什麼

`[DESIGN]` D 的三個 stage 中,只有中間那段沒有現成路徑。兩個選項:

| | 選項 1:改 `src/`(加 self-review 模式) | **選項 2:harness-only(推薦)** |
|---|---|---|
| 位置 | `src/agents/collaboration.ts` + orchestrator | `experiments/m2b/harness/` |
| 風險 | 動到 rev.20 已驗收的 production code;需重跑並重新宣稱 212 | 不碰 production code |
| 缺點 | 違反本輪禁令 | D 的 prompt builder 是 harness 程式,可能與 C 漂移 |
| 緩解 | — | D 的 decision synthesis 以 C 的 `buildDecisionSynthesisPrompt` 為**逐字模板**,並加自動比對測試 |

`[DECISION]` **推薦選項 2。**
arm D 是**控制組,不是候選功能** —— 它不需要、也不應該進入 production code path。
把 self-review 寫進 `src/` 等於在 runtime 裡新增一個沒人要出貨的功能。

`[DESIGN]` harness 需要的三個新函式(**本輪只提案,不實作**):

```
buildSelfReviewPrompt({ task, mission, previousOutput })
    → 與 buildRound2Prompt 相同的骨架，但沒有 peer chunk、沒有 challenge，
      改為要求 target 自行提出對自己最強的反對意見並回答

buildSelfReviewDecisionPrompt({ task, specialistBlock, degradedNote, selfObjection, revisedOutput })
    → 與 buildDecisionSynthesisPrompt 結構等價
    → Decision contract 五條逐字相同（含 neutrality guard）

assertNoPeerLeakage(prompt, peerChunkText, challengeText)
    → NC-3：任何 20 字元連續子字串命中即拋錯
```

`[FACT]` `buildDecisionSynthesisPrompt` 目前的簽章是
`{ task, specialistBlock, degradedNote, issue: CollaborationIssue, revisedOutput }`。
`issue` 是 peer-specific 的,所以 D 無法直接重用它 ——
這正是需要一個平行 builder 的原因,而不是設計疏漏。

## 23.3 其他需要的 harness 程式(全部在 `src/` 之外)

`[DESIGN]`

```
recording dispatcher      錄下 gate 回應供 B′/C/D 共用；pin temperature；斷言 resolvedModel
normalizer                deterministic 去 banner / 去 metadata，可重跑
pair builder              產生去識別化的 blind pairs + 隱藏的 assignments
verify.mjs                以 production function 重推所有 artifact claim
control runner            NC-1 的 16 組 disabled control（可直接沿用既有 control.mjs）
```

## 23.4 Q17 的答案

`[DECISION]` **Q17: 真正開始 live experiment 前,`src/` 需要的變更是「零」。
唯一需要新寫的是 arm D 的兩個 prompt builder、一個洩漏斷言,以及 harness 工具 ——
全部位於 `experiments/` 之下,不進 production code path。**
`[DESIGN]` **本輪不實作其中任何一項。**

---

# 24. Explicit Non-Goals

`[DESIGN]` Phase 1 **明確不回答**以下問題。任何據此推論的宣稱都無效:

```
✗ M2-A 是否應該出貨                    （只回答「什麼證據才足以支持出貨」）
✗ 多模型是否優於單模型                  （需要 arm A，不在 Phase 1）
✗ 有外部證據時 peer challenge 是否更有價值（EP-2 全關 retrieval）
✗ NORMAL 是否應啟用 collaboration       （fixture 全為 DEEP）
✗ chunk granularity 是否最佳            （chunker 為 frozen parameter）
✗ Gate prompt 的最佳措辭                （本輪不調 prompt；只量測 precision）
✗ 跨 provider 泛化                      （每個 provider 僅 1 個 fixture）
✗ token / 美元成本                      （Step 8 未實作）
✗ latency 分布 / SLA                    （只有觀察值，不構成分布）
✗ DEGRADED 執行下的協作行為              （gate 本就排除 DEGRADED）
```

## 24.1 rev.21 三項 hygiene 的處置

`[DESIGN]` 依指令書第三十五節,本輪**只記錄,不修改**:

| ID | 內容 | 本輪處置 | 未來處置 |
|---|---|---|---|
| **D1** | 兩個測試名稱超出實際 assert 範圍 | 記錄 | 下次修改 `test-collaboration.mjs` 時順帶改名為 `…prompt states…` 形式 |
| **D2** | byte-equivalence 測試名稱實為同 build parity | 記錄 | 同上 |
| **E4** | `noRound2Leak` 在 replay path 恆真 | 記錄 | ⚠️ **絕不回頭改 Replay #4** |

`[FACT]` **E4 特別說明:`harness.mjs` 在 `controlled-replay-4/hashes.json` 的封印範圍內
(我確認過該檔的 12 個 key 包含 `harness.mjs`),`verify.mjs` 會逐檔比對。
原地改名會直接破壞封印,使 Replay #4 的既有證據失效。**

`[DESIGN]` 正確作法:**M2-B 的新 harness 從一開始就用真正可失敗的不變式**。
例如將 `noRound2Leak` 改寫成:

```
對每個 arm，以 frozen Round 1 重算 report，
斷言 result.report 與該重算值逐欄相同
→ 這在 Round 2 洩漏時「會」失敗，而不是恆真
```

`[DESIGN]` 這條已經隱含在 NC-2 裡。**新 harness 不繼承舊 harness 的弱代理。**

## 24.2 一個 HANDOFF 尚未記錄的既有發現

`[FACT]` Diagnostic #1 的 `business_strategist` 輸出含**系統性算術錯誤**,
可由 committed artifact 直接重算(`diagnostics/m2a-live/run1-not-exercised/artifact.json`,
`calls[1].responseText`):

```
                    增量成本合計   減：原外租省下   淨增量（報告值）   正確值
Base      殘留 64萬      454萬          -256萬           198萬          134萬  ← 高估 64萬
Upside    殘留  0萬      390萬          -320萬            70萬           70萬  ← 正確
Downside  殘留160萬      590萬          -160萬           430萬          270萬  ← 高估 160萬
```

錯誤性質:殘留外租已被計入「增量成本合計」,卻只扣除**被取代的那部分**外租
(320萬 × 取代比例),而非全額 320萬。**殘留為 0 時剛好正確,這解釋了為何 Upside 沒錯 ——
是系統性錯誤,不是隨機失誤。**

`[DESIGN]` **此發現目前不在 HANDOFF 任何一節。** 建議 Architecture Review 決定是否補記,
因為它同時是:(a) F7 排除算術重 fixture 的直接依據;(b) 未來 Deterministic Finance Layer 的動機證據。

## 24.3 Q12 的答案

`[DECISION]` **Q12: 是,Phase 1 排除核心決策依賴大量 deterministic arithmetic 的 fixture。**

`[DESIGN]` 理由與一個重要的公平性說明:

- 單一算術錯誤足以翻轉 headline decision,而它的發生是**隨機的**,
  會成為與 peer information 無關的巨大變異來源(X13)
- 上述 `[FACT]` 顯示這不是假設性風險,而是**已在本專案的真實輸出中發生過**
- **公平性:排除算術題其實對 C 不利,不是圖利 C。**
  算術錯誤正是 peer challenge 最有機會抓到的東西之一。
  排除它是**保守**選擇 —— 若 C 在沒有算術漏洞可抓的情況下仍勝出,結論更強

`[DESIGN]` 數字**可以**出現在 fixture 裡,但不得**承載決策**。
判準:若把所有數字換成定性描述後決策仍成立,該 fixture 通過 F7。

`[DESIGN]` Finance Layer 實作後,應**專門**做一輪 arithmetic-heavy 的 effectiveness 研究 ——
那是一個獨立且有價值的問題,不該混進 Phase 1。

---

# 25. Recommended Next Step

## 25.1 主要推薦

```
RECOMMEND:

  B / B′ / C / D  四臂、共用 frozen Round-1、共用 gate 呼叫的配對 pilot
  4 fixtures（3 positive + 1 negative control）× 5 repetitions
  120 live calls
  D 採 D₁（self-targeted challenge），harness-only，不動 src/
  Phase 1 內 target provider 跨 fixture 輪換（Option 3′），合成器全程固定
  所有 arm retrieval 全關；所有 model 明確 pin 並逐呼叫斷言
  pilot 的交付物是「變異估計 + judge 信度」，不是 effectiveness 結論
```

## 25.2 為什麼是這個,不是別的

`[DESIGN]` 三個關鍵取捨,各用一句話:

1. **留下 B′** —— 它是最便宜的 arm,卻解決最大的 confound(附錄效果)。
   拿掉它,`C > B` 在因果上無法解釋。
2. **D 用 D₁ 而非 D₀** —— 研究問題是「peer 資訊的增量價值」;
   用通用 self-review 當控制組,會讓「有具體標的」這件事偽裝成 peer 效果。
3. **C 與 D 共用 gate 呼叫** —— 同時**降低成本**與**提高效力**。
   `§25-E1` 證明 gate 抽樣變異大到能翻轉 headline;把它從主估計量裡消掉是免費的。

## 25.3 執行順序

`[DESIGN]`

```
1.  Architecture Review 拍板本 protocol（尤其 3.2 的 D₁、4.3 的四臂、15.3 的 Option 3′）
2.  凍結 4 個 fixture + gold issues + conflict labels，commit + hash
        ★ 必須全部早於任何 arm 執行 ★
3.  實作 harness（arm D builders、recording dispatcher、normalizer、verify.mjs）
4.  跑 NC-1（16 組 disabled control）確認 runtime 未漂移
5.  跑 temperature 支援性探測（1–2 次呼叫，確認 gpt-5 是否接受）
6.  跑 pilot（120 calls）
7.  先評 judge 信度、leakage、變異；通過後才解讀 arm 比較
8.  依觀察到的變異決定正式 N，回到 Architecture Review
```

`[DESIGN]` 第 7 步的順序是紀律性的:**先確認工具可信,再看結果。**
反過來做,就會在工具不可信時看見自己想看的東西。

## 25.4 本輪未做的事

```
未修改 src/            未修改 Gate Prompt      未移除 strengthening
未新增 only            未修改 Planner          未開 NORMAL
未修改 Chunker         未 pin production router 未做 Step 8
未做 Finance Layer     未跑 live API           未跑 B/C/D
未新增 self-review runtime                     未 productionize
未 merge main          未修改 rev.20 tests     未觸碰 Replay #4 封印
```

`[DESIGN]` 第 23 節提出的三個 builder 與 harness 工具**只是提案**,本輪一行都沒有實作。

---

## 附錄:核心問題對照表

| Q | 答案位置 | 一句話結論 |
|---|---|---|
| Q1 | 4.3 | **B / B′ / C / D**;B′ 最便宜卻解決最大 confound |
| Q2 | 5.3 | 共用 gate 呼叫 + 全欄位匹配 + D₁ 同樣是「回應具體挑戰」 |
| Q3 | 6.3 | 所有 arm 共用同一 frozen Round 1,within-fixture 配對 |
| Q4 | 7.6 | 先跑 pilot 量變異;正式 N 由變異決定,現在不指定 |
| Q5 | 8.6 | 五個位置明確 pin;hash 整份 manifest;preview 版本以時間窗紀律緩解。**不需改 src/** |
| Q6 | 10.6 | deterministic normalization 只去 runtime metadata;另設 Leakage Auditor |
| Q7 | 11.5 | 四維 + 全局偏好 + Gold Issue Coverage;剔除無 ground truth 與不可靠維度 |
| Q8 | 12.4 | Level 1 headline(穩定性診斷)/ Level 2 可檢核承諾(品質);density 防灌水 |
| Q9 | 13.3.1 | frozen Round 1 讓 arm 分派與任務無關;未觸發不剔除;偏誤被設計消除而非統計調整 |
| Q10 | 20.4 | verbosity / order / model-family / provider identity 四項最小控制 |
| Q11 | 13.6 | 執行前凍結 + F4 與 gate 無關 + 不剔除 + negative control |
| Q12 | 24.3 | 排除;且排除對 C 不利,是保守選擇 |
| Q13 | 16.4 | 執行前凍結的 Independent Conflict Labelling + negative control,離線算 precision |
| Q14 | 15.4 | Option 3′:合成器固定,target provider 跨 fixture 輪換;泛化留 Phase 2 |
| Q15 | 21.4 | 方向性 pass/fail/stop;「無可偵測差異」是合法結果 |
| Q16 | 22.1 | 六層 ladder;L2 的證據不得說 L3 的話;L3 ≠ 多模型優越性 |
| Q17 | 23.4 | `src/` 變更為零;只需 harness 層的兩個 builder + 一個洩漏斷言 |

---

**狀態:DESIGN ONLY。未實作、未 live、未修改 runtime。交回 GPT Architecture Review。**

---

# 26. 治理規則 Conformance(依 `AI_COLLAB_WORKFLOW_RULES.md`)

> 本節在本文件主體完成後補上。撰寫主體時我尚未讀過治理規則,
> 讀過之後回頭稽核,結果如下。**主體的設計結論未因此改變**,
> 只補齊三處格式缺口,並列出兩項需要 GPT 裁決的偏離。

## 26.1 Defect 分類(規則 §10)

`[DESIGN]` 規則要求不要把所有問題都叫 bug。本文件涉及的既有 finding 分類如下:

| Finding | 分類 | 依據 | 本輪處置 |
|---|---|---|---|
| `§25-A1` `strengthening` 使判準接近恆真 | **Specification Defect** | code 逐字實作了已批准的 contract,問題在 contract 本身 | MONITOR;以 negative control 量測(§13.5) |
| `§25-A2` material / decision-sensitive 重疊 | **Specification Defect** | 同上 | MONITOR |
| `§25-A3` `only` 限制語氣消失 | **Specification Defect** | 同上 | MONITOR |
| `§25-E1` 模型隨機性使 n=1 無效 | **Experiment Defect** | 無法隔離變因 | 本 protocol 的 repetition + 共用 gate 設計(§5.1、§7) |
| `§25-E2` R2 model 未 pin | **Experiment Defect** | 非 runtime 錯誤;runtime 行為完全符合規格 | §8,**protocol 修正,不需改 code** |
| `§25-E3` cross-provider 未驗 | **Architecture Question** | evidence 不足,需要下一個 measurement | §15,Option 3′ |
| `§25-E5` chunk precision 未證明 | **Architecture Question** | 同上 | §16.3,frozen parameter + 免費訊號 |
| `§25-D1` / `§25-D2` 測試名稱超出證明範圍 | **Documentation Defect** | 斷言正確,標籤過寬(規則 §24) | 記錄;下次修改該檔時順帶改名 |
| `§25-E4` `noRound2Leak` 恆真 | **Documentation Defect** | 性質成立,但該 assertion 不是它的實證(規則 §25) | ⚠️ 舊 artifact 不修;新 harness 用 NC-2 取代 |
| Diagnostic #1 的算術重複計算 | **Answer-Quality Defect** | runtime 正常,模型輸出本身錯誤 | §24.2、§24.3;F7 排除算術重 fixture |

`[DESIGN]` **本文件未提出任何 Runtime Defect。** rev.20 審查已確認 runtime 無缺陷,
本輪的 protocol 設計也未發現新的 runtime 問題。

## 26.2 需要 GPT 裁決的兩項偏離

`[OPEN]` 本文件在兩處與治理規則的文字不同。**我不自行決定,列出供 Architecture Review 裁決。**

### 偏離 1 — Claims Ladder 的 L2 定義

| | 治理規則 §32 | 本文件 §22 |
|---|---|---|
| L2 | `C > B` on matched evaluation | `C > B′` on matched fixtures |
| 額外層 | 無 | 插入 L3.5(Gate precision)、L6(productionization 決策) |

`[DESIGN]` 我改成 `C > B′` 的理由:第二十一節已記錄 gate 附錄 confound ——
`C − B` 同時包含「附錄效果」與「第二輪效果」。若 L2 寫成 `C > B`,
那麼達到 L2 時我們仍無法說「第二輪帶來改善」,因為改善可能全部來自附錄。
`C > B′` 才是「第二輪整體有效果」的乾淨陳述。

`[DESIGN]` 但 `C > B` 仍是**產品問題本身**(比今天出貨的好嗎),所以它沒有消失,
而是成為 §4.1 分解式裡的 `C − B = (B′−B) + (C−B′)`。

`[OPEN]` **請 GPT 裁決:L2 應為 `C > B` 還是 `C > B′`,或兩者並列。**
若採 `C > B`,本文件其餘設計不受影響 —— 只需改 ladder 的文字。

### 偏離 2 — Cross-Provider 覆蓋的時點

| | 治理規則 §27-E3 | 本文件 §15.3 |
|---|---|---|
| 立場 | 「不需要現在單獨補一個 replay;應納入後續 generalization study」 | Phase 1 內以「target provider 跨 fixture 輪換」取得 live 覆蓋 |

`[DESIGN]` 我認為兩者**不衝突**,理由:

- Option 3′ **沒有**新增任何 replay 或額外呼叫 —— 只是決定哪個 fixture 用哪個 target provider
- 真正的 generalization study 仍留在 Phase 2(§15.4 明寫)
- Phase 1 只取得「機制在三個 provider 上都真的執行過」,`[DESIGN]` 這被明確寫入
  claims ladder 的 L4 界線:**每個 provider 只有 1 個 fixture,不足以宣稱泛化**

`[OPEN]` **請 GPT 裁決:是否接受在不增加成本的前提下,把 cross-provider 的
「執行覆蓋」(非「泛化證據」)納入 Phase 1。** 若不接受,
改為全部 fixture 使用同一 target provider 即可,本文件其餘設計不受影響。

## 26.3 其餘條目的稽核結果

`[FACT]` 我逐條比對後,以下規則本文件已符合,無需修改:

| 規則 | 對應章節 |
|---|---|
| §2.1 Minimum Sufficient Collaboration | §15.3 明確拒絕「產品有三模型所以每題三模型」 |
| §9 四層標記 | 全文使用 `[FACT]` / `[SIGNAL]` / `[DESIGN]` / `[DECISION]` / `[OPEN]` |
| §11 Measurement before architecture change | §16.2 量測 gate precision 而不調 prompt |
| §12 單次測量的解讀規則 | §17.3、全文 `[SIGNAL]` 標記 |
| §13 Evidence ≠ Consensus | §5.2 要求 D 保留 neutrality guard;EP-4 |
| §21 Hard Gates | §8(pinning)、§6/§9(frozen + parity)、§10(blind)、§18(reproducibility) |
| §22 Artifact 結構 | §18.1(本輪已對齊目錄名為 `experiments/m2b/`) |
| §23 Hash / Seal | §24.1,明確不動 Replay #4 封印 |
| §24 Test Naming | §24.1 的 D1 / D2 |
| §25 Weak Proxy | §24.1 的 E4 + NC-2 取代方案 |
| §28 不要把 Trigger Rate 當產品價值 | §16.1 的五個指標定義 |
| §29 禁止 Cherry-Picking | §13.6 四道防線;GI-1..GI-5 |
| §30 Finance 邊界 | §13.1 F7、§24.3 |
| §31 Cost / Latency | §17.1、§17.2 |
| §36 禁止順便改善 | 全部 finding 只記錄,§23 的三個 builder 只提案未實作 |
| §37 語言 | 繁中,code / field / stage / model 名保留英文 |

---

# 27. 交付格式(規則 §38)

## What changed / reviewed

`[FACT]` 本輪產出 `M2_EFFECTIVENESS_EXPERIMENT.md`(新檔),
並在讀過治理規則後補上第 26、27 節。
**未修改 `src/`、tests、`HANDOFF.md`、任何 diagnostics 目錄或 Replay #4 封印。**
`git status` 僅顯示一個 untracked 新檔。

過程中為驗證 `[FACT]` 而讀取的 code:
`src/modes/orchestrator.ts`、`src/agents/collaboration.ts`、`src/providers/types.ts`、
`src/providers/openai.ts`、`src/config.ts`、`src/models/capabilities.ts`,
以及 `diagnostics/m2a-live/` 下的 artifact。**全部唯讀。**

## What is proven

`[FACT]` 本輪**不產生任何新的實證**。這是設計文件,不是實驗。

本文件所依據的既有事實(全部可由 committed code / artifact 重算):

```
M2-A 完整機制在真實 provider call 下跑通一次（Replay #4）
disabled path 在 rev.19 / rev.20 之間未漂移（16 組 control，同一 sha256）
evidence label 由 buildRunReport 從 Round 1 單向推導，Round 2 結構上碰不到
replaySynthesis / disableRound2 / toRound1Snapshot 已足以支撐 B / B′ / C
Worker.model 與 synthesizer.model 可明確指定；result.model 回報實際使用值
CallOptions.temperature 三個 adapter 都轉發，orchestrator 從不設定它
```

## What is not proven

```
C 是否優於 B          未知
C 是否優於 D          未知
gate 附錄本身的效果    未知
Gate precision        未知
chunk granularity 是否恰當  未知
cross-provider peer interaction  零 live 證據
本 protocol 本身是否可行  未經 pilot 驗證
```

`[DESIGN]` 特別聲明:**本文件推薦的設計尚未被任何資料支持。**
它是依據既有 confound 分析所做的架構選擇,不是實證結論。

## Known limitations

```
L1  fixture 數少（4），archetype 覆蓋有限，不足以宣稱跨任務泛化
L2  每個 provider 僅 1 個 fixture，不足以宣稱跨 provider 泛化
L3  retrieval 全關，因此無法回答「有外部證據時 peer challenge 是否更有價值」
L4  arm A（強單模型）不在 Phase 1，因此無法回答「多模型 vs 單模型」
L5  X9 arm leakage 已 [SIGNAL] 觀察到存在於答案內容中，只能量測不能消除
L6  X11 D 的主題層級間接洩漏難以自動偵測，NC-3 只能擋字面洩漏
L7  preview model 的服務端版本不可得，只能以時間窗紀律緩解
L8  temperature 是否被 gpt-5 接受未經實測（§7.4 [OPEN]）
```

## Runtime defects

```
無。本輪未發現任何 runtime defect。
```

`[FACT]` rev.20 獨立審查亦未發現 runtime defect(HANDOFF 第二十五節)。

## Experiment concerns

`[DESIGN]` 完整清單見第 19 節 Bias / Confound Register(X1–X15)。
其中最致命的三項:

```
X11  D 被 peer 資訊汙染 → C−D 假性歸零，且方向確定地得出錯誤結論
X1   Gate 附錄 confound → 沒有 B′ 則 C>B 無法解釋
X3   模型隨機性 → 已由 Replay #3/#4 的 headline 翻轉直接證實
```

## Forbidden claims

`[DESIGN]` 在 Phase 1 完成前,以下陳述一律禁止(規則 §15 + 本文件 §22):

```
M2-A improves quality
Peer Challenge causes better decisions
Multi-agent beats single-agent
C > B  /  C > D
NORMAL 應啟用 collaboration
M2-A production ready
「rev.20 的 wording 修正造成了 Replay #4 觸發」  ← 本文件新增，見 §2.3
```

`[DESIGN]` 最後一條是本文件新增的禁止項:`§25-E1` 顯示 gate 輸出本身會變,
因此 #3(未提報)與 #4(提報)的差異**同時**包含 wording 變更與抽樣變異,
n=1 vs n=1 無法歸因。**這條先前未被明文禁止。**

## Recommended next step

```
1. Gemini 對本文件做 Independent Methodology Analysis（規則 §19）
2. User 將本文件 + Gemini 分析一併交給 GPT
3. GPT Architecture Review，至少裁決：
     - §26.2 偏離 1：Claims Ladder 的 L2 定義
     - §26.2 偏離 2：Cross-Provider 覆蓋的時點
     - §3.2 D₁ vs D₀
     - §4.3 四臂 vs 三臂
     - §23 arm D 走 harness-only 而非改 src/
4. 僅在 GPT 批准後，才進入 M2-B Minimal Experiment Harness
```

## Stop condition

```
本輪已完成指定 deliverable。STOP。

不進行：implementation / live call / harness 撰寫 / fixture 凍結 /
        Gate 調整 / merge / 下一個 milestone。

下一輪需由 Gemini 獨立分析 + GPT Architecture Review 重新授權。
```


---
---

# PART 2 — HANDOFF.md 節錄(逐字)

```
source commit : 339d700201ee493f592b6a9a56b3e96248bd6f8d
sha256        : f83caa5e6dada8de303b9901172a791a2702765521cf3c996dd3482781567523
revision      : rev. 22
```

## HANDOFF EXCERPT SELECTION MANIFEST

**Included** —— 只包含**直接影響 M2-B methodology / causal validity / claims boundary** 的原文:

```
交接狀態表與 claim boundary
rev.20 / rev.21 / rev.22 的變更說明
第十五節  工程原則（方法學紀律的來源）
第二十節（節錄）  兩個 code-level 實驗阻礙、evidence 不變式、待拍板問題
第二十一節（節錄）Gate 啟動條件、selective peer context、evidence 不變式、
                  trigger rate 定位、⚠️ 附錄 confound、rev.15 selection-bias 反轉、
                  A/B/C/D 就緒條件
第二十二節（節錄）單次 latency 觀察與不得宣稱的事
第二十三節（全）  Controlled Replay #3 —— 設計對立的發現
第二十四節（全）  Controlled Replay #4 —— 完整機制跑通
第二十五節（全）  rev.20 獨立審查（A1–A4 / E1–E5 / D1–D3 的原始出處）
```

**Excluded** —— 與本輪 experiment validity 無直接關係者:

```
Step 1–7 的一般 implementation history（第一～十四、十六～十九節）
SIMPLE baseline / worker context propagation / registry / retrieval MVP 的施工紀錄
rev.1–rev.19 的逐版變更說明（rev.20 之後者已包含）
```

> ⚠️ **這是 deliberate context reduction,不是宣稱本 packet 等同完整 `HANDOFF.md`。**
> 完整檔案為 2674 行 / 169363 bytes,本節錄約佔其中一部分。
> 若審查需要被排除的部分,請向使用者索取完整檔案。
>
> **所有 excerpt 均為逐字原文,標示原始行號與 heading,未經 editor paraphrase。**
> Editor 撰寫的內容只出現在標題列與本說明段,不得被當成 source fact。

---

## E-01 — 文件標題 + 交接狀態表 + rev.20/rev.14 摘要段

```
HANDOFF.md @ 339d700  lines 1–27  （逐字）
```

<!-- BEGIN VERBATIM E-01 -->

# ai-collab-mcp — Progress Report (2026-09-06, rev. 22)

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
> | **Experimental Milestone 2-A Prototype** | **STOPPED / AWAITING ARCHITECTURE REVIEW / DEFAULT OFF —— 詳見第二十四節** |
> | **M2-A Diagnostic Live #1 / #2** | **兩次皆 NOT EXERCISED —— 被兩個不同條件擋在 gate 之前,詳見第二十二節** |
> | **M2-A Controlled Replay #3** | **NOT EXERCISED —— gate 首次真正執行,但認出分歧後選擇在答案內解決,未輸出區塊,詳見第二十三節** |
> | **M2-A Controlled Replay #4** | **FULL MECHANISM RUNTIME PASS —— 一次自然 valid issue → R2 → Decision Synthesis,不代表品質或產品價值已驗證** |
> | **rev.20 Independent Code Review** | **ACCEPT WITH DOCUMENTATION CORRECTION —— 無 runtime defect;3 項文件/命名修正 + 1 項規格 concern 待 review,詳見第二十五節** |
> | **M2-B Effectiveness Experiment Design** | **DELIVERED / AWAITING GEMINI + GPT REVIEW —— 見 `M2_EFFECTIVENESS_EXPERIMENT.md` @ `734ad8e`。protocol 已產出,尚未 ACCEPT,尚未 implementation,尚未 live experiment** |
> | **Claude Code handoff** | **EXECUTED —— deliverable 已產出,等 architecture review** |
> | **目前離線測試** | **212 項全過 = rev.19 的 208 + Gate semantics 新增 4** |
> | **Step 8 Scope Analysis** | **DONE —— runtime usage / pricing / cost / reporting 已分層,詳見第十七節** |
> | **Step 8 Implementation** | **DEFERRED —— Milestone 2 驗證後再回來** |
> | 未完成的程式修改 | **無** |
>
> **Experimental Milestone 2-A 已完成本輪限定工程,現在 STOPPED / AWAITING ARCHITECTURE REVIEW,default OFF。** 使用者批准 Gate eligibility 由 post-synthesis unresolved conflict 改成 pre-synthesis material disagreement;唯一一次 Replay #4 使用與 #3 byte-identical 的 fixture,自然跑通 valid issue、sourceRef、Targeted R2 與 Decision Synthesis。212 項離線測試通過,既有 assertions 未放寬,16 組修改前/後 control capture byte-identical。這是機制驗證,尚未執行品質比較或 live A/B/C/D。
>
> **Milestone 2 scope analysis(rev.14)。** `MILESTONE2_SCOPE_ANALYSIS.md` 依實際 code 回答全部 18 題,並修正兩處 rev.13 邊界:DEEP logical call ceiling 應寫成 `N + 4`(在 `SPECIALIST_CAP.deep` 下是 8,不是約 7),且 synthesizer 目前完全收不到 retrieval metadata —— 被要求判斷 `needs_evidence` 的 gate 會是在對它看不到的證據做推論。核心設計建議是**不要把交付物押在 parse 上**:自由文字答案在前、選擇性 JSON 區塊在後、best-effort 解析,任何解析失敗都退回今日行為。7 個 `[OPEN]` 問題待 architecture review 拍板,未經批准不進入 implementation。

<!-- END VERBATIM E-01 -->

---

## E-02 — ## rev. 22 改了什麼(只加狀態指標)

```
HANDOFF.md @ 339d700  lines 29–51  （逐字）
```

<!-- BEGIN VERBATIM E-02 -->

## rev. 22 改了什麼(只加狀態指標 —— 無 code、無設計內容)

**rev.22 = rev.21 的 code + 一列狀態指標。`src/` 一個 byte 都沒動,離線測試仍是 212 項。**

1. **本輪唯一變更** —— 交接狀態表新增一列,指向 `M2_EFFECTIVENESS_EXPERIMENT.md`
   (commit `734ad8e`,1992 行)。**M2-B 的設計內容一律不抄進 HANDOFF**;
   依協作規則 §46,實驗設計屬於該文件,HANDOFF 只記工程狀態。
2. **Claim boundary(必須維持)** ——

   ```
   ✅ M2-B protocol 已產出
   ❌ 尚未經 Gemini independent review
   ❌ 尚未經 GPT Architecture Review
   ❌ 尚未 ACCEPT
   ❌ 尚未 implementation
   ❌ 尚未 live experiment
   ```

3. **M2-A 狀態未變** —— 仍是 STOPPED / AWAITING ARCHITECTURE REVIEW / DEFAULT OFF。
   本輪未跑 live call、未改 Gate、未動 Replay #4 封印、未 merge main。

---


<!-- END VERBATIM E-02 -->

---

## E-03 — ## rev. 21 改了什麼(rev.20 獨立審查紀錄)

```
HANDOFF.md @ 339d700  lines 52–69  （逐字）
```

<!-- BEGIN VERBATIM E-03 -->

## rev. 21 改了什麼(rev.20 獨立審查紀錄 —— 無 production code 變更)

**rev.21 = rev.20 的 code + 一份獨立審查紀錄。`src/` 一個 byte 都沒動,離線測試仍是 212 項。**
被審對象是 `experimental/m2a-peer-challenge` @ `4e34d89d9d88e64d0bcfd641809c8ff57bf03b25`。

1. **結論** —— `ACCEPT WITH DOCUMENTATION CORRECTION`。未發現 production runtime defect。
   11 個審查面向中 10 項 PASS,1 項 CONCERN(Gate semantics —— 針對已批准規格本身的寬度,
   不是實作偏差)。詳見第二十五節。
2. **驗證方式** —— 不是讀 artifact 自報值。在 scratchpad 另開 `aedc9ef` 與 `4e34d89`
   兩個乾淨 worktree,各自從 committed source 重新 `tsc` build,重跑 control capture、
   全套離線測試、`verify.mjs`,並從 frozen snapshot 重建 live gate prompt 比對 byte。
   審查全程只讀不寫,repo 未被修改,worktree 事後清除。
3. **待處理項目** —— 3 項文件/命名落差(D1/D2/E4)與 1 項規格 concern(A1「strengthening」)。
   **本輪未實作任何修正**,原因見第二十五節「為什麼不當場修」。
4. **BENCHMARK RESET(rev.19)仍有效。** 本輪未執行任何 live call,未動 M2-A,未 productionize。

---


<!-- END VERBATIM E-03 -->

---

## E-04 — ## rev. 20 改了什麼(Gate Eligibility Specification / Controlled Replay #4)

```
HANDOFF.md @ 339d700  lines 70–81  （逐字）
```

<!-- BEGIN VERBATIM E-04 -->

## rev. 20 改了什麼(Gate Eligibility Specification / Controlled Replay #4)

1. **授權與起點** —— 使用者先明確停止 M2-A 等 architecture review,其後批准本次限定 Gate semantics 修正與一次 Replay #4。實際起點為 rev.19 / `aedc9efe0ff1f4acf7d5a36d9a1b3ab87e5b9af8`,不是較舊的 rev.18。第二十三節的設計對立仍是設計 observation,未改稱 parser、chunker 或 planner bug。
2. **唯一 production diff** —— `src/agents/collaboration.ts::buildGateAppendix()` 改為先看原始 Round 1 的 material、cross-agent、decision-sensitive disagreement。Provisional 能折衷不再自動取消 issue 資格;wording/style/minor emphasis/equivalent recommendations 仍排除,max-one 與不捏造分歧保留。沒有新增 call、flag 或調整其他 runtime。
3. **離線驗證** —— `npm test` 208 → 212,0 failed。新增四項 contract/runtime tests;另以固定 offline clock 保存16組 disabled/omitted control,修改前後 payload、prompt、stage sequence、finalOutput 完全 byte-identical。LLM 判斷由 live observation 驗證,不以 mock 取代。
4. **Replay #4 FULL MECHANISM RUNTIME PASS** —— 一次 Gate → R2 → Decision Synthesis,三次皆 openai / gpt-5。parse=parsed;emitted/valid/rejected/eligible/selected=1/1/0/1/1;target=brand_creative;sourceRef=business_strategist:p5,精確引用40字元,與 challenge 直接相關。未重跑 Planning/Workers或人工插入 issue。
5. **Evidence 與 failure 邊界** —— HYPOTHESIS → HYPOTHESIS、SUCCESS → SUCCESS、banner/retrieval summary 不變,所有 live calls retrieval request/result 均 null。Provisional/R2/final 原文完整保存。成功路徑為 live evidence;R2/Decision failure fallback 與多 issue 防護本輪由 offline tests 驗證,未額外 live 注入失敗。
6. **Timing 與完整性** —— Gate 46729ms、R2 42713ms、Decision 68965ms、replay total 158408ms。五份 fixture hashes、snapshot/order/status/roster/chunks 皆與 #3 相同,詳見 `diagnostics/m2a-live/controlled-replay-4/`。Single replay observation 不作 latency distribution 或 quality comparison。
7. **提交與停止** —— Prompt/tests 獨立 commit `267ecffb2eebbb8fe4d42333469ad8d10b0362f4`;diagnostic evidence/HANDOFF 另外提交於 `experimental/m2a-peer-challenge`。本輪未確認 production runtime defect;離線 verifier 的 undefined/JSON serialization 比對修正已記錄。完成後停止,等待 Architecture Review。rev.19 BENCHMARK RESET 仍有效,未做 B vs B′、self-review、A/B/C/D、NORMAL eligibility、Finance Layer 或 productionization。

---


<!-- END VERBATIM E-04 -->

---

## E-05 — # 十五、本專案累積的工程原則(全節)

```
HANDOFF.md @ 339d700  lines 1444–1491  （逐字）
```

<!-- BEGIN VERBATIM E-05 -->

# 十五、本專案累積的工程原則

rev. 21 新增:

> **An invariant that cannot fail in the path it runs in is not evidence, even when the property it names is true.**

這條來自 rev.20 審查的 E4。`noRound2Leak: !Object.hasOwn(result,'workerResults')` 在 replay path 上**恆真** —— `replaySynthesis` 本來就不回傳該欄位,所以即使 production path 真的洩漏,它也照樣 PASS。該性質確實成立,但撐住它的是另外三條 invariant 加上結構論證,不是這條掛著它名字的檢查。**證據的標籤必須等於它實際檢查的東西**;不然日後有人會拿一條恆真式當保證。

> **A faithful implementation of an approved specification does not make the specification right.**

rev.20 的 Gate eligibility 文字與指令書的 contract 逐字對應 —— 實作零偏差。但判準裡的 `strengthening` 讓「改變 ∪ 強化」蓋住了 binary 的兩支,接近恆真。**審查要能分開問兩個問題:code 有沒有照規格做,以及規格本身合不合理。** 把第二個問題摺進第一個,規格的缺陷就永遠不會被發現。

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


<!-- END VERBATIM E-05 -->

---

## E-06 — # 二十(節錄):latency 風險 / 兩個 code-level 阻礙 / evidence 不變式 / Q-A–Q-G / scope gate

```
HANDOFF.md @ 339d700  lines 1814–1862  （逐字）
```

<!-- BEGIN VERBATIM E-06 -->

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


<!-- END VERBATIM E-06 -->

---

## E-07 — # 二十一(節錄):Gate 啟動條件

```
HANDOFF.md @ 339d700  lines 1887–1899  （逐字）
```

<!-- BEGIN VERBATIM E-07 -->

## Gate 啟動條件

| 條件 | 不符合時 |
|---|---|
| `experimental.collaboration.enabled === true` | 完全走舊路徑,回傳物件連 `collaboration` 這個 key 都沒有 |
| `complexity === 'deep'` | `NOT_TRIGGERED` / `complexity_not_deep (...)` |
| Round 1 `status === 'SUCCESS'` | `NOT_TRIGGERED` / `round1_status_degraded` |
| 成功的專家 ≥ 2 | `NOT_TRIGGERED` / `single_specialist_no_peer` |

Gate 沒啟動時,synthesis prompt 是既有那一份,一字未改 —— 不合格的執行不會偷偷變成另一個實驗。

DEGRADED 被排除是刻意的:gate 會在少了一位專家的情況下比較專家,這時候的挑戰量到的是那次失敗,不是協作。


<!-- END VERBATIM E-07 -->

---

## E-08 — # 二十一(節錄):Selective peer context + Evidence 不變式

```
HANDOFF.md @ 339d700  lines 1934–1959  （逐字）
```

<!-- BEGIN VERBATIM E-08 -->

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


<!-- END VERBATIM E-08 -->

---

## E-09 — # 二十一(節錄):Trigger rate 的正確定位 / 未做的事 / ⚠️ 附錄 confound / rev.15 反轉 / A-B-C-D 條件 / 首次 live

```
HANDOFF.md @ 339d700  lines 1979–2057  （逐字）
```

<!-- BEGIN VERBATIM E-09 -->

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


<!-- END VERBATIM E-09 -->

---

## E-10 — # 二十二(節錄):一句話結論

```
HANDOFF.md @ 339d700  lines 2064–2074  （逐字）
```

<!-- BEGIN VERBATIM E-10 -->

## 一句話結論

**targeted peer challenge 機制到目前為止一次也沒有被真正執行過,而且兩次被擋下的原因不同。**

| | Fixture 性質 | complexity | N | 阻擋點 | logical calls |
|---|---|---|---|---|---|
| #1 | 五年租約 + 650 萬 capex 的重大投資決策 | `deep` | 1 | `single_specialist_no_peer` | 3 |
| #2 | 月訂閱新服務,含商業/市場/品牌三種決策資訊 | **`normal`** | 2 | `complexity_not_deep (normal)` | 4 |

**修掉其中一個不會讓另一個消失。** M2-A 的 gate 需要同時滿足 `deep` **且** 至少 2 位成功專家;兩次執行各自缺了其中一個條件。


<!-- END VERBATIM E-10 -->

---

## E-11 — # 二十二(節錄):Latency 觀察 / 不得宣稱的事 / 開放問題

```
HANDOFF.md @ 339d700  lines 2138–2165  （逐字）
```

<!-- BEGIN VERBATIM E-11 -->

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


<!-- END VERBATIM E-11 -->

---

## E-12 — # 二十三、M2-A Controlled Frozen Round-1 Replay(#3)(全節)

```
HANDOFF.md @ 339d700  lines 2166–2280  （逐字）
```

<!-- BEGIN VERBATIM E-12 -->

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


<!-- END VERBATIM E-12 -->

---

## E-13 — # 二十四、Controlled Replay #4(全節)

```
HANDOFF.md @ 339d700  lines 2281–2356  （逐字）
```

<!-- BEGIN VERBATIM E-13 -->

# 二十四、Controlled Replay #4 — FULL MECHANISM RUNTIME PASS / STOPPED

完整驗收與原始證據見 [evaluation.md](diagnostics/m2a-live/controlled-replay-4/evaluation.md)
及 [artifact.json](diagnostics/m2a-live/controlled-replay-4/artifact.json)。
本輪只執行一次 controlled frozen Round-1 replay;Planning/Workers 是原 synthetic fixture,
後三個 stage 為真實 provider calls。此處只驗證 mechanism,不判 B/C 商業正確性。

## 已批准的語義修正

由「synthesis 完後仍未解決的 conflict」改為「原始 Round 1 是否存在 material、
cross-agent、decision-sensitive disagreement,其直接回應是否可能 materially 改變/強化/
推翻/限縮 final decision」。即使 provisional 可提出折衷或 Kill Switch,仍可提報。
不滿足條件時依然可以省略區塊;max-one、sourceRef/schema/selection/runtime flags 全部未改。
這是對第二十三節設計對立的 specification decision,不是通用 force-trigger。

## Fixture 與驗收

#3/#4 的 Original Task、missions、synthetic outputs、complexity、assignment order、
status 與 chunkMap 都相同。逐檔 hash 見 preflight;聚合 snapshot hash 都為:

`cb5e9c309a8b64cac1b688d9de4ff4a9b26fc504d40d3ccb5ff412bcb4965a4b`

此 hash 定義為原 #3 snapshot 形狀的 `SHA256(JSON.stringify(snapshot))`。
Status 另由 buildRunReport 重算,仍是 SUCCESS。未使用 rev.19 reset 後的 BENCHMARK_TASK
替換此 fixture,因此不混用舊/新年度策略 benchmark 數字。

| 檢查 | 結果 |
|---|---|
| Gate Live Reachability / Disagreement Recognition | PASS / PASS |
| parse.status | parsed |
| issues.emitted / valid / rejected / eligible | 1 / 1 / 0 / 1 |
| selected issue | brand_creative ← business_strategist:p5 |
| action / decisionSensitive | peer_challenge / true |
| sourceRef / deterministic selection | PASS / PASS;selected=1;fallback used=false |
| Targeted R2 / Decision Synthesis | PASS / PASS |
| R2 actual prompt context | task、target mission/output、exact peer chunk、challenge 逐字一致 |
| R2 retrieval request/result | null / null |
| EvidenceLabel / RunStatus | HYPOTHESIS / SUCCESS,前後相同 |
| banner / retrieval summary / frozen snapshot | 前後一致 |
| provisional / R2 / final raw text | 完整保存 |
| runtime fingerprint before/after | 相同 |

Resolved chunk: `business_strategist:p5`,offset [175,215),未截短。

> 在公司沒有足夠資源同時擴編兩條產品線的條件下，我不建議現在投入新的固定服務承諾。

**Chunk relevance=YES。** Challenge 要求品牌 specialist 直接回應資源不足下的交付與毛利
前提;R2 回應該論點並條件化其建議。Actual R2 contract 允許反駁、維持立場與部分修正,
沒有強迫 consensus。Decision contract 保留 revision/recency/agreement 不等於 evidence。

## Calls、Timing 與限制

實際 live logical calls=3,皆 openai / gpt-5:

| Stage | Runtime phase |
|---|---:|
| synthesis_gate | 46729ms |
| round2_worker | 42713ms |
| decision_synthesis | 68965ms |
| replay total | 158408ms |

未重跑 Planning/Workers,不可宣稱實際花了 N+4 次。N=2 的完整 runtime ceiling 仍是6。
SDK HTTP retries、tokens/cost 未計量。這次是跨 specialist 的 mechanism replay,
不是兩個不同 provider 都 live 產出後的 end-to-end 品質測試。

Failure fallback 與模型違規產出多 issue 的分支仍有 offline tests,本次未 live exercised。
Verifier 曾因 undefined 欄位在 JSON 中省略而誤判,只修比較表示方式後通過,
未修改 live artifact 或再次執行。未確認需修復的 production runtime defect。
模型輸出中的工時/毛利/價格等假設不當作已驗證資料或 pricing registry。

**狀態:STOPPED / AWAITING ARCHITECTURE REVIEW。**
PASS 只代表 downstream mechanism 在真實 provider calls 下跑通一次。
未證明 peer challenge 的品質增益或多模型優勢,未批准 productionization 或後續實驗。

---


<!-- END VERBATIM E-13 -->

---

## E-14 — # 二十五、rev.20 Independent Code Review(全節)

```
HANDOFF.md @ 339d700  lines 2357–2674  （逐字）
```

<!-- BEGIN VERBATIM E-14 -->

# 二十五、rev.20 Independent Code Review —— ACCEPT WITH DOCUMENTATION CORRECTION

由 Claude Code 執行的獨立 architecture + code review,對象是 rev.20。
本輪**未實作任何變更**:`src/` 未動、測試未動、`diagnostics/` 未動,repo 只被讀取。

```
Branch reviewed       : experimental/m2a-peer-challenge
HEAD reviewed         : 4e34d89d9d88e64d0bcfd641809c8ff57bf03b25
Parent implementation : 267ecffb2eebbb8fe4d42333469ad8d10b0362f4
Baseline              : aedc9efe0ff1f4acf7d5a36d9a1b3ab87e5b9af8 (rev.19)
Ancestry              : aedc9ef → 267ecff → 4e34d89(線性,無 rebase / force)
```

## 驗證方式(重要:以下 PASS 不是讀 artifact 自報值)

在 scratchpad 另開 `aedc9ef` 與 `4e34d89` 兩個乾淨 git worktree,各自從 committed source
重新 `tsc` build,然後:

| 動作 | 用途 |
|---|---|
| 兩個 commit 各跑一次 `control.mjs` | 獨立重算 disabled control hash |
| 兩個 commit 各跑一次完整離線套件 | 獨立確認 208 / 212 |
| 在 after worktree 跑 `verify.mjs` | 獨立確認 fixture identity、seal、runtime fingerprint |
| 從 frozen snapshot + rev.20 `buildGateAppendix()` 重建 gate prompt | 獨立確認 gate 實際看到什麼 |

worktree 事後已 `git worktree remove`,主 checkout 未受影響。

## 逐項判定

| # | 面向 | 判定 |
|---|---|---|
| 1 | Scope fidelity | **PASS** |
| 2 | Gate semantics correctness | **CONCERN** |
| 3 | Disabled control byte-equivalence | **PASS**(獨立重現) |
| 4 | Offline tests | **PASS** |
| 5 | Replay fixture identity | **PASS** |
| 6 | Valid issue parsing | **PASS** |
| 7 | SourceRef correctness | **PASS** |
| 8 | Selective R2 context | **PASS** |
| 9 | Evidence invariants | **PASS** |
| 10 | Failure semantics classification | **PASS** |
| 11 | Claims discipline | **PASS** |

**Runtime defects found:無。**

## 1. Scope fidelity —— PASS

`src/` 全樹 diff = **4 additions / 1 deletion,單檔單 hunk**,位於 `buildGateAppendix()` 內。

逐項核對宣稱的排除,全部成立:新增 provider call、force flag / detector / Judge、Planner、
Chief、DEEP-only 資格、Chunker、parser schema、sourceRef resolver、retrieval、EvidenceLabel、
Step 7 —— **一項都沒動**。`CollaborationConfig` 介面與 baseline `diff` 結果為 IDENTICAL,
default OFF(`input.collaboration?.enabled === true`)未改。

**HANDOFF 宣稱與 code reality 一致,未發現不符。**

`verify.mjs` 自己也做了一次結構性 scope 檢查(`split('buildGateAppendix')[0]` 與
`split('buildRound2Prompt')[1]` 對 baseline byte 相等),但要注意它的界線:
`buildGateAppendix` 函式**本體**不在這兩段之內。真正把範圍釘死的是 git diff。

## 2. Gate semantics correctness —— CONCERN

先講清楚:**實作對規格是逐字忠實的。** 指令書的 contract「有實質可能改變、強化、否證或
重大限定 final decision」與 code 的 `a meaningful chance of changing, strengthening,
falsifying, or materially qualifying the final decision` 一一對應。**這不是實作越權。**

三個限制與兩個 counterweight 都在(從 live gate prompt 原文確認,非從 source 推論):
`material` / `cross-agent` / `decision-sensitive`、exclusion list、`At most one`、
`Prefer omitting the block entirely`。

CONCERN 針對**規格本身的寬度**:

**(a)「strengthening」使判準接近恆真。** binary 結果只有「改變」與「不改變」兩支;
「改變 ∪ 強化」把兩支都蓋住。直接 peer response 若沒改變決策,幾乎必然「強化」它。
四個動詞裡它是唯一無法被否證的。

**(b) 三個限制中只有一個是獨立的。** `material、cross-agent、decision-sensitive` 後面接冒號,
由**同一句**定義三者 —— material 與 decision-sensitive 塌縮成同一條判準。真正獨立且有 code
強制的只有 cross-agent(`validateIssues` 拒絕 self-review)。實際 guard 是
**一條 code check + 一條 prompt 子句**,不是三條。

**(c) 限制性語氣消失。** rev.19 是 `Raise an issue **only** where…`;rev.20 的 eligibility
段落沒有 `only`,取而代之是祈使句 `If so, **emit** … even if your provisional answer offers
a compromise`。`Prefer omitting` 防的是**捏造**分歧,不防**真實但次要**的分歧被過度提報;
防後者的 exclusion list 現在正好排在那句 override 之下。

**(d) 風險有界,且是成本不是正確性。** DEEP-only + SUCCESS + N≥2 未動;`selectIssue` 在 code
層強制單一,不管模型吐幾個;ceiling 仍 N+4。過度觸發的最壞情況是每次 DEEP run 多兩次
provider call。

⚠️ **Replay #4 只有 1 個 issue,既不證明也不排除過度觸發。**

## 3. Disabled control byte-equivalence —— PASS(獨立重現)

在兩個 commit 各自 rebuild 後重跑 `control.mjs`:

```
aedc9ef → f50a7b2ee2a8b7f896dc6a6b88692d612281553011a1de685b2e39c9a567c698
4e34d89 → f50a7b2ee2a8b7f896dc6a6b88692d612281553011a1de685b2e39c9a567c698
committed control-before.json / control-after.json 亦同一 hash
```

16 組 = 3 complexity × 2 config × 3 status − 2 個不可能的 simple/DEGRADED。捕捉內容含
provider、**完整 prompt**、options(model/system/stage)與完整 result(含 `finalOutput`、
`workerResults`、`report`、`timings`),共 52 次 call;`result.collaboration` 全部 absent,
三個 collaboration stage 全部未出現。

`control.mjs` 以 `flag:'wx'` 寫檔,**無法事後覆寫 before** —— 這個細節讓證據鏈站得住。
**Control 未漂移。**

## 4. Offline tests —— PASS

獨立重跑,非引用 log:

```
aedc9ef : 11 + 25 + 20 + 11 + 36 + 105 = 208 passed / 0 failed
4e34d89 : 11 + 25 + 20 + 11 + 36 + 109 = 212 passed / 0 failed
```

**test diff 是純插入(`@@ -848,6 +848,71 @@`,零刪除行)** —— 這是「既有 assertions
未放寬」最硬的證據,比逐條讀測試更可靠。四項新測試對應四個要求,全部到位;max-one 那項
額外驗了 `calls.length === N + 4`。

## 5. Replay fixture identity —— PASS

`verify.mjs` 直接 `assert.deepEqual(a.snapshot, old.snapshot)` 對上 #3 的 artifact,
不是比對自報 hash;五份 fixture 也逐檔 SHA-256 對回 `../controlled-replay/`。我重跑通過。

```
replay3SnapshotSha256 = replay4SnapshotSha256
                      = cb5e9c309a8b64cac1b688d9de4ff4a9b26fc504d40d3ccb5ff412bcb4965a4b
task / missions / Round1 outputs / assignment order / RunStatus / roster / chunkMap(18+22)
```

額外確認一項未被宣稱的事:`runtimeFingerprint`(33 個 src/dist/config 檔的 SHA-256)在我這台
機器 clean rebuild 後**逐檔相同** —— build 是可重現的。

## 6. Valid issue parsing —— PASS

不看 artifact 自報欄位,改用 committed 的 production function 從 committed 的 gate response
重算:`parseGateOutput(calls[0].responseText)` → `deepEqual(artifact.parserReplay)` ✓。
`parse=parsed`;`emitted 1 / valid 1 / rejected 0 / eligible 1 / selected 1`。

另從 frozen snapshot + rev.20 `buildGateAppendix` 獨立重建 live gate prompt,
與 artifact 記錄 **byte-identical**:

```
sha256 a64cd320b27a61e722ff0e87701afa2469ca03b2329cd5a2d15ab0928009f8c7
新語義存在 = true      rev.19 舊語義存在 = false
max-one = true         prefer-omitting = true      exclusion list = true
deterministic references offered = 40(unique 40)
```

**Gate 確實看到了新規則,而且看到的是 40 個確定性引用。**

## 7. SourceRef correctness —— PASS(附精確度觀察)

```
sourceRef : business_strategist:p5
resolved  : ok=true, index=4, offsets [175,215), 40 chars, truncated=false
source ≠ target : business_strategist ≠ brand_creative
```

`resolveSourceRef` 是 `chunks.find(c => c.id === chunkId)` 精確比對 —— **無 fuzzy match**。
唯一的 bare-id 接受條件是該 specialist 只有一個 chunk;本次 sourceRef 帶了 chunkId,
該路徑未觸發 —— **無 answer-head fallback**。

**相關性判定成立,但要記一筆:** p5 是 business_strategist 的**結論段**;真正針對副品牌的
論證在 p7(「副品牌可以隔離部分品牌風險,但無法隔離營運資源」)與 p8(「即使叫 Content Lab,
實際執行仍然會使用同一批剪輯…資源」)。引用機制 works,但 **n=1 尚未顯示 gate 在 40 個候選中
會挑最精確的那個**。這正是 open question R-4,仍未解。

## 8. Selective R2 context —— PASS

讀 `calls[1].prompt` 原文:Original Task、Target Mission、Target Round1、**僅 p5 一段
peer chunk**、Challenge。`business_strategist` 的其餘 17 個 chunk **一個都沒進去**。
prompt 2188 字元 vs gate 5236 字元 —— **不是 full broadcast**。

精確性補充:R2 prompt 還含第六個區塊「Round 2 contract」(5 條),那是 rev.19 就有的
`buildRound2Prompt`,本次未改。該 contract 明文允許反駁(`Do not concede in order to
agree`)—— 沒有強迫 consensus。

## 9. Evidence invariants —— PASS(附 invariant 命名問題)

```
EvidenceLabel : HYPOTHESIS → HYPOTHESIS（並由 buildRunReport 從凍結 Round1 重算確認）
RunStatus     : SUCCESS → SUCCESS
banner        : before === after,且 finalOutput.startsWith(banner)
retrieval     : 三次 live call 的 request / result 全為 null
```

「Round 2 不得進 `workerResults` / `summarizeRetrieval()` / `deriveEvidenceLabel()`」
—— **性質成立**,但要點名它是**怎麼**成立的:

- 結構上:`workerResults` 在 `orchestrator.ts:459` 建立一次,之後無任何 append;
  `buildRunReport` 只在 line 491(production)與 951(replay)被呼叫,兩處都只吃 Round 1;
  `summarizeRetrieval` / `deriveEvidenceLabel` 只能從 `buildRunReport` 內部到達;
  `runCollaboration` 回傳 `{ answer, report }`,沒有通往 `workerResults` 的路徑。
- 證據上:`reportUnchanged` + `recomputedReportUnchanged` + `bannerUnchanged` 三項合起來
  就是這個性質的實證。

**但掛著這個名字的那條 invariant 不是。** 見 E4。

## 10. Failure semantics classification —— PASS

分層正確,沒有把 offline test 寫成 live failure injection。

**Live verified(真實 provider call,成功路徑):** Gate 執行 → valid issue 解析 →
sourceRef 解析 → Targeted R2 → Decision Synthesis。

**Offline-only(本次未 live 注入):** R2 failure fallback(`test-collaboration.mjs:535, 1060`)、
Decision Synthesis fallback(`:550`)、multi-issue deterministic 保護(`:189, 926`)、
malformed / schema_invalid 降級(`:224-238, 266, 302`)、validation 拒絕(`:348-381`)。

## 11. Claims discipline —— PASS

對 HANDOFF、evaluation.md、README.md 做禁語掃描(`p50 / p95 / average / 平均 / SLA /
production ready / 優於 baseline / 品質提升 / 多模型優於`),所有命中都是**否定句**或
**引用模型輸出**(`SLA` 出現在 challenge 原文裡,不是對系統的宣稱)。

evaluation.md 有兩處主動放棄有利敘事,值得記功:

1. 「#3 provisional 選 B、#4 provisional 選 C 是觀察,**不能歸因成 peer interaction 效果**」
   —— 我驗證了 #3 provisional 開頭確實是「決策:選 B」,#4 是「選 C」。自我設限正確且必要。
2. 主動記錄 verifier 曾因 `retrieval: undefined` 的 JSON 序列化而誤判,只改比較表示、
   未改 artifact、未重跑 live。

**另補一件文件沒宣稱但重要的事:headline decision 沒有翻轉。** #4 的 provisional 是 C,
final 也是 C。改變的是 C 的**條件結構** —— final 加上「封閉艙驗證 → 90 天後轉 B」的門檻,
並吸收了 brand_creative 在 R2 中從無條件 B 退到條件 B/否則 C 的修正。
**任何「peer challenge 改變了決策」的說法都是錯的**;正確說法是「改變了決策的附帶條件」,
而這是好是壞**未經證明**。

## Architecture concerns

**A1 —「strengthening」使 eligibility 判準接近恆真。** 見第 2 節。這是**已批准規格本身**的
性質,不是實作偏差。建議 architecture review **明知地**決定它是否該留。
**若日後出現過度觸發,這是第一個該懷疑的詞。**

**A2 — 三個限制中僅一個獨立且有 code 強制。** 見第 2 節 (b)。

**A3 — 限制性語氣(`only`)在 eligibility 段落消失,改為祈使的 `emit`。** 見第 2 節 (c)。
若要恢復 rev.19 的緊度,補一條明確限制句即可,不需動其他任何東西。

**A4 —(緩解)過度觸發的損害有界。** 見第 2 節 (d)。

## Experimental validity concerns

**E1 — #3 → #4 的差異是混淆的,而 artifact 自己證明了混淆非平凡。** 在 byte-identical
fixture 上,gate 自己的 provisional 從 #3 的 B 變成 #4 的 C。既然模型在該 stage 的輸出
**已被證實會變**,「#4 有 issue 而 #3 沒有」就無法在 n=1 vs n=1 下歸因於 wording change。
evaluation.md 已正確聲明這點,**不是文件缺陷**;但任何建立在「wording 修正生效了」之上的
後續決策,都需要兩種 wording 各跑多次。

**E2 — Round 2 的 model 未 pin。** `round2_worker` 以 `model: null` 派送(roster 兩位的
model 都是 null),由 adapter default 解成 gpt-5。`preflight.round2DefaultModels` 記了預期值
且吻合,但**未來 adapter default 一改,這個 hash-frozen replay 的 R2 臂會靜默改變**。
若 #4 要當日後的 comparator,建議把 R2 model 釘死。

**E3 — 單 provider。** 三次 live call 全是 openai / gpt-5。target 恰好是 brand_creative
(openai),`business_strategist`(claude)的 R2 路徑**從未執行**。跨 provider 的即時合作
未驗證。evaluation.md 已揭露。

**E4 — `noRound2Leak` 是該性質的弱代理。** `!Object.hasOwn(result,'workerResults')` 在
replay path 上**恆真**(`replaySynthesis` 本就不回傳該欄位),即使 production path 真的
洩漏也會 PASS。真正撐住該性質的是第 9 節列的三條 invariant 加結構論證。
建議改名或改基,讓證據標籤等於實際檢查。

**E5 — chunk 精確度未驗。** 見第 7 節,對應 open question R-4。

## Documentation inconsistencies

**D1 — 兩個新測試名稱超出其實際 assert 範圍。**
`a provisional compromise does not disqualify a material Round 1 conflict` 與
`equivalent recommendations and non-material differences remain excluded` 都跑在
**scripted** gate response 上,驗的是 prompt 文字 + runtime 分支,不是模型判斷。
檔案自己在上方註解已寫明(`These lock the delivered prompt contract and scripted runtime
behavior, not LLM judgment`)—— **在上下文中沒有失實**,但只掃 pass list 的讀者會誤以為
排除行為已被離線證明。建議改成 `…prompt states…` 形式。

**D2 — 第四個測試名稱的「remain byte-equivalent」是同一 build 內的 parity 測試。**
它比較 `run()`(omitted)與 `run({collaboration:false})`,**偵測不到跨 revision 漂移**。
跨 revision 的保證只來自 committed 的 control-before/after artifact。應寫明,以免日後有人
單靠離線套件來守這條線。

**D3 —(既存,非 rev.20 回歸)`result.timings.synthesisMs` = 46729 只記 gate,**
而交付答案來自 decision_synthesis(68965ms)。`collaboration.timings` 拆得正確,
`result.timings.totalMs` = 158408 也正確。這是 rev.19 就有的行為,本次 diff 未觸及 ——
僅標記以免日後有人把 `synthesisMs` 讀成「產生最終答案的成本」。

## 為什麼不當場修

1. **指令書明文禁止**:本輪只做 review,`Do not implement any follow-up changes`。
2. **D1 / D2 要動 `test-collaboration.mjs`** —— 那是 rev.20 acceptance 的一部分,
   改了就得重跑並重新宣稱 212,不該夾帶在 review 裡。
3. **E4 要動 `harness.mjs`,而它在封印裡。** `diagnostics/m2a-live/controlled-replay-4/
   hashes.json` 涵蓋該目錄下所有檔案(含 `harness.mjs`),`verify.mjs` 會逐檔比對。
   **在原地改名會直接破壞 Replay #4 的封印,使既有證據失效。**
   → 這項只能在**下一次 replay 的 harness** 修,不能回頭改。

## Final recommendation

```
ACCEPT WITH DOCUMENTATION CORRECTION
```

production diff 乾淨(單檔單 hunk),證據鏈可獨立重現。`verify.mjs` 用 **production
function** 從 committed source + committed response text 重推每個 downstream 欄位,
這讓 artifact 不是敘述而是**可重算的紀錄**。文件的 claims discipline 通過,且有兩處
主動放棄有利敘事。

需要修正的是 **D1 / D2 / E4 三處標籤與其實際證明範圍的落差** —— 都是文件與命名,不是 code。

**A1(`strengthening`)不列為 accept 的阻礙**,因為它是已批准規格的內容而非實作偏差;
但它應該在 M2-A 本來就在等的那次 architecture review 裡被**明知地**決定,而不是預設留著。

**狀態:M2-A 仍 STOPPED / AWAITING ARCHITECTURE REVIEW。本輪未實作任何 follow-up 變更。**


<!-- END VERBATIM E-14 -->

---

# PACKET END

```
packetVersion : GEMINI-M2B-PACKET-1
branch HEAD   : 339d700201ee493f592b6a9a56b3e96248bd6f8d
HANDOFF       : 339d700201ee493f592b6a9a56b3e96248bd6f8d  sha256 f83caa5e6dada8de303b9901172a791a2702765521cf3c996dd3482781567523
M2 EXPERIMENT : 734ad8e1e7f681c6e3d4548383a267ca624304a0  sha256 1f9cd428251b014384019833c1c2cc51e85d9946b281684da4c956298c2a10c7
```

**下一步(依 `AI_COLLAB_WORKFLOW_RULES.md` §7.1、§40):**

```
Gemini  → Independent Methodology Analysis（本 packet 為 frozen input）
User    → 將 latest HANDOFF.md + M2_EFFECTIVENESS_EXPERIMENT.md + Gemini review
          一併交回 GPT Architecture Review
GPT     → ACCEPT / ACCEPT WITH CORRECTION / REVISE / DEFER / REJECT

在 GPT 明確批准前：
  NO implementation
  NO live experiment
  NO harness 撰寫
  NO productionization
  NO 下一個 milestone
```
