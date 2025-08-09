export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { items = [], recipient } = req.body || {};
  // 这里先不接 Meta API；演示返回“已发送”
  res.status(200).json({ status: "sent", count: items.length, recipient });
}
