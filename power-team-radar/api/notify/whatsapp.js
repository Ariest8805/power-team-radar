export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { items = [], recipient, template = "POWER_TEAM_BRIEF_V1" } = req.body || {};
  // 模拟发送耗时
  await new Promise(r => setTimeout(r, 500));
  res.status(200).json({
    status: "sent",
    recipient,
    template,
    delivered: items.map((id, idx) => ({ id, status: "queued", ref: `msg_${Date.now()}_${idx}` })),
    note: "MVP mock sender — switch to WhatsApp Cloud API in production."
  });
}
