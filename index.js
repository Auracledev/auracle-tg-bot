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
  DATA_DIR = '/data', // On Render, mount a disk here; during local dev, you can set ./data
  DEBUG, // set to "1" to see verbose logs
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
 *   options: Array<{ label: string, pct: number|null }>,   // 2 or 3 (e.g., includes "Draw"); supports more
 *   winner: string|null                                     // label of winning option when resolved
 * }
 */
async function fetchMarkets({ debug = false } = {}) {
  const base = AURACLE_BASE_URL.replace(/\/+$/, '');
  const candidates = [`${base}/markets`, `${base}/Markets`];

  for (const url of candidates) {
    try {
      const page = await newPage();
      if (debug || dbg) console.log('[markets] goto', url);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

      // PROBE: are there any useful links at all?
      const probe = await page.evaluate(() => {
        const a = Array.from(document.querySelectorAll('a[href]'))
          .map((el) => el.getAttribute('href'))
          .filter(Boolean);
        const marketLinks = a.filter((h) => /\/markets\//i.test(h) || /MarketDetails/i.test(h));
        return { totalLinks: a.length, marketLinks: marketLinks.slice(0, 10) };
      });
      if (debug || dbg) console.log('[probe]', probe);

      if (!probe.marketLinks.length) {
        await autoScroll(page);
        await page.waitForTimeout(1500);
        const probe2 = await page.evaluate(() => {
          const a = Array.from(document.querySelectorAll('a[href]'))
            .map((el) => el.getAttribute('href'))
            .filter(Boolean);
          const marketLinks = a.filter((h) => /\/markets\//i.test(h) || /MarketDetails/i.test(h));
          return { totalLinks: a.length, marketLinks: marketLinks.slice(0, 10) };
        });
        if (debug || dbg) console.log('[probe2]', probe2);
      }

      // WAIT for likely containers
      const readySelectors = [
        '.market-card',
        '[data-market-id]',
        '.card-market',
        'a[href*="/markets/"]',
        'a[href*="/MarketDetails"]',
      ];
      let ready = false;
      for (const sel of readySelectors) {
        try {
          await page.waitForSelector(sel, { timeout: 8000 });
          ready = true;
          break;
        } catch {}
      }
      if (!ready) {
        await autoScroll(page);
        for (const sel of readySelectors) {
          try {
            await page.waitForSelector(sel, { timeout: 4000 });
            ready = true;
            break;
          } catch {}
        }
      }
      if (!ready) {
        if (debug || dbg) {
          const bodySnippet = await page.evaluate(
            () => document.body?.innerText?.slice(0, 500) || ''
          );
          console.log('[markets] no selectors matched. body snippet:', bodySnippet);
        }
        await page.close();
        continue; // try next candidate URL
      }

      // Ensure virtualized lists render
      await autoScroll(page);

      const markets = await page.evaluate(() => {
        const text = (el) => (el?.textContent || '').trim();
        const getPct = (node) => {
          const s = text(node).replace('%', '').replace(/[^\d.]/g, '');
          const n = parseFloat(s);
          return Number.isFinite(n) ? Math.round(n) : null;
        };

        const optionRowSelectors = [
          '.option', '.side',
          '.option-a, .option-b, .option-c',
          '.side-a, .side-b, .side-c',
          '.left, .right, .center',
        ];

        const cardNodes = Array.from(
          document.querySelectorAll('.market-card, [data-market-id], .card-market')
        );
        const linkNodes = cardNodes.length
          ? []
          : Array.from(
              document.querySelectorAll('a[href*="/markets/"], a[href*="/MarketDetails"]')
            );

        const nodes = cardNodes.length ? cardNodes : linkNodes;

        const out = nodes.map((el) => {
          const isLink = el.tagName?.toLowerCase() === 'a';
          const hrefEl = isLink
            ? el
            : el.querySelector?.('a[href*="/markets/"], a[href*="/MarketDetails"]');
          const href = hrefEl ? hrefEl.getAttribute('href') : null;

          // id from data-* or from href
          let id =
            el.getAttribute?.('data-id') ||
            el.getAttribute?.('data-market-id') ||
            null;
          if (!id && href) {
            let m = href.match(/\/markets\/([^/?#]+)/i);
            if (!m) m = href.match(/[?&]id=([^&#]+)/i);
            if (m) id = m[1];
          }

          // title
          let title =
            text(el.querySelector?.('.market-title')) ||
            text(el.querySelector?.('h1, h2, h3')) ||
            (hrefEl ? text(hrefEl) : '');

          // status
          let statusRaw =
            text(el.querySelector?.('.market-status, .status, .badge-status')).toLowerCase();
          let status = 'open';
          const block = text(el).toLowerCase();
          if (statusRaw.includes('resolved') || block.includes('resolved')) status = 'resolved';
          else if (
            statusRaw.includes('closed') ||
            statusRaw.includes('finished') ||
            statusRaw.includes('ended') ||
            block.includes('closed') ||
            block.includes('finished') ||
            block.includes('ended')
          ) {
            status = 'closed';
          }

          // ---- options (2, 3, or more) ----
          let options = [];

          // Try structured rows first
          for (const sel of optionRowSelectors) {
            const rows = Array.from(el.querySelectorAll?.(sel) || []);
            if (rows.length >= 2) {
              options = rows
                .map((row) => {
                  const label =
                    text(
                      row.querySelector('.label, .name, .team, .option-label')
                    ) || text(row.querySelector('strong, span'));
                  const pct = getPct(
                    row.querySelector(
                      '.percent, .percentage, .progress-label, .option-percent'
                    )
                  );
                  return {
                    label: label || '',
                    pct: Number.isFinite(pct) ? pct : null,
                  };
                })
                .filter((o) => o.label || o.pct !== null);
              if (options.length >= 2) break;
            }
          }

          // Fallback: first 2–3 labels + percents anywhere inside card
          if (options.length < 2) {
            const labels = Array.from(
              el.querySelectorAll?.('.label, .name, .team') || []
            )
              .map((n) => text(n))
              .filter(Boolean)
              .slice(0, 3);
            const percNodes = Array.from(
              el.querySelectorAll?.('.percent, .percentage, .progress-label') || []
            ).slice(0, 3);
            const pcts = percNodes.map(getPct);
            const len = Math.max(labels.length, pcts.length);
            if (len >= 2) {
              options = Array.from({ length: len }).map((_, i) => ({
                label: labels[i] || (i === 2 ? 'Draw' : `Option ${i + 1}`),
                pct: Number.isFinite(pcts[i]) ? pcts[i] : null,
              }));
            }
          }

          // If exactly 2 options and only one pct given, infer the other as (100 - x)
          if (options.length === 2) {
            const a = options[0],
              b = options[1];
            if (a.pct != null && b.pct == null) b.pct = 100 - a.pct;
            if (b.pct != null && a.pct == null) a.pct = 100 - b.pct;
          }

          // Clamp/clean percentages
          options = options.map((o) => ({
            label: o.label || 'Option',
            pct:
              o.pct != null && o.pct >= 0 && o.pct <= 100
                ? Math.round(o.pct)
                : null,
          }));

          // winner (when resolved)
          let winner =
            text(el.querySelector?.('.winner .name, .winner, .result-winner')) ||
            null;
          if (!winner) {
            const winNode = el.querySelector?.(
              '.option.winner, .side.winner, .option-a.winner, .option-b.winner, .option-c.winner'
            );
            if (winNode) {
              const wlabel =
                text(winNode.querySelector('.label, .name, .team')) ||
                text(winNode);
              if (wlabel) winner = wlabel;
            }
          }

          const absoluteUrl =
            href && !href.startsWith('http')
              ? `${location.origin}${href}`
              : href || location.href;

          return id && title && absoluteUrl
            ? {
                id,
                title,
                url: absoluteUrl,
                status,
                options,
                winner: winner || null,
              }
            : null;
        });

        return out.filter(Boolean);
      });

      await page.close();
      if (debug || dbg) console.log('[markets] fetched', markets.length, 'from', url);
      if (markets.length) return markets;
    } catch (err) {
      if (debug || dbg) console.error(`[fetchMarkets] ${url} ->`, err.message);
      // try next candidate url
    }
  }

  return [];
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
        'Fetched 0 markets (debug on). Check logs for [probe] and [markets] entries — selectors may need tweaking.'
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
    // (Nice to have) set commands for autocomplete
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
  try {
    if (browser) await browser.close();
  } catch {}
  bot.stop('SIGINT');
});
process.once('SIGTERM', async () => {
  try {
    if (browser) await browser.close();
  } catch {}
  bot.stop('SIGTERM');
});
