# Clean-room annotator output — Task B (gold issues)
#
# Received verbatim from a SEPARATE clean-room session that never saw Task A's output.
# Committed unedited per protocol: Claude validates structure only and may not touch the
# semantic judgement.

```json
[
  {
    "fixtureId": "fx-03",
    "goldIssues": [
      {
        "id": "gi-1",
        "issue": "決策必須判定第一輪 Pilot 的高留存是否代表產品具備真實市場需求，還是僅為熟客與人情關係影響下的偏誤結果。",
        "supportRefs": ["demand_research:p15", "retention_analysis:p4", "retention_analysis:p6"]
      },
      {
        "id": "gi-2",
        "issue": "決策必須評估是否需透過付費獲客測試陌生客群的獲客成本（CAC），以及直接公開推出是否會因同時引入陌生客群與獲客成本兩項變數而無法歸因留存下滑。",
        "supportRefs": ["demand_research:p9", "demand_research:p10", "retention_analysis:p14"]
      },
      {
        "id": "gi-3",
        "issue": "決策必須回應已知的配送時段營運問題，並處理第一輪 Pilot 中未測出的價格敏感度與四成問卷未填答所隱含的數據缺口。",
        "supportRefs": ["demand_research:p5", "retention_analysis:p9", "retention_analysis:p11"]
      }
    ]
  },
  {
    "fixtureId": "fx-01",
    "goldIssues": [
      {
        "id": "gi-1",
        "issue": "決策必須評估資深講師產能上限對高客單價 B2B 業務的排擠風險，以及能否運用非資深講師獨立授課以解開產能瓶頸。",
        "supportRefs": ["market_positioning:p7", "delivery_operations:p2", "delivery_operations:p5", "delivery_operations:p11"]
      },
      {
        "id": "gi-2",
        "issue": "決策必須衡量與平台合作對於 B2B 企業客戶價格重新錨定的風險，以及失去學員名單與定價主導權的長期代價。",
        "supportRefs": ["market_positioning:p4", "market_positioning:p12", "market_positioning:p13"]
      },
      {
        "id": "gi-3",
        "issue": "決策必須權衡公開班作為 B2B 客戶獲客漏斗上游的長期戰略價值，與自建行銷／系統或經營平台課程所帶來的團隊營運負擔。",
        "supportRefs": ["market_positioning:p6", "market_positioning:p9", "delivery_operations:p9"]
      }
    ]
  },
  {
    "fixtureId": "fx-04",
    "goldIssues": [
      {
        "id": "gi-1",
        "issue": "決策必須釐清「交付前漏改」的根本原因究竟是客戶回饋缺乏集中記錄，還是記錄後缺乏執行與檢核機制。",
        "supportRefs": ["team_workflow:p3", "client_delivery:p2", "client_delivery:p13", "client_delivery:p14"]
      },
      {
        "id": "gi-2",
        "issue": "決策必須解決無專職 PM 且團隊對行政負擔排斥的採用門檻，確保設計師能持續維護工具而不重演試算表填寫不全的問題。",
        "supportRefs": ["team_workflow:p5", "team_workflow:p6", "team_workflow:p10", "client_delivery:p8", "client_delivery:p9"]
      },
      {
        "id": "gi-3",
        "issue": "決策必須訂定工具導入成功與否的客觀衡量標準，並確立小規模試用失敗時改回現行流程的替代與檢核方案。",
        "supportRefs": ["team_workflow:p11", "team_workflow:p13", "client_delivery:p11", "client_delivery:p14"]
      }
    ]
  },
  {
    "fixtureId": "fx-02",
    "goldIssues": [
      {
        "id": "gi-1",
        "issue": "決策必須評估主治獸醫人力缺口與長招募週期（>4 個月），以及抽調人力是否會進一步惡化現有院區已排至兩週後的等待時間。",
        "supportRefs": ["clinical_staffing:p4", "clinical_staffing:p5", "clinical_staffing:p6", "growth_planning:p4", "growth_planning:p12"]
      },
      {
        "id": "gi-2",
        "issue": "決策必須衡量第二院區採取「限縮診別」啟動的可行性，能否在不攤薄現有院區核心產能的前提下把握黃金物件保留期（3 個月）。",
        "supportRefs": ["clinical_staffing:p11", "growth_planning:p5", "growth_planning:p7", "growth_planning:p8", "growth_planning:p12"]
      },
      {
        "id": "gi-3",
        "issue": "決策必須解決內部流程依賴口頭默契未文件化的隱患，並防範資深獸醫助理調動或離職對現有看診量與服務品質的衝擊。",
        "supportRefs": ["clinical_staffing:p8", "clinical_staffing:p9", "clinical_staffing:p14"]
      }
    ]
  }
]
```

各情境關鍵議題摘要與說明

* 情境 fx-03（訂閱制生鮮食材箱）： 兩位專家的核心衝突在於第一輪 Pilot 留存數據的解讀角度。一者主張留存訊號明確，下一步應直接投廣告驗證獲客成本（CAC）；另一者則指出熟客樣本存在嚴重偏誤，若不先向陌生客群驗證，公開推出時會因變數重疊而無法判定留存下滑主因。最終決策必須明確回應樣本有效性、CAC 驗證方式與數據缺口。
* 情境 fx-01（B2B 顧問公司公開班）： 決策關鍵在於「資源排擠」與「品牌/價格錨定」的權衡。資深講師時數已達上限，任何公開班形式都可能衝擊高單價 B2B 交付；而選擇平台合作雖能節省行銷成本，卻有學員名單流失及破壞 B2B 定價結構的隱憂。好的決策必須說明如何解決講師產能瓶頸並維護 B2B 客戶的價格感知。
* 情境 fx-04（設計工作室專案管理工具）： 兩位專家均認同先從小規模試用輕量工具切入，但對失敗主因及解決重點有不同假設。核心議題在於分辨「漏改」是來自資訊未記錄還是未執行，並在無專職 PM 的狀況下降低設計師的行政負擔，同時設定具體的驗證標準與試用不順時的退場方案。
* 情境 fx-02（社區動物醫院第二院區）： 決策的核心衝突在於「把握黃金物件」與「人力/服務品質崩潰風險」之間的取捨。招募週期長達四個月以上，直接抽調醫師會惡化現有院區長達兩週的等待時間；若要提前啟動，決策必須驗證「限縮診別」模式能否真實解套，並處理流程未文件化對資深助理離職的脆弱性。
