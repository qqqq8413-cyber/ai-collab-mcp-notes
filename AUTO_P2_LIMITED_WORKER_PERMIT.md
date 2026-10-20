# AUTO-P2 正式單次 Pilot Permit Packet 草案

**UNISSUED_NOT_AUTHORITY / EXE HOLD / NOT AUTHORIZED**

本文件是待 Human／Architect 核發的封包規格，不是簽發紀錄、不寫入 Archive，不授權付費模型、EXE、H1–H9、Git 或部署。不得回填日期假裝已核准。

## 固定範圍

| 欄位 | 限制 |
|---|---|
| Repository | qqqq8413-cyber/ai-collab-mcp-notes |
| Agent | limited-readme-worker（單一 Agent） |
| Provider／model | anthropic / claude-haiku-4-5-20251001，無 alias／替代／fallback |
| Protocol | Messages HTTPS API，anthropic-version 2023-06-01；不使用 Claude Code CLI |
| 工作 | Human Goal 指定的唯讀 README 文件審查，以繁體中文保存 Markdown 問題清單 |
| Source | a3164fd12d6d3129978da32ea024854d6e9b5cdc:README.md，最多 16KB |
| Source hash／bytes | 5a65327552f70506d0c68fe297f5202bf2a530f3cdc6e9c279ad6f74d8438d5d / 5568 |
| Host 操作 | READ_PINNED_README、WRITE_ISOLATED_REPORT；模型本身沒有 tools |
| Output | 綁定 store identity／outputKey 下唯一 report.md，最多 64KB，無 repo write |
| Network | 模型請求僅 api.anthropic.com:443；另唯讀官方 pricing document，不允許任意 URL |
| Input／output | 輸入按模型 200,000 上界預留，來源另限 16KB；output max_tokens 2,048，thinking disabled |
| 請求／重試 | 最多一個 generation，0 自動重試，0 fallback，0 其他 Agent |
| 費用 | 單次及綁定 store 終身總預留最多 US$1；目前已查驗 tariff 的單次保守預留 US$0.210240 |
| 時間 | 最多 300 秒，quote／grant 更早到期即中止；grant 最長 3600 秒 |
| 中止 | Human CANCEL／AbortSignal／deadline；送出後狀態不確定則保留預算且不得重放 |
| 禁止 | shell、Git write／push、deploy、私人 Session／憑證／其他專案、其他 Agent、Authority write |
| issuedAt／expiresAt | null / null，尚未核發 |

## 必須在正式封包填入的 exact 值

由真實準備流程產生，而不是人工猜測：

- 最終已審查執行版本 implementationSha、Worker codeHash。
- Goal ID、objectiveHash、Run ID、slice ID。
- source SHA/path/hash/bytes、store physical identity、outputKey。
- 官方 pricing URL／sourceSha256／checkedAt／validUntil 與固定 tariff。
- 完整 canonical contract 及 contractHash。
- 固定欄位重建的 ImplementationPacket 及 packetHash。
- Human／Architect principal 與真實 Archive refs。

最終候選提交後，本機另提供 `PILOT_PERMIT_PACKET.json`，含上述契約及待審 ImplementationPacket。該檔依然為 UNISSUED，不含偽造 Authorization 或假發行時間。

## 所需 Direct Authority

1. Architect 的精確 ImplementationPacket，透過既有 governed activation 保存並把 ROOT/IDLE 置於正確的 PACKET_READY occurrence。
2. Human `LIVE_PROVIDER_MODEL_CALL`：exact Run／packet／anthropic／model／implementation scope／egress，依既有 Driver 驗證。
3. Human `LIMITED_README_WORKER`：target = exact contractHash；相同 Run／packet／scope；expiresAt 必填且 issuedAt 到 expiresAt 最長 1 小時。Archive 的 bodyHash、repository、slice 與 Goal owner 的 Human principal 必須全部一致，且不是已被取代的版本。
4. 另行經 Architect／Human 核准 EXE 及必要 H1–H9 activation。此候選硬 HOLD；本文件或前述 grant 本身不釋放它。

`--permit-config` 只能載入已核發授權的私有 operational copies。檔案必須 regular／非 symlink、owner-only、至多 32KB，strict fields：`schemaVersion: 1`、`liveCallGrant`、`limitedGrant`。沒有此檔預設 null；載入不等於匯入 Archive 或取得權限。

## 核發前必核對

- 指定帳戶的 exact model metadata 與標準價格已確認；任何未知／不一致均拒絕。
- 當前程式 clean、Exact SHA／codeHash 等於契約；quote 有效且來源文件未變。
- store identity、單次 Run claim、US$1 總預留仍一致，沒有不確定請求被重送。
- 如另行修改 activation／EXE 程式，舊 Worker SHA／quote／Goal／Run 契約不可冒用，重新準備並核發。
- 真正金鑰僅 Human 在本機設置，不放入封包、聊天、成果、log 或 repo。
- 真實生成成功必須以 provider message ID、usage、Invocation APPLIED、report hash 與 Controller IMPLEMENTATION_COMPLETE 核對；OFFLINE_SYNTHETIC 不算。

目前：Human 尚未核發，Archive 無本輪正式授權，付費呼叫 0。STOP FOR ARCHITECT REVIEW。
