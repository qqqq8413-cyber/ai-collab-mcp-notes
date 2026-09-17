# CHIEF

**Before you send this artifact, know which parts you cannot defend.**

CHIEF is decision-audit infrastructure for AI-assisted review, revision, and
human adjudication. It doesn't just help produce an artifact — it produces
the record of *how* it was produced: which issues were raised against it,
whether a human actually authorized acting on each one, what was changed in
response, and whether that change is provably present in whatever came next.

## The pipeline

```
review → deliberation → human adjudication → revision → successor verification
```

- **Review** — issues and findings are raised against a draft artifact
  (`SemanticIssue`, `ReviewFinding`).
- **Deliberation** — those issues are routed and reasoned about
  (`DeliberationState`, `RouteOutcome`) before anyone is authorized to act.
- **Human adjudication** — a human, not the model, decides whether each
  finding is actionable. Nothing downstream can act on an issue without an
  explicit, recorded YES.
- **Revision** — a `RevisionAction` is taken, and it can only cite source
  references that trace back to a YES-adjudicated finding. Every action's
  status (`PLANNED` / `IMPLEMENTED` / `REJECTED`) is part of the audit trail.
- **Successor verification** — when a revised artifact exists, CHIEF doesn't
  take "fixed" on faith. `RevisionSuccessorBinding` cryptographically links
  the source and successor artifacts, and `RevisionVerification` records
  whether the change is actually present in the successor
  (`VERIFIED_PRESENT` / `NOT_PRESENT` / `INCONCLUSIVE`) — closing the loop
  between "we said we'd fix it" and "it's actually in the file."

**AI assists; human authority remains final.** Every write path in this
system checks the full ledger before trusting or mutating anything locally —
a model can raise an issue and propose a revision, but it cannot authorize
its own action, and it cannot claim a verification it hasn't earned.

## Current state

The decision-audit engine above (`src/stress-test/`) is implemented and
covered by an extensive offline test suite (853 tests, 0 live API calls as
of this writing — see build/test instructions below). **It is not yet wired
into the MCP server's tool surface.** The MCP server this repository builds
today exposes an earlier, separate layer of this project instead —
multi-model orchestration across Claude, GPT, and Gemini (`run_pipeline`,
`run_orchestrator`, `run_debate`) — documented in full below.

---

## 專案技術細節(Technical details / build / tests)

此 repository 包含可建置的 MCP server、離線測試與交接紀錄。最新狀態見 [HANDOFF.md](HANDOFF.md);歷史架構分析見 [STEP7_SCOPE_ANALYSIS.md](STEP7_SCOPE_ANALYSIS.md)。

目前狀態:

- **Step 7 V1 IMPLEMENTED** —— 僅 SIMPLE、恰好一位成功且輸出非空的 Worker、non-retrieval 執行會原樣直接交付,其餘路徑保留原行為。`report.policy` 記錄是否 synthesis 及原因,`synthesisAllowed` 保留原 Run Status 的失敗保護語意。
- **Experimental Milestone 2-A —— default OFF,尚未 productionize。** Targeted peer challenge 的 prototype,只在 `deep`、Round 1 SUCCESS 且至少兩位專家時才可能啟動,最多一位 Round 2 specialist,Round 2 不做檢索。不傳 `experimental` 參數時,執行行為與回傳 payload 與加入前逐欄相同(有測試斷言)。
- **三次 diagnostic live 的機制後半段仍未被執行過** —— parser 成功路徑、sourceRef 解析、Round 2 與 Decision Synthesis 皆為零次真實執行。證據見 `diagnostics/m2a-live/`,判讀見 HANDOFF 第二十一〜二十三節。

### 建置與離線測試

本次使用 Node.js v24.15.0 驗證。從 repository 根目錄執行:

```sh
npm ci
npm test
```

`npm test` 先編譯 TypeScript,再執行 208 項離線測試與 MCP smoke tests。全部不需要 API key。其中 36 項是 execution-policy tests,另有 M2-A 的 stage instrumentation、call ceiling、best-effort parsing、issue 驗證、deterministic selection、selective peer context、失敗回退與 evidence 不變式測試。

### 啟動 MCP Server

```sh
npm run build
npm start
```

Server 使用 stdio 傳輸。實際模型呼叫需要對應的 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 或 `GEMINI_API_KEY`,可透過環境變數或本機 `.env` 設定。`.env`、`node_modules/` 與產生的 `dist/` 不提交至 Git。

### 歷史 Regression 證據

`regressions/simple-readiness/2026-09-05/` 保留 Step 6.1 後、Step 7 前的 SIMPLE-2 / SIMPLE-3 三階段 live 結果。可離線核對:

```sh
node regressions/simple-readiness/verify.mjs regressions/simple-readiness/2026-09-05
```

同目錄的 `run.mjs` 是歷史三階段測試 harness,其驗收預期 synthesis 執行;不是後續 direct path 的驗收工具。`test-simple-baseline.mjs` 與 `test-orchestrator.mjs` 會呼叫 live API,不包含於 `npm test`。

`diagnostics/m2a-live/` 保存三次 M2-A diagnostic live 的完整 artifact,含每次呼叫的 prompt 原文與回應原文、逐字 fixture 與 harness。harness 是 pass-through recorder,參數原封轉給真正的 provider dispatcher,不改變 runtime 行為。

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability privately.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
