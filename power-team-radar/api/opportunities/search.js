// api/opportunities/search.js
// 多数据源：Google News RSS（免token） + Eventbrite（可选） + Facebook Page（可选） + LinkedIn Org（可选）
// 环境变量（Vercel → Settings → Environment Variables）可选：
//   EVENTBRITE_TOKEN
//   FB_PAGE_IDS            例： "1234567890,9876543210"
//   FB_TOKEN               例： "EAAG..."（页面读取用）
//   LINKEDIN_ORG_IDS       例： "123456,789012"
//   LINKEDIN_TOKEN         例： "AQX..."
// 端点：POST /api/opportunities/search

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const {
      industries = [],              // ["corporate wellness","nutrition",...]
      locations = [],               // ["Kuala Lumpur","Selangor",...]
      min_budget_rm,                // 目前不做硬过滤
      time_range_days = 7,
      limit = 5,
      language = "en"               // "en" | "zh" | "ms"
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

    // ---------- 汇总关键词、地点 ----------
    const langCode = language === "zh" ? "zh" : "en";
    const country = "MY";
    const baseKws = uniq([...health_keywords, ...industries]);         // 让 industries 参与检索
    const searchKws = baseKws.slice(0, 6).join(" OR ");                // 控制长度
    const geoList = locations.length ? locations : ["Malaysia"];

    // ---------- 并发抓取多数据源 ----------
    const sinceIso = isoDaysAgo(time_range_days);

    const tasks = [];

    // Google News（免token）
    for (const loc of geoList) {
      tasks.push(fetchFromGoogleNews({ kws: searchKws, loc, langCode, country })
        .catch(() => []));
    }

    // Eventbrite（需 token，可选）
    if (process.env.EVENTBRITE_TOKEN) {
      for (const loc of geoList) {
        tasks.push(fetchFromEventbrite({ kws: baseKws.slice(0,3).join(" "), location: loc, sinceIso })
          .catch(() => []));
      }
    }

    // Facebook 公共专页（需 page ids + token，可选）
    if (process.env.FB_PAGE_IDS && process.env.FB_TOKEN) {
      const pageIds = process.env.FB_PAGE_IDS.split(",").map(s => s.trim()).filter(Boolean);
      tasks.push(fetchFromFacebookPages({ pageIds, sinceIso }).catch(() => []));
    }

    // LinkedIn 公司页（需 org ids + token，可选；注意权限）
    if (process.env.LINKEDIN_ORG_IDS && process.env.LINKEDIN_TOKEN) {
      const orgIds = process.env.LINKEDIN_ORG_IDS.split(",").map(s => s.trim()).filter(Boolean);
      tasks.push(fetchFromLinkedInOrgs({ orgIds, sinceIso }).catch(() => []));
    }

    const results = await Promise.all(tasks);
    let items = results.flat();

    // ---------- 去重 / 过滤 / 打分 ----------
    items = uniqBy(items, x => x.url || (x.title + x.published_at));

    items = items.filter(x => daysBetween(x.published_at) <= time_range_days);

    const enriched = items.map(x => {
      const text = `${x.title || ""} ${x.summary || ""}`.toLowerCase();
      const kwHits = countHits(text, health_keywords);
      const signals = signal_keywords.filter(k => text.includes(k.toLowerCase()));
      const locationMatch = geoList.length === 1 && geoList[0] !== "Malaysia"
        ? (x.location && geoList.includes(x.location))
        : true; // 有明确城市时更严格
      const daysAge = daysBetween(x.published_at);
      const score = scoreItem({ locationMatch, signalsCount: signals.length, daysAge, kwHits });
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

/* ========================= 数据源实现 ========================= */

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

// Eventbrite（需要 EVENTBRITE_TOKEN）
async function fetchFromEventbrite({ kws, location, sinceIso }) {
  const token = process.env.EVENTBRITE_TOKEN;
  if (!token) return [];
  const url = "https://www.eventbriteapi.com/v3/events/search/?" + new URLSearchParams({
    q: kws,
    "location.address": location,
    "start_date.range_start": sinceIso,
    sort_by: "date"
  }).toString();

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` }});
  if (!resp.ok) throw new Error("Eventbrite API error " + resp.status);
  const data = await resp.json();
  const events = data.events || [];
  return events.map(ev => ({
    source: "eventbrite",
    title: ev.name?.text || "Eventbrite Event",
    summary: ev.description?.text?.slice(0, 300) || "",
    url: ev.url,
    published_at: ev.start?.utc || ev.created || new Date().toISOString(),
    location: location
  }));
}

// Facebook 公共专页（需要 FB_PAGE_IDS + FB_TOKEN）
async function fetchFromFacebookPages({ pageIds, sinceIso }) {
  const token = process.env.FB_TOKEN;
  if (!token || !pageIds?.length) return [];
  const out = [];
  for (const id of pageIds) {
    const url = `https://graph.facebook.com/v20.0/${id}/posts?` + new URLSearchParams({
      fields: "message,created_time,permalink_url",
      since: Math.floor(new Date(sinceIso).getTime() / 1000)  // unix秒
    }).toString();
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` }});
    if (!resp.ok) continue;
    const data = await resp.json();
    const posts = data.data || [];
    for (const p of posts) {
      out.push({
        source: "facebook_page",
        title: (p.message || "").split("\n")[0].slice(0, 100) || "Facebook Post",
        summary: p.message?.slice(0, 300) || "",
        url: p.permalink_url,
        published_at: p.created_time,
        location: null
      });
    }
  }
  return out;
}

// LinkedIn 公司页（需要 LINKEDIN_ORG_IDS + LINKEDIN_TOKEN；权限较严格）
async function fetchFromLinkedInOrgs({ orgIds, sinceIso }) {
  const token = process.env.LINKEDIN_TOKEN;
  if (!token || !orgIds?.length) return [];
  const out = [];
  for (const org of orgIds) {
    // 简化版：抓 shares（注意：LinkedIn API 权限限制严格，可能返回403）
    const url = `https://api.linkedin.com/v2/shares?` + new URLSearchParams({
      q: "owners",
      owners: `urn:li:organization:${org}`,
      sharesPerOwner: "20"
    }).toString();
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` }});
    if (!resp.ok) continue;
    const data = await resp.json();
    const elements = data.elements || [];
    for (const el of elements) {
      const created = el.created?.time ? new Date(el.created.time).toISOString() : null;
      if (created && created < sinceIso) continue;
      const text = el.text?.text || "";
      out.push({
        source: "linkedin_org",
        title: text.split("\n")[0].slice(0, 100) || "LinkedIn Post",
        summary: text.slice(0, 300),
        url: `https://www.linkedin.com/feed/update/${el.activity || ""}`,
        published_at: created || new Date().toISOString(),
        location: null
      });
    }
  }
  return out;
}

/* ========================= 通用工具 ========================= */

function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
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

function stripHtml(str) { return str.replace(/<[^>]+>/g, "").trim(); }
function decodeHtml(str) {
  return str.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
            .replace(/&quot;/g,'"').replace(/&#39;/g,"'");
}

function daysBetween(iso) {
  if (!iso) return 999;
  const now = Date.now();
  const t = new Date(iso).getTime();
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
