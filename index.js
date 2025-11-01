// ──────────────────────────────────────────────
// Auracle TG Bot — Stable + Trending v3
// Fixed: zero-list bug, resolved detect, % snapshot
// ──────────────────────────────────────────────

import puppeteer from "puppeteer";
import fs from "fs";
import http from "http";
import fetch from "node-fetch";

// ======= CONFIG =======
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "YOUR_TELEGRAM_BOT_TOKEN";
const CHAT_ID  = process.env.TELEGRAM_CHAT_ID  || "YOUR_TELEGRAM_CHAT_ID";
const AURACLE_BASE = "https://auracle.fi";
const POLL_INTERVAL_MS = 30000;
const PORT = process.env.PORT || 8080;

const DEBUG = false; // set TRUE for logs

// ======= STATE =======
const STATE_FILE = "./state.json";
let state = loadState();

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { markets: {}, seeded: false }; }
}
function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));
const log = (...a)=> console.log(...a);
const dbg = (...a)=> { if (DEBUG) console.log(...a); };

function esc(s="") {
  return s.replace(/([_*\[\]()~>#+\-=|{}.!\\])/g, "\\$1");
}

// ======= TELEGRAM =======
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
  } catch(e) {
    console.log("[send] error", e);
  }
}

// ======= FORMATTING =======
function fmtNew(m) {
  const opts = (m.options||[]).map(o => `• ${esc(o.label)} — *${o.pct}%*`).join("\n");
  const t = m.endsIn ? `⏳ ${esc(m.endsIn)}` : "";
  return `🔥 *New Market Live on Auracle*\n🏟️ ${esc(m.title)}\n${t}\n\n${opts}\n\n🔗 ${m.url}`;
}
function fmtTrending(m) {
  return `📈 *Trending Now on Auracle!*\n🏟️ ${esc(m.title)}\n\n🔗 ${m.url}`;
}
function fmtClosed(m) {
  const opt = (m.options||[]).map(o=>`${esc(o.label)} ${o.pct}%`).join(" | ") || "—";
  return `🛑 *Market Closed — Final Pool*\n🏟️ ${esc(m.title)}\n📊 ${opt}\n👀 Awaiting resolution…\n🔗 ${m.url}`;
}
function fmtResolved(m) {
  const opt = (m.options||[]).map(o=>`${esc(o.label)} ${o.pct}%`).join(" | ") || "—";
  return `✅ *Market Resolved*\n🏟️ ${esc(m.title)}\n🏆 Winner: *${esc(m.winner)}*\n📊 Final: ${opt}\n💰 Rewards live now\n🔗 ${m.url}`;
}

// ======= PUPPETEER =======
async function getBrowser() {
  const b = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"]
  });
  const p = await b.newPage();
  await p.setUserAgent("Mozilla/5.0 AuracleBot");
  await p.setViewport({ width:1200, height:1200 });
  return { b, p };
}

async function autoScroll(p) {
  for (let i=0;i<8;i++) {
    await p.evaluate(()=>window.scrollBy(0,1200));
    await sleep(300);
  }
}

// ======= LIST SCRAPE (Active + Trending) =======
async function scrapeList() {
  const {b,p} = await getBrowser();
  try {
    await p.goto(`${AURACLE_BASE}/Markets?ts=${Date.now()}`, { waitUntil:"networkidle2", timeout:60000 });
    await autoScroll(p);

    const res = await p.evaluate(() => {
      const out = { active:[], trending:[] };
      const nodes = [...document.querySelectorAll('a[href*="MarketDetails?id="]')];

      function card(a) {
        let n=a; for (let i=0;i<6 && n;i++){ if(n.innerText?.includes("#") && n.innerText?.includes("HOT")) return {el:n, hot:true};
        n=n.parentElement;} return {el:a, hot:false};
      }

      for (const a of nodes) {
        const id = new URL(a.href).searchParams.get("id");
        if (!id) continue;
        const c = card(a);
        let title = c.el.querySelector("h1,h2,h3")?.innerText?.trim() || a.innerText.split("\n")[0].trim();
        const ent = {id, url:a.href, title};
        if (c.hot) out.trending.push(ent);
        else out.active.push(ent);
      }
      return out;
    });

    return res;
  } catch(e) {
    console.log("[list] error", e.message);
    return { active:[], trending:[] };
  } finally {
    await b.close();
  }
}

