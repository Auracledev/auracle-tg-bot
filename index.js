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
  TELEGRAM_CHAT_ID,
  AURACLE_BASE_URL = 'https://auracle.fi',
  POLL_INTERVAL_SECONDS = '30',
  DATA_DIR = '/data',
  DEBUG,
  PORT = process.env.PORT || 3000,
  TZ = process.env.TZ || 'UTC'
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
if (!fs.existsSync(STATE_FILE)) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ markets: {}, seeded: false }, null, 2));
}

// Per-market state structure noted previously
const loadState = () => {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { markets: {}, seeded: false }; }
};
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

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
  return {
    total, open, closed, resolved, aO, aC, aR,
    seeded: !!state.seeded,
    targetChatId: state.targetChatId || TELEGRAM_CHAT_ID
  };
}

function getTargetChatId() {
  try { return loadState().targetChatId || TELEGRAM_CHAT_ID; }
  catch { return TELEGRAM_CHAT_ID; }
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
      '--window-size=1280,1024',
    ],
  });
  console.log('[puppeteer] launched');
  return browser;
}

async function newPage() {
  const b = await getBrowser();
  const page = await b.newPage();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) AuracleBot/1.0 Chrome/117 Safari/537.36');
  await page.setViewport({ width: 1280, height: 1024 });
  await page.setCacheEnabled(false); // disable disk/mem cache
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

