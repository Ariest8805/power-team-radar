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
      id: "opp_kl_fitout_001",
      title: "KL mall announces new wing fit-out (Q4)",
      summary: "Major retail mall expanding; seeking renovation, M&E, signage vendors.",
      url: "https://news.example.com/kl-fitout",
      published_at: now.toISOString(),
      budget_rm: 500000,
      matched_industries: ["renovation","interior design"],
      location: "Kuala Lumpur",
      signals: ["expansion","fit-out","Q4"],
      suggested_members: [
        { name: "Alice Tan", specialty: "Commercial Renovation", chapter_role: "Contractor" }
      ],
      opening_line: "嗨，我这边刚好有商场新翼装潢项目，你们团队是否有空档承接 Q4 fit-out？"
    },
    {
      id: "opp_selangor_office_002",
      title: "Selangor tech startup relocating HQ",
      summary: "Tech firm moving to bigger office; needs ID, cabling, partition.",
      url: "https://news.example.com/sg-office",
      published_at: new Date(now.getTime() - 2*86400000).toISOString(),
      budget_rm: 180000,
      matched_industries: ["interior design","network cabling"],
      location: "Selangor",
      signals: ["relocation","fit-out"],
      suggested_members: [
        { name: "Ben Lee", specialty: "Office ID", chapter_role: "Designer" }
      ],
      opening_line: "听说你们擅长办公室快速交付，这家科技公司要迁 HQ，或许适合你。"
    },
    {
      id: "opp_penang_chain_003",
      title: "Penang F&B chain to open 3 outlets",
      summary: "Local brand expanding; looking for renovation, signage, kitchen equipment.",
      url: "https://news.example.com/pg-fnb",
      published_at: new Date(now.getTime() - 3*86400000).toISOString(),
      budget_rm: 250000,
      matched_industries: ["renovation","signage"],
      location: "Penang",
      signals: ["expansion","multi-outlet"],
      suggested_members: [
        { name: "Chong", specialty: "F&B Fitout", chapter_role: "Contractor" }
      ],
      opening_line: "这家连锁 F&B 计划 3 家新店，建议你先聊聊厨房与门头招牌标准化。"
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
