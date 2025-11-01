// ─────────────────────────────────────────────────────────
// Auracle Telegram Bot — Stable + Trending (No waitForTimeout)
// ─────────────────────────────────────────────────────────

import puppeteer from "puppeteer";
import fs from "fs";
import http from "http";

// ====== CONFIG (env or defaults) ======
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "YOUR_TELEGRAM_BOT_TOKEN";
const CHAT_ID  = process.env.TELEGRAM_CHAT_ID  || "YOUR_TELEGRAM_CHAT_ID";
const AURACLE_BASE = (process.env.AURACLE_BASE_URL || "https://auracle.fi").replace(/\/+$/,"");
const POLL_INTERVAL_MS = Math.max(10000, parseInt(process.env.POLL_INTERVAL_MS || "30000", 10)); // default 30s
const PORT = parseInt(process.env.PORT || "8080", 10);
const DEBUG = (process.env.DEBUG === "1" || process.env.DEBUG === "true");

// ====== STATE ======
const STATE_FILE = "./state.json";
let state = loadState();
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { markets: {}, seeded: false }; }
}
function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ====== UTILS ======
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a)=> console.log(...a);
const dbg = (...a)=> { if (DEBUG) console.log(...a); };

function escMD(s="") {
  return s.replace(/([_*\[\]()~>#+\-=|{}.!\\])/g, "\\$1");
}

function humanizeEta(targetMs) {
  if (!Number.isFinite(targetMs)) return "soon";
  const diff = Math.max(0, Math.floor((targetMs - Date.now())/1000));
  const m = Math.floor(diff/60), h = Math.floor(m/60), d = Math.floor(h/24);
  if (d >= 2) return `in about ${d} days`;
  if (d === 1) return `in about 1 day`;
  if (h >= 2) return `in about ${h} hours`;
  if (h === 1) return `in about 1 hour`;
  if (m >= 2) return `in about ${m} minutes`;
  if (m === 1) return `in about 1 minute`;
  return "soon";
}

// ====== TELEGRAM ======
async function send(msg) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: msg,
        parse_mode: "Markdown",
        disable_web_page_preview: true
      })
    });
  } catch (e) {
    console.error("[send] error", e?.message || e);
  }
}

// ====== MESSAGES ======
function fmtNew(m) {
  const lines = (m.options||[]).slice(0,3).map(o => `• ${escMD(o.label)} — *${o.pct}%*`).join("\n");
  const time = m.endsIn ? `\n⏳ ${escMD(m.endsIn)}` : "";
  return `🔥 *New Market Live on Auracle*\n🏟️ ${escMD(m.title)}${time}\n${lines ? ("\n"+lines) : ""}\n\n🔗 ${m.url}`;
}
function fmtTrending(m) {
  return `📈 *Trending Now on Auracle!*\n🏟️ ${escMD(m.title)}\n\n🔗 ${m.url}`;
}
function fmtClosed(m) {
  const list = (m.options||[]).map(o => `${escMD(o.label)} ${o.pct}%`).join(" | ") || "—";
  return `🛑 *Market Closed — Final Pool*\n🏟️ ${escMD(m.title)}\n📊 ${list}\n👀 Awaiting resolution…\n🔗 ${m.url}`;
}
function fmtResolved(m) {
  const list = (m.options||[]).map(o => `${escMD(o.label)} ${o.pct}%`).join(" | ") || "—";
  return `✅ *Market Resolved*\n🏟️ ${escMD(m.title)}\n🏆 Winner: *${escMD(m.winner)}*\n📊 Final: ${list}\n💰 Rewards live on Auracle\n🔗 ${m.url}`;
}

// ====== PUPPETEER ======
async function newBrowserPage() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"]
  });
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (AuracleBot)");
  await page.setViewport({ width: 1280, height: 1200 });
  return { browser, page };
}

async function autoScroll(page) {
  // robust scrolling (no page.waitForTimeout)
  for (let i=0;i<8;i++){
    await page.evaluate(()=>window.scrollBy(0, 1200));
    await sleep(400);
  }
}

