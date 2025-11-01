/**
 * Auracle Telegram Bot — Stable Build
 * Features:
 * ✅ Scrape open markets
 * ✅ Announce new markets
 * ✅ Announce closed markets with final %s
 * ✅ Announce resolved markets with winner name + %
 * ✅ Deduplicate + retire after resolve
 * ✅ Auto-seed so no first-boot spam
 * ✅ Emoji by sport
 * ✅ Robust tick loop w/ setInterval
 */

import 'dotenv/config';
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer";
import http from "http";
import { Telegraf } from "telegraf";

/* ============================= ENV / PATH ============================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  AURACLE_BASE_URL = "https://auracle.fi",
  POLL_INTERVAL_SECONDS = "30",
  DATA_DIR = "/data",
  DEBUG,
  PORT = process.env.PORT || 8080
} = process.env;

if (!TELEGRAM_BOT_TOKEN) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const dbg = !!DEBUG;

/* ============================= STATE FILE ============================= */

const STATE_DIR = path.resolve(DATA_DIR);
const STATE_FILE = path.join(STATE_DIR, "state.json");

if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
if (!fs.existsSync(STATE_FILE)) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ markets: {}, seeded: false }, null, 2)
  );
}

const loadState = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { markets: {}, seeded: false };
  }
};

const saveState = (s) =>
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

const getTargetChatId = () => loadState().targetChatId || TELEGRAM_CHAT_ID;
const setTargetChatId = (id) => {
  const st = loadState();
  st.targetChatId = id;
  saveState(st);
};

/* ============================= TELEGRAM ============================= */

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

