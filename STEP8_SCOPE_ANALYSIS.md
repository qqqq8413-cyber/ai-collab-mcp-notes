# Step 8 V1 — Cost / Token / Latency Tracking Scope Analysis

**Status:** ANALYSIS COMPLETE — NOT IMPLEMENTED — AWAITING ARCHITECTURE REVIEW

**Date:** 2026-09-05

**Code baseline:** `d80416701690fc380a6aa160723ec71aa97419d6` (`main`)
**Scope guard:** Step 7 V1 已驗收並凍結；本文件不修改 runtime、測試或 execution policy。

---

## 1. Executive decision

Step 8 不應從「加一個 `totalCostUsd`」開始。目前 codebase 已從三家 provider 收到部分 usage metadata，但 adapters 在 `CallResult` 邊界將它們丟棄；orchestrator 只有 phase-level wall-clock timing，沒有 call ledger。若直接套用目前的兩欄 token price schema，會把 cache、thinking/reasoning、service tier、tool/search request、context threshold 與 unknown coverage 壓成看似精確、實際不可稽核的數字。

建議把 Step 8 拆成四個明確層次：

1. **Runtime usage truth**：忠實保存 provider response 實際回報的欄位；缺值就是 unknown，不做 tokenizer 估算。
2. **Pricing registry**：版本化保存經人工驗證的公開計價規則；不由 runtime usage 猜價格。
3. **Cost calculation**：只在 usage 與 price rule 可完整、唯一匹配時產生 public-list estimate。
4. **Run-level reporting**：呈現 call、phase、run 三種 latency，以及 usage/cost coverage；partial subtotal 不冒充 total。

**推薦 V1 邊界：先落地 runtime usage truth、per-call telemetry 與 run-level token/latency reporting；同時定義 pricing/cost contracts，但保持 price book 為空、cost 為 unavailable。** 經 architecture review 後，再以獨立、可審核的價格資料提交啟用 monetary estimate。

這個順序先建立計算成本必需的可信分母。

---

## 2. Code reality audit

### 2.1 實際 dependency baseline

`package.json` / lockfile 與本機安裝版本一致：

| Provider | SDK | 實際版本 | API surface |
|---|---|---:|---|
| OpenAI | `openai` | `7.10.0` | `chat.completions.create` |
| Anthropic | `@anthropic-ai/sdk` | `0.123.0` | `messages.create` |
| Gemini | `@google/generative-ai` | `0.24.1` | `generateContent` |

以下判讀以這些 pinned types、目前 adapter 程式與官方文件交叉驗證，不假設較新 SDK 的型別已存在於 runtime。

### 2.2 Provider adapter 現況

`src/providers/types.ts` 的 `CallResult` 目前只有：

```ts
interface CallResult {
  provider: string;
  model: string;
  text: string;
  retrieval?: RetrievalResult;
}
```

因此 provider 回應離開 adapter 後，usage 已不可恢復：

| Adapter | response 中可見 | 現行程式怎麼用 | 回傳給 orchestrator |
|---|---|---|---|
| OpenAI | `response.usage` | 只在空輸出錯誤中讀 `reasoning_tokens` | usage 全部丟棄 |
| Anthropic | `response.usage` | 只在空輸出錯誤中讀 `thinking_tokens` | usage 全部丟棄 |
| Gemini | `response.usageMetadata` | 完全未讀 | usage 全部丟棄 |

`src/providers/index.ts` 只做 provider dispatch，沒有共用 timing 或 telemetry wrapper。`pipeline.ts` 與 `debate.ts` 同樣只取文字，沒有 usage 或 timing report。

### 2.3 Orchestrator timing 現況

`src/modes/orchestrator.ts` 用 `Date.now()` 在 `runOrchestrator()` 外層量測：

```text
startedAt
  planningStart  -> planning call + local plan parsing/enforcement -> planningMs
  workersStart   -> Promise.all(all workers)                       -> workersMs
  synthesisStart -> synthesis call + prompt/result handling       -> synthesisMs
                                                              end -> totalMs
```

