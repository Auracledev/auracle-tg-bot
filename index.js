import 'dotenv/config';
import * as fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { Telegraf } from 'telegraf';
import puppeteer from 'puppeteer';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ----------------- ENV -----------------
const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,                // initial/fallback target; can be changed at runtime
  AURACLE_BASE_URL = 'https://auracle.fi',
  POLL_INTERVAL_SECONDS = '30',
  DATA_DIR = '/data',             // mount a disk here in prod; use ./data locally
  DEBUG,
  PORT = process.env.PORT || 3000 // for Railway/Render
} = process.env;

const dbg = !!DEBUG;

if (!TELEGRAM_BOT_TOKEN) {
  console.error('Missing env: TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

// ----------------- TELEGRAM -----------------
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// ----------------- STATE (persistent) -----------------
const STATE_DIR = path.resolve(DATA_DIR);
const STATE_FILE = path.join(STATE_DIR, 'state.json');
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
if (!fs.existsSync(STATE_FILE)) fs.writeFileSync(STATE_FILE, JSON.stringify({ markets: {}, seeded: false }, null, 2));

const loadState = () => {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { markets: {}, seeded: false }; }
};
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

// ---- state helpers
function summarizeState(state) {
  const m = state.markets || {};
  let total=0, open=0, closed=0, resolved=0, aO=0, aC=0, aR=0;
  for (const id in m) {
    total++;
    const s = m[id];
    if (s.lastStatus === 'open') open++;
    if (s.lastStatus === 'closed') closed++;
    if (s.lastStatus === 'resolved') resolved++;
    if (s.announcedOpen) aO++;
    if (s.announcedClosed) aC++;
    if (s.announcedResolved) aR++;
  }
  return { total, open, closed, resolved, aO, aC, aR, seeded: !!state.seeded, targetChatId: state.targetChatId || TELEGRAM_CHAT_ID };
}

function getTargetChatId() {
  try {
    const st = loadState();
    return st.targetChatId || TELEGRAM_CHAT_ID;
  } catch {
    return TELEGRAM_CHAT_ID;
  }
}
function setTargetChatId(id) {
  const st = loadState();
  st.targetChatId = id;
  saveState(st);
  return id;
}

// ----------------- UTILS -----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ----------------- PUPPETEER (singleton) -----------------
let browser = null;

async function getBrowser() {
  if (browser) return browser;
  browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
    ],
  });
  if (dbg) console.log('[puppeteer] launched');
  return browser;
}

async function newPage() {
  const b = await getBrowser();
  const page = await b.newPage();
  await page.setUserAgent('AuracleBot/1.0 (+Telegram)');
  await page.setViewport({ width: 1280, height: 1024 });
  return page;
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const distance = 800;
      const timer = setInterval(() => {
        const doc = document.scrollingElement || document.documentElement;
        const { scrollTop, scrollHeight, clientHeight } = doc;
        window.scrollBy(0, distance);
        total += distance;
        if (scrollTop + clientHeight >= scrollHeight - 2 || total > 20000) {
          clearInterval(timer);
          resolve();
        }
      }, 250);
    });
  });
}

// ----------------- SCRAPER -----------------
/**
 * Market:
 * { id, title, url, status: "open"|"closed"|"resolved", options: [{label,pct}], winner|null }
 */

// Collect markets from list page, then scrape each MarketDetails
async function fetchMarkets({ debug = false } = {}) {
  const base = AURACLE_BASE_URL.replace(/\/+$/, '');
  // Prefer the path that worked in your logs
  const listCandidates = [`${base}/Markets`, `${base}/markets`];

  // 1) Gather detail links
  let detailLinks = [];
  for (const url of listCandidates) {
    try {
      const page = await newPage();
      if (debug || dbg) console.log('[markets:list] goto', url);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

      // wait for any anchor to render, then scroll
      try { await page.waitForSelector('a[href]', { timeout: 8000 }); } catch {}
      await autoScroll(page);
      await sleep(1000);

      const links = await page.evaluate(() => {
        const hrefs = Array.from(document.querySelectorAll('a[href]'))
          .map(a => a.getAttribute('href'))
          .filter(Boolean);

        const marketLinks = [];
        for (const h of hrefs) {
          if (/\/MarketDetails\?id=/.test(h) || /\/markets\//.test(h)) {
            const abs = h.startsWith('http') ? h : `${location.origin}${h}`;
            if (!marketLinks.includes(abs)) marketLinks.push(abs);
          }
        }
        return marketLinks.slice(0, 50);
      });

      if (debug || dbg) console.log('[markets:list] links found:', links.length);
      await page.close();

      if (links.length) { detailLinks = links; break; }
    } catch (err) {
      if (debug || dbg) console.log('[markets:list] error', err.message);
    }
  }

  if (!detailLinks.length) {
    if (debug || dbg) console.log('[markets:list] no links found');
    return [];
  }

  // 2) Scrape each detail sequentially (stable on small hosts)
  const results = [];
  for (const url of detailLinks) {
    try {
      const m = await scrapeMarketDetail(url, { debug });
      if (m) results.push(m);
    } catch (e) {
      if (debug || dbg) console.log('[markets:detail] error', e.message, 'for', url);
    }
  }

  if (debug || dbg) console.log('[markets] total scraped:', results.length);
  return results;
}