// ----------------- SCRAPERS -----------------
function extractIdFromUrl(u) {
  try {
    const url = new URL(u);
    const id = url.searchParams.get('id');
    if (id) return id;
  } catch {}
  const m = u.match(/\/markets\/([^/?#]+)/i);
  return m ? m[1] : null;
}

/**
 * HOT badge → Trending, else Active. Only ID/URL + light meta (no titles).
 * Adds cache-buster to defeat edge caching.
 */
async function fetchMarketsFromSections({ debug = false } = {}) {
  const base = AURACLE_BASE_URL.replace(/\/+$/, '');
  const now = Date.now();
  const listCandidates = [`${base}/Markets?ts=${now}`, `${base}/markets?ts=${now}`];

  for (const url of listCandidates) {
    try {
      const page = await newPage();
      if (debug || dbg) console.log('[sections] goto', url);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

      try {
        await page.waitForFunction(
          () => !!document.querySelector('a[href*="MarketDetails?id="], a[href*="/markets/"]'),
          { timeout: 20000 }
        );
      } catch {}
      for (let i = 0; i < 10; i++) { await autoScroll(page); await sleep(400); }

      const data = await page.evaluate(() => {
        const text = (el) => (el?.textContent || '').trim();
        const HAS_HOT = (node) => {
          if (!node) return false;
          const nodes = Array.from(node.querySelectorAll('*:not(script):not(style)')).slice(0, 500);
          for (const n of nodes) {
            const t = (n.textContent || '').toUpperCase();
            if (/#\s*\d+\s*HOT/.test(t)) return true;
          }
          return false;
        };

        const anchors = Array.from(document.querySelectorAll('a[href*="MarketDetails?id="], a[href*="/markets/"]'));
        const seenUrls = new Set();
        const entries = [];

        for (const a of anchors) {
          const href = a.getAttribute('href') || '';
          const abs = href.startsWith('http') ? href : `${location.origin}${href}`;
          if (seenUrls.has(abs)) continue;
          seenUrls.add(abs);

          const cardRoot = a.closest('article, section, div.card, div') || a.parentElement;

          const category =
            text(cardRoot?.querySelector('.badge, .chip, .category, [data-testid="category"]')) || '';

          let endsIn = '';
          const smalls = Array.from(cardRoot?.querySelectorAll('time, .text-xs, .text-sm, [data-testid="ends-in"], .ends-in') || [])
            .map(el => text(el));
          const endsCand = smalls.find(t => /in\b.*(hour|day|minute|about)/i.test(t) || /about/i.test(t));
          if (endsCand) endsIn = endsCand;

          const rowSelectors = [
            '.option', '.side', '.row',
            '.left, .center, .right',
            '[data-option]', '[role="listitem"]',
            '.market-option', '.market-side'
          ].join(',');

          const labelSel = [
            '.label', '.name', '.team', '.option-label',
            '[data-testid="option-label"]', '[data-testid="option-name"]',
            'strong', 'span', 'p'
          ].join(',');

          const pctSel = [
            '.percent', '.percentage', '.progress-label', '.option-percent',
            '[data-testid="option-percent"]'
          ].join(',');

          const options = [];
          const rows = Array.from(cardRoot?.querySelectorAll(rowSelectors) || []);
          for (const row of rows) {
            const pctNode = row.querySelector(pctSel);
            const lblNode = row.querySelector(labelSel);
            if (!pctNode || !lblNode) continue;
            const pctStr = (pctNode.textContent || '').replace('%','').replace(/[^\d.]/g,'');
            const pct = Number.isFinite(parseFloat(pctStr)) ? Math.round(parseFloat(pctStr)) : null;
            const label = text(lblNode);
            if (!label || pct === null) continue;
            options.push({ label, pct });
            if (options.length >= 3) break;
          }

          let id = null;
          try {
            const u = new URL(abs);
            id = u.searchParams.get('id') || (u.pathname.match(/\/markets\/([^/]+)/i)?.[1] || null);
          } catch {}

          const entry = { id, url: abs, title: '', category, endsIn, options, status: 'open' };
          const trending = HAS_HOT(cardRoot);
          entries.push({ entry, trending });
        }

        // Dedup by ID/URL
        const byKey = new Map();
        for (const { entry, trending } of entries) {
          const key = entry.id || entry.url;
          if (!byKey.has(key)) byKey.set(key, { entry, trending });
        }

        const trendingArr = [];
        const activeArr = [];
        for (const { entry, trending } of byKey.values()) {
          if (trending) trendingArr.push(entry); else activeArr.push(entry);
        }
        if (activeArr.length === 0 && trendingArr.length > 0) {
          return { trending: [], active: trendingArr };
        }
        return { trending: trendingArr, active: activeArr };
      });

      await page.close();
      if (debug || dbg) console.log('[sections] trending:', data.trending.length, 'active:', data.active.length);
      return data;
    } catch (err) {
      if (debug || dbg) console.log('[sections] error', err.message);
    }
  }
  return { trending: [], active: [] };
}

// --------- DETAIL SCRAPER (robust title) ----------
async function scrapeMarketDetail(url, { debug = false } = {}) {
  const page = await newPage();
  if (debug || dbg) console.log('[detail] goto', url);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

  try { await page.waitForSelector('body', { timeout: 8000 }); } catch {}
  await autoScroll(page);
  await sleep(600);

  const data = await page.evaluate(() => {
    const text = (el) => (el?.textContent || '').trim();
    const up = (s) => (s || '').toUpperCase();

    const og = document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim();

    const nodes = Array.from(document.querySelectorAll(
      'h1, h2, h3, .market-title, [data-testid="market-title"], .title, .text-3xl, .text-2xl'
    ));
    const bad = /^(AURACLE|BACK TO AURACLES|PREDICT THE FUTURE)$/i;

    const scoreTitle = (s) => {
      if (!s) return -1e9;
      let t = s.replace(/\s+/g, ' ').trim();
      if (bad.test(t)) return -1e9;
      if (/AURACLE\s*(•|-|—|\|)/i.test(t)) return -1000;
      let score = 0;
      if (/\bvs\b/i.test(t)) score += 50;
      if (/\?/.test(t)) score += 30;
      if (t.length >= 12) score += 10;
      score += Math.min(60, t.length / 2);
      return score;
    };

    const cand = [];
    if (og) cand.push({ t: og, s: scoreTitle(og) });

    for (const n of nodes) {
      const t = text(n);
      cand.push({ t, s: scoreTitle(t) });
    }

    const pct = document.querySelector('[data-testid="option-percent"], .option-percent, .percentage, .percent');
    if (pct) {
      const blk = pct.closest('article, section, div');
      if (blk) {
        const localHead = blk.querySelector('h1, h2, h3, .market-title, .title');
        if (localHead) {
          const t = text(localHead);
          cand.push({ t, s: scoreTitle(t) + 5 });
        }
      }
    }

    cand.sort((a, b) => b.s - a.s);
    let bestTitle = (cand.find(x => x.s > 0)?.t || '').trim();

    if (!bestTitle) {
      let dt = (document.title || '').trim();
      let parts = dt.split(/[\|\-•—]/).map(s => s.trim()).filter(Boolean);
      parts = parts.filter(p => !/^AURACLE$/i.test(p));
      bestTitle = parts[0] || dt;
    }

    const getPctFromNode = (node) => {
      if (!node) return null;
      const s = (node?.textContent || '').replace('%','').replace(/[^\d.]/g,'');
      const n = parseFloat(s);
      return Number.isFinite(n) ? Math.round(n) : null;
    };

    const pageTextRaw = document.body?.innerText || '';
    const pageTextUP  = up(pageTextRaw);
    const isClosedText = pageTextUP.includes('ORACLE CLOSED - AWAITING RESOLUTION');

    let winner = null;
    const resolvedMatch = pageTextRaw.match(/ORACLE RESOLVED:\s*(.+)$/mi);
    if (resolvedMatch && resolvedMatch[1]) winner = resolvedMatch[1].trim();

    const optionRowSelectors = [
      '.option', '.side',
      '.option-a, .option-b, .option-c',
      '.side-a, .side-b, .side-c',
      '.left, .right, .center',
      '[data-option]', '[role="listitem"]',
      '[data-testid="market-option"]',
      '.market-option, .market-side'
    ];

    const labelSelectors = [
      '.label', '.name', '.team', '.option-label',
      '[data-testid="option-label"]', '[data-testid="option-name"]',
      'strong', 'span', 'p'
    ].join(',');

    const percentSelectors = [
      '.percent', '.percentage', '.progress-label', '.option-percent',
      '[data-testid="option-percent"]'
    ].join(',');

    let options = [];
    for (const sel of optionRowSelectors) {
      const rows = Array.from(document.querySelectorAll(sel));
      if (rows.length >= 2) {
        options = rows.map((row, i) => {
          const label = (row.querySelector(labelSelectors)?.textContent || '').trim() || `Option ${i+1}`;
          const pct = getPctFromNode(row.querySelector(percentSelectors));
          return { label, pct: Number.isFinite(pct) ? Math.round(pct) : null };
        }).filter(o => o.label || o.pct !== null);
        if (options.length >= 2) break;
      }
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

    let status = 'open';
    if (winner) status = 'resolved';
    else if (isClosedText) status = 'closed';

    let id = null;
    try {
      const u = new URL(location.href);
      id = u.searchParams.get('id') || (u.pathname.match(/\/markets\/([^/]+)/i)?.[1] || null);
    } catch {}

    return { id, title: bestTitle, url: location.href, status, options, winner: winner || null };
  });

  await page.close();
  if (debug || dbg) console.log('[detail] scraped', data ? `${data.id} title="${data.title}" status: ${data.status}` : 'null');
  return data;
}

// ----------------- MSG TEMPLATES (HTML) -----------------
function formatOptionsList(options = []) {
  if (!options.length) return '—';
  return options.map((o) =>
    `${escapeHtml(o.label)}: <b>${o.pct ?? '?' }%</b>`
  ).join('  |  ');
}
function fmtNewMarket(m) {
  const cat = m.category ? `📂 <b>${escapeHtml(m.category)}</b>\n` : '';
  const end = m.endsIn ? `⏳ ${escapeHtml(m.endsIn)}\n` : '';
  const lines = (m.options || []).slice(0, 3).map(
    o => `• ${escapeHtml(o.label)} — <b>${o.pct}%</b>`
  ).join('\n');

  return [
    '🔥 <b>New Market Live on Auracle</b>',
    `🏟️ <b>${escapeHtml(m.title)}</b>`,
    cat + end + (lines || ''),
    `🔗 ${escapeHtml(m.url)}`
  ].join('\n');
}
function fmtClosed(m) {
  return [
    '🛑 <b>Market Closed — Final Pool</b>',
    `🏟️ <b>${escapeHtml(m.title)}</b>`,
    `📊 ${formatOptionsList(m.options)}`,
    '👀 Awaiting resolution…',
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
function fmtTrending(m) {
  const cat = m.category ? `📂 <b>${escapeHtml(m.category)}</b>\n` : '';
  const lines = (m.options || []).slice(0,3).map(
    o => `• ${escapeHtml(o.label)} — <b>${o.pct}%</b>`
  ).join('\n');
  return [
    '📈 <b>Now Trending on Auracle</b>',
    `🏟️ <b>${escapeHtml(m.title)}</b>`,
    cat + (lines || ''),
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
    console.log('[tick] run at', new Date().toISOString());

    const { trending, active } = await fetchMarketsFromSections({ debug: dbg });

    const activeIds   = new Set(active.map(m => m.id).filter(Boolean));
    const trendingIds = new Set(trending.map(m => m.id).filter(Boolean));

    let state = loadState();
    if (!state || !state.markets) state = { markets: {}, seeded: false };
    const knownIds = new Set(Object.keys(state.markets));
    const toWatch = new Set([...activeIds, ...knownIds]); // announce open only if in Active

    console.log('[tick] counts → active:', activeIds.size, 'trending:', trendingIds.size, 'known:', knownIds.size, 'watch:', toWatch.size);

    const activeById   = new Map(active.map(m => [m.id, m]));
    const trendingById = new Map(trending.map(m => [m.id, m]));

    const base = AURACLE_BASE_URL.replace(/\/+$/, '');
    const results = [];
    for (const id of toWatch) {
      const known = state.markets[id];
      const url =
        known?.url ||
        activeById.get(id)?.url ||
        trendingById.get(id)?.url ||
        `${base}/MarketDetails?id=${id}`;

      const detail = await scrapeMarketDetail(url, { debug: dbg });
      if (!detail || !detail.id) continue;

      if (detail.status === 'open') {
        const card = activeById.get(detail.id) || trendingById.get(detail.id);
        if (card) {
          detail.category = card.category || detail.category;
          detail.endsIn   = card.endsIn   || detail.endsIn;
          if (Array.isArray(card.options) && card.options.length >= 2) detail.options = card.options;
        }
      }

      results.push(detail);
    }

    if (!state.seeded && results.length) {
      console.log('[seed] first run — seeding', results.length, 'markets');
      for (const m of results) {
        const inActive   = activeById.has(m.id);
        const card       = activeById.get(m.id) || trendingById.get(m.id);
        state.markets[m.id] = {
          announcedOpen:     m.status === 'open' && inActive,
          announcedClosed:   m.status === 'closed',
          announcedResolved: m.status === 'resolved',
          lastStatus:        m.status,
          url:               m.url,
          missingCount:      0,
          wasTrending:       trendingIds.has(m.id),
          lastSeen:          card ? { title: m.title, category: card.category, endsIn: card.endsIn, options: card.options } :
                                    { title: m.title, category: m.category, endsIn: m.endsIn, options: m.options },
          closedSnapshot:    m.status === 'closed' ? { options: (m.options || []) } : null
        };
      }
      state.seeded = true;
      saveState(state);
      console.log('[seed] done');
      return;
    }

    console.log('[tick] scraped detail count:', results.length);

    for (const id of Object.keys(state.markets)) {
      state.markets[id].missingCount = activeIds.has(id) ? 0 : ((state.markets[id].missingCount || 0) + 1);
    }

    for (const m of results) {
      const prev = state.markets[m.id] || {
        announcedOpen: false, announcedClosed: false, announcedResolved: false,
        lastStatus: 'unknown', url: m.url, missingCount: 0, lastSeen: null, closedSnapshot: null, wasTrending: false
      };
      const next = { ...prev, url: m.url };

      if (m.status === 'open') {
        const card = activeById.get(m.id) || trendingById.get(m.id);
        const seenOpts = card?.options?.length ? card.options : m.options;
        next.lastSeen = {
          title: m.title,
          category: card?.category ?? m.category,
          endsIn: card?.endsIn ?? m.endsIn,
          options: Array.isArray(seenOpts) ? seenOpts : (prev.lastSeen?.options || [])
        };
      }

      if (!activeIds.has(m.id) && (prev.missingCount || 0) >= 1 && m.status === 'open') {
        console.log('[infer] CLOSED due to disappearance from Active:', m.id);
        m.status = 'closed';
      }

      if (m.status === 'closed' && !next.closedSnapshot) {
        const finalOpts = (prev.lastSeen?.options?.length ? prev.lastSeen.options : m.options) || [];
        next.closedSnapshot = { options: finalOpts };
      }

      if (m.status === 'open' && activeIds.has(m.id) && !prev.announcedOpen) {
        const card = activeById.get(m.id);
        const openPayload = {
          ...m,
          title: m.title || prev.lastSeen?.title || card?.title || 'Unknown',
          category: next.lastSeen?.category ?? card?.category ?? m.category,
          endsIn: next.lastSeen?.endsIn ?? card?.endsIn ?? m.endsIn,
          options: (card?.options?.length ? card.options :
                    next.lastSeen?.options?.length ? next.lastSeen.options :
                    m.options)
        };
        await send(fmtNewMarket(openPayload), 'OPEN');
        next.announcedOpen = true;
      }

      if (m.status === 'closed' && !prev.announcedClosed) {
        const closedOptions =
          next.closedSnapshot?.options?.length ? next.closedSnapshot.options
            : (prev.lastSeen?.options?.length ? prev.lastSeen.options : m.options);
        const closedPayload = { ...m, options: closedOptions, title: m.title || prev.lastSeen?.title || 'Unknown' };
        await send(fmtClosed(closedPayload), 'CLOSED');
        next.announcedClosed = true;
      }

      if (m.status === 'resolved' && !prev.announcedResolved) {
        const finalOptions =
          next.closedSnapshot?.options?.length ? next.closedSnapshot.options
            : (prev.lastSeen?.options?.length ? prev.lastSeen.options : m.options);
        const resolvedPayload = { ...m, options: finalOptions, title: m.title || prev.lastSeen?.title || 'Unknown' };
        await send(fmtResolved(resolvedPayload), 'RESOLVED');
        next.announcedResolved = true;
      }

      const isTrendingNow = trendingIds.has(m.id);
      const wasTrendingBefore = !!prev.wasTrending;
      if (isTrendingNow && !wasTrendingBefore) {
        const card = activeById.get(m.id) || trendingById.get(m.id);
        const payload = {
          ...m,
          title: m.title || card?.title || prev.lastSeen?.title || 'Unknown',
          category: card?.category ?? m.category,
          options: (card?.options?.length ? card.options :
                    prev.lastSeen?.options?.length ? prev.lastSeen.options :
                    m.options) || []
        };
        await send(fmtTrending(payload), 'TRENDING');
      }
      next.wasTrending = isTrendingNow;

      next.lastStatus = m.status;
      state.markets[m.id] = next;
    }

    saveState(state);
    console.log('[tick] done', summarizeState(state));
  } catch (e) {
    console.error('tick error:', e.message);
  }
}

// ----------------- COMMANDS -----------------
bot.command('ping', (ctx) => ctx.reply('pong 🏓'));

bot.command('health', async (ctx) => {
  try {
    const { trending, active } = await fetchMarketsFromSections({ debug: true });

    const aSample = await Promise.all(
      active.slice(0,2).map(async (c) => {
        const d = await scrapeMarketDetail(c.url, { debug: false });
        return (d?.title || '(no title)').toUpperCase();
      })
    );
    const tSample = await Promise.all(
      trending.slice(0,2).map(async (c) => {
        const d = await scrapeMarketDetail(c.url, { debug: false });
        return (d?.title || '(no title)').toUpperCase();
      })
    );

    await ctx.reply(
      `Active: ${active.length}  |  Trending: ${trending.length}\n` +
      `Active sample: ${aSample.join(' | ') || '—'}\n` +
      `Trending sample: ${tSample.join(' | ') || '—'}`
    );
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

bot.command('announce_open_now', async (ctx) => {
  const parts = (ctx.message.text || '').trim().split(/\s+/);
  const limit = Math.max(1, Math.min(parseInt(parts[1] || '3', 10) || 3, 20));

  const { active } = await fetchMarketsFromSections({ debug: false });
  let count = 0;
  for (const card of active.slice(0, limit)) {
    const detail = await scrapeMarketDetail(card.url, { debug: dbg });
    const merged = {
      ...card,
      id: card.id || detail?.id,
      url: detail?.url || card.url,
      title: (detail?.title || 'Unknown').toUpperCase(),
      options: (card.options?.length ? card.options : detail?.options || [])
    };
    await send(fmtNewMarket(merged), 'OPEN(TEST)');
    const st = loadState();
    st.markets[merged.id] = {
      ...(st.markets[merged.id] || {}),
      announcedOpen: true,
      lastStatus: 'open',
      url: merged.url,
      missingCount: 0,
      wasTrending: false,
      lastSeen: { title: merged.title, category: merged.category, endsIn: merged.endsIn, options: merged.options }
    };
    saveState(st);
    count++;
  }
  await ctx.reply(`Announced ${count} open market(s) to target chat.`);
});

// Manual tick trigger
bot.command('tick_now', async (ctx) => {
  try {
    await ctx.reply('Tick started…');
    await tick();
    await ctx.reply('Tick finished.');
  } catch (e) {
    await ctx.reply(`Tick error: ${e.message || e}`);
  }
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
      { command: 'health', description: 'Active/Trending counts (titles from details)' },
      { command: 'whereami', description: 'Show current & target chat' },
      { command: 'set_target', description: 'Set target chat id or "here"' },
      { command: 'announce_open_now', description: 'Announce N open markets now (from Active)' },
      { command: 'tick_now', description: 'Run a tick immediately' },
      { command: 'state', description: 'Show tracked/announced counts' },
    ]);
  } catch {}
  const interval = Math.max(5, parseInt(POLL_INTERVAL_SECONDS, 10) || 30);
  console.log(`[cron] scheduling tick every ${interval}s (TZ=${TZ})`);

  // immediate tick
  tick();

  // node-cron schedule (seconds field enabled)
  const expr = `*/${interval} * * * * *`;
  cron.schedule(expr, () => {
    console.log(`[cron] tick firing @ ${new Date().toISOString()} via node-cron (${expr})`);
    tick();
  }, { timezone: TZ });

  // fallback safety: setInterval (in case cron is blocked in the env)
  setInterval(() => {
    console.log(`[cron-fallback] tick firing @ ${new Date().toISOString()} every ${interval}s`);
    tick();
  }, interval * 1000);
});

// ----------------- TINY HTTP SERVER -----------------
const server = http.createServer(async (req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const st = loadState();
    const sum = summarizeState(st);
    res.end(JSON.stringify({ ok: true, ...sum, now: new Date().toISOString() }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Auracle Telegram bot is running.\n');
});
server.listen(PORT, () => console.log(`[http] listening on :${PORT}`));

// ----------------- GRACEFUL SHUTDOWN -----------------
process.once('SIGINT', async () => { try { if (browser) await browser.close(); } catch {} bot.stop('SIGINT'); server.close(); });
process.once('SIGTERM', async () => { try { if (browser) await browser.close(); } catch {} bot.stop('SIGTERM'); server.close(); });
