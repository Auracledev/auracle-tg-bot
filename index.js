/**  AURACLE TELEGRAM BOT — FINAL BUILD w/ EMOJIS ✅ **/

import 'dotenv/config';
import * as fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Telegraf } from 'telegraf';
import puppeteer from 'puppeteer';
import http from 'http';

/****************************
 ENV + PATHS
*****************************/
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

if (!TELEGRAM_BOT_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

const dbg = !!DEBUG;

/****************************
 TELEGRAM INIT
*****************************/
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

/****************************
 STATE FILE
*****************************/
const STATE_DIR = path.resolve(DATA_DIR);
const STATE_FILE = path.join(STATE_DIR, 'state.json');

if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
if (!fs.existsSync(STATE_FILE)) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ markets: {}, seeded: false }, null, 2));
}

const loadState = () => {
  try { return JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); }
  catch { return { markets: {}, seeded:false }; }
};
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s,null,2));

const getTargetChatId = () => loadState().targetChatId || TELEGRAM_CHAT_ID;
const setTargetChatId = (id) => { const st=loadState(); st.targetChatId=id; saveState(st); return id; };

/****************************
 UTILS
*****************************/
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

function escapeHtml(s=''){
  return s
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

function humanizeEta(targetMs, nowMs = Date.now()){
  if(!Number.isFinite(targetMs))return'';
  let diff=Math.max(0,Math.floor((targetMs-nowMs)/1000));
  const min=Math.floor(diff/60), hr=Math.floor(min/60),day=Math.floor(hr/24);
  if(day>=2) return `in about ${day} days`;
  if(day===1) return `in about 1 day`;
  if(hr>=2) return `in about ${hr} hours`;
  if(hr===1) return `in about 1 hour`;
  if(min>=2) return `in about ${min} minutes`;
  if(min===1) return `in about 1 minute`;
  return 'in about moments';
}

/****************************
 EMOJI DETECTOR 🎯
*****************************/
function detectEmoji(title='', category='') {
  const t=(title||'').toLowerCase();
  const c=(category||'').toLowerCase();

  if(/(fc|united|city|madrid|barcelona|dortmund|liverpool|arsenal|juventus|serie a|bundesliga|premier|la liga)/.test(t)) return '⚽';
  if(/nba|lakers|celtics|bulls|warriors|76ers|spurs/.test(t)) return '🏀';
  if(/nfl|patriots|chiefs|eagles|cowboys|steelers/.test(t)) return '🏈';
  if(/mlb|dodgers|yankees|mets|blue jays/.test(t)) return '⚾';
  if(/nhl|bruins|rangers|penguins/.test(t)) return '🏒';
  if(/ufc|fight|mma|ko|tk o|octagon/.test(t)) return '🥊';
  if(/btc|eth|sol|crypto|token|coin/.test(t)) return '₿';
  if(/csgo|valorant|league of legends|esports|gaming/.test(t)) return '🎮';
  return '🎯';
}

/****************************
 PUPPETEER
*****************************/
let browser=null;

async function getBrowser(){
  if(browser) return browser;
  browser = await puppeteer.launch({
    headless:'new',
    args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
  });
  return browser;
}

async function newPage(){
  const b = await getBrowser();
  const p = await b.newPage();
  await p.setUserAgent('Mozilla/5.0 AuracleBot/1.0');
  return p;
}

async function autoScroll(page){
  await page.evaluate(async()=>{
    await new Promise(resolve=>{
      let total=0;
      const dist=800;
      const t=setInterval(()=>{
        window.scrollBy(0,dist);
        total+=dist;
        if(total>20000){clearInterval(t);resolve();}
      },250);
    });
  });
}

/****************************
 LIST SCRAPER (Active / Trending)
*****************************/
async function fetchMarketsFromSections(){
  const base=AURACLE_BASE_URL.replace(/\/+$/,'');
  const urls=[`${base}/Markets?ts=${Date.now()}`,`${base}/markets?ts=${Date.now()}`];

  for(const url of urls){
    try{
      const p=await newPage();
      await p.goto(url,{waitUntil:'networkidle2',timeout:60000});
      await autoScroll(p);

      const data = await p.evaluate(()=>{
        const text = el=> (el?.textContent||'').trim();

        const nodes=Array.from(document.querySelectorAll('a[href*="MarketDetails?id"]'));
        const list={active:[],trending:[]};

        function isTrendingCard(el){
          return /#\s*\d+\s*HOT/.test(el.innerText.toUpperCase());
        }

        for(const a of nodes){
          const url=a.href;
          const id = new URL(url).searchParams.get('id');
          if(!id) continue;

          const card=a.closest('article,div')||a.parentElement;
          const category = text(card?.querySelector('.badge,.chip,.category'));
          const options=[];
          const rows=Array.from(card?.querySelectorAll('.option,.side,[data-option]')||[]);
          for(const r of rows){
            const lbl=text(r?.querySelector('.label,.team,.option-label'));
            const p=r?.querySelector('.percent,.percentage'); 
            if(lbl&&p){
              const pct=parseInt(p.textContent.replace('%',''));
              if(Number.isFinite(pct)) options.push({label:lbl,pct});
            }
          }

          const entry={id,url,title:'',category,options,status:'open'};
          if(isTrendingCard(card)) list.trending.push(entry);
          else list.active.push(entry);
        }
        return list;
      });

      await p.close();
      return data;
    }catch{}
  }
  return {active:[],trending:[]};
}

/****************************
 DETAIL SCRAPER
*****************************/
async function scrapeMarketDetail(url){
  const p=await newPage();
  await p.goto(url,{waitUntil:'networkidle2',timeout:60000});
  await autoScroll(p);

  const d = await p.evaluate(()=>{
    const text=el=>(el?.textContent||'').trim();
    const up=s=>(s||'').toUpperCase();
    const pageRaw=(document.body?.innerText||'');

    // title
    let title='';
    const og=document.querySelector('meta[property="og:title"]')?.content;
    if(og) title=og.trim();
    if(!title){
      const h=document.querySelector('h1,h2,.title');
      title=text(h);
    }

    // winner / status
    const upTxt=up(pageRaw);
    let status='open';
    let winner=null;
    if(upTxt.includes('ORACLE CLOSED')) status='closed';
    const m=pageRaw.match(/ORACLE RESOLVED:\s*(.+)$/mi);
    if(m){ status='resolved'; winner=m[1].trim(); }

    // options extraction: try multiple heuristics
    const getPct=node=>{
      if(!node) return null;
      const s=(node.textContent||'').replace('%','').replace(/[^\d.]/g,'');
      const n=parseFloat(s);
      return Number.isFinite(n)?Math.round(n):null;
    };

    const options=[];

    // live rows
    const rows=document.querySelectorAll('.option,.side,[data-option]');
    for(const r of rows){
      const lbl=text(r.querySelector('.label,.team,.option-label,span,strong'));
      const pct=getPct(r.querySelector('.percent,.percentage'));
      if(lbl&&pct!=null) options.push({label:lbl,pct});
    }

    // fallback CURRENT blocks when closed
    const rawNodes=Array.from(document.querySelectorAll('*'));
    for(const el of rawNodes){
      const t=el.textContent.toUpperCase();
      const m=t.match(/CURRENT\s+(.+?)\s+(\d+)\s*%/);
      if(m){
        const pct=parseInt(m[2]);
        if(Number.isFinite(pct)) options.push({label:m[1].trim(),pct});
      }
    }

    // fallback IMPLIED
    for(const el of rawNodes){
      const t=(el.textContent||'');
      const m=t.match(/^(.+?)\s+IMPLIED.*?(\d+)\s*%/i);
      if(m){
        const pct=parseInt(m[2]);
        if(Number.isFinite(pct)) options.push({label:m[1].trim(),pct});
      }
    }

    // dedupe
    const seen=new Set();
    const finalOpts=[];
    for(const o of options){
      const k=o.label+'_'+o.pct;
      if(!seen.has(k)){finalOpts.push(o); seen.add(k);}
      if(finalOpts.length>=3) break;
    }

    // close time
    let closeISO='', closeText='';
    const body=pageRaw.replace(/\s+/g,' ');
    const dt=body.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s*\d{4}\s+at\s+\d{1,2}:\d{2}\s*(AM|PM)/i);
    if(dt){
      const d=new Date(dt[0]);
      if(!isNaN(d.getTime())){closeISO=d.toISOString(); closeText=dt[0];}
    }

    const id = new URL(location.href).searchParams.get('id');

    return {id,url:location.href,title,status,winner,options:finalOpts,closeISO,closeText};
  });

  await p.close();
  return d;
}

