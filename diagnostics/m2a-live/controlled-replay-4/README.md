# Controlled Replay #4

結果:**M2-A Full Mechanism Runtime PASS**。詳見 [evaluation.md](evaluation.md)。
Baseline 為 rev.19,只批准 Gate eligibility 語義修改與一次 controlled replay。

## 證據索引

- `artifact.json`:完整 Gate/R2/Decision prompts、adapter-returned raw responses、
  snapshot、parse/selection/resolution、report 前後值、timings 與 source/build fingerprints。
- `preflight.json`:fixture 與 control bytes、模型、source 範圍、208/212 tests 預檢。
- `attempt.json`:一次性 live 執行記號,防止同一路徑重跑。
- `control-before.json` / `control-after.json`:16 組 deterministic disabled/omitted control。
- `npm-test-before.log` / `npm-test-after.log`:完整離線套件輸出。
- `harness.mjs`:既有 replaySynthesis 入口的 pass-through recorder;唯一 live invocation。
- `control.mjs`:離線控制組 capture;不呼叫 provider。
- `verify.mjs`:只讀 saved evidence 與 runtime,離線核對 parser/resolver/selection/不變式。
- `hashes.json`:本目錄其他檔案的 SHA-256。

五份 fixture 直接取自 [Replay #3](../controlled-replay/),沒有修改。
聚合 snapshot hash 的定義與逐檔 hash 見 evaluation/preflight。
Captured raw text 保留原語言;sourceRef resolver 與 R2 context builder 都是 runtime 既有實作。

## 離線重驗

在 repository root、同一 runtime commit build 下執行:

```sh
node diagnostics/m2a-live/controlled-replay-4/verify.mjs
```

不需要 API key 或網路。需要重建時先 `npm ci` / `npm run build`;
不同 Node/TypeScript/build bytes 可能造成 fingerprint check 失敗,應檢查差異而非重封證據。

本輪已執行一次 `harness.mjs --live`,不可為重驗再次 live 執行。
本機 API keys 僅由原專案環境讀取,未保存 .env 或 credentials。
時鐘使用 runtime 原有 Date.now;僅 control.mjs 的 offline capture 固定時鐘。

完成後 STOPPED / AWAITING ARCHITECTURE REVIEW。未批准後續實驗或 productionization。