async function scrapeMarketDetail(url, { debug = false } = {}) {
  const page = await newPage();
  if (debug || dbg) console.log('[detail] goto', url);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

  try { await page.waitForSelector('body', { timeout: 8000 }); } catch {}
  await autoScroll(page);
  await sleep(800);

  const data = await page.evaluate(() => {
    const text = (el) => (el?.textContent || '').trim();
    const getPctFromNode = (node) => {
      if (!node) return null;
      const s = text(node).replace('%','').replace(/[^\d.]/g,'');
      const n = parseFloat(s);
      return Number.isFinite(n) ? Math.round(n) : null;
    };

    let title = text(document.querySelector('.market-title, h1, h2, [data-testid="market-title"]')) || document.title || '';

    const bodyTxt = (document.body?.innerText || '').toLowerCase();
    let status = 'open';
    if (bodyTxt.includes('resolved')) status = 'resolved';
    else if (bodyTxt.includes('closed') || bodyTxt.includes('finished') || bodyTxt.includes('ended')) status = 'closed';

    const optionRowSelectors = [
      '.option', '.side',
      '.option-a, .option-b, .option-c',
      '.side-a, .side-b, .side-c',
      '.left, .right, .center',
      '[data-option]', '[role="listitem"]'
    ];

    let options = [];
    for (const sel of optionRowSelectors) {
      const rows = Array.from(document.querySelectorAll(sel));
      if (rows.length >= 2) {
        options = rows.map((row, i) => {
          const label =
            text(row.querySelector('.label, .name, .team, .option-label, [data-testid="option-label"]')) ||
            text(row.querySelector('strong, span, p')) ||
            `Option ${i+1}`;
          const pct =
            getPctFromNode(row.querySelector('.percent, .percentage, .progress-label, .option-percent, [data-testid="option-percent"]'));
          return { label, pct: Number.isFinite(pct) ? pct : null };
        }).filter(o => o.label || o.pct !== null);
        if (options.length >= 2) break;
      }
    }

    if (options.length < 2) {
      const candidates = Array.from(document.querySelectorAll('*'))
        .filter(el => /%/.test(el.textContent || ''))
        .slice(0, 6);
      const seen = new Set();
      const guesses = [];
      for (const node of candidates) {
        const pct = getPctFromNode(node);
        if (pct == null) continue;
        let label = '';
        const prev = node.previousElementSibling;
        if (prev && (prev.textContent || '').trim() && !/%/.test(prev.textContent)) {
          label = text(prev);
        }
        if (!label) {
          const parent = node.parentElement;
          if (parent) {
            const strong = parent.querySelector('strong, .label, .name, .team');
            if (strong) label = text(strong);
          }
        }
        if (!label) label = `Option ${guesses.length + 1}`;
        const key = label + '|' + pct;
        if (!seen.has(key)) { guesses.push({ label, pct }); seen.add(key); }
      }
      if (guesses.length >= 2) options = guesses.slice(0, 3);
    }

    if (options.length === 2) {
      const [a, b] = options;
      if (a.pct != null && b.pct == null) b.pct = 100 - a.pct;
      if (b.pct != null && a.pct == null) a.pct = 100 - b.pct;
    }

    options = options.map((o, i) => ({
      label: (o.label || (i === 2 ? 'Draw' : `Option ${i+1}`)).trim(),
      pct: (o.pct != null && o.pct >= 0 && o.pct <= 100) ? Math.round(o.pct) : null
    }));

    let winner =
      text(document.querySelector('.winner .name, .winner, .result-winner, [data-testid="winner"]')) || null;
    if (!winner) {
      const winNode = document.querySelector('.option.winner, .side.winner, .option-a.winner, .option-b.winner, .option-c.winner');
      if (winNode) {
        winner = text(winNode.querySelector('.label, .name, .team')) || text(winNode) || null;
      }
    }

    let id = null;
    try {
      const u = new URL(location.href);
      id = u.searchParams.get('id');
      if (!id) {
        const m = u.pathname.match(/\/markets\/([^/]+)/i);
        if (m) id = m[1];
      }
    } catch {}

    return (id && title) ? { id, title, url: location.href, status, options, winner } : null;
  });

  await page.close();
  if (debug || dbg) console.log('[detail] scraped', data ? data.id : 'null', 'status:', data?.status);
  return data;
}

