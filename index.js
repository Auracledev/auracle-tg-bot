// ─────────────────────────────────────────────────────────
// Auracle Telegram Bot — with Trending Alerts
// Version: trending-v1
// ─────────────────────────────────────────────────────────

import puppeteer from "puppeteer";
import fetch from "node-fetch";
import fs from "fs";
import http from "http";

const BOT_TOKEN = "YOUR_TELEGRAM_BOT_TOKEN";
const CHAT_ID = "YOUR_TELEGRAM_CHAT_ID";

const AURACLE_BASE = "https://auracle.fi";
const POLL_INTERVAL_MS = 30000; // 30s

// State file
const STATE_FILE = "./state.json";
let state = loadState();

// ─────────────────────────────────────────────
// Load / Save State
// ─────────────────────────────────────────────
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { markets: {} };
  }
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─────────────────────────────────────────────
// Telegram Send Helper
// ─────────────────────────────────────────────
async function send(msg) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: msg,
      parse_mode: "Markdown"
    })
  });
}

// Escape Markdown
function esc(s) {
  return s?.replace(/([_*\[\]()~>#+\-=|{}.!])/g, "\\$1");
}

// ─────────────────────────────────────────────
// Format Messages
// ─────────────────────────────────────────────
function fmtNew(m) {
  const opts = m.options?.map(o => `• ${esc(o.label)} — ${o.pct}%`).join("\n") || "";
  const time = m.time || "";
  return `🔥 *New Market Live on Auracle*\n🏟️ ${esc(m.title)}\n⏳ ${time}\n\n${opts}\n\n🔗 ${m.url}`;
}

function fmtTrending(m) {
  return `📈 *Trending Now On Auracle!*\n🏟️ ${esc(m.title)}\n\n🔗 ${m.url}`;
}

function fmtClosed(m) {
  const opts = m.options?.map(o => `${esc(o.label)} ${o.pct}%`).join(" | ") || "";
  return `🛑 *Market Closed — Final Pool*\n🏟️ ${esc(m.title)}\n📊 ${opts || "—"}\n👀 Awaiting resolution…\n🔗 ${m.url}`;
}

function fmtResolved(m) {
  const opts = m.options?.map(o => `${esc(o.label)} ${o.pct}%`).join(" | ") || "";
  return `✅ *Market Resolved*\n🏟️ ${esc(m.title)}\n🏆 Winner: ${esc(m.winner)}\n📊 Final: ${opts || "—"}\n💰 Rewards now live on Auracle\n🔗 ${m.url}`;
}

// ─────────────────────────────────────────────
// Puppeteer helpers
// ─────────────────────────────────────────────
async function browserPage() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox","--disable-setuid-sandbox"]
  });
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0");
  return { browser, page };
}

// scrape Active + Trending list
async function scrapeList() {
  const { browser, page } = await browserPage();
  const url = `${AURACLE_BASE}/Markets?ts=${Date.now()}`;

  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    // scroll
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(2000);

    const sections = await page.evaluate(() => {
      function grab(selector) {
        const cards = Array.from(document.querySelectorAll(`${selector} a[href*="id="]`));
        return cards.map(a => {
          const id = new URL(a.href).searchParams.get("id");
          const title = a.innerText?.trim().split("\n")[0] || "";
          return { id, title, url: a.href };
        });
      }
      return {
        active: grab("text=Active Auracles, Active Auracle, active-auracles,div:has(> h2:contains('Active'))"),
        trending: grab("text=Trending, trending-auracles,div:has(> h2:contains('Trending'))")
      };
    });

    return sections;
  } catch (e) {
    console.log("[list] error", e.message);
    return { active: [], trending: [] };
  } finally {
    await browser.close();
  }
}