// ====== LIST SCRAPER (Active + Trending) ======
async function scrapeList() {
  const { browser, page } = await newBrowserPage();
  const url = `${AURACLE_BASE}/Markets?ts=${Date.now()}`;
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
    await autoScroll(page);

    const result = await page.evaluate(() => {
      const out = { active: [], trending: [] };
      const anchors = Array.from(document.querySelectorAll('a[href*="MarketDetails?id="]'));
      // For each anchor, find a reasonable card root and infer if it's trending by "#x HOT"
      const textOf = (el)=> (el?.textContent||"").trim();
      function findCard(el){
        let cur = el;
        for (let i=0;i<6 && cur;i++) {
          if (cur.matches?.("article,section,div")) return cur;
          cur = cur.parentElement;
        }
        return el.parentElement;
      }
      function isTrendingCard(card){
        const t = card?.innerText?.toUpperCase() || "";
        return /#\s*\d+\s*HOT/.test(t);
      }
      for (const a of anchors) {
        const id = new URL(a.href).searchParams.get("id");
        if (!id) continue;
        const card = findCard(a);
        // Prefer a heading inside card for title; fallback to first line of anchor text
        let title = textOf(card?.querySelector("h3,h2,h1,.title")) || textOf(a).split("\n")[0];
        title = title.replace(/\s+/g," ").trim();
        const entry = { id, url: a.href, title };
        if (isTrendingCard(card)) out.trending.push(entry);
        else out.active.push(entry);
      }
      return out;
    });

    return result;
  } catch (e) {
    console.error("[list] error", e.message);
    return { active: [], trending: [] };
  } finally {
    await browser.close();
  }
}

// ====== DETAIL SCRAPER ======
async function scrapeDetail(url) {
  const { browser, page } = await newBrowserPage();
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
    await autoScroll(page);

    const data = await page.evaluate(() => {
      const txt = (el)=> (el?.textContent||"").trim();
      const raw = (document.body?.innerText||"");

      // Title
      let title = document.querySelector('meta[property="og:title"]')?.content?.trim() || "";
      if (!title) title = txt(document.querySelector("h1,h2,.title")) || "";

      // Status + winner
      let status = "open";
      let winner = null;
      if (/ORACLE CLOSED/i.test(raw)) status = "closed";
      const m = raw.match(/ORACLE RESOLVED:\s*(.+)/i);
      if (m) { status = "resolved"; winner = (m[1]||"").trim(); }

      // Options: try visible rows first
      const options = [];
      const rows = document.querySelectorAll(".option,.side,[data-option],.market-option");
      rows && rows.forEach(r=>{
        const label = txt(r.querySelector(".label,.team,.option-label,span,strong"));
        const p = r.querySelector(".percent,.percentage");
        if (label && p) {
          const pct = parseInt(p.textContent.replace(/[^0-9.]/g,""),10);
          if (Number.isFinite(pct)) options.push({label, pct});
        }
      });

      // Fallback parsing on closed/resolved: "CURRENT TEAM 55%" or "TEAM IMPLIED 55%"
      if (options.length < 2) {
        const lines = raw.split("\n").map(s=>s.trim()).filter(Boolean);
        for (const line of lines) {
          let mm = line.match(/CURRENT\s+(.+?)\s+(\d+)\s*%/i);
          if (mm) options.push({ label: mm[1].trim(), pct: parseInt(mm[2],10) });
          mm = line.match(/^(.+?)\s+IMPLIED.*?(\d+)\s*%/i);
          if (mm) options.push({ label: mm[1].trim(), pct: parseInt(mm[2],10) });
          if (options.length >= 3) break;
        }
      }

      // End time (best-effort)
      let closeISO = "";
      const dateMatch = raw.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s*\d{4}\s+at\s+\d{1,2}:\d{2}\s*(AM|PM)/i);
      if (dateMatch) {
        const d = new Date(dateMatch[0]);
        if (!isNaN(d.getTime())) closeISO = d.toISOString();
      }

      const id = new URL(location.href).searchParams.get("id");
      return { id, url: location.href, title, status, winner, options, closeISO };
    });

    // YES/NO mapping → option names
    if (data && data.winner && Array.isArray(data.options) && data.options.length >= 2) {
      const w = data.winner.toLowerCase();
      if (w.includes("yes")) data.winner = data.options[0].label;
      if (w.includes("no"))  data.winner = data.options[1].label;
    }

    // endsIn string
    if (data?.closeISO) {
      const ms = Date.parse(data.closeISO);
      if (Number.isFinite(ms)) data.endsIn = humanizeEta(ms);
    }

    return data;
  } catch (e) {
    console.error("[detail] error", e.message);
    return null;
  } finally {
    await browser.close();
  }
}

