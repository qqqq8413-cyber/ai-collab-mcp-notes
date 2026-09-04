# ai-collab-mcp

此 repository 包含可建置的 MCP server、離線測試與交接紀錄。最新狀態見 [HANDOFF.md](HANDOFF.md);歷史架構分析見 [STEP7_SCOPE_ANALYSIS.md](STEP7_SCOPE_ANALYSIS.md)。

目前 **Step 7 V1 IMPLEMENTED**: 僅 SIMPLE、恰好一位成功且輸出非空的 Worker、non-retrieval 執行會原樣直接交付,其餘路徑保留原行為。`report.policy` 記錄是否 synthesis 及原因,`synthesisAllowed` 保留原 Run Status 的失敗保護語意。

## 建置與離線測試

本次使用 Node.js v24.15.0 驗證。從 repository 根目錄執行:

```sh
npm ci
npm test
```

`npm test` 先編譯 TypeScript,再執行 99 項離線測試與 MCP smoke tests。這些測試不需要 API key,包括 36 項新增 execution-policy tests。

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