// ======= DETAIL SCRAPE =======
async function scrapeDetail(url) {
  const {b,p} = await getBrowser();
  try {
    await p.goto(url, { waitUntil:"networkidle2", timeout:60000 });
    await autoScroll(p);

    const d = await p.evaluate(() => {
      const raw = document.body.innerText;
      const text = (s)=>s?.textContent?.trim() || "";

      let title = text(document.querySelector("h1,h2,.title"));
      if (!title) title = document.title.split("|")[0].trim();

      let status="open", winner=null;
      if (/ORACLE\s+CLOSED/i.test(raw)) status="closed";

      const rm =
        raw.match(/ORACLE\s+RESOLVED\s*[:\-]\s*([^\n\r]+)/i) ||
        raw.match(/ORACLE\s+RESOLVED\s*(?:\r?\n)+\s*([^\n\r]+)/i);

      if (rm) { status="resolved"; winner=rm[1].trim(); }

      const options = [];
      const rows = document.querySelectorAll(".option,.market-option,[data-option]");
      rows.forEach(r=>{
        const lbl = text(r.querySelector(".label,.team,.option-label,span,strong"));
        const pctNode = r.querySelector(".percent,.percentage");
        if (lbl && pctNode) {
          const pct = parseInt(pctNode.textContent.replace(/[^0-9]/g,""),10);
          if (!isNaN(pct)) options.push({label:lbl.trim(), pct});
        }
      });

      if (options.length<2) {
        const lines = raw.split("\n").map(s=>s.trim()).filter(Boolean);
        for (const l of lines) {
          let m = l.match(/CURRENT\s+(.+?)\s+(\d+)%/i);
          if (m) options.push({label:m[1].trim(), pct:+m[2]});
          m = l.match(/^(.+?)\s+IMPLIED.*?(\d+)%/i);
          if (m) options.push({label:m[1].trim(), pct:+m[2]});
        }
      }

      let closeISO=""; 
      const dm = raw.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s*\d{4}\s+at\s+\d{1,2}:\d{2}\s*(AM|PM)/i);
      if (dm) {
        const d2 = new Date(dm[0]);
        if(!isNaN(d2.getTime())) closeISO=d2.toISOString();
      }

      const id = new URL(location.href).searchParams.get("id");
      return { id, url:location.href, title, status, winner, options, closeISO };
    });

    if (d?.winner && d.options?.length>=2) {
      const w=d.winner.toLowerCase();
      if (w.includes("yes")) d.winner = d.options[0].label;
      if (w.includes("no"))  d.winner = d.options[1].label;
    }

    if (d?.closeISO) {
      const ms = Date.parse(d.closeISO);
      if (!isNaN(ms)) {
        const diff = ms-Date.now();
        if (diff>0) {
          const min=Math.floor(diff/60000), h=Math.floor(min/60), d2=Math.floor(h/24);
          if (d2>0) d.endsIn=`in about ${d2} days`;
          else if (h>0) d.endsIn=`in about ${h} hours`;
          else if (min>0) d.endsIn=`in about ${min} minutes`;
        }
      }
    }

    return d;
  } catch(e){ 
    console.log("[detail] error", e.message);
    return null;
  } finally {
    await b.close();
  }
}

// ======= MAIN LOOP =======
let RUNNING=false;

async function tick() {
  if (RUNNING) return;
  RUNNING=true;
  const start=Date.now();
  log("[tick] START", new Date().toISOString());

  const lists = await scrapeList();
  let {active,trending} = lists;

  if (active.length===0 && trending.length===0) {
    log("[tick] zero lists — continuing with known markets");
    active=[]; trending=[];
  } else {
    log(`[tick] lists → active ${active.length}, trending ${trending.length}`);
  }

  // first-boot silent seed
  if (!state.seeded) {
    [...active,...trending].forEach(m=>{
      state.markets[m.id]={...m, announcedOpen:true, announcedTrending:true};
    });
    state.seeded=true;
    saveState();
    RUNNING=false; return;
  }

  // NEW markets (Active only)
  for (const m of active) {
    const rec=state.markets[m.id];
    if (!rec?.announcedOpen) {
      const d=await scrapeDetail(m.url);
      if (d) {
        await send(fmtNew({...d, url:m.url, options:d.options}));
      }
      state.markets[m.id]={ ...(rec||{}), announcedOpen:true, url:m.url };
      saveState();
    }
  }

  // TRENDING detect always
  for (const m of trending) {
    const rec=state.markets[m.id]||{};
    if (!rec.announcedTrending) {
      await send(fmtTrending(m));
      state.markets[m.id]={...rec, announcedTrending:true, url:m.url};
      saveState();
    }
  }

  // detail pass
  for (const id of Object.keys(state.markets)) {
    const rec=state.markets[id];
    if (rec.retired) continue;

    const url = rec.url || `${AURACLE_BASE}/MarketDetails?id=${id}`;
    const d = await scrapeDetail(url);
    if (!d) continue;

    if (d.status==="open" && d.options?.length)
      rec.lastSeen={ options:d.options };

    if (d.status==="closed" && !rec.announcedClosed) {
      const opts=d.options?.length ? d.options : (rec.lastSeen?.options||[]);
      await send(fmtClosed({...d,options:opts}));
      rec.announcedClosed=true;
      rec.closedSnapshot={options:opts};
      saveState();
    }

    if (d.status==="resolved" && !rec.announcedResolved) {
      const opts = rec.closedSnapshot?.options?.length ? rec.closedSnapshot.options :
                  (rec.lastSeen?.options||d.options||[]);
      const winner = d.winner || opts[0]?.label || "YES";
      await send(fmtResolved({ ...d, options:opts, winner }));
      rec.announcedResolved=true;
      rec.retired=true;
      saveState();
    }
  }

  log("[tick] END", new Date().toISOString(), "elapsed",Date.now()-start,"ms");
  RUNNING=false;
}

// ======= SERVER KEEP-ALIVE =======
http.createServer((_,res)=>res.end("OK")).listen(PORT,()=>console.log("[HTTP] listening on",PORT));

// ====== START ======
await tick();
setInterval(tick, POLL_INTERVAL_MS);
setInterval(()=>console.log("[hb]",new Date().toISOString()),10000);