/****************************
 MESSAGE TEMPLATES
*****************************/
function fmtNew(m){
  const emoji=detectEmoji(m.title,m.category);
  const lines=(m.options||[]).slice(0,3).map(o=>`• ${escapeHtml(o.label)} — <b>${o.pct}%</b>`).join('\n');
  return `🔥 <b>New Market Live</b>\n${emoji} <b>${escapeHtml(m.title)}</b>\n⏳ ${escapeHtml(m.endsIn||'Soon')}\n${lines}\n🔗 ${m.url}`;
}

function fmtClosed(m){
  const list=(m.options||[]).map(o=>`${escapeHtml(o.label)} ${o.pct}%`).join(' - ')||'—';
  const emoji=detectEmoji(m.title,m.category);
  return `🛑 <b>Market Closed — Final Pool</b>\n${emoji} <b>${escapeHtml(m.title)}</b>\n📊 ${list}\n👀 Awaiting resolution…\n🔗 ${m.url}`;
}

function fmtResolved(m){
  const list=(m.options||[]).map(o=>`${escapeHtml(o.label)}: <b>${o.pct}%</b>`).join(' | ')||'—';
  const emoji=detectEmoji(m.title,m.category);
  return `✅ <b>Market Resolved</b>\n${emoji} <b>${escapeHtml(m.title)}</b>\n🏆 Winner: <b>${escapeHtml(m.winner)}</b>\n📊 Final: ${list}\n💰 Rewards live on Auracle\n🔗 ${m.url}`;
}

