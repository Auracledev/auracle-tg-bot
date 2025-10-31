import 'dotenv/config';
import * as fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { Telegraf } from 'telegraf';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ----------------- ENV -----------------
const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  AURACLE_BASE_URL = 'https://auracle.fi',
  POLL_INTERVAL_SECONDS = '30',
  DATA_DIR = '/data', // mount a disk here on your host; for local dev you can set ./data
  DEBUG, // set to "1" to enable verbose logs
} = process.env;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('Missing env vars: TELEGRAM_BOT_TOKEN and/or TELEGRAM_CHAT_ID');
  process.exit(1);
}
const dbg = !!DEBUG;

// ----------------- TELEGRAM -----------------
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// ----------------- STATE (persistent) -----------------
const STATE_DIR = path.resolve(DATA_DIR);
const STATE_FILE = path.join(STATE_DIR, 'state.json');
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
if (!fs.existsSync(STATE_FILE)) fs.writeFileSync(STATE_FILE, JSON.stringify({ markets: {} }, null, 2));

const loadState = () => JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

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
  // Scroll to bottom to trigger lazy/virtualized lists
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
 * Normalized market shape:
 * {
 *   id: string,
 *   title: string,
 *   url: string,
 *   status: "open" | "closed" | "resolved",
 *   options: Array<{ label: string, pct: number|null }>,   // 2 or 3+ (supports Draw)
 *   winner: string|null                                     // label of winning option when resolved
 * }
 */

// Collect markets from /markets (or /Markets) and scrape each details page
async function fetchMarkets({ debug = false } = {}) {
  const base = AURACLE_BASE_URL.replace(/\/+$/, '');
  const listCandidates = [`${base}/markets`, `${base}/Markets`];

  // 1) Open markets list and collect links to MarketDetails (or /markets/<id>)
  let detailLinks = [];
  for (const url of listCandidates) {
    try {
      const page = await newPage();
      if (debug || dbg) console.log('[markets:list] goto', url);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

      await autoScroll(page);
      await page.waitForTimeout(1000);

      // collect up to 50 market links
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
      // try next candidate
    }
  }

  if (!detailLinks.length) {
    if (debug || dbg) console.log('[markets:list] no links found');
    return [];
  }

  // 2) Visit each details page and scrape normalized data (sequential for stability)
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

// Scrape a single MarketDetails page
async function scrapeMarketDetail(url, { debug = false } = {}) {
  const page = await newPage();
  if (debug || dbg) console.log('[detail] goto', url);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

  await autoScroll(page);
  await page.waitForTimeout(800);

  const data = await page.evaluate(() => {
    const text = (el) => (el?.textContent || '').trim();
    const getPctFromNode = (node) => {
      if (!node) return null;
      const s = text(node).replace('%','').replace(/[^\d.]/g,'');
      const n = parseFloat(s);
      return Number.isFinite(n) ? Math.round(n) : null;
    };

    // Title: prefer big heading, then document.title
    let title = text(document.querySelector('.market-title, h1, h2, [data-testid="market-title"]')) || document.title || '';

    // Status: heuristics
    const bodyTxt = (document.body?.innerText || '').toLowerCase();
    let status = 'open';
    if (bodyTxt.includes('resolved')) status = 'resolved';
    else if (bodyTxt.includes('closed') || bodyTxt.includes('finished') || bodyTxt.includes('ended')) status = 'closed';

    // Options: attempt structured selectors first
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

    // Fallback: find % nodes and infer nearby labels
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
        if (!seen.has(key)) {
          guesses.push({ label, pct });
          seen.add(key);
        }
      }
      if (guesses.length >= 2) options = guesses.slice(0, 3);
    }

    // If exactly 2 options and one pct missing, infer from 100
    if (options.length === 2) {
      const [a, b] = options;
      if (a.pct != null && b.pct == null) b.pct = 100 - a.pct;
      if (b.pct != null && a.pct == null) a.pct = 100 - b.pct;
    }

    // Label cleanups + clamp %
    options = options.map((o, i) => ({
      label: (o.label || (i === 2 ? 'Draw' : `Option ${i+1}`)).trim(),
      pct: (o.pct != null && o.pct >= 0 && o.pct <= 100) ? Math.round(o.pct) : null
    }));

    // Winner (if resolved)
    let winner =
      text(document.querySelector('.winner .name, .winner, .result-winner, [data-testid="winner"]')) || null;
    if (!winner) {
      const winNode = document.querySelector('.option.winner, .side.winner, .option-a.winner, .option-b.winner, .option-c.winner');
      if (winNode) {
        winner = text(winNode.querySelector('.label, .name, .team')) || text(winNode) || null;
      }
    }

    // ID normalization from ?id=… or /markets/<id>
    let id = null;
    try {
      const u = new URL(location.href);
      id = u.searchParams.get('id');
      if (!id) {
        const m = u.pathname.match(/\/markets\/([^/]+)/i);
        if (m) id = m[1];
      }
    } catch {}

    return (id && title)
      ? { id, title, url: location.href, status, options, winner }
      : null;
  });

  await page.close();
  if (debug || dbg) console.log('[detail] scraped', data ? data.id : 'null', 'status:', data?.status);
  return data;
}

