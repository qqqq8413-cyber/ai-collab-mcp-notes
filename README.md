# ai-collab-mcp

此 repository 包含可建置的 MCP server、離線測試與交接紀錄。最新狀態見 [HANDOFF.md](HANDOFF.md);歷史架構分析見 [STEP7_SCOPE_ANALYSIS.md](STEP7_SCOPE_ANALYSIS.md)。

目前狀態:

- **Step 7 V1 IMPLEMENTED** —— 僅 SIMPLE、恰好一位成功且輸出非空的 Worker、non-retrieval 執行會原樣直接交付,其餘路徑保留原行為。`report.policy` 記錄是否 synthesis 及原因,`synthesisAllowed` 保留原 Run Status 的失敗保護語意。
- **Experimental Milestone 2-A —— default OFF,尚未 productionize。** Targeted peer challenge 的 prototype,只在 `deep`、Round 1 SUCCESS 且至少兩位專家時才可能啟動,最多一位 Round 2 specialist,Round 2 不做檢索。不傳 `experimental` 參數時,執行行為與回傳 payload 與加入前逐欄相同(有測試斷言)。
- **三次 diagnostic live 的機制後半段仍未被執行過** —— parser 成功路徑、sourceRef 解析、Round 2 與 Decision Synthesis 皆為零次真實執行。證據見 `diagnostics/m2a-live/`,判讀見 HANDOFF 第二十一〜二十三節。

## 建置與離線測試

本次使用 Node.js v24.15.0 驗證。從 repository 根目錄執行:

```sh
npm ci
npm test
```

`npm test` 先編譯 TypeScript,再執行 208 項離線測試與 MCP smoke tests。全部不需要 API key。其中 36 項是 execution-policy tests,另有 M2-A 的 stage instrumentation、call ceiling、best-effort parsing、issue 驗證、deterministic selection、selective peer context、失敗回退與 evidence 不變式測試。

## 啟動 MCP Server

```sh
npm run build
npm start
```

Server 使用 stdio 傳輸。實際模型呼叫需要對應的 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 或 `GEMINI_API_KEY`,可透過環境變數或本機 `.env` 設定。`.env`、`node_modules/` 與產生的 `dist/` 不提交至 Git。

## 歷史 Regression 證據

`regressions/simple-readiness/2026-09-05/` 保留 Step 6.1 後、Step 7 前的 SIMPLE-2 / SIMPLE-3 三階段 live 結果。可離線核對:

```sh
node regressions/simple-readiness/verify.mjs regressions/simple-readiness/2026-09-05
```

同目錄的 `run.mjs` 是歷史三階段測試 harness,其驗收預期 synthesis 執行;不是後續 direct path 的驗收工具。`test-simple-baseline.mjs` 與 `test-orchestrator.mjs` 會呼叫 live API,不包含於 `npm test`。

`diagnostics/m2a-live/` 保存三次 M2-A diagnostic live 的完整 artifact,含每次呼叫的 prompt 原文與回應原文、逐字 fixture 與 harness。harness 是 pass-through recorder,參數原封轉給真正的 provider dispatcher,不改變 runtime 行為。