/****************************
 SEND TO TELEGRAM
*****************************/
async function send(msg){
  const chatId=getTargetChatId();
  try{
    await bot.telegram.sendMessage(chatId,msg,{parse_mode:'HTML',disable_web_page_preview:true});
  }catch(e){console.error('send error',e.response?.description||e.message);}
}

/****************************
 MAIN TICK
*****************************/
async function tick(){
  console.log('[tick]',new Date().toISOString());

  const {active,trending}=await fetchMarketsFromSections();
  const activeIds=new Set(active.map(m=>m.id));
  const trendingIds=new Set(trending.map(m=>m.id));

  let state=loadState();
  const knownIds=new Set(Object.keys(state.markets));

  const toWatch=new Set([...activeIds,...trendingIds,...knownIds]);
  for(const id of [...toWatch]) if(state.markets[id]?.retired) toWatch.delete(id);

  const base=AURACLE_BASE_URL.replace(/\/+$/,'');
  const results=[];
  for(const id of toWatch){
    const rec=state.markets[id];
    const card=active.find(x=>x.id===id)||trending.find(x=>x.id===id);
    const url=rec?.url || card?.url || `${base}/MarketDetails?id=${id}`;

    const detail=await scrapeMarketDetail(url);
    if(!detail) continue;

    if(detail.status==='open'){
      if(detail.closeISO){
        const ms=Date.parse(detail.closeISO);
        if(Number.isFinite(ms)) detail.endsIn=humanizeEta(ms);
      } else if(card?.endsIn) detail.endsIn=card.endsIn;
      detail.category=card?.category||detail.category;
      if(card?.options?.length>=2) detail.options=card.options;
    }

    results.push(detail);
  }

  if(!state.seeded && results.length){
    for(const m of results){
      state.markets[m.id]={
        announcedOpen:false,announcedClosed:false,announcedResolved:false,
        lastStatus:m.status,url:m.url,retired:m.status==='resolved',
        lastSeen:{title:m.title,category:m.category,endsIn:m.endsIn,options:m.options},
        closedSnapshot:m.status==='closed'?{options:m.options}:null
      };
    }
    state.seeded=true;
    saveState(state);
    return;
  }

  for(const m of results){
    const prev=state.markets[m.id]||{};
    const next={...prev,url:m.url,retired:prev.retired||false};

    if(prev.retired){ state.markets[m.id]=next; continue; }

    if(m.status==='open'){
      next.lastSeen={title:m.title,category:m.category,endsIn:m.endsIn,options:m.options};
    }

    if(m.status==='closed' && !next.closedSnapshot){
      next.closedSnapshot={options:(prev.lastSeen?.options?.length?prev.lastSeen.options:m.options)||[]};
    }

    // OPEN announcement
    if(m.status==='open' && !prev.announcedOpen){
      await send(fmtNew({...m,options:(m.options?.length?m.options:prev.lastSeen?.options)}));
      next.announcedOpen=true;
    }

    // CLOSED announcement
    if(m.status==='closed' && !prev.announcedClosed && prev.lastStatus!=='closed'){
      const closedOpts=(next.closedSnapshot?.options?.length && next.closedSnapshot.options)
        || (prev.lastSeen?.options?.length && prev.lastSeen.options)
        || (m.options?.length && m.options) || [];
      await send(fmtClosed({...m,options:closedOpts}));
      next.announcedClosed=true;
    }

    // RESOLVED announcement + YES/NO → real team fix
    if(m.status==='resolved' && !prev.announcedResolved){
      const finalOpts=(next.closedSnapshot?.options?.length && next.closedSnapshot.options)
        || (prev.lastSeen?.options?.length && prev.lastSeen.options)
        || (m.options?.length && m.options) || [];

      let winName = m.winner;
      const lower=String(winName||'').toLowerCase();
      if(lower.includes('yes') && finalOpts[0]?.label) winName=finalOpts[0].label;
      if(lower.includes('no')  && finalOpts[1]?.label) winName=finalOpts[1].label;

      await send(fmtResolved({...m,winner:winName,options:finalOpts}));
      next.announcedResolved=true;
      next.retired=true;
    }

    next.lastStatus=m.status;
    state.markets[m.id]=next;
  }

  // state prune
  const ids=Object.keys(state.markets);
  if(ids.length>2000){
    for(const id of ids){
      if(state.markets[id]?.retired) delete state.markets[id];
    }
  }

  saveState(state);
}

