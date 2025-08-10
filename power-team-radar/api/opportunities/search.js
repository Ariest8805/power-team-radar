// api/opportunities/search.js
// 多数据源 + 超时保护 + 兜底数据（保证不空）
// Sources（免 token）：Google News RSS / Bing News RSS / Eventbrite Public RSS / The Star Health / Malay Mail Life / Meetup RSS

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const {
      industries = [],
      locations = [],
      time_range_days = 7,
      limit = 5,
      language = "en"
    } = req.body || {};

    // ===== keywords / signals =====
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

    const langCode = language === "zh" ? "zh" : "en";
    const country = "MY";
    const baseKws = uniq([...health_keywords, ...industries]);
    const searchKwsShort = baseKws.slice(0, 6).join(" OR ");
    const geoList = locations.length ? locations : ["Malaysia"];
    const sinceIso = isoDaysAgo(time_range_days);

    // ===== 并发抓取（每源自带超时） =====
    const tasks = [];

    for (const loc of geoList) {
      tasks.push(fetchFromGoogleNews({ kws: searchKwsShort, loc, langCode, country }).catch(() => []));
      tasks.push(fetchFromBingNews({ kws: searchKwsShort, loc }).catch(() => []));
    }
    const ebCities = geoList.includes("Kuala Lumpur") ? ["Kuala Lumpur"] : geoList;
    for (const city of ebCities) tasks.push(fetchFromEventbritePublicRss({ city }).catch(() => []));
    tasks.push(fetchFromTheStarHealth().catch(() => []));
    tasks.push(fetchFromMalayMailLife().catch(() => []));
    for (const city of (geoList.includes("Kuala Lumpur") ? ["Kuala Lumpur"] : geoList)) {
      tasks.push(fetchFromMeetup({ city, keyword: "health" }).catch(() => []));
    }

    // 等待全部返回（单源有超时，不会拖死总时长）
    const settled = await Promise.all(tasks);
    let items = settled.flat();

    // ===== 去重 / 过滤 / 打分 =====
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

    // ===== 兜底：如果为空，给 3 条 demo（方便你课堂或演示） =====
    let out = enriched.slice(0, limit);
    if (out.length === 0) {
      const now = new Date();
      out = [
        {
          id: `fallback_${Date.now()}_1`,
          title: "KL 科技园 Q4 Corporate Wellness Program（示例）",
          summary: "为 500 名员工的 3 个月企业健康计划，包含健康讲座、体测与营养咨询。",
          url: "https://example.com/kl-corpwellness",
          published_at: now.toISOString(),
          score: 0.9,
          matched_industries: industries.length ? industries : ["corporate wellness","nutrition"],
          location: geoList[0],
          signals: ["corporate wellness program","RFP"],
          suggested_members: [
            { name: "Wellness Coach", specialty: "Wellness Coach", chapter_role: "Wellness" },
            { name: "Medical Lab", specialty: "Medical Lab", chapter_role: "Health Screening" }
          ],
          opening_line: language === "zh" ? "嗨，这个企业健康方案很适合你们团队，要不要我牵线？" : "This wellness program looks like a fit—want an intro?"
        },
        {
          id: `fallback_${Date.now()}_2`,
          title: "Selangor 新诊所开业联合活动合作（示例）",
          summary: "多专科诊所寻营养与体检合作，开业活动可联合举办健康讲座。",
          url: "https://example.com/selangor-clinic-opening",
          published_at: new Date(now.getTime()-86400000).toISOString(),
          score: 0.86,
          matched_industries: ["health screening","nutrition"],
          location: geoList[0],
          signals: ["opening","panel clinic"],
          suggested_members: [{ name: "Medical Lab", specialty: "Medical Lab", chapter_role: "Lab" }],
          opening_line: language === "zh" ? "恭喜开业，我们可提供入职体检+讲座，一起做曝光？" : "Congrats on opening—shall we co-run a health talk + screenings?"
        },
        {
          id: `fallback_${Date.now()}_3`,
          title: "Penang 工厂健康讲座招募讲师（示例）",
          summary: "围绕睡眠、营养、压力管理主题，每月一场，约 200 名员工。",
          url: "https://example.com/penang-healthtalk",
          published_at: new Date(now.getTime()-2*86400000).toISOString(),
          score: 0.8,
          matched_industries: ["nutrition","physiotherapy"],
          location: geoList[0],
          signals: ["health talk","employee wellness"],
          suggested_members: [{ name: "Physio", specialty: "Physio", chapter_role: "Physiotherapy" }],
          opening_line: language === "zh" ? "这主题我们教材齐全，安排试点？" : "We have decks ready—shall we run a pilot talk?"
        }
      ].slice(0, limit);
    }

    return res.status(200).json({ items: out });
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
}

/* ====================== 数据源（每个都带超时） ====================== */

const PER_SOURCE_TIMEOUT = 4500; // 每个源最多 4.5s，避免 Action 超时

async function fetchFromGoogleNews({ kws, loc, langCode, country }) {
  const base = "https://news.google.com/rss/search";
  const q = `(${kws}) AND (${loc})`;
  const url = `${base}?` + new URLSearchParams({
    q, hl: `${langCode}-${country}`, gl: country, ceid: `${country}:${langCode}`
  }).toString();
  const rss = await fetchRss(url, PER_SOURCE_TIMEOUT);
  return rss.map(r => ({ source: "google_news", title: r.title, summary: r.description?.slice(0,300)||"", url: r.link, published_at: r.pubDate, location: loc }));
}

