// api/opportunities/search.js
// ✅ 多数据源（全部免 Token，立即可测）
//    - Google News RSS
//    - Bing News RSS
//    - Eventbrite 公共 RSS（KL 健康主题）
//    - The Star Health RSS
//    - Malay Mail Life/Health RSS
//    - Meetup 公共 RSS（KL + health）
// ✅ 统一去重 / 过滤（近 N 天）/ 打分 / 排序
// ✅ 端点：POST /api/opportunities/search

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const {
      industries = [],               // ["corporate wellness","nutrition",...]
      locations = [],                // ["Kuala Lumpur","Selangor",...]
      time_range_days = 7,
      limit = 5,
      language = "en"                // "en" | "zh" | "ms"
    } = req.body || {};

    // ---------- 关键词 & 触发词 ----------
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
    const role_map = {
      "nutrition": ["Wellness Coach","Dietitian","Supplements"],
      "corporate wellness": ["Wellness Coach","Health Screening"],
      "health screening": ["Medical Lab","Wellness Coach"],
      "physiotherapy": ["Physio","Ergonomics"],
      "dental clinic": ["Dentist"],
      "clinic": ["Wellness Center","Medical Lab"],
      "supplements": ["Supplements","Wellness Coach"]
    };

    // ---------- 检索组合 ----------
    const langCode = language === "zh" ? "zh" : "en";
    const country = "MY";
    const baseKws = uniq([...health_keywords, ...industries]);
    const searchKwsShort = baseKws.slice(0, 6).join(" OR ");
    const geoList = locations.length ? locations : ["Malaysia"];
    const sinceIso = isoDaysAgo(time_range_days);

    // ---------- 并发抓取（免 Token 源） ----------
    const tasks = [];

    // Google News
    for (const loc of geoList) {
      tasks.push(fetchFromGoogleNews({ kws: searchKwsShort, loc, langCode, country }).catch(() => []));
    }

    // Bing News
    for (const loc of geoList) {
      tasks.push(fetchFromBingNews({ kws: searchKwsShort, loc }).catch(() => []));
    }

    // Eventbrite 公共 RSS（KL 健康主题；如果传别的城市，就简单替换）
    const ebCities = geoList.includes("Kuala Lumpur") ? ["Kuala Lumpur"] : geoList;
    for (const city of ebCities) {
      tasks.push(fetchFromEventbritePublicRss({ city }).catch(() => []));
    }

    // The Star Health（专栏 RSS）
    tasks.push(fetchFromTheStarHealth().catch(() => []));

    // Malay Mail Life（包含健康）
    tasks.push(fetchFromMalayMailLife().catch(() => []));

    // Meetup（KL + health 的公共 RSS）
    const meetupCities = geoList.includes("Kuala Lumpur") ? ["Kuala Lumpur"] : geoList;
    for (const city of meetupCities) {
      tasks.push(fetchFromMeetup({ city, keyword: "health" }).catch(() => []));
    }

    const results = await Promise.all(tasks);
    let items = results.flat();

    // ---------- 去重 / 过滤 / 打分 ----------
    items = uniqBy(items, x => x.url || (x.title + (x.published_at || "")));

    items = items.filter(x => daysBetween(x.published_at) <= time_range_days);

    const enriched = items.map(x => {
      const text = `${x.title || ""} ${x.summary || ""}`.toLowerCase();
      const kwHits = countHits(text, health_keywords);
      const signals = signal_keywords.filter(k => text.includes(k.toLowerCase()));
      const locMatch = locations.length
        ? (x.location && locations.map(s=>s.toLowerCase()).includes(x.location.toLowerCase()))
        : true;
      const daysAge = daysBetween(x.published_at);
      const score = scoreItem({ locationMatch: locMatch, signalsCount: signals.length, daysAge, kwHits });

      return {
        ...x,
        score,
        matched_industries: industries.length ? industries : ["health"],
        signals
      };
    });

    enriched.sort((a,b) => (b.score - a.score) || (new Date(b.published_at) - new Date(a.published_at)));

    const out = enriched.slice(0, limit).map((x, idx) => {
      const firstIndustry = (x.matched_industries[0] || "health").toLowerCase();
      const roles = role_map[firstIndustry] || ["Wellness Coach","Medical Lab"];
      const suggested = roles.slice(0,2).map(r => ({ name: r, specialty: r, chapter_role: r }));
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
        location: x.location || guessLocationFromText(x.summary) || geoList[0],
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

/* ====================== 各数据源实现（免 Token） ====================== */

// Google News RSS
async function fetchFromGoogleNews({ kws, loc, langCode, country }) {
  const base = "https://news.google.com/rss/search";
  const q = `(${kws}) AND (${loc})`;
  const url = `${base}?` + new URLSearchParams({
    q,
    hl: `${langCode}-${country}`,
    gl: country,
    ceid: `${country}:${langCode}`
  }).toString();
  const rss = await fetchRss(url);
  return rss.map(r => ({
    source: "google_news",
    title: r.title,
    summary: r.description?.slice(0, 300) || "",
    url: r.link,
    published_at: r.pubDate,
    location: loc
  }));
}

// Bing News RSS（超宽松）
async function fetchFromBingNews({ kws, loc }) {
  // e.g. https://www.bing.com/news/search?q=health+Malaysia&format=RSS
  const query = encodeURIComponent(`${kws.replace(/\\s+OR\\s+/g, " ").replace(/\\(|\\)/g,"")} ${loc}`);
  const url = `https://www.bing.com/news/search?q=${query}&format=RSS`;
  const rss = await fetchRss(url);
  return rss.map(r => ({
    source: "bing_news",
    title: r.title,
    summary: r.description?.slice(0, 300) || "",
    url: r.link,
    published_at: r.pubDate,
    location: loc
  }));
}

// Eventbrite 公共 RSS（城市健康主题）
async function fetchFromEventbritePublicRss({ city }) {
  // KL 健康类公共 RSS（其它城市可尝试替换 city 名）
  const citySlug = (city || "Kuala Lumpur").toLowerCase().replace(/\\s+/g, "-");
  const url = `https://www.eventbrite.com/d/malaysia--${encodeURIComponent(citySlug)}/health--events/rss/`;
  const rss = await fetchRss(url);
  return rss.map(r => ({
    source: "eventbrite_rss",
    title: r.title,
    summary: r.description?.slice(0, 300) || "",
    url: r.link,
    published_at: r.pubDate,
    location: city
  }));
}

// The Star Health RSS
async function fetchFromTheStarHealth() {
  const url = "https://www.thestar.com.my/rss/health";
  const rss = await fetchRss(url);
  return rss.map(r => ({
    source: "the_star_health",
    title: r.title,
    summary: r.description?.slice(0, 300) || "",
    url: r.link,
    published_at: r.pubDate,
    location: "Malaysia"
  }));
}

// Malay Mail Life（含健康）
async function fetchFromMalayMailLife() {
  const url = "https://www.malaymail.com/rss?tag=life";
  const rss = await fetchRss(url);
  return rss.map(r => ({
    source: "malay_mail_life",
    title: r.title,
    summary: r.description?.slice(0, 300) || "",
    url: r.link,
    published_at: r.pubDate,
    location: "Malaysia"
  }));
}

// Meetup 公共 RSS（城市 + 关键字）
async function fetchFromMeetup({ city = "Kuala Lumpur", keyword = "health" }) {
  // Meetup RSS 搜索页（公共查询），注意并非所有组合都有结果
  const url = "https://www.meetup.com/find/events/?" + new URLSearchParams({
    allMeetups: "true",
    keywords: keyword,
    radius: "Infinity",
    userFreeform: city,
    format: "rss"
  }).toString();
  const rss = await fetchRss(url);
  return rss.map(r => ({
    source: "meetup_rss",
    title: r.title,
    summary: r.description?.slice(0, 300) || "",
    url: r.link,
    published_at: r.pubDate,
    location: city
  }));
}

/* ============================ 通用工具 ============================ */

function isoDaysAgo(days) {
  const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString();
}
async function fetchRss(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`RSS fetch failed ${res.status}`);
  const xml = await res.text();
  return parseRss(xml);
}
function parseRss(xml) {
  const items = [];
  const itemRegex = /<item>([\\s\\S]*?)<\\/item>/g;
  let m; while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const title = getTag(block, "title");
    const link = getTag(block, "link");
    const pubDate = getTag(block, "pubDate") || getTag(block, "published");
    const description = stripHtml(getTag(block, "description") || "");
    items.push({
      title: decodeHtml(title || ""),
      link: decodeHtml(link || ""),
      pubDate: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
      description: decodeHtml(description || "")
    });
  }
  return items;
}
function getTag(block, tag) {
  const r = new RegExp(`<${tag}>([\\\\s\\\\S]*?)<\\/${tag}>`, "i");
  const m = r.exec(block);
  return m ? m[1].trim() : null;
}
function stripHtml(str) { return str.replace(/<[^>]+>/g, "").trim(); }
function decodeHtml(str) {
  return str.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
            .replace(/&quot;/g,'"').replace(/&#39;/g,"'");
}
function daysBetween(iso) {
  if (!iso) return 999;
  const now = Date.now(), t = new Date(iso).getTime();
  return Math.floor((now - t) / 86400000);
}
function countHits(text, kws) {
  const lower = text.toLowerCase();
  let n = 0; for (const k of kws) if (lower.includes(k.toLowerCase())) n++;
  return n;
}
function scoreItem({ locationMatch, signalsCount, daysAge, kwHits }) {
  const kwScore = Math.min(1, kwHits / 3);
  const geoScore = locationMatch ? 1 : 0.6;
  const signalScore = Math.min(1, signalsCount / 2);
  const recency = daysAge <= 7 ? 1 : daysAge <= 14 ? 0.7 : 0.4;
  const score = 0.5*kwScore + 0.2*geoScore + 0.2*signalScore + 0.1*recency;
  return Number(Math.min(1, score).toFixed(2));
}
function uniq(arr) { return Array.from(new Set(arr)); }
function uniqBy(arr, keyFn) {
  const map = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!map.has(k)) map.set(k, x);
  }
  return Array.from(map.values());
}
function guessLocationFromText(text) {
  if (!text) return null;
  const locs = ["Kuala Lumpur","Selangor","Penang","Johor","Malaysia","Singapore"];
  const t = text.toLowerCase();
  for (const l of locs) if (t.includes(l.toLowerCase())) return l;
  return null;
}