/****************************
 COMMANDS
*****************************/
bot.command('ping',ctx=>ctx.reply('pong ✅'));
bot.command('tick_now',async(ctx)=>{await ctx.reply('manual tick…');await tick();await ctx.reply('done ✅');});
bot.command('whereami',ctx=>ctx.reply(`Target: ${getTargetChatId()}\nHere: ${ctx.chat.id}\n/set_target here`));
bot.command('set_target',(ctx)=>{
  const [,arg]=ctx.message.text.split(' ');
  if(!arg) return ctx.reply('Usage: /set_target <chatId|here>');
  const id=(arg==='here')?ctx.chat.id:arg;
  setTargetChatId(id);
  ctx.reply(`✅ Set target to ${id}`);
});

/****************************
 LOOP + SERVER
*****************************/
setInterval(()=>console.log(`[hb] ${new Date().toISOString()}`),10000);

async function loopTick(){
  await tick();
  setTimeout(loopTick,Math.max(5,parseInt(POLL_INTERVAL_SECONDS))*1000);
}
loopTick();

const server=http.createServer((req,res)=>{
  if(req.url==='/status'){
    res.writeHead(200,{'Content-Type':'application/json'});
    return res.end(JSON.stringify({ok:true,ts:new Date().toISOString()}));
  }
  res.end('Auracle bot running ✅');
});
server.listen(PORT,()=>console.log(`[HTTP] :${PORT}`));

bot.launch();
