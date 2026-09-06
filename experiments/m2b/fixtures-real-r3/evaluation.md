# M2-B Replacement Real Round1 Capture — Set R3

## 結果

```text
PARTIAL /
R3 POSITIVE SET INCOMPLETE /
REQUIRES GPT ARCHITECTURE REVIEW /
LIVE PILOT NOT AUTHORIZED
```

三個 candidate 都只執行一次。F1/F2/F3 全過,但三題在只讀 task、actual missions、
actual Round1 outputs 的 obvious pre-Gate screen 都呈現 substantive agreement。
因此未組成 provisional final set,未生成 clean-room packets,未執行 Gate 或任何後續階段。

## Freeze 與範圍

- Starting HEAD:`d9ad17599b3a8c6a918062d899ba34f6b17c8e3b`
- R3 freeze/harness commit:`1fb5eb5fc4808c35a5ac0ddd30e78f031b09b59d`
- Accepted production boundary:`d01043b6c520c29473e3960c60bad28aec9719ed`
- Branch:`experimental/m2a-peer-challenge`
- Production `src/**`:與 accepted boundary 同一 Git tree `378f80cbc713e22ad136d4b7ee26de221132de49`
- Live policy:`ROUND1_CAPTURE_ONLY`
- Hard ceiling:12;observed:9
- Runtime fingerprint:start/end 都是 `54e0d5853297ac12acae46e5b7b091c00a3daa7f3bf28b3a4127c41d0953aa8f`

三份 task 在首次 provider call 前已 commit/push。Task hashes:

| fixture | SHA-256 |
|---|---|
| fxr-09 | `0aa4859ee1a6027becf4183f5d98784c1c2b908e67c30a974afcab7699bbe525` |
| fxr-10 | `e1eb8ec9d5812ec93803b9c5450f3e0ace9768cb45a7480923309488007088b1` |
| fxr-11 | `726adca19d4bee91a16896dee4f6971e204d91914f8e5eaa0eb29855dc5afecf` |

## Candidate 結果

| fixture | complexity | assignments | successful | status | worker provider/model | calls | F1/F2/F3 | pre-Gate screen | final |
|---|---|---|---:|---|---|---:|---|---|---|
| fxr-09 | deep | business_strategist,brand_creative | 2 | SUCCESS | openai/gpt-5 | 3 | PASS/PASS/PASS | 兩位都選 A | FAILED_PRE_GATE_SCREEN |
| fxr-10 | deep | business_strategist,brand_creative | 2 | SUCCESS | claude/claude-sonnet-5 | 3 | PASS/PASS/PASS | 兩位都支持第18週第一波、其餘分波 | FAILED_PRE_GATE_SCREEN |
| fxr-11 | deep | business_strategist,brand_creative | 2 | SUCCESS | gemini/gemini-3.1-pro-preview | 3 | PASS/PASS/PASS | 兩位都選 B | FAILED_PRE_GATE_SCREEN |

完整 raw planning、missions、provider responses、call records、snapshots、reports 與 manifest
皆在各 fixture 目錄。Production verifier 重算 R3 capture 149/149,另重算 synthetic 36/36。

## Chief 原始 reason

### fxr-09

> This is a company-level strategy choice needing financial/tradeoff logic and brand/CX implications. External market data is disallowed, so a market researcher adds little. Two specialists can deliver a high-quality, focused recommendation with risks and flip conditions.

### fxr-10

> Decision hinges on two domains only: strategic/contract risk and creative approval capacity. No external research is allowed or needed. Business strategist integrates the final A/B/C with non-negotiables; brand/creative quantifies throughput and bottlenecks to inform feasibility. This is the minimum sufficient collaboration for a high-stakes contract decision.

### fxr-11

> Board‑level choice needs rigorous data/financial read and brand architecture judgment. No external research is allowed; a market researcher would add little. Two specialists can deliver a defensible recommendation with minimal overlap.

## Pre-Gate screen

`fxr-09`:business_strategist 明寫「建議擇 A」;brand_creative 明寫「建議:A」。
兩者都承認價格/品牌/客資風險,但同樣以護欄支持 A,沒有核心決策衝突。

`fxr-10`:business_strategist 明確選 B。brand_creative 自我限縮不做最後 A/B/C 商業選擇,
但它的交付結論明確支持「Wk18 第一波、其餘分波」來緩解 CD 單點瓶頸,與 B 的核心內容相同。
「全同步理論上並非不可能」是條件化可行性描述,不是與 B 對立的建議。

`fxr-11`:兩位第一句都明確選 B,且都把 56% 新客/21% 升級視為保留入門市場的訊號,
把促銷依賴、選址偏差、-9% 高價營收與高階印象下降視為反對 A 的理由。

逐字 evidence quotes 見 `pre-gate-screen.json`。這是 obvious agreement screen,
不是 clean-room ground truth,也未代 Gemini 撰寫 `materialConflict` label。

## Provenance 與 call accounting

三次 planning 都 requested/resolved `openai/gpt-5`。六次 worker calls 依 fixture 分別為:

- fxr-09:`openai/gpt-5` → `openai/gpt-5`
- fxr-10:`claude/claude-sonnet-5` → `claude/claude-sonnet-5`
- fxr-11:`gemini/gemini-3.1-pro-preview` → `gemini/gemini-3.1-pro-preview`

Stage counts:`planning=3`,`round1_worker=6`,total R3=9。
所有 call 的 `retrievalRequested=false`,`retrievalResult=null`,
`temperatureRequested=null`;所有 raw worker output 與保存的 provider response byte-identical。

累計 real-Round1 live calls:`R1=10`,`R2=10`,`R3=9`,`TOTAL=29`。

## 歷史與禁止事項

R1、R2、synthetic fixtures/evaluation 與 Replay #4 的 Git trees 都與 starting HEAD 相同。
Replay #4 artifact seal:INTACT;historical runtime fingerprint:
`MISMATCH — EXPECTED AFTER APPROVED d01043b REFACTOR`;disabled/omitted behavioral control:
PASS,16 cases,`f50a7b2ee2a8b7f896dc6a6b88692d612281553011a1de685b2e39c9a567c698`。

```text
synthesis = 0
synthesis_gate = 0
round2_worker = 0
self_review = 0
decision_synthesis = 0
temperature probe = NO
Gemini annotation = NO
pilot = NO
main merge = NO
src changes = NONE
```

Packets:`NOT GENERATED — R3 incomplete`。Provisional final set:`NOT ASSEMBLED`。
未建立 R4,未 retry,未修改 task,未重新封印歷史 artifact。

**STOPPED / AWAITING GPT ARCHITECTURE REVIEW**
