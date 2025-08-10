import { health_keywords } from "../_config/keywords.js";
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const body = req.body || {};
  const {
    industries = [],
    locations = [],
    min_budget_rm = 0,
    time_range_days = 7,
    limit = 5
  } = body;

  // 假数据池（先够你演示；下一步我会教你对接真实 RSS/News）
  const now = new Date();
  const fake = [
  {
    id: "opp_kl_corpwellness_001",
    title: "KL科技园区发起 Q4 Corporate Wellness Program",
    summary: "园区计划为500名员工推进为期3个月的企业健康计划，包含健康讲座、体测与营养咨询，欢迎健康服务供应商对接。",
    url: "https://news.example.com/kl-corpwellness",
    published_at: now.toISOString(),
    budget_rm: 120000,
    matched_industries: ["corporate wellness","nutrition","health screening"],
    location: "Kuala Lumpur",
    signals: ["corporate wellness program","Q4","RFP"],
    suggested_members: [
      { name: "Ariest", specialty: "Supplements & Wellness Coach", chapter_role: "Health & Wellness" },
      { name: "Jess", specialty: "Health Screening", chapter_role: "Medical Lab" }
    ],
    opening_line: "你好，我这边看到你们在规划企业健康计划，我们有完整的讲座+体测+营养方案，可以聊聊贵司员工画像与KPI吗？"
  },
  {
    id: "opp_sgr_newclinic_002",
    title: "Selangor PJ 地区即将开设多专科诊所",
    summary: "新诊所预计 11 月开张，寻求体检合作与企业客户导入，优先考虑已具备企业福利方案的团队。",
    url: "https://news.example.com/pj-clinic",
    published_at: new Date(now.getTime()-86400000).toISOString(),
    budget_rm: 80000,
    matched_industries: ["health screening","dental clinic","wellness center"],
    location: "Selangor",
    signals: ["new branch","opening","panel clinic"],
    suggested_members: [
      { name: "Ben", specialty: "Corporate Panel Setup", chapter_role: "Insurance/TPA" }
    ],
    opening_line: "恭喜新院开业！我们可协助企业体检与面向 HR 的福利方案，一起做开业联合活动？"
  },
  {
    id: "opp_pg_healthtalk_003",
    title: "Penang 工厂 Q3-Q4 连续健康讲座招募讲师",
    summary: "围绕睡眠、压力管理、营养与关节保养四大主题，每月一场，为200名生产线员工。",
    url: "https://news.example.com/pg-healthtalk",
    published_at: new Date(now.getTime()-2*86400000).toISOString(),
    budget_rm: 30000,
    matched_industries: ["nutrition","physiotherapy","supplements"],
    location: "Penang",
    signals: ["health talk","CSR health","employee wellness"],
    suggested_members: [
      { name: "Chong", specialty: "Physiotherapy Ergonomics", chapter_role: "Physio" }
    ],
    opening_line: "你们健康讲座主题我们都有现成教材，是否先安排一场试点？我们可连带做员工风险筛查。"
  }
];


  // 简单过滤逻辑
  const withinDays = (iso, days) => {
    const ts = new Date(iso).getTime();
    return (now.getTime() - ts) <= days * 86400000;
  };

  const items = fake
    .filter(x => withinDays(x.published_at, time_range_days))
    .filter(x => (industries.length ? industries.some(i => x.matched_industries.includes(i)) : true))
    .filter(x => (locations.length ? locations.includes(x.location) : true))
    .filter(x => x.budget_rm >= min_budget_rm)
    .slice(0, limit)
    .map(x => {
      const score =
        0.5 * (industries.length ? 1 : 0.7) +
        0.2 * (locations.length ? 1 : 0.6) +
        0.2 * (x.signals?.length >= 2 ? 1 : 0.6) +
        0.1 * 1;
      return { ...x, score: Math.min(1, Number(score.toFixed(2))) };
    });

  res.status(200).json({ items });
}