重要語意：

- `workersMs` 是平行 workers 的 **wall-clock span**，不是各 worker duration 的總和。
- `totalMs` 可以小於所有 provider call durations 相加，因為 workers 平行執行。
- phase timing 包含鄰近的本機 parsing、prompt building 或 policy work，不是 provider server latency。
- MCP transport 建立、client-side serialization 與 `runOrchestrator()` 外部時間不在 `totalMs` 內。
- Step 7 direct-delivery 與全敗路徑目前都以 `synthesisMs: 0` 表示未執行 synthesis；真正原因要讀 `report.policy`。
- planning 或 synthesis throw 時，函式不會回傳 run report；worker failure 則會被收進既有 `WorkerRunResult`。
- `Date.now()` 是 wall clock。新增 per-call duration 應使用 monotonic clock；現有欄位先保留相容性，避免 Step 8 偷改 Step 7 contract。

### 2.4 現有 pricing 與 budget 並非 cost truth

`src/models/capabilities.ts` 已有 optional `ModelPricing`：

```ts
interface ModelPricing {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  source: string;
  checkedOn: string;
}
```

目前所有 model profile 都刻意未填 pricing；`modelsMissingPricing()` 與 `list_models` 已正確表達「unknown，不是 zero」。這個兩 rate schema 也不足以表示 cache read/write、service tier、context threshold、modality、region 或 tool request 費用。

`maxCostUsd` 與 `maxLatencySeconds` 目前只被寫進 Chief planning prompt。除了 `maxSpecialists` 外，runtime 沒有 pricing、usage 或 deadline enforcement，因此它們是 **planning hints**，不是已執行的 hard budget。Step 8 V1 不應宣稱已可保證預算。

---

## 3. Runtime usage truth by provider

### 3.1 OpenAI

目前使用的 non-streaming Chat Completions response 將 `usage` 定義為 optional。Pinned SDK 可取得：

- `prompt_tokens`
- `completion_tokens`
- `total_tokens`
- optional prompt details：`cached_tokens`、`cache_write_tokens`、text/image/audio token breakdown
- optional completion details：`reasoning_tokens`、accepted/rejected prediction、text/audio token breakdown
- response-level `model`，以及可能的 `service_tier`