async function fetchFromBingNews({ kws, loc }) {
  const query = encodeURIComponent(`${kws.replace(/\s+OR\s+/g," ").replace(/\(|\)/g,"")} ${loc}`);
  const url = `https://www.bing.com/news/search?q=${query}&format=RSS`;
  const rss = await fetchRss(url, PER_SOURCE_TIMEOUT);
  return rss.map(r => ({ source: "bing_news", title: r.title, summary: r.description?.slice(0,300)||"", url: r.link, published_at: r.pubDate, location: loc }));
}

async function fetchFromEventbritePublicRss({ city }) {
  const citySlug = (city || "Kuala Lumpur").toLowerCase().replace(/\s+/g,"-");
  const url = `https://www.eventbrite.com/d/malaysia--${encodeURIComponent(citySlug)}/health--events/rss/`;
  const rss = await fetchRss(url, PER_SOURCE_TIMEOUT);
  return rss.map(r => ({ source: "eventbrite_rss", title: r.title, summary: r.description?.slice(0,300)||"", url: r.link, published_at: r.pubDate, location: city }));
}

async function fetchFromTheStarHealth() {
  const rss = await fetchRss("https://www.thestar.com.my/rss/health", PER_SOURCE_TIMEOUT);
  return rss.map(r => ({ source: "the_star_health", title: r.title, summary: r.description?.slice(0,300)||"", url: r.link, published_at: r.pubDate, location: "Malaysia" }));
}

async function fetchFromMalayMailLife() {
  const rss = await fetchRss("https://www.malaymail.com/rss?tag=life", PER_SOURCE_TIMEOUT);
  return rss.map(r => ({ source: "malay_mail_life", title: r.title, summary: r.description?.slice(0,300)||"", url: r.link, published_at: r.pubDate, location: "Malaysia" }));
}

async function fetchFromMeetup({ city = "Kuala Lumpur", keyword = "health" }) {
  const url = "https://www.meetup.com/find/events/?" + new URLSearchParams({
    allMeetups: "true", keywords: keyword, radius: "Infinity", userFreeform: city, format: "rss"
  }).toString();
  const rss = await fetchRss(url, PER_SOURCE_TIMEOUT);
  return rss.map(r => ({ source: "meetup_rss", title: r.title, summary: r.description?.slice(0,300)||"", url: r.link, published_at: r.pubDate, location: city }));
}

/* ============================ 工具 ============================ */

function isoDaysAgo(days){ const d=new Date(); d.setDate(d.getDate()-days); return d.toISOString(); }

async function fetchRss(url, timeoutMs=4500){
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), timeoutMs);
  try{
    const res = await fetch(url, { headers: { "User-Agent":"Mozilla/5.0" }, signal: controller.signal });
    if (!res.ok) throw new Error(`RSS fetch failed ${res.status}`);
    const xml = await res.text();
    return parseRss(xml);
  } finally { clearTimeout(timer); }
}

function parseRss(xml){
  const items=[]; const re=/<item>([\s\S]*?)<\/item>/g; let m;
  while((m=re.exec(xml))!==null){
    const b=m[1];
    const title=getTag(b,"title"); const link=getTag(b,"link");
    const pub=getTag(b,"pubDate")||getTag(b,"published");
    const desc=stripHtml(getTag(b,"description")||"");
    items.push({ title:decodeHtml(title||""), link:decodeHtml(link||""), pubDate: pub?new Date(pub).toISOString():new Date().toISOString(), description: decodeHtml(desc||"") });
  }
  return items;
}
function getTag(b,tag){ const r=new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`,"i"); const m=r.exec(b); return m?m[1].trim():null; }
function stripHtml(s){ return s.replace(/<[^>]+>/g,"").trim(); }
function decodeHtml(s){ return s.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'"); }
function daysBetween(iso){ if(!iso) return 999; const now=Date.now(), t=new Date(iso).getTime(); return Math.floor((now-t)/86400000); }
function countHits(t,kws){ const l=t.toLowerCase(); let n=0; for(const k of kws) if(l.includes(k.toLowerCase())) n++; return n; }
function scoreItem({locationMatch,signalsCount,daysAge,kwHits}){ const kw=Math.min(1,kwHits/3), geo=locationMatch?1:0.6, sig=Math.min(1,signalsCount/2), rec=daysAge<=7?1:daysAge<=14?0.7:0.4; return Number(Math.min(1, 0.5*kw+0.2*geo+0.2*sig+0.1*rec).toFixed(2)); }
function uniq(arr){ return Array.from(new Set(arr)); }
function uniqBy(arr,key){ const m=new Map(); for(const x of arr){ const k=key(x); if(!m.has(k)) m.set(k,x);} return Array.from(m.values()); }
function guessLocationFromText(text){ if(!text) return null; const locs=["Kuala Lumpur","Selangor","Penang","Johor","Malaysia","Singapore"]; const t=text.toLowerCase(); for(const l of locs) if(t.includes(l.toLowerCase())) return l; return null; }