function escapeHtml(s = "") {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function send(msg) {
  const chatId = getTargetChatId();
  try {
    await bot.telegram.sendMessage(chatId, msg, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (e) {
    console.error("send error", e?.response?.description || e.message);
  }
}

/* ============================= EMOJI DETECTOR ============================= */

function detectEmoji(title = "", category = "") {
  const t = (title + " " + category).toLowerCase();
  if (/fc|united|city|madrid|barcelona|psg|dortmund|liverpool|arsenal|premier|bundesliga/.test(t)) return "⚽";
  if (/nba|lakers|celtics|warriors|76ers|knicks|bucks/.test(t)) return "🏀";
  if (/nfl|patriots|chiefs|eagles|cowboys|steelers/.test(t)) return "🏈";
  if (/mlb|dodgers|yankees|blue jays|mets/.test(t)) return "⚾";
  if (/ufc|mma|fight/.test(t)) return "🥊";
  if (/btc|eth|sol|crypto/.test(t)) return "₿";
  return "🎯";
}

/* ============================= BROWSER ============================= */

let browser = null;
async function getBrowser() {
  if (browser) return browser;
  browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  return browser;
}
async function newPage() {
  const b = await getBrowser();
  return b.newPage();
}

/* ============================= SCRAPERS ============================= */

async function fetchMarketsList() {
  const url = `${AURACLE_BASE_URL}/Markets?ts=${Date.now()}`;
  const page = await newPage();
  await page.goto(url, { waitUntil: "networkidle2" });

  const data = await page.evaluate(() => {
    const pick = (n) => (n?.textContent || "").trim();
    const links = Array.from(document.querySelectorAll('a[href*="MarketDetails?id"]'));

    const out = { active: [], trending: [] };

    function isTrending(el) {
      return /#\s*\d+\s*HOT/.test(el.innerText.toUpperCase());
    }

    for (const a of links) {
      const id = new URL(a.href).searchParams.get("id");
      if (!id) continue;

      const card = a.closest("article,div") || a.parentElement;

      const category = pick(card?.querySelector(".badge,.chip,.category"));
      const options = [];

      const rows = card?.querySelectorAll(".option,.side,[data-option]");
      rows && rows.forEach(r => {
        const lbl = pick(r.querySelector(".label,.team,.option-label"));
        const pctEl = r.querySelector(".percent,.percentage");
        const pct = pctEl ? parseInt(pctEl.textContent.replace("%","")) : null;
        if (lbl && pct != null) options.push({ label: lbl, pct });
      });

      const entry = { id, url: a.href, title: pick(card?.querySelector("h3,.title")), category, options };

      if (isTrending(card)) out.trending.push(entry)
      else out.active.push(entry);
    }

    return out;
  });

  await page.close();
  return data;
}

async function scrapeMarketDetail(url) {
  const page = await newPage();
  await page.goto(url, { waitUntil: "networkidle2" });
  const text = (x) => (x?.textContent || "").trim();

  const d = await page.evaluate(() => {
    const t = (x) => (x?.textContent || "").trim();
    const raw = document.body.innerText.toUpperCase();

    let title = document.querySelector("h1,h2,.title")?.textContent?.trim() || "";
    if (!title) {
      const og = document.querySelector('meta[property="og:title"]')?.content;
      if (og) title = og.trim();
    }

    let status = "open";
    let winner = null;
    if (raw.includes("ORACLE CLOSED")) status = "closed";
    const m = raw.match(/ORACLE RESOLVED:\s*(.+)$/mi);
    if (m) { status = "resolved"; winner = m[1].trim(); }

    const options = [];
    const rows = document.querySelectorAll(".option,.side,[data-option]");
    rows && rows.forEach(r => {
      const lbl = t(r.querySelector(".label,.team,.option-label,span,strong"));
      const pctEl = r.querySelector(".percent,.percentage");
      if (lbl && pctEl) {
        const pct = parseInt(pctEl.textContent.replace("%",""));
        if (Number.isFinite(pct)) options.push({label:lbl,pct});
      }
    });

    const id = new URL(location.href).searchParams.get("id");

    // close time
    let closeISO = "";
    const body = document.body.innerText;
    const dt = body.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s*\d{4}\s+at\s+\d{1,2}:\d{2}/i);
    if (dt) {
      const d = new Date(dt[0]);
      if (!isNaN(d.getTime())) closeISO = d.toISOString();
    }

    return { id, url: location.href, title, status, winner, options, closeISO };
  });

  await page.close();
  return d;
}

/* ============================= HUMAN TIME ============================= */

function humanizeEta(targetMs) {
  if (!Number.isFinite(targetMs)) return "";
  const diff = Math.max(0, Math.floor((targetMs - Date.now())/1000));
  const min = Math.floor(diff/60), hr = Math.floor(min/60), day = Math.floor(hr/24);
  if (day>=2) return `in about ${day} days`;
  if (day===1) return `in about 1 day`;
  if (hr>=2) return `in about ${hr} hours`;
  if (hr===1) return `in about 1 hour`;
  if (min>=2) return `in about ${min} minutes`;
  if (min===1) return `in about 1 minute`;
  return "soon";
}

/* ============================= FORMATTING ============================= */

function fmtNew(m) {
  const emoji = detectEmoji(m.title,m.category);
  const lines = (m.options||[]).slice(0,3).map(o=>`• ${escapeHtml(o.label)} — <b>${o.pct}%</b>`).join("\n");
  return `🔥 <b>New Market Live</b>
${emoji} <b>${escapeHtml(m.title)}</b>
⏳ ${escapeHtml(m.endsIn||"soon")}
${lines}
🔗 ${m.url}`;
}

function fmtClosed(m) {
  const emoji = detectEmoji(m.title,m.category);
  const list = (m.options||[]).map(o=>`${escapeHtml(o.label)} ${o.pct}%`).join(" - ")||"—";
  return `🛑 <b>Market Closed — Final Pool</b>
${emoji} <b>${escapeHtml(m.title)}</b>
📊 ${list}
👀 Awaiting resolution…
🔗 ${m.url}`;
}

function fmtResolved(m) {
  const emoji = detectEmoji(m.title,m.category);
  const list = (m.options||[]).map(o=>`${escapeHtml(o.label)}: <b>${o.pct}%</b>`).join(" | ")||"—";
  return `✅ <b>Market Resolved</b>
${emoji} <b>${escapeHtml(m.title)}</b>
🏆 Winner: <b>${escapeHtml(m.winner)}</b>
📊 Final: ${list}
💰 Rewards live on Auracle
🔗 ${m.url}`;
}

/* ============================= TICK ============================= */

async function tick() {
  const start = Date.now();
  console.log("[tick] START", new Date().toISOString());

  const { active, trending } = await fetchMarketsList();
  console.log(`[tick] list → active ${active.length}, trending ${trending.length}`);

  const ids = new Set([...active, ...trending].map(m=>m.id));
  const state = loadState();
  const known = new Set(Object.keys(state.markets));
  const all = new Set([...ids, ...known]);

  /* first boot seed */
  if (!state.seeded && all.size) {
    console.log("[seed] seeding first scrape", all.size);
    for (const m of [...active, ...trending]) {
      state.markets[m.id] = {
        announcedOpen: true,
        announcedClosed: m.status==="closed",
        announcedResolved: m.status==="resolved",
        lastStatus: "open",
        url: m.url,
        retired: m.status==="resolved",
        lastSeen: { title:m.title, category:m.category, options:m.options }
      };
    }
    state.seeded = true;
    saveState(state);
    console.log("[seed] done — no announcements");
    return;
  }

  /* detail scrape each watched */
  for (const id of all) {
    const rec = state.markets[id] || {};
    if (rec.retired) continue;

    const card = active.find(x=>x.id===id) || trending.find(x=>x.id===id);
    const url = rec.url || card?.url || `${AURACLE_BASE_URL}/MarketDetails?id=${id}`;

    const detail = await scrapeMarketDetail(url);

    // track lastSeen
    if (!state.markets[id]) state.markets[id] = {};
    const m = state.markets[id];

    if (detail.status === "open") {
      if (detail.closeISO) {
        const ms = Date.parse(detail.closeISO);
        if (!isNaN(ms)) detail.endsIn = humanizeEta(ms);
      }
      m.lastSeen = {
        title: detail.title,
        category: detail.category,
        endsIn: detail.endsIn,
        options: detail.options
      };
    }

    /* OPEN announcement */
    if (detail.status==="open" && !m.announcedOpen) {
      const opts = detail.options?.length ? detail.options : m.lastSeen?.options;
      await send(fmtNew({...detail,options:opts}));
      m.announcedOpen = true;
    }

    /* CLOSED announcement */
    if (detail.status==="closed" && !m.announcedClosed) {
      const opts = detail.options?.length
        || m.lastSeen?.options?.length
        ? (detail.options || m.lastSeen.options)
        : [];
      m.closedSnapshot = { options: opts };
      await send(fmtClosed({...detail,options:opts}));
      m.announcedClosed = true;
    }

    /* RESOLVED announcement */
    if (detail.status==="resolved" && !m.announcedResolved) {
      const finalOpts = m.closedSnapshot?.options?.length
        ? m.closedSnapshot.options
        : (m.lastSeen?.options || detail.options || []);

      let win = detail.winner;
      const lower = (win||"").toLowerCase();
      if (lower.includes("yes") && finalOpts[0]?.label) win = finalOpts[0].label;
      if (lower.includes("no")  && finalOpts[1]?.label) win = finalOpts[1].label;

      await send(fmtResolved({...detail, winner:win, options:finalOpts}));
      m.announcedResolved = true;
      m.retired = true;
    }

    m.lastStatus = detail.status;
    m.url = url;
  }

  saveState(state);
  console.log("[tick] END", new Date().toISOString(), "elapsed", Date.now()-start, "ms");
}

/* ============================= COMMANDS ============================= */

bot.command("ping", ctx=>ctx.reply("pong ✅"));
bot.command("tick_now", async ctx=>{
  await ctx.reply("manual tick running…");
  await tick();
  await ctx.reply("done ✅");
});
bot.command("whereami", ctx=>ctx.reply(`Target: ${getTargetChatId()}\nHere: ${ctx.chat.id}\n/set_target here`));
bot.command("set_target", ctx=>{
  const [,arg] = ctx.message.text.split(" ");
  if (!arg) return ctx.reply("Usage: /set_target <chatId|here>");
  const id = arg==="here" ? ctx.chat.id : arg;
  setTargetChatId(id);
  ctx.reply(`✅ Target set: ${id}`);
});

/* ============================= LOOP ============================= */

const intervalSec = Math.max(8, parseInt(POLL_INTERVAL_SECONDS||"30",10));

async function safeTickOnce() {
  try {
    await tick();
  } catch(e) {
    console.error("[loop] tick error", e?.stack||e);
  }
}

safeTickOnce();
setInterval(safeTickOnce, intervalSec*1000);

setInterval(()=>console.log("[hb]", new Date().toISOString()), 10000);

/* ============================= SERVER + LAUNCH ============================= */
const server = http.createServer((_,res)=>{
  res.writeHead(200,{"Content-Type":"application/json"});
  res.end(JSON.stringify({ ok:true, ts:new Date().toISOString() }));
});
server.listen(PORT,()=>console.log(`[HTTP] :${PORT}`));
bot.launch();
console.log("✅ Bot running");