// ----------------- MSG TEMPLATES (HTML) -----------------
function formatOptionsList(options = []) {
  if (!options.length) return '—';
  const parts = options.map((o) =>
    `${escapeHtml(o.label)}: <b>${o.pct ?? '?' }%</b>`
  );
  return parts.join('  |  ');
}
function fmtNewMarket(m) {
  return [
    '🔥 <b>New Market Live on Auracle</b>',
    `🏟️ <b>${escapeHtml(m.title)}</b>`,
    '📈 Pool is open — make your prediction.',
    `🔗 ${escapeHtml(m.url)}`
  ].join('\n');
}
function fmtClosed(m) {
  return [
    '🛑 <b>Market Closed — Final Pool</b>',
    `🏟️ <b>${escapeHtml(m.title)}</b>`,
    `📊 ${formatOptionsList(m.options)}`,
    '👀 Waiting for result…',
    `🔗 ${escapeHtml(m.url)}`
  ].join('\n');
}
function fmtResolved(m) {
  return [
    '✅ <b>Market Resolved</b>',
    `🏟️ <b>${escapeHtml(m.title)}</b>`,
    `🏆 <b>Winner:</b> ${escapeHtml(m.winner ?? '—')}`,
    `📊 Final: ${formatOptionsList(m.options)}`,
    '💰 Rewards available on Auracle.',
    `🔗 ${escapeHtml(m.url)}`
  ].join('\n');
}

// ----------------- TELEGRAM SEND (HTML) -----------------
async function send(msg, tag = '') {
  const chatId = getTargetChatId();
  try {
    const m = await bot.telegram.sendMessage(chatId, msg, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    if (dbg) console.log(`[send] OK → chat ${chatId} ${tag ? '[' + tag + ']' : ''} message_id=${m?.message_id}`);
  } catch (e) {
    const desc = e?.response?.description || e.message;
    console.error('[send] ERROR → chat', chatId, desc);
  }
}

// ----------------- TICK LOOP -----------------
async function tick() {
  try {
    if (dbg) console.log('[tick] run at', new Date().toISOString());
    const markets = await fetchMarkets({ debug: dbg });
    let state = loadState();
    if (!state || !state.markets) state = { markets: {}, seeded: false };

    // One-time cold start seed to avoid spam
    if (!state.seeded && markets.length) {
      if (dbg) console.log('[seed] first run — seeding', markets.length, 'markets');
      for (const m of markets) {
        state.markets[m.id] = {
          announcedOpen:     m.status === 'open',
          announcedClosed:   m.status === 'closed',
          announcedResolved: m.status === 'resolved',
          lastStatus:        m.status
        };
      }
      state.seeded = true;
      saveState(state);
      if (dbg) console.log('[seed] done');
      return;
    }

    if (dbg) console.log('[tick] scraped', markets.length, 'markets');

    // Normal incremental announcements
    for (const m of markets) {
      const prev = state.markets[m.id] || {
        announcedOpen: false, announcedClosed: false, announcedResolved: false, lastStatus: 'unknown'
      };
      const next = { ...prev };

      if (m.status === 'open' && !prev.announcedOpen) {
        await send(fmtNewMarket(m), 'OPEN');
        next.announcedOpen = true;
      }
      if (m.status === 'closed' && !prev.announcedClosed) {
        await send(fmtClosed(m), 'CLOSED');
        next.announcedClosed = true;
      }
      if (m.status === 'resolved' && !prev.announcedResolved) {
        await send(fmtResolved(m), 'RESOLVED');
        next.announcedResolved = true;
      }

      next.lastStatus = m.status;
      state.markets[m.id] = next;
    }

    saveState(state);
    if (dbg) console.log('[tick] done.', summarizeState(state));
  } catch (e) {
    console.error('tick error:', e.message);
  }
}

// ----------------- COMMANDS -----------------
bot.command('ping', (ctx) => ctx.reply('pong 🏓'));

bot.command('health', async (ctx) => {
  try {
    const markets = await fetchMarkets({ debug: true });
    if (!markets.length) {
      await ctx.reply('Fetched 0 markets (debug on). Check logs for [markets:list]/[detail] entries.');
    } else {
      const sample = markets.slice(0, 3).map(m => m.title).join(' | ');
      await ctx.reply(`OK. Found ${markets.length} markets.\nSample: ${sample || '—'}`);
    }
  } catch (e) {
    await ctx.reply(`Fetch failed: ${String(e.message || e).slice(0, 300)}`);
  }
});

bot.command('whereami', async (ctx) => {
  const target = getTargetChatId();
  const here = ctx.chat?.id;
  await ctx.reply(`Target chat: ${String(target)}\nThis chat: ${String(here)}\nTip: /set_target here`);
});

bot.command('set_target', async (ctx) => {
  const parts = (ctx.message.text || '').trim().split(/\s+/);
  const arg = parts[1];
  if (!arg) { await ctx.reply('Usage: /set_target <chatId|here>'); return; }
  const id = (arg === 'here') ? ctx.chat.id : arg;
  setTargetChatId(id);
  await ctx.reply(`OK. Target chat set to: ${id}`);
});

function chunk(arr, n){ const out=[]; for(let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n)); return out; }

