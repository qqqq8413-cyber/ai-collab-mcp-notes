# AUTO-P2-R1：嚴格 4,096 Input Token 證據審查

## 驗收結論

**BLOCKED_NO_PROVABLE_INPUT_BOUND**

基準：`05c05b4ff0b94382d2764df5e554b2fb9c30600c`。
工作分支：`work/auto-p2-r1-strict-input-proof`。
固定模型：`claude-haiku-4-5-20251001`；正式請求 header：`anthropic-version: 2023-06-01`。
Human A2-D1 維持嚴格 4,096 完整輸入上限；本輪沒有變更規格或執行授權。

目前查到的官方契約不足以證明這個模型、這個 API 版本的完整輸入在送出前必然不超過 4,096 tokens。這不是「數學上不可能」的判定，也不是已取得供應商的否定答覆。它是現有可查核證據不足的結論，不能用測試通過取代缺失的前提。

## 官方來源與適用範圍

查核日期：2026-10-23（Asia/Taipei）。逐份 retrieval timestamp、URL、內容 SHA-256、模型／API 適用限制見 `regressions/auto-p2-r1/official-source-evidence.json`。完整公開文件快照留在本機 outputs，不將第三方文件全文重新發布進 repository。

| 來源 | 可支持的結論 | 模型／API 與證據限制 |
| --- | --- | --- |
| [Token counting guide](https://platform.claude.com/docs/en/build-with-claude/token-counting) | count_tokens 是估計；實際生成計數可能不同；可能含服務端加入且不計費的 tokens。未見可用的數值誤差上界。 | 一般 active Claude 模型；未提供 Haiku 4.5 + 2023-06-01 的特別精確保證，不能把「小量差異」改寫為固定常數。 |
| [Count API reference](https://platform.claude.com/docs/en/api/messages/count_tokens) | 接受 system／messages／model 的結構化計數輸入。未見與後續生成原子綁定的 reservation、tokenizer fingerprint 或硬上界證書。 | 列有指定 Haiku snapshot，但目前公開 reference 顯示 2026-10-21；不代表已驗證舊版 header 的實際帳戶行為。 |
| [Messages API reference](https://platform.claude.com/docs/en/api/messages/create) | max_tokens 是輸出上限。已檢查的 request fields 未見可由呼叫端設定 4,096 的 input hard cap；回傳 usage 是事後資料。 | 公開 reference 是 2026-10-21；本機官方 SDK 0.123.0 使用 2023-06-01 預設 header，request declarations 亦未見 input-cap 欄位，僅為佐證，不是伺服器完整性證明。 |
| [Get a Model](https://platform.claude.com/docs/en/api/models/retrieve) | max_input_tokens 是 model context capacity 的 metadata，不是 Messages request 可設定的上限。 | reference 為 2026-10-21；未呼叫帳戶 Models API，不能聲稱帳戶 metadata 已核對。 |
| [Context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows) | 明列 Haiku 4.5 的自動 context-awareness 注入；沒有提供其完整 token 上界。超出 context 的拒絕機制不是任意較小輸入 cap。 | 文件直接提 Haiku 4.5 與 Claude 4.5+，但未逐一聲明 2023-06-01 的 framing／注入 token 保證；只能確立風險，不能填造 H。 |
| [API versions](https://platform.claude.com/docs/en/api/versioning) | 相容政策保留既有輸入／輸出參數，不等於 tokenizer、正規化與服務端注入語意不變。 | 2023-06-01 在版本歷史內；本輪未更新 API header，也不以新版 reference 冒充舊版執行驗證。 |
| [固定 Haiku 模型規格](https://platform.claude.com/docs/en/models/haiku-4-5/overview) | 固定 snapshot、200K context、64K max output 的公開規格；不是 4,096 input cap。 | 適用指定模型；公開狀態不是帳戶可用性保證。未改模型或使用 alias。 |
| [官方舊 tokenizer](https://github.com/anthropics/anthropic-tokenizer-typescript) | 官方明示 Claude 3 起不能準確計數；不能拿它證明 Haiku 4.5 上界。 | 較舊模型適用；不是指定模型的 tokenizer／normalizer／special-token 完整規格。未找到可核驗的 Haiku 4.5 專用完整發行物。 |
| [Task budgets](https://platform.claude.com/docs/en/build-with-claude/task-budgets) | advisory／soft hint，不是硬限制，且 Haiku 4.5 不支援。 | beta 功能；不能套用到本輪模型或偷偷啟用 beta header。 |

上述「未見」指已列來源及本機鎖定 SDK declarations 的查核範圍，不宣稱已窮盡供應商所有非公開能力。第三方 tokenizer、使用者 issue、一般 BPE 理論及模型自行回報均未當作保證。

## 完整輸入盤點

離線命令：`npm run build` 後執行 `node scripts/audit-limited-input.mjs --evidence OUTPUT_JSON`。
它是盤點工具，不是 tokenizer、獨立的 admission 路徑或可簽發證書的 verifier。

使用已提交 A2 的 OFFLINE_SYNTHETIC Goal 及完整真實公開 README，直接呼叫既有 `messageBody`／`inputFacts`，沒有複製另一套 prompt builder：

| 成分 | 本機可精確核對的值 | 不可推出的結論 |
| --- | --- | --- |
| README | 5,568 UTF-8 bytes，未截斷；source SHA/hash 綁定 | 不是 5,568 tokens，也不是其 token 上界 |
| Goal | 67 UTF-16 units／123 UTF-8 bytes | 字元數不是 token 數 |
| 固定 system prompt | 318 UTF-8 bytes／system hash | 不包含服務端未公開 framing 的 token 保證 |
| user content | 5,901 bytes：完整 Goal、README、source SHA/path 的 canonical JSON 字串 | 內層 JSON 本身是模型文字；不可只計 README |
| 完整外層 request | 6,539 UTF-8 bytes／完整 request hash | 外層 JSON escape 與 HTTP metadata 不可直接等同 tokenizer 輸入 |
| 角色與服務端 | 一個 user role；no tools、no cache_control、thinking disabled、standard_only | 仍無可證明的 role／特殊 token／context-awareness／其他注入上界 |

實際 request hash 與各項量測見 `request-inventory.json`。Exact input tokens、estimated tokens、protocol overhead、proven upper bound 全為 null。保守費用預留 200,000 仍僅為既有成本防線，不是放寬輸入規格。

## 候選證明逐一否決

1. **count_tokens + 任意 margin**：必須有同模型／API／完整 request 的單向有限誤差保證及 count-to-generation 一致性。官方未提供可用數值，margin=1／100／百分比均不能自行成立。零次 count_tokens 呼叫，沒有用少量樣本推定全域保證。
2. **本機 tokenizer + framing 常數**：需要可驗證的指定模型 tokenizer、normalizer、special-token 處理及完整 framing／服務端注入規格。已查到的舊官方 tokenizer 明確不準確；context-awareness 標記的文字例子也不是完整 tokenizer 或上界證書。
3. **UTF-8 bytes + H**：形式可寫為 T_total ≤ f(content) + H，但必須先證明 provider transformations 下 f 的上界及有限 H。未建立這兩個前提，不能直接宣稱一 byte 至多一 token。即使假設該不等式，允許的 16KB 原文也不會自動得到 4,096 的可用界線；不能任意截斷 README。
4. **調大 max_tokens 擠壓輸入**：不成立。Context 文件說 Claude 4.5+ 可接受 input + max_tokens 超過 context，生成時才以 model_context_window_exceeded 停止；並非藉此預先拒絕較大 input。模型 max output 與本工作固定 2,048 輸出限制也不能任意變更。
5. **context capacity／rate／金額限制**：200K context 的 prompt-too-long 拒絕不是 4,096 cap；每分鐘 rate bucket 與美元預算也沒有證明單次完整輸入的 token 上限。
6. **usage 或 max_tokens=0 探測**：usage 在送出請求後才取得；即使不生成輸出也已送入模型服務，不能提供本次請求送出前的保證，也不是本輪授權的方法。本輪完全未做。
7. **在 prompt 要求模型數 token、開 advisory task budget、或先摘要**：前兩者不是硬限制，後者改變完整 README 工作範圍或增加請求；都不採用。

## 驗證界線與保留控制

新增26項測試接入 `npm test`，原2,182項未移除。驗證 Unicode／NFC-NFD 區別／emoji／RTL／escape／特殊 token 文字／未配對 surrogate、真實 request/system hash、完整16KB原文、Goal byte與UTF-16差異、固定模型與API／USD1／零重試／300秒／一次生成。原 Workspace START拒絕、Controller／Archive／Journal、取消崩潰後不重放、macOS Seatbelt 回歸仍在完整測試內。

4,095／4,096／4,097 的測試分成「位元組長度」與「未驗證的計數聲明」。它們全部維持拒絕；**不是實測 provider token 邊界**。真正 token-boundary acceptance 沒有可用 oracle／proof，狀態為 UNVERIFIED，不得命名為 PASS。

Production source、UI、Authority、EXE 及現有服務完全不修改。研究結果碼為 BLOCKED_NO_PROVABLE_INPUT_BOUND；原 runtime guard 繼續 INPUT_LIMIT_DECISION_REQUIRED。本輪不為換錯誤碼修改執行契約或冒充修好了上限。

完整測試／CI／source seals 見 `regressions/auto-p2-r1/` 與提交後本機 closure。測試成功只證明本機盤點與拒絕防線，不代表輸入保證或付費執行授權。

## 剩餘風險與下一個 Human 決定

還缺：同模型／2023-06-01／完整 request 的 tokenizer 與 transformation、服務端 overhead 的可審核上界，或官方可驗證的 per-request input-cap／有限誤差契約。帳戶實際能力也未探測。供應商改版或模型更換都需重新證明，不能跨版本重用本報告。

**不要求 Human 再選一次是否放寬4,096。** 下一個需要決定的是：是否透過供應商支援取得上述書面技術規格／保證，並在取得可用證據前暫停這條首次付費工作路徑。聯絡供應商、提供資料、付費研究或改換模型／平台都不由本輪自行進行；若要走替代路徑，必須另開明確 Architect／Human 決策，不視為本報告已核准。

可交供應商的最小問題：對 snapshot `claude-haiku-4-5-20251001`、header `2023-06-01`，能否提供涵蓋 system、user、角色 framing、Unicode 處理及自動注入的單向 token 上界／誤差保證，或在推論前拒絕完整輸入超過4,096的正式參數？該保證如何綁定 request、版本與計數後生成的一致性？不附金鑰或私人內容。

**STOP FOR ARCHITECT REVIEW。**