// scrape MarketDetails page
async function scrapeDetail(url) {
  const { browser, page } = await browserPage();
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForTimeout(1500);

    return await page.evaluate(() => {
      const text = document.body.innerText;

      function readOptions() {
        const rows = Array.from(document.querySelectorAll(".MarketDetailOption, .market-option"));
        return rows.map(r => {
          const t = r.innerText;
          const m = t.match(/(.*) (\d+)%/);
          if (m) return { label: m[1].trim(), pct: m[2] };
          return null;
        }).filter(Boolean);
      }

      const title = document.querySelector("h1,h2,.market-title")?.innerText.trim() || "";
      const options = readOptions();

      let status = "open";
      let winner = null;
      if (/ORACLE CLOSED/i.test(text)) status = "closed";
      if (/ORACLE RESOLVED/i.test(text)) {
        status = "resolved";
        const mm = text.match(/ORACLE RESOLVED:\s*(.*)/i);
        winner = mm?.[1]?.trim();
      }

      // map YES/NO
      if (winner && options.length === 2) {
        const l = winner.toLowerCase();
        if (l.includes("yes")) winner = options[0].label;
        if (l.includes("no")) winner = options[1].label;
      }

      const d = document.querySelector("div:contains('Ends')")?.innerText || "";
      return { title, status, winner, options, endRaw: d };
    });
  } catch {
    return null;
  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────
// Time formatting
// ─────────────────────────────────────────────
function cleanTime(raw) {
  if (!raw) return "";
  const m = raw.match(/Ends.*?in (.*)/i);
  return m ? `in ${m[1]}` : "";
}

// ─────────────────────────────────────────────
// Scheduler tick
// ─────────────────────────────────────────────
let TICK_RUNNING = false;

async function tick() {
  if (TICK_RUNNING) return;
  TICK_RUNNING = true;

  console.log("[tick] START", new Date().toISOString());

  const lists = await scrapeList();
  let { active, trending } = lists;

  // protect against glitch ticks (site returns 0 temporarily)
  if (active.length === 0 && trending.length === 0) {
    console.log("[tick] zero lists — skipping");
    TICK_RUNNING = false;
    return;
  }

  console.log(`[tick] list → active ${active.length}, trending ${trending.length}`);

  const ids = new Set([...active, ...trending].map(m => m.id));

  // Seed existing markets silently on first startup
  for (const id of ids) {
    if (!state.markets[id]) {
      state.markets[id] = { id, announcedOpen: true };
    }
  }

  // detect NEW markets (from active only)
  for (const m of active) {
    if (!state.markets[m.id]?.announcedOpen) {
      const detail = await scrapeDetail(m.url);
      if (detail) {
        const time = cleanTime(detail.endRaw);
        await send(fmtNew({ ...m, options: detail.options, time }));
      }
      state.markets[m.id] = { ...state.markets[m.id], announcedOpen: true, url: m.url };
      saveState();
    }
  }

  // detect TRENDING entries
  for (const m of trending) {
    const rec = state.markets[m.id] || {};
    if (!rec.announcedTrending) {
      await send(fmtTrending({ ...m, url: m.url }));
      state.markets[m.id] = { ...rec, announcedTrending: true, url: m.url };
      saveState();
    }
  }

  // detail checks for closed/resolved
  for (const id of Object.keys(state.markets)) {
    const rec = state.markets[id];
    if (rec.retired) continue;

    const url = rec.url || `${AURACLE_BASE}/MarketDetails?id=${id}`;
    const detail = await scrapeDetail(url);
    if (!detail) continue;

    // closed
    if (detail.status === "closed" && !rec.announcedClosed) {
      await send(fmtClosed({ ...detail, url }));
      state.markets[id].announcedClosed = true;
      state.markets[id].options = detail.options;
      saveState();
    }

    // resolved
    if (detail.status === "resolved" && !rec.announcedResolved) {
      await send(fmtResolved({ ...detail, url, options: rec.options }));
      state.markets[id].announcedResolved = true;
      state.markets[id].retired = true;
      saveState();
    }
  }

  TICK_RUNNING = false;
}

// ─────────────────────────────────────────────
// Heartbeat server (Railway keeps alive)
http.createServer((_,res)=>res.end("OK")).listen(8080,()=>console.log("[HTTP] :8080"));

// ─────────────────────────────────────────────
// Start loop
console.log("✅ Bot running");
await tick();
setInterval(tick, POLL_INTERVAL_MS);
setInterval(() => console.log("[hb]", new Date().toISOString()), 10000);
