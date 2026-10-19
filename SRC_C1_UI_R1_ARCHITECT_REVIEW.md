# SRC-C1-UI-R1 Architect Review 交接

狀態：**實作與驗證完成，待 GPT-6 Architect 審查**。以下為 Codex 實作者自查與證據，不是 Architect 核准，也不授權發布 main。

## 基準與修改範圍

- 基準：SRC-C1 candidate `dc84970260522e28ead15b05879e6d3702294e06`。
- 獨立分支：`work/src-c1-ui-r1-reading-space`；Exact SHA 由本輪完成回報提供。
- UI：`workspace-ui/app.js`、`collaboration.js`、`conversation.js`、`styles.css`。
- 新增純顯示模組 `reader-source.js`、本機 bundle 建置腳本、固定版本依賴與測試。伺服器僅增加兩個靜態資產的 allowlist，API 路由仍為 12 條。
- `src/event-source/`、事件儲存、Identity、Automation、Human Authority、GitHub workflow／保護設定皆無變更。EXE HOLD 維持；模型／provider 呼叫 0。

## 閱讀區決策

移除房間外層 `.scroll`／`.work` 與對話窗固定高度，保留每個可見訊息區各自的一層縱向捲動。沒有用隱藏溢出來截掉訊息。
單 Agent 不顯示多餘切換控制，使用全寬、剩餘可用高度。多 Agent 同時最多兩欄；全部參與者仍可透過名稱列選取，不刪除事件或推算收件者。
房間寬度不足 820px 時顯示單窗；寬螢幕可切雙欄、單窗或以各窗的最大化圖示切換，再還原。按鍵左右／Home／End 可選擇參與者。

| 指標 | 修改前 | 修改後 |
|---|---:|---:|
| 1440×900 桌面訊息閱讀高度 | 532px | 692px |
| 390×844 手機訊息閱讀高度 | 476px | 598px |
| 訊息文字 | 14.5px | 16px |
| 行距 | 24.65px | 27.2px（1.7） |
| 同一閱讀路徑的縱向捲動層 | 2 | 1 |

原有的來源、Session、Event ID、時間與歷史／監看標示完整保留，預設收合。說明移至收合的「紀錄資訊」，沒有把來源／非授權界線刪除。
重繪前依 participant 保存閱讀位置與來源資訊展開狀態；讀舊文時不跳到底部，已在末尾時才跟隨新增內容。這些狀態只在頁面記憶體，不寫事件或設定檔。

## Markdown 安全界線

使用固定版本 `markdown-it 15.0.3`，原始 HTML 關閉；不使用可注入 HTML 的高亮器或外掛。只接受沒有帳密的絕對 HTTP(S) 連結，需使用者點擊，以 `noopener noreferrer` 在新分頁開啟。
拒絕 JavaScript／data／file／VBScript／相對與 protocol-relative 連結；Markdown 圖片僅顯示替代文字，不嵌入圖片、SVG、iframe 或遠端資產。
支援標題、粗斜體、列表、引用、程式碼與表格。程式碼換行以免擠寬頁面；寬表格只在表格自身水平捲動，不新增外層縱向捲動。

圖示來自固定版本 `lucide 1.59.0`；`esbuild 0.28.2` 在 `npm run build` 產生同源 ESM 與第三方授權檔。無 CDN、無 inline script；CSP 未放寬。
生成檔不納入 Git，乾淨 `npm ci --ignore-scripts --no-audit` 後可重新建置。此處沿用 [markdown-it 官方解析器](https://github.com/markdown-it/markdown-it)，安全界線以本輪實際設定與攻擊測試為證據，不宣稱任何輸入都安全。

## 驗證證據

- 完整 `npm test`：53 組，1,990 passed／0 failed／0 skipped（本機 macOS）。新增閱讀與攻擊測試 10 項；既有 UI 49、事件來源 18 與治理／隔離測試仍通過。
- 真實歷史事件：沿用同一個 3 則事件庫，只讀取，不重新匯入；測試前後檔案 SHA-256 相同。
- 桌面／手機：上述兩個主尺寸皆無橫向溢出，閱讀層數為 1；另測 1280×600、320×568、844×390、1920×1080，訊息區未超出可視高度。
- 多 Agent 案例：清楚標示 DEMO_SAMPLE 的隔離瀏覽器 fixture。雙欄、最大化／還原、第三個參與者、手機單窗、鍵盤切換、新事件不拉動舊文均通過，沒有寫入事件庫或啟動第二個 Agent。
- 模擬讀取失敗／恢復：警告可見，既有閱讀位置、來源資訊與房間資訊展開狀態保留。
- 攻擊案例：HTML／SVG／script／事件屬性／iframe、危險協定、編碼協定、圖片追蹤與程式碼中的 HTML。實際瀏覽器無程式錯誤、無外站請求、無寫入請求，測試標記未執行。
- 可提交的量測摘要：`regressions/src-c1-ui-r1/browser-acceptance.json`。私人歷史文字的前後截圖僅存本機 `outputs/src-c1-ui-r1/`，不公開提交。

## 審查重點與限制

實作者自查未發現阻擋性缺陷；不等於獨立審查結論。請 Architect 審查：雙欄／單窗選擇及未讀行為、Markdown URL 政策、同源 bundle 建置、範圍隔離證據。

- Markdown 按既有事件片段呈現，不重新拼接來源；跨原有 4000 字元分段的 fence／表格可能分開顯示。本輪不變更原始文字或分段儲存。
- 沒有啟動真實第二個 Agent，也沒有新增真實即時事件驗收；多 Agent 與新增事件測試是顯示層合成測試。
- 空的「需要你」區不佔閱讀空間；確有請求才顯示。需要你區與展開的資訊浮層可個別捲動，但都不是訊息區的捲動祖先。
- 既有依賴仍回報 5 項漏洞警示（與 SRC-C1 相同數量），未在此 UI 任務升級其他依賴或宣稱已解決。
- 未進行正式輔助科技稽核或產品發布；未改 main。

**STOP FOR ARCHITECT REVIEW**