// ====== TICK LOOP ======
let TICK_RUNNING = false;

async function tick() {
  if (TICK_RUNNING) return;
  TICK_RUNNING = true;

  const start = Date.now();
  log("[tick] START", new Date().toISOString());

  // Scrape lists
  const lists = await scrapeList();
  let { active, trending } = lists;

  if ((active.length === 0) && (trending.length === 0)) {
    log("[tick] zero lists — skipping");
    TICK_RUNNING = false;
    return;
  }
  log(`[tick] list → active ${active.length}, trending ${trending.length}`);

  // First-boot silent seed (no spam)
  if (!state.seeded) {
    for (const m of [...active, ...trending]) {
      state.markets[m.id] = {
        id: m.id,
        url: m.url,
        title: m.title,
        announcedOpen: true,           // silent
        announcedTrending: true,       // silent
        announcedClosed: false,
        announcedResolved: false,
        retired: false,
        lastSeen: {}
      };
    }
    state.seeded = true;
    saveState();
    log("[seed] initial seed complete");
    TICK_RUNNING = false;
    return;
  }

  // Detect new markets (from Active only)
  for (const m of active) {
    const rec = state.markets[m.id];
    if (!rec || !rec.announcedOpen) {
      const d = await scrapeDetail(m.url);
      if (d) {
        const options = d.options || [];
        const endsIn = d.endsIn;
        await send(fmtNew({ ...m, options, endsIn }));
        state.markets[m.id] = {
          ...(rec||{}),
          id: m.id, url: m.url, title: d.title || m.title,
          announcedOpen: true,
          lastSeen: { options: options }
        };
        saveState();
      }
    }
  }

  // Detect new entries into Trending (announce always — Option B)
  for (const m of trending) {
    const rec = state.markets[m.id] || {};
    if (!rec.announcedTrending) {
      await send(fmtTrending({ ...m }));
      state.markets[m.id] = { ...rec, id:m.id, url:m.url, title:m.title, announcedTrending: true };
      saveState();
    }
  }

  // Detail pass for closed/resolved
  const idsToCheck = Object.keys(state.markets).filter(id => !state.markets[id].retired);
  for (const id of idsToCheck) {
    const rec = state.markets[id];
    const url = rec.url || `${AURACLE_BASE}/MarketDetails?id=${id}`;
    const d = await scrapeDetail(url);
    if (!d) continue;

    // track lastSeen options while open
    if (d.status === "open" && d.options?.length) {
      rec.lastSeen = { ...(rec.lastSeen||{}), options: d.options };
      saveState();
    }

    // closed
    if (d.status === "closed" && !rec.announcedClosed) {
      const options = (d.options?.length ? d.options : (rec.lastSeen?.options||[]));
      rec.closedSnapshot = { options };
      await send(fmtClosed({ title: d.title || rec.title || "Market", options, url }));
      rec.announcedClosed = true;
      rec.title = d.title || rec.title;
      saveState();
    }

    // resolved
    if (d.status === "resolved" && !rec.announcedResolved) {
      const options = (rec.closedSnapshot?.options?.length ? rec.closedSnapshot.options
                      : (rec.lastSeen?.options || d.options || []));
      const winner = d.winner || (options[0]?.label || "YES");
      await send(fmtResolved({ title: d.title || rec.title || "Market", winner, options, url }));
      rec.announcedResolved = true;
      rec.retired = true;
      rec.title = d.title || rec.title;
      saveState();
    }
  }

  log("[tick] END", new Date().toISOString(), "elapsed", (Date.now()-start), "ms");
  TICK_RUNNING = false;
}

// ====== SERVER + SCHEDULER ======
http.createServer((_,res)=>{res.end("OK");}).listen(PORT, ()=>log("[HTTP] :"+PORT));

await tick();
setInterval(tick, POLL_INTERVAL_MS);
setInterval(()=>log("[hb]", new Date().toISOString()), 10000);