bot.command('announce_open_now', async (ctx) => {
  const parts = (ctx.message.text || '').trim().split(/\s+/);
  const limit = Math.max(1, Math.min(parseInt(parts[1] || '3', 10) || 3, 20));
  const markets = await fetchMarkets({ debug: false });
  const openNow = markets.filter(m => m.status === 'open').slice(0, limit);

  if (!openNow.length) { await ctx.reply('No open markets found right now.'); return; }

  for (const batch of chunk(openNow, 5)) {
    for (const m of batch) {
      await send(fmtNewMarket(m), 'OPEN(TEST)');
      const st = loadState();
      st.markets[m.id] = { ...(st.markets[m.id] || {}), announcedOpen: true, lastStatus: 'open' };
      saveState(st);
    }
  }
  await ctx.reply(`Announced ${openNow.length} open market(s) to target chat.`);
});

bot.command('state', async (ctx) => {
  try {
    const s = summarizeState(loadState());
    await ctx.reply(
      `seeded: ${s.seeded}\n` +
      `target: ${s.targetChatId}\n` +
      `tracked: ${s.total}\n` +
      `statuses: open=${s.open}, closed=${s.closed}, resolved=${s.resolved}\n` +
      `announced: open=${s.aO}, closed=${s.aC}, resolved=${s.aR}`
    );
  } catch { await ctx.reply('state read error'); }
});

bot.command('reseed_off', async (ctx) => {
  const st = loadState(); st.seeded = true; saveState(st);
  await ctx.reply('Seeding disabled (seeded=true).');
});

// ----------------- START -----------------
bot.launch().then(async () => {
  console.log('Bot started.');
  try {
    await bot.telegram.setMyCommands([
      { command: 'ping', description: 'Ping the bot' },
      { command: 'health', description: 'Fetch market count' },
      { command: 'whereami', description: 'Show current & target chat' },
      { command: 'set_target', description: 'Set target chat id or "here"' },
      { command: 'announce_open_now', description: 'Announce N open markets now' },
      { command: 'state', description: 'Show tracked/announced counts' },
    ]);
  } catch {}
  const interval = Math.max(5, parseInt(POLL_INTERVAL_SECONDS, 10) || 30);
  tick(); // immediate run
  cron.schedule(`*/${interval} * * * * *`, tick);
});

// ----------------- TINY HTTP SERVER (keeps Railway/Render happy) -----------------
const server = http.createServer(async (req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const st = loadState();
    const sum = summarizeState(st);
    res.end(JSON.stringify({ ok: true, ...sum }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Auracle Telegram bot is running.\n');
});
server.listen(PORT, () => console.log(`[http] listening on :${PORT}`));

// ----------------- GRACEFUL SHUTDOWN -----------------
process.once('SIGINT', async () => { try { if (browser) await browser.close(); } catch {} bot.stop('SIGINT'); server.close(); });
process.once('SIGTERM', async () => { try { if (browser) await browser.close(); } catch {} bot.stop('SIGTERM'); server.close(); });
