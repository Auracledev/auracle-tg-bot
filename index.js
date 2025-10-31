import 'dotenv/config';
import fetch from 'node-fetch';
import * as fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Telegraf } from 'telegraf';
import cron from 'node-cron';
import cheerio from 'cheerio';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- ENV ----
const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  AURACLE_BASE_URL = 'https://auracle.fi',
  POLL_INTERVAL_SECONDS = '30',
  DATA_DIR = path.resolve(__dirname, 'data'),
} = process.env;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
  process.exit(1);
}

// ---- TELEGRAM ----
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// ---- STATE (persistent) ----
const STATE_DIR = DATA_DIR;
const STATE_FILE = path.join(STATE_DIR, 'state.json');
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
if (!fs.existsSync(STATE_FILE)) fs.writeFileSync(STATE_FILE, JSON.stringify({ markets: {} }, null, 2));

const loadState = () => JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

// ---- SCRAPER ----
// Goal shape:
/*
[
  {
    id: "market_123",
    title: "Lakers vs Bucks",
    url: "https://auracle.fi/markets/market_123",
    status: "open" | "closed" | "resolved",
    percentages: { aLabel:"A", aPct:63, bLabel:"B", bPct:37 } | null,
    winner: "Lakers" | "Bucks" | null
  }
]
*/
async function fetchMarkets() {
  // Load markets index page
  const res = await fetch(`${AURACLE_BASE_URL}/markets`, { headers: { 'user-agent': 'AuracleBot/1.0 (+telegram)' }});
  if (!res.ok) throw new Error(`Markets page HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  // NOTE: Update selectors to match auracle.fi DOM.
  // The below is a safe starting point with common class names.
  const markets = [];
  const cards = $('.market-card, [data-market-id], .card-market');

  cards.each((_, el) => {
    const $el = $(el);

    // ID: prefer data attr, fall back to href slug
    const dataId = $el.attr('data-id') || $el.attr('data-market-id');
    const href = $el.find('a[href*="/markets/"]').attr('href') || '';
    let id = dataId;
    if (!id && href) {
      const m = href.match(/\/markets\/([^/?#]+)/i);
      if (m) id = m[1];
    }

    // URL
    const url = href ? (href.startsWith('http') ? href : `${AURACLE_BASE_URL}${href}`) : null;

    // Title
    const title = (
      $el.find('.market-title,h3,h2').first().text().trim() ||
      $el.find('a[href*="/markets/"]').first().text().trim()
    );

    // Status text (normalize)
    let statusTxt = (
      $el.find('.market-status,.status,.badge-status').first().text().trim().toLowerCase()
    );
    // Try to infer if missing
    if (!statusTxt) {
      // heuristics: look for "open/close/resolved" badges or countdowns
      if ($el.text().toLowerCase().includes('resolved')) statusTxt = 'resolved';
      else if ($el.text().toLowerCase().includes('closed')) statusTxt = 'closed';
      else statusTxt = 'open';
    }
    const status = (statusTxt.includes('resolve') ? 'resolved'
                   : statusTxt.includes('close') ? 'closed'
                   : 'open');

    // Percentages (present when closed/resolved)
    let aLabel = $el.find('.side-a .label,.option-a .label,.left .label').first().text().trim();
    let bLabel = $el.find('.side-b .label,.option-b .label,.right .label').first().text().trim();
    let aPctTxt = $el.find('.side-a .percent,.option-a .percent,.left .percent').first().text().replace('%','').trim();
    let bPctTxt = $el.find('.side-b .percent,.option-b .percent,.right .percent').first().text().replace('%','').trim();

    // Try alt selectors if empty:
    if (!aPctTxt && !bPctTxt) {
      const percents = $el.find('.percent,.percentage,.progress-label').map((_, p) => $(p).text().replace('%','').trim()).get();
      if (percents.length >= 2) {
        aPctTxt = percents[0];
        bPctTxt = percents[1];
      }
    }
    if (!aLabel && !bLabel) {
      const labels = $el.find('.label,.name,.team').map((_, p) => $(p).text().trim()).get();
      if (labels.length >= 2) {
        aLabel = labels[0]; bLabel = labels[1];
      }
    }

    let percentages = null;
    if (status !== 'open') {
      const aPct = Number.isFinite(parseFloat(aPctTxt)) ? Math.round(parseFloat(aPctTxt)) : null;
      const bPct = Number.isFinite(parseFloat(bPctTxt)) ? Math.round(parseFloat(bPctTxt)) : (aPct !== null ? 100 - aPct : null);
      percentages = { aLabel: aLabel || 'Side A', aPct, bLabel: bLabel || 'Side B', bPct };
    }

    // Winner (only when resolved)
    let winner = null;
    if (status === 'resolved') {
      winner = (
        $el.find('.winner .name,.winner,.result-winner').first().text().trim() || null
      );
      // If still null, infer by badge or CSS class
      if (!winner) {
        const winnerA = $el.find('.side-a,.option-a').first().hasClass('winner');
        const winnerB = $el.find('.side-b,.option-b').first().hasClass('winner');
        if (winnerA) winner = aLabel || 'Side A';
        if (winnerB) winner = bLabel || 'Side B';
      }
    }

    if (id && title && url) {
      markets.push({ id, title, url, status, percentages, winner });
    }
  });

  return markets;
}

// ---- MESSAGE TEMPLATES ----
function fmtNewMarket(m) {
  return [
    '🔥 *New Market Live on Auracle!*',
    `🏟️ *${escapeMd(m.title)}*`,
    '📈 Pool is open — make your prediction.',
    `🔗 ${m.url}`
  ].join('\n');
}
function fmtClosed(m) {
  const p = m.percentages || {};
  return [
    '🛑 *Market Closed — Final Pool*',
    `🏟️ *${escapeMd(m.title)}*`,
    `📊 ${escapeMd(p.aLabel ?? 'A')}: *${p.aPct ?? '?'}%*  |  ${escapeMd(p.bLabel ?? 'B')}: *${p.bPct ?? '?'}%*`,
    '👀 Waiting for result…',
    `🔗 ${m.url}`
  ].join('\n');
}
function fmtResolved(m) {
  const p = m.percentages || {};
  return [
    '✅ *Market Resolved*',
    `🏟️ *${escapeMd(m.title)}*`,
    `🏆 *Winner:* ${escapeMd(m.winner ?? '—')}`,
    `📊 Final: ${escapeMd(p.aLabel ?? 'A')}: *${p.aPct ?? '?'}%*  |  ${escapeMd(p.bLabel ?? 'B')}: *${p.bPct ?? '?'}%*`,
    '💰 Rewards available on Auracle.',
    `🔗 ${m.url}`
  ].join('\n');
}

// Minimal Markdown escaper for underscores/asterisks/brackets/parentheses
function escapeMd(s='') {
  return s.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

// ---- TELEGRAM SEND ----
async function send(msg) {
  try {
    await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'MarkdownV2', disable_web_page_preview: true });
  } catch (e) {
    console.error('Telegram send error:', e.message);
  }
}

// ---- POLLER ----
async function tick() {
  try {
    const markets = await fetchMarkets();
    const state = loadState();

    for (const m of markets) {
      const prev = state.markets[m.id] || { announcedOpen: false, announcedClosed: false, announcedResolved: false };
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
  } catch (e) {
    console.error('tick error:', e.message);
  }
}

// ---- COMMANDS ----
bot.command('ping', ctx => ctx.reply('pong 🏓'));
bot.command('health', async ctx => {
  try {
    const markets = await fetchMarkets();
    await ctx.reply(`OK. Found ${markets.length} markets.`);
  } catch (e) {
    await ctx.reply(`Fetch failed: ${e.message}`);
  }
});

// ---- START ----
bot.launch().then(() => {
  console.log('Bot started.');
  tick(); // immediate
  const step = Math.max(5, parseInt(POLL_INTERVAL_SECONDS, 10) || 30); // safety min 5s
  cron.schedule(`*/${step} * * * * *`, tick);
});

// ---- GRACEFUL ----
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