目前 adapter 只讀取 `choices[0].message.content`，並在空文字錯誤訊息中碰到 reasoning token；所有 counters 與 response model 都未保存。官方 Chat response 也明確回傳「實際使用的 model」，因此 schema 應同時保留 `requestedModel` 與 `reportedModel`，不可把 alias 當成已解析的 billing key。參考：[OpenAI Chat API reference](https://developers.openai.com/api/reference/resources/chat)。

**Gap：** `usage` 可缺；目前沒有 verified mapping 能把回傳 model/tier 唯一映射到 price rule。SDK 的 retry 次數也沒有流入 adapter，不能從一次 logical call 的 duration 猜 HTTP attempts。

### 3.2 Anthropic

Pinned `Message.usage` 是 required，並提供：

- `input_tokens`
- `cache_creation_input_tokens`
- `cache_read_input_tokens`
- `output_tokens`
- cache creation TTL breakdown
- `output_tokens_details.thinking_tokens`
- `server_tool_use.web_search_requests` / `web_fetch_requests`
- `service_tier`
- `inference_geo`

Anthropic 的 `input_tokens` 不是含 cache 的總輸入。官方公式是：

```text
total input = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
```

因此不可只拿 `input_tokens` 乘 input rate，也不可把 null cache 欄位當成「已確認為 0」。參考：[Anthropic rate-limit token semantics](https://platform.claude.com/docs/en/api/rate-limits) 與 [Anthropic pricing categories](https://platform.claude.com/docs/en/about-claude/pricing)。

**Gap：** API 沒有單一 `total_tokens`；總輸入只能由 provider-reported components 做可追溯 derivation。工具請求、cache 類別、service tier 與 geography 都可能有獨立計價語意，目前兩 rate schema 無法表示。

### 3.3 Gemini

Pinned `@google/generative-ai@0.24.1` 的 `UsageMetadata` 型別只有：

- `promptTokenCount`
- `candidatesTokenCount`
- `totalTokenCount`
- optional `cachedContentTokenCount`

目前官方 GenerateContent schema 另列 `thoughtsTokenCount`、`toolUsePromptTokenCount` 與各 modality breakdown；這表示 installed SDK types 落後於當前 API schema。V1 可以可靠讀 pinned type 已知欄位，但對新欄位必須採 allowlisted optional parsing，不能假設每個 response 或舊 SDK 都會帶回。參考：[Gemini GenerateContent UsageMetadata](https://ai.google.dev/api/generate-content)。

現有 Gemini grounding normalization 會保存 `webSearchQueries` 與 `queryCount`，但：

- 沒有 metadata 不代表已確認為 0 requests。
- `groundingChunks` / sources 數量不等於 search query 數量。
- provider 的定價規則可能以個別 query、grounded prompt、tier 或月度 allowance 為單位；runtime 沒有帳戶 allowance 狀態。

官方價格頁顯示 token、cache、modality 與 grounding 不是單一 rate，且一個 request 可能觸發多個 search queries。參考：[Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)。

**Gap：** pinned SDK 不完整；目前 `queryCount` 是 grounding metadata observation，不應自動升格成 billable request truth。若沒有 provider billing counter，grounding cost 應保持 unknown。

---

## 4. Recommended schema

### 4.1 原則

1. Optional 必須保持 optional；missing 不轉成 `0`。
2. 不以字串長度、通用 tokenizer 或 `total - input` 補 provider 欄位。
3. Provider-native facts 與 normalized/derived metrics 分開。
4. 每個 derived value 要列出來源欄位與 derivation rule。
5. 金額使用 decimal string 或整數最小貨幣單位，不用 binary floating-point 累加。
6. Telemetry 不複製 prompt、API key 或 raw model output。

### 4.2 Call-level runtime truth

建議由 provider adapter 保存 usage，generic dispatcher 量 call duration，orchestrator 加上 stage/agent context：

```ts
type ProviderId = "openai" | "anthropic" | "gemini";
type CallStage = "planning" | "worker" | "synthesis";

type RuntimeUsage =
  | {
      status: "reported";
      provider: ProviderId;
      reported: ProviderReportedUsage;
      normalized: {
        providerInputTotalTokens?: MetricValue;
        providerOutputTotalTokens?: MetricValue;
        providerTotalTokens?: MetricValue;
        cachedInputTokens?: MetricValue;
        cacheCreationInputTokens?: MetricValue;
        candidateOutputTokens?: MetricValue;
        reasoningOrThinkingTokens?: MetricValue;
        toolPromptTokens?: MetricValue;
        webSearchRequests?: MetricValue;
        webFetchRequests?: MetricValue;
      };
    }
  | {
      status: "unavailable";
      provider: ProviderId;
      reason: "not_reported" | "call_failed_before_response";
    };

type ProviderReportedUsage =
  | OpenAIReportedUsage
  | AnthropicReportedUsage
  | GeminiReportedUsage;

interface MetricValue {
  value: number;
  basis: "provider_reported" | "derived_from_provider_reported";
  sourceFields: string[];
}

interface ProviderCallTelemetry {
  callId: string;                 // local stable ID, not a provider request ID
  stage: CallStage;
  agentId?: string;
  provider: ProviderId;
  requestedModel: string;
  reportedModel?: string;
  outcome: "succeeded" | "failed";
  startedAt: string;              // audit timestamp
  durationMs: number;             // local monotonic elapsed time
  usage: RuntimeUsage;
}
```

`OpenAIReportedUsage`、`AnthropicReportedUsage` 與 `GeminiReportedUsage` 應是 discriminated interfaces，只列第三節已驗證的原生欄位與型別；nested details/modality arrays 也明確建模。這是 allowlist，不是把整份 SDK response dump 進 report。Provider request ID、server processing time、retry count 等欄位只有實際取得並驗證型別後才新增；V1 不預留假值。

Gemini 的 `candidateOutputTokens` 刻意不自動升格成 `providerOutputTotalTokens`，因為 pinned shape 缺少 thoughts/tool prompt details 時，不能證明它代表完整輸出計價基礎。三家共有欄位只在語意相容時才 normalized；其餘仍留在 provider-native union。

### 4.3 Run-level aggregation

```ts
interface AggregateMetric {
  observedSubtotal: number;
  reportedCalls: number;
  applicableCalls: number;
  completeness: "complete" | "partial" | "unavailable";
}

interface RunTelemetry {
  schemaVersion: 1;
  calls: ProviderCallTelemetry[];
  phases: {
    planningMs: number;
    workersWallMs: number;
    synthesisMs: number;
    totalMs: number;
  };
  tokens: {
    input: AggregateMetric;
    output: AggregateMetric;
    total: AggregateMetric;
  };
  usageCoverage: {
    succeededCalls: number;
    usageReportedCalls: number;
    usageUnavailableCalls: number;
    failedCalls: number;
  };
}
```

Aggregation 規則：

- `observedSubtotal` 只加總已回報值；coverage 不完整時不得命名為 `total`。
- `applicableCalls` 是實際發生的 calls。Step 7 direct path 沒有 synthesis call，因此 ledger 中 **沒有 synthesis record**，不是一筆 0-token call。
- Failed call 可以有 duration/outcome；若沒有成功 response usage，`usage.status = unavailable`，不填 0。
- `calls` 依 planning、assignment order、synthesis 排序。Worker 內部仍可平行，不能以 promise completion order 造成報表不穩定。
- 保留現有 `timings` contract；新 `phases.workersWallMs` 可映射既有 `workersMs`。Per-call durations 與 phase wall time 並列，不能互相替代。

### 4.4 Pricing registry

Pricing 應從 capability registry 分離，因為 capability fact 與商業規則有不同版本生命週期：

```ts
interface PriceBook {
  id: string;
  currency: "USD";
  sourceUrls: string[];
  checkedAt: string;
  effectiveFrom?: string;
  effectiveUntil?: string;
  entries: PriceRule[];
}

interface PriceRule {
  id: string;
  provider: ProviderId;
  exactModel: string;
  apiSurface: "chat_completions" | "messages" | "generate_content";
  serviceTier?: string;
  region?: string;
  modality?: string;
  contextBand?: { minTokens?: number; maxTokens?: number };
  category:
    | "input"
    | "cached_input"
    | "cache_write"
    | "output"
    | "web_search_request"
    | "web_fetch_request"
    | "search_query"
    | "grounded_prompt";
  billingUnit: "token" | "request" | "query" | "grounded_prompt";
  cacheTtl?: string;
  rate: { amountUsd: string; perUnits: number };
}
```

Registry policy：

- 僅 exact model key；未審核 alias/prefix 不做 wildcard fallback。
- 每本 price book 必須有官方 source、查核日期與版本 ID。
- 公開價只能標為 `public_list_estimate`，不可叫 actual invoice cost。
- Account-specific discount、free allowance、batch/priority/flex tier、region 或 billing platform 不明時，price match 失敗而不是採預設值。
- 本分析不填任何價格。現行 `ModelPricing` 也保持空白，直到另一次 architecture/data review。

### 4.5 Cost calculation

```ts
interface CostReport {
  status: "estimated" | "partial" | "unavailable";
  basis?: "public_list";
  priceBookId?: string;
  knownSubtotalUsd?: string;
  estimatedTotalUsd?: string;
  lineItems: CostLineItem[];
  unknownReasons: string[];
}

interface CostLineItem {
  callId: string;
  usageCategory: PriceRule["category"];
  units: number;
  priceRuleId: string;
  estimatedUsd: string;
}
```

計算不變式：

- 只有所有 applicable usage categories 都有唯一 price rule 時，才填 `estimatedTotalUsd`。
- Partial 可呈現 `knownSubtotalUsd`，但不得複製到 `estimatedTotalUsd`。
- 沒 usage、沒 exact price、tier/region/allowance 不明或 billing unit 不吻合，都要列 `unknownReasons`。
- Provider 回報的 0 可以計成 0；provider 沒回報不能計成 0。
- Rounding 規則集中且可測，只在 line item / final display 的既定位置處理。
- V1 不用 post-hoc cost report 宣稱 pre-run `maxCostUsd` 已被 enforce。

---

## 5. Recommended data flow

```text
Provider SDK response
  -> provider adapter extracts text + allowlisted native usage + reported model/tier
  -> generic call wrapper adds local monotonic duration and outcome
  -> orchestrator attaches stage + agentId
  -> deterministic call ledger
  -> coverage-aware token aggregation
  -> exact pricing lookup (empty in proposed V1)
  -> pure cost calculator
  -> run report serialization
```

Ownership 建議：

| Concern | Owner |
|---|---|
| Provider field extraction / semantics | `src/providers/*` |
| Generic duration + call metadata | provider dispatcher / dedicated telemetry wrapper |
| Stage、agent、ordering、phase wall time | `src/modes/orchestrator.ts` |
| Aggregation | pure telemetry module |
| Pricing records | separate versioned registry module/data |
| Cost arithmetic + coverage | pure cost module |
| MCP JSON exposure | existing run result/report boundary |

不要讓 orchestrator 直接讀三家 SDK shapes，也不要讓 adapters 知道 planning/worker/synthesis。這能保留 provider-specific truth 與 orchestration context 的責任邊界。

### Failure-path limitation

目前 planning/synthesis failure 會 throw，沒有可回傳的 run report。V1 不應為了 telemetry 順手重寫整個 error contract。建議 V1 保證：

- 所有成功回傳的 orchestrator runs 都有完整 call ledger。
- Worker failures 依現有 degraded/failed flow 記 outcome、duration 與 unavailable usage。
- Planning/synthesis throw 的 durable failed-run reporting 另列後續 scope；若 architecture review 要求它進 V1，需先明確定義 error envelope，不能靠 side effect/global collector 偷存。

---

## 6. Provider-specific normalization rules

| Metric | OpenAI | Anthropic | Gemini |
|---|---|---|---|
| Input | `prompt_tokens` | 三個 provider-reported input components 的可追溯和 | `promptTokenCount` |
| Cached input | `cached_tokens` if present | `cache_read_input_tokens` | `cachedContentTokenCount` if present |
| Cache creation | `cache_write_tokens` if present | `cache_creation_input_tokens` | V1 unknown unless API explicitly reports compatible field |
| Output | `completion_tokens` | `output_tokens` | `candidatesTokenCount`；若 thoughts 另報，二者保持分項，不猜完整 billable output |
| Reasoning/thinking | `reasoning_tokens` if present | `thinking_tokens` if present | `thoughtsTokenCount` only when runtime actually returns it |
| Provider total | `total_tokens` | 無直接欄位；derived total 必須標示公式 | `totalTokenCount` |
| Tool requests | 無現行 runtime field | server tool request counters if present | grounding metadata 只當 observation，非 billing truth |

不要強迫三家共享一個「billable tokens」欄位。Token semantics 不完全同構，cost calculator 應使用 provider-native category 與明確 rule，而不是只吃 normalized input/output。

---

## 7. Test strategy

### 7.1 Provider extraction unit tests

- 三家各用 typed fixture 驗證已知 usage 欄位逐項保存。
- 分別測 optional missing、explicit `0`、`null` 與額外未知欄位。
- 驗證 Anthropic total input derivation 的 components/provenance。
- 驗證 Gemini 新欄位存在時可 allowlisted 保存、舊 pinned shape 仍可運作。
- 驗證 `requestedModel` 與 `reportedModel` 不被互相覆蓋。

### 7.2 Orchestrator contract tests

- Injected planning/worker/synthesis results 帶 deterministic usage fixture。
- 多 workers 平行時 ledger 維持 assignment order。
- 驗證 `workersWallMs` 不等於 worker durations 總和，且 run total 可小於 call-duration sum。
- Step 7 direct delivery 只有 planning + worker records；`policy`、raw output 與既有 timings 不變。
- NORMAL/DEEP 與 retrieval 仍有 synthesis record。
- Worker partial/all failure 不製造 0 usage；status/banner/policy 行為不變。
- Usage partial coverage 只能產生 observed subtotal，不產生完整 total。

### 7.3 Pricing / cost pure tests

- Exact model/tier/category match 才能選中 rule。
- Missing、duplicate、expired/ambiguous、wrong API surface、unknown tier/region 一律 unavailable。
- Cache、reasoning/output、tool request 分項計算，不能 double count。
- Partial cost 只有 known subtotal，沒有 estimated total。
- Decimal arithmetic 與 rounding boundary 測試。
- Empty registry 永遠不回傳零成本。

### 7.4 Compatibility and security

- 現有 99 項離線測試必須全過。
- MCP serialization snapshot 驗證沒有 prompt、output duplication、API key 或整份 raw response。
- Typecheck/build 驗證 pinned SDK，不以 `any` 掩蓋 provider shape。
- Architecture review 與 offline tests 完成後，才各跑一次三家 live smoke，保存 raw usage shape、SDK version 與 model response；live smoke 是 contract validation，不是成本或 latency distribution benchmark。

---

## 8. Proposed V1 scope

### In scope

1. 擴充 `CallResult`，保存 allowlisted provider-native usage、requested/reported model 與 optional tier/region facts。
2. 為每次 logical provider call 量 monotonic local duration。
3. Orchestrator 建 deterministic planning/worker/synthesis call ledger。
4. Coverage-aware token aggregation；unknown、partial、reported zero 三者可區分。
5. 保留現有 `timings` 與 Step 7 policy/output behavior。
6. 定義獨立 pricing registry 與 cost result contracts，但 price book 保持空白。
7. Run report 明示 cost unavailable reason；不輸出假總額。
8. 完整 offline fixture/contract tests；review 後才做最小 live shape validation。

### Explicitly out of scope

- 填入或自動爬取 provider prices。
- 以 public list price 宣稱 actual invoice cost。
- Pre-run hard cost/latency enforcement。
- Token estimation fallback。
- SDK migration、streaming、retry instrumentation 或 provider dashboard reconciliation。
- Pipeline/debate run-level reporting rollout；schema 需可重用，但 V1 先接 orchestrator。
- Planning/synthesis thrown-error envelope redesign。
- Step 7、Model Router、Validation Layer 或 execution topology 修改。

### Acceptance gates

V1 implementation 在 architecture review 後才可開始，且需符合：

1. 三家 adapter fixtures 能證明所有輸出數字來自 provider-reported fields 或明示 derivation。
2. 任一缺失資料都不被序列化成 0。
3. Parallel worker latency 同時呈現 wall time 與 per-call time，命名無歧義。
4. Empty/unmatched pricing registry 不會產生 monetary total。
5. Existing Step 7 direct-delivery byte equality、call count、policy 與 99 tests 不回歸。
6. Live contract check 前不宣稱已驗證 production usage shape。

---

## 9. Architecture review questions

1. 是否接受「V1 先建立 usage/latency truth，pricing contracts 定義但 registry 保持空」？
2. `reported` 採 per-provider discriminated union，還是 JSON-safe allowlist map？前者型別較強，後者較容易容納 SDK drift；建議 discriminated union。
3. 是否要求 planning/synthesis throw 也必須產生 durable failed-run report？若是，需擴大 V1 error contract scope。
4. Public price book 應由 code review 管理，還是獨立 versioned data artifact？建議獨立資料檔但同 repo review。
5. Cost report 的對外名稱是否統一為 `publicListEstimate`，避免與 provider invoice 混淆？

在上述決策完成前，Step 8 維持 **NOT IMPLEMENTED**。
