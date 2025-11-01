// ─────────────────────────────────────────────────────────
// Auracle Telegram Bot — Trending by "#N HOT" badge only
// Robust + Verbose + Snapshots + No waitForTimeout
// v5
// ─────────────────────────────────────────────────────────

import puppeteer from "puppeteer";
import fs from "fs";
import http from "http";
import fetch from "node-fetch";

// ====== CONFIG (env) ======
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "YOUR_TELEGRAM_BOT_TOKEN";
const CHAT_ID  = process.env.TELEGRAM_CHAT_ID  || "YOUR_TELEGRAM_CHAT_ID";
const AURACLE_BASE = (process.env.AURACLE_BASE_URL || "https://auracle.fi").replace(/\/+$/,"");
const POLL_INTERVAL_MS = Math.max(15000, parseInt(process.env.POLL_INTERVAL_MS || "30000", 10)); // >=15s
const PORT = parseInt(process.env.PORT || "8080", 10);
const DEBUG = (process.env.DEBUG === "1" || process.env.DEBUG === "true" || process.env.DEBUG === "yes");

// ====== STATE ======
const STATE_FILE = "./state.json";
let state = loadState();
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { markets: {}, seeded: false }; }
}
function saveState() { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }

// ====== UTILS ======
const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));
const log  = (...a)=> console.log(...a);
const dbg  = (...a)=> { if (DEBUG) console.log(...a); };
const escMD = (s="") => s.replace(/([_*\[\]()~>#+\-=|{}.!\\])/g, "\\$1");

function humanizeETA(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = Math.max(0, Math.floor((t - Date.now())/1000));
  const m = Math.floor(diff/60), h = Math.floor(m/60), d = Math.floor(h/24);
  if (d>=2) return `in about ${d} days`;
  if (d===1) return `in about 1 day`;
  if (h>=2) return `in about ${h} hours`;
  if (h===1) return `in about 1 hour`;
  if (m>=2) return `in about ${m} minutes`;
  if (m===1) return `in about 1 minute`;
  return "soon";
}

// ====== TELEGRAM ======
async function send(text) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
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
  const eta = m.endsIn ? `\n⏳ ${escMD(m.endsIn)}` : "";
  return `🔥 *New Market Live on Auracle*\n🏟️ ${escMD(m.title)}${eta}\n${lines ? ("\n"+lines) : ""}\n\n🔗 ${m.url}`;
}
function fmtTrending(m) {
  return `📈 *Trending Now on Auracle!*\n🏟️ ${escMD(m.title)}\n\n🔗 ${m.url}`;
}
function fmtClosed(m) {
  const list = (m.options||[]).map(o=>`${escMD(o.label)} ${o.pct}%`).join(" | ") || "—";
  return `🛑 *Market Closed — Final Pool*\n🏟️ ${escMD(m.title)}\n📊 ${list}\n👀 Awaiting resolution…\n🔗 ${m.url}`;
}
function fmtResolved(m) {
  const list = (m.options||[]).map(o=>`${escMD(o.label)} ${o.pct}%`).join(" | ") || "—";
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
  await page.setViewport({ width: 1280, height: 1400 });
  return { browser, page };
}

async function autoScroll(page) {
  for (let i=0;i<8;i++) {
    await page.evaluate(()=>window.scrollBy(0, 1200));
    await sleep(250);
  }
}

// ====== LIST SCRAPER (Trending via "#N HOT" only) ======
async function scrapeList() {
  const { browser, page } = await newBrowserPage();
  const url = `${AURACLE_BASE}/Markets?ts=${Date.now()}`;

  try {
    await page.goto(url, { waitUntil:"networkidle2", timeout:60000 });
    await autoScroll(page);

    const lists = await page.evaluate(() => {
      function pick(el){ return (el?.textContent || "").trim(); }
      function findCardRoot(a){
        let cur = a;
        for (let i=0;i<8 && cur;i++){
          if (cur.querySelector && cur.querySelector('a[href*="MarketDetails?id="]')) return cur;
          cur = cur.parentElement;
        }
        return a.parentElement || a;
      }
      function hasHotBadge(card){
        // Look for elements that look like "#1 HOT"
        const txt = (card?.innerText || "").toUpperCase();
        return /#\s*\d+\s*HOT/.test(txt);
      }

      const out = { active: [], trending: [] };
      const anchors = Array.from(document.querySelectorAll('a[href*="MarketDetails?id="]'));
      const seen = new Set();

      for (const a of anchors) {
        const id = new URL(a.href).searchParams.get("id");
        if (!id || seen.has(id)) continue;
        seen.add(id);

        const card = findCardRoot(a);
        let title = pick(card.querySelector("h1,h2,h3,.title")) || pick(a).split("\n")[0];
        title = title.replace(/\s+/g," ").trim();

        const entry = { id, url: a.href, title };
        if (hasHotBadge(card)) out.trending.push(entry);
        else out.active.push(entry);
      }
      return out;
    });

    return lists;
  } catch (e) {
    console.error("[list] error", e.message);
    return { active: [], trending: [] };
  } finally {
    await browser.close();
  }
}

// ====== DETAIL SCRAPER (robust + verbose) ======
async function scrapeDetail(url) {
  const { browser, page } = await newBrowserPage();
  try {
    await page.goto(url, { waitUntil:"networkidle2", timeout:60000 });
    await autoScroll(page);

    const d = await page.evaluate(() => {
      const raw = document.body.innerText;
      const pick = (el)=> (el?.textContent || "").trim();

      // Title
      let title = pick(document.querySelector("h1, h2, .title"));
      if (!title) title = (document.title || "").split("|")[0].trim();

      // Status + Winner (robust)
      let status = "open";
      let winner = null;
      if (/ORACLE\s+CLOSED/i.test(raw)) status = "closed";

      const rm =
        raw.match(/ORACLE\s+RESOLVED\s*[:\-]\s*([^\n\r]+)/i) ||
        raw.match(/ORACLE\s+RESOLVED\s*(?:\r?\n)+\s*([^\n\r]+)/i);
      if (rm) { status = "resolved"; winner = (rm[1] || "").trim(); }

      // Options via DOM
      const options = [];
      const rows = document.querySelectorAll(".option, .market-option, [data-option]");
      rows.forEach(r => {
        const lbl = pick(r.querySelector(".label, .team, .option-label, span, strong"));
        const pctEl = r.querySelector(".percent, .percentage");
        if (lbl && pctEl) {
          const pct = parseInt(pctEl.textContent.replace(/[^0-9]/g,""),10);
          if (Number.isFinite(pct)) options.push({ label: lbl.trim(), pct });
        }
      });

      // Fallback parsing on text (Closed/Resolved views)
      if (options.length < 2) {
        raw.split("\n").forEach(line => {
          let m = line.match(/CURRENT\s+(.+?)\s+(\d+)%/i);
          if (m) options.push({ label: m[1].trim(), pct: parseInt(m[2],10) });
          m = line.match(/^(.+?)\s+IMPLIED.*?(\d+)%/i);
          if (m) options.push({ label: m[1].trim(), pct: parseInt(m[2],10) });
        });
      }

      // End date/time
      let closeISO = "";
      const dm = raw.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s*\d{4}\s+at\s+\d{1,2}:\d{2}\s*(AM|PM)/i);
      if (dm) {
        const d = new Date(dm[0]);
        if (!isNaN(d.getTime())) closeISO = d.toISOString();
      }

      const id = new URL(location.href).searchParams.get("id");
      return { id, url: location.href, title, status, winner, options, closeISO };
    });

    // YES/NO → label mapping
    if (d?.winner && d.options?.length >= 2) {
      const w = d.winner.toLowerCase();
      if (w.includes("yes")) d.winner = d.options[0].label;
      if (w.includes("no"))  d.winner = d.options[1].label;
    }

    if (d?.closeISO) d.endsIn = humanizeETA(d.closeISO);
    return d;
  } catch (e) {
    console.error("[detail] error", e.message);
    return null;
  } finally {
    await browser.close();
  }
}

// ====== MAIN TICK ======
let TICK_RUNNING = false;

async function tick() {
  if (TICK_RUNNING) { dbg("[loop] skip (busy)"); return; }
  TICK_RUNNING = true;
  const start = Date.now();
  log("[tick] START", new Date().toISOString());

  // 1) Scrape lists
  const { active, trending } = await scrapeList();
  if (active.length === 0 && trending.length === 0) {
    log("[tick] lists → 0/0 (SPA glitch) — continuing with known markets");
  } else {
    log(`[tick] lists → active ${active.length}, trending ${trending.length}`);
  }

  // 2) First boot seed (silent)
  if (!state.seeded) {
    [...active, ...trending].forEach(m => {
      state.markets[m.id] = {
        id: m.id,
        url: m.url,
        title: m.title,
        announcedOpen: true,
        announcedTrending: true,
        announcedClosed: false,
        announcedResolved: false,
        retired: false,
        lastStatus: "open",
        lastSeen: {}
      };
    });
    state.seeded = true;
    saveState();
    log("[seed] initial seed complete — no announcements");
    TICK_RUNNING = false;
    return;
  }

  // 3) Announce NEW (from Active only)
  for (const m of active) {
    const rec = state.markets[m.id];
    if (!rec || !rec.announcedOpen) {
      const d = await scrapeDetail(m.url);
      if (d) {
        dbg(`[detail] scraped ${m.id} status=${d.status} opts=${d.options?.length||0}`);
        await send(fmtNew({ ...d, url: m.url, options: d.options }));
        state.markets[m.id] = {
          ...(rec||{}),
          id: m.id, url: m.url, title: d.title || m.title,
          announcedOpen: true,
          lastStatus: d.status,
          lastSeen: { options: d.options || [] }
        };
        saveState();
      }
    }
  }

  // 4) Announce TRENDING entries (Option B: always when newly seen)
  for (const m of trending) {
    const rec = state.markets[m.id] || {};
    if (!rec.announcedTrending) {
      dbg(`[trend] ${m.id} entered trending: ${m.title}`);
      await send(fmtTrending(m));
      state.markets[m.id] = {
        ...rec, id: m.id, url: m.url, title: m.title, announcedTrending: true
      };
      saveState();
    }
  }

  // 5) Detail pass over all known markets (open/closed/resolved transitions)
  const ids = Object.keys(state.markets).filter(id => !state.markets[id].retired);
  for (const id of ids) {
    const rec = state.markets[id];
    const url = rec.url || `${AURACLE_BASE}/MarketDetails?id=${id}`;
    const d = await scrapeDetail(url);
    if (!d) continue;

    const prev = rec.lastStatus || "unknown";
    if (d.status !== prev) log(`[status] ${id} ${prev} → ${d.status} | winner=${d.winner||"-"}`);
    rec.lastStatus = d.status;

    if (d.status === "open" && d.options?.length) {
      rec.lastSeen = { options: d.options };
      dbg(`[options] ${id} updated lastSeen options = ${d.options.length}`);
    }

    if (d.status === "closed" && !rec.announcedClosed) {
      const opts = d.options?.length ? d.options : (rec.lastSeen?.options || []);
      dbg(`[announce] CLOSED ${id} opts=${opts.length}`);
      await send(fmtClosed({ title: d.title || rec.title || "Market", options: opts, url }));
      rec.announcedClosed = true;
      rec.closedSnapshot = { options: opts };
      saveState();
    }

    if (d.status === "resolved" && !rec.announcedResolved) {
      const opts = rec.closedSnapshot?.options?.length
        ? rec.closedSnapshot.options
        : (rec.lastSeen?.options || d.options || []);
      const winner = d.winner || opts[0]?.label || "YES";
      dbg(`[announce] RESOLVED ${id} winner=${winner} opts=${opts.length}`);
      await send(fmtResolved({ title: d.title || rec.title || "Market", options: opts, winner, url }));
      rec.announcedResolved = true;
      rec.retired = true;
      saveState();
    }
  }

  log("[tick] END", new Date().toISOString(), "elapsed", (Date.now()-start), "ms");
  TICK_RUNNING = false;
}

// ====== SERVER + SCHEDULER ======
http.createServer((_,res)=>{res.end("OK");}).listen(PORT,()=>log("[HTTP] listening on", PORT));

await tick();
setInterval(tick, POLL_INTERVAL_MS);
setInterval(()=>log("[hb]", new Date().toISOString()), 10000);
