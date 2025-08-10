// api/opportunities/search.js
// ✅ 单文件可运行：抓 Google News RSS（健康相关），筛选近 N 天，打分并返回机会列表
// ✅ 不依赖 package.json / 额外模块，不需要 import
// ✅ 端点：POST /api/opportunities/search

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const {
      industries = [],          // ["corporate wellness","nutrition",...]
      locations = [],           // ["Kuala Lumpur","Selangor",...]
      min_budget_rm,            // 目前用于展示/预留，不做硬过滤
      time_range_days = 7,
      limit = 5,
      language = "en"           // "en" | "zh" | "ms"
    } = req.body || {};

    // ---------- 关键词 & 触发词（可按需修改） ----------
    const health_keywords = [
      "health screening","wellness program","corporate wellness","employee wellness",
      "nutrition consultation","dietitian","supplement","USANA","physiotherapy","rehabilitation",
      "chiropractic","ergonomics","posture","TCM","acupuncture",
      "dental clinic","orthodontic","scaling and polishing",
      "medical lab","blood test","DNA test","health talk","awareness campaign",
      "new clinic","new branch","grand opening","expansion","relocation",
      "RFP","tender","invitation to bid","panel clinic","TPA panel","insurance panel"
    ];

    const signal_keywords = [
      "opening","grand opening","new branch","expansion","relocation",
      "tender","RFP","invitation to bid","corporate wellness program",
      "health talk","CSR health","panel clinic","insurance panel","TPA panel"
    ];

    // 建议角色（用于“适合承接”显示）
    const role_map = {
      "nutrition": ["Wellness Coach","Dietitian","Supplements"],
      "corporate wellness": ["Wellness Coach","Health Screening"],
      "health screening": ["Medical Lab","Wellness Coach"],
      "physiotherapy": ["Physio","Ergonomics"],
      "dental clinic": ["Dentist"],
      "clinic": ["Wellness Center","Medical Lab"],
      "supplements": ["Supplements","Wellness Coach"]
    };

    // ---------- 构造查询 ----------
    const GOOGLE_NEWS_BASE = "https://news.google.com/rss/search";
    const langCode = language === "zh" ? "zh" : "en";
    const country = "MY";
    const baseKws = uniq([
      ...health_keywords,
      ...industries  // 让用户给的行业也参与搜索
    ]);
    const kws = baseKws.slice(0, 6).join(" OR "); // 控制查询长度

    const queries = [];
    if (locations.length) {
      for (const loc of locations) {
        queries.push({ q: `(${kws}) AND (${loc})`, loc });
      }
    } else {
      queries.push({ q: `(${kws}) AND (Malaysia)`, loc: "Malaysia" });
    }

    // ---------- 抓取 RSS 并合并 ----------
    let items = [];
    for (const { q, loc } of queries) {
      const url = buildGoogleNewsUrl(GOOGLE_NEWS_BASE, { query: q, lang: langCode, country });
      try {
        const rss = await fetchRss(url);
        items = items.concat(
          rss.map(r => ({
            title: r.title,
            url: r.link,
            published_at: r.pubDate,
            raw_description: r.description,
            locationGuess: loc
          }))
        );
      } catch {
        // 某个源失败就跳过，不影响整体
      }
    }

    // ---------- 去重 / 过滤 / 打分 ----------
    items = uniqBy(items, x => x.url || x.title);

    const filtered = items.filter(x => daysBetween(x.published_at) <= time_range_days);

    const enriched = filtered.map(x => {
      const text = `${x.title} ${x.raw_description}`.toLowerCase();
      const kwHits = countHits(text, health_keywords);
      const signals = signal_keywords.filter(k => text.includes(k.toLowerCase()));
      const locationMatch = !locations.length || (x.locationGuess && locations.includes(x.locationGuess));
      const daysAge = daysBetween(x.published_at);
      const score = scoreItem({ locationMatch, signalsCount: signals.length, daysAge, kwHits });
      return {
        ...x,
        score,
        matched_industries: industries.length ? industries : ["health"],
        location: x.locationGuess || "Malaysia",
        signals,
        summary: (x.raw_description || "").slice(0, 300)
      };
    });

    enriched.sort((a, b) => (b.score - a.score) || (new Date(b.published_at) - new Date(a.published_at)));

    const out = enriched.slice(0, limit).map((x, idx) => {
      const firstIndustry = (x.matched_industries[0] || "health").toLowerCase();
      const roles = role_map[firstIndustry] || ["Wellness Coach","Medical Lab"];
      const suggested = roles.slice(0, 2).map(r => ({ name: r, specialty: r, chapter_role: r }));
      const opening_line = language === "zh"
        ? "嗨，这个健康相关机会看起来挺匹配，要不要我帮你引荐一下？"
        : "Hi, this health-related opportunity looks like a fit—want me to tee up an intro?";
      return {
        id: `opp_${Date.now()}_${idx}`,
        title: x.title,
        summary: x.summary,
        url: x.url,
        published_at: x.published_at,
        score: x.score,
        matched_industries: x.matched_industries,
        location: x.location,
        signals: x.signals,
        suggested_members: suggested,
        opening_line
      };
    });

    return res.status(200).json({ items: out });

  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
}

/* ---------------------- 小工具函数（内置，无需 import） ---------------------- */

function buildGoogleNewsUrl(base, { query, lang, country }) {
  const params = new URLSearchParams({
    q: query,
    hl: `${lang}-${country}`,
    gl: country,
    ceid: `${country}:${lang}`
  });
  return `${base}?${params.toString()}`;
}

async function fetchRss(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`RSS fetch failed ${res.status}`);
  const xml = await res.text();
  return parseRss(xml);
}

function parseRss(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const title = getTag(block, "title");
    const link = getTag(block, "link");
    const pubDate = getTag(block, "pubDate") || getTag(block, "published");
    const description = stripHtml(getTag(block, "description") || "");
    items.push({
      title: decodeHtml(title || ""),
      link: decodeHtml(link || ""),
      pubDate: pubDate ? new Date(pubDate).toISOString() : null,
      description: decodeHtml(description || "")
    });
  }
  return items;
}

function getTag(block, tag) {
  const r = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = r.exec(block);
  return m ? m[1].trim() : null;
}

function stripHtml(str) {
  return str.replace(/<[^>]+>/g, "").trim();
}

function decodeHtml(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function daysBetween(iso) {
  if (!iso) return 999;
  const now = Date.now();
  const t = new Date(iso).getTime();
  return Math.floor((now - t) / 86400000);
}

function countHits(text, kws) {
  const lower = text.toLowerCase();
  let n = 0;
  for (const k of kws) if (lower.includes(k.toLowerCase())) n++;
  return n;
}

function scoreItem({ locationMatch, signalsCount, daysAge, kwHits }) {
  const kwScore = Math.min(1, kwHits / 3);                 // 关键词命中越多越高
  const geoScore = locationMatch ? 1 : 0.6;                // 地点匹配加分
  const signalScore = Math.min(1, signalsCount / 2);       // 命中触发词（opening/tender等）
  const recency = daysAge <= 7 ? 1 : daysAge <= 14 ? 0.7 : 0.4;
  const score = 0.5*kwScore + 0.2*geoScore + 0.2*signalScore + 0.1*recency;
  return Number(Math.min(1, score).toFixed(2));
}

function uniq(arr) {
  return Array.from(new Set(arr));
}
function uniqBy(arr, keyFn) {
  const map = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!map.has(k)) map.set(k, x);
  }
  return Array.from(map.values());
}