// ----------------- MSG TEMPLATES -----------------
function escapeMd(s = '') {
  // Escape for Telegram MarkdownV2
  return s.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}
function formatOptionsList(options = []) {
  // e.g., "Home: 45% | Draw: 12% | Away: 43%"
  if (!options.length) return '—';
  const parts = options.map((o) => `${escapeMd(o.label)}: *${o.pct ?? '?'}%*`);
  return parts.join('  |  ');
}

function fmtNewMarket(m) {
  return [
    '🔥 *New Market Live on Auracle!*',
    `🏟️ *${escapeMd(m.title)}*`,
    '📈 Pool is open — make your prediction.',
    `🔗 ${m.url}`,
  ].join('\n');
}
function fmtClosed(m) {
  return [
    '🛑 *Market Closed — Final Pool*',
    `🏟️ *${escapeMd(m.title)}*`,
    `📊 ${formatOptionsList(m.options)}`,
    '👀 Waiting for result…',
    `🔗 ${m.url}`,
  ].join('\n');
}
function fmtResolved(m) {
  return [
    '✅ *Market Resolved*',
    `🏟️ *${escapeMd(m.title)}*`,
    `🏆 *Winner:* ${escapeMd(m.winner ?? '—')}`,
    `📊 Final: ${formatOptionsList(m.options)}`,
    '💰 Rewards available on Auracle.',
    `🔗 ${m.url}`,
  ].join('\n');
}

// ----------------- TELEGRAM SEND -----------------
async function send(msg) {
  try {
    await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, msg, {
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    });
  } catch (e) {
    console.error('Telegram send error:', e.message);
  }
}

// ----------------- POLLING TICK -----------------
async function tick() {
  try {
    if (dbg) console.log('[tick] run at', new Date().toISOString());
    const markets = await fetchMarkets({ debug: dbg });
    const state = loadState();

    for (const m of markets) {
      const prev =
        state.markets[m.id] || {
          announcedOpen: false,
          announcedClosed: false,
          announcedResolved: false,
        };
      const next = { ...prev };

      if (m.status === 'open' && !prev.announcedOpen) {
        await send(fmtNewMarket(m));
        next.announcedOpen = true;
      }
      if (m.status === 'closed' && !prev.announcedClosed) {
        await send(fmtClosed(m));
        next.announcedClosed = true;
      }
      if (m.status === 'resolved' && !prev.announcedResolved) {
        await send(fmtResolved(m));
        next.announcedResolved = true;
      }

      state.markets[m.id] = next;
    }

    saveState(state);
    if (dbg) console.log('[tick] done. markets seen:', markets.length);
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
      await ctx.reply(
        'Fetched 0 markets (debug on). Check host logs for [markets:list], [detail], and [markets] entries — selectors may need a tweak.'
      );
    } else {
      const sample = markets
        .slice(0, 3)
        .map((m) => m.title)
        .join(' | ');
      await ctx.reply(`OK. Found ${markets.length} markets.\nSample: ${sample || '—'}`);
    }
  } catch (e) {
    await ctx.reply(`Fetch failed: ${String(e.message || e).slice(0, 300)}`);
  }
});

// ----------------- START -----------------
bot.launch().then(async () => {
  console.log('Bot started.');
  try {
    await bot.telegram.setMyCommands([
      { command: 'ping', description: 'Ping the bot' },
      { command: 'health', description: 'Fetch market count' },
    ]);
  } catch {}
  const interval = Math.max(5, parseInt(POLL_INTERVAL_SECONDS, 10) || 30); // min 5s
  tick(); // run immediately
  cron.schedule(`*/${interval} * * * * *`, tick);
});

// ----------------- GRACEFUL SHUTDOWN -----------------
process.once('SIGINT', async () => {
  try { if (browser) await browser.close(); } catch {}
  bot.stop('SIGINT');
});
process.once('SIGTERM', async () => {
  try { if (browser) await browser.close(); } catch {}
  bot.stop('SIGTERM');
});
