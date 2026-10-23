# AUTO-P2-A3：首次文件審查未核發封包

**OPERATIONAL_RECORD／UNISSUED_NOT_AUTHORITY。EXE／H1–H9 HOLD。**

這份草案不是正式Human Authority，也不解除HOLD。最終exact SHA的機器封包在提交後由新隔離Goal／Run自動產生，保存於本機 `outputs/auto-p2-a3/PILOT_PERMIT_PACKET_A3.json`；其中issue／expiry及三份Authority均為null，不填造發行人或簽章。

- 工作：閱讀CHIEF指定版本的完整README，找出文件問題，交付繁體中文Markdown報告。
- Agent／provider／model：limited-readme-worker／Anthropic／claude-haiku-4-5-20251001。
- API：2023-06-01；不使用alias、其他Agent、CLI或SDK重試。
- 資料：指定Git SHA普通README.md blob，≤16,384 UTF-8 bytes；Goal≤2,000 UTF-16 units；完整JSON body≤131,072 bytes。不截斷README，不主張精確input token上限。
- 成果：僅能寫綁定隔離目錄report.md，≤64KB；不能Git寫入、push、部署、任意shell或取用私人Session／憑證／其他專案。
- 用量：一次模型生成、零retry／fallback、output max_tokens=2,048；300秒或更早許可／quote到期。
- 費用：單次及同store累積US$1；按既有200K input-context基礎與output上限保守預留；未知usage／費用維持未知，不把預留當實際帳單。不自動退還或重送不確定請求。
- 來源及契約：系統綁定exact implementation SHA／compiled codeHash／Goal／Run／source SHA、hash、bytes／tools／store identity／output key／quote hash／packet ID及hash，不需Human手填。
- 正式治理文件：Architect IMPLEMENTATION_PACKET、Human LIVE_PROVIDER_MODEL_CALL及Human LIMITED_README_WORKER，須由既有可信程序分別核發、歸檔並exact綁定本次契約，最長一小時有效，執行前及preflight後重查。任何版本變更、過期、取代或不匹配均拒絕。
- 舊契約：A1／A2／R1的Goal／Run／contract／Permit不能原地升級或換名稱生效；須另建新A3工作，不轉移預算或刪舊歷史。
- 帳戶模型與key：本輪未提供或讀取key，實際帳戶可用性／pinned API相容性尚未驗證。之後只能在可信Host按另次授權查核；不得在Workspace貼key或放入Journal／report。
- 中止：取消／逾時中止HTTP；send後未知則UNCERTAIN，保留生成claim、預算與Journal；重啟不自動重放。Human須先核對證據，不自行重設store來重試。

正式Pilot還需要Architect接受本候選及另案可信activation／execution接線、Human對EXE／H1–H9與單次付費工作另行明確核准、最終執行版本與新鮮quote／帳戶能力驗證，以及上述正式文件歸檔。本輪不執行任何一項被禁止的正式授權或模型呼叫。

**STOP FOR ARCHITECT REVIEW。**
