# 第一份限定 AI Pilot Permit 草案

**DRAFT_NOT_AUTHORITY / UNISSUED。不是 Human grant，不能匯入 Authority Archive 當授權。EXE HOLD / H1-H9 不變。**

| 項目 | 建議限定範圍 |
| --- | --- |
| 目的 | 唯讀審查 CHIEF README.md，產出有來源引用的文件問題清單，不修改程式 |
| Repository / source | `qqqq8413-cyber/ai-collab-mcp-notes`，建議基準 `913385b0e1b8f8c529152a091255f46cad67787a` 的 `README.md`，最多 16KB；正式 packet 必須另綁 source hash |
| Agent / provider | 首次只選 Claude Code / Anthropic；不自動切換 Codex 或其他 Agent |
| 模型 | 申請值 `claude-sonnet-5`，只是 repo default，未探測可用性；正式模型、CLI executable/hash 與 egress 需審查後精確綁定，未完成不得執行 |
| 工具 | 僅 READ_BOUND_SOURCE、WRITE_ISOLATED_RESULT；不授予任意 shell |
| 寫入 | 僅單次隔離 output 目錄；正式簽發時必須填 exact path 並通過根目錄互斥檢查 |
| 禁止 | source/Git 寫入、push、main、部署、Authority Archive、其他專案／私人 Session、憑證、web search、AI-to-AI 循環 |
| 外部副作用 | 若未來正式授權，只允許一次 exact 模型推理請求，無其他網路操作 |
| 費用上限 | 單次及總額 USD 1；pricing=null、costEnforced=false，這是阻擋條件，不是已實作保證 |
| Token / 次數 | 輸入最多 4096、輸出最多 2048；maxCalls=1、retries=0、fallback=0；需實際 enforcement 才可簽發 |
| 時間 / 模式 | 最長 300 秒，MANUAL only，不排程 |
| 中止 | Human cancel／服務停止／逾時中止模型程序與子程序樹，保存不確定結果後等待 Human；必須先通過與實際 adapter 結合的隔離／中止驗證 |
| 有效期間 | 最長 1 小時；notBefore=null、expiresAt=null，正式簽發時填 UTC 起訖，不回填成現在有效 |
| 成果 | 單一 Markdown 報告，列來源、觀察、證據與不確定性；未知事項不可填成已驗證 |
| 正式授權 | 綁定 Goal/objective hash、exact implementation SHA、source hash、packet hash、run、provider/model、工具、額度、有效期間；只能透過既有受控 Human Authority 機制簽發 |

## 執行前必須補齊

目前 Claude implementation adapter 會提交／推送分支，與此草案不相容；Codex architect-review adapter 則要求既有實作 lineage，不能代替第一個文件 Worker。本輪不修改它們，也不建立新 live adapter。

需另獲授權實作限定文件 adapter、pricing／費用及 token enforcement、精確 sandbox/egress、中止驗證及 Driver / Invocation Journal 的正式組合。完成後由 Architect review，Human 再決定是否簽發有期限的 exact grant。不是只需按「允許」就能執行。

STOP FOR ARCHITECT REVIEW。
