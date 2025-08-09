let SUBS = []; // 内存存储，演示用；生产会换 DB/cron

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const payload = req.body || {};
  const id = `sub_${Date.now()}`;
  SUBS.push({ id, ...payload });
  res.status(200).json({ status: "ok", subscription_id: id });
}
