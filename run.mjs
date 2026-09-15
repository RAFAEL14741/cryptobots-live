// run.mjs — the cloud "brain" for the bots. GitHub Actions runs this file on a schedule (see
// .github/workflows/run-bots.yml). Each invocation is a fresh Node process: it reads state.json (balances,
// positions, trade history, last-seen bar per bot) from the repo, fetches real closed candles, runs the same
// strategy logic as the browser app (engine.mjs, unmodified), updates state.json + log.json, and exits.
// The workflow then commits+pushes those two files back to the repo.
//
// No live trading exists here, same as the browser app: modes are "signal" (log-only, "your call") and
// "paper" (fake-money auto-execute). There is no code path in this file that can move real money.
//
// ---------------------------------------------------------------------------------------------------------
// Accuracy rules this file follows on purpose (they are what make the numbers trustworthy, so don't "simplify"
// them away):
//
// 1. NO TIME-TRAVEL FILLS. A cron tick every 5 minutes means a 1-minute bot can wake up with several bars
//    already closed. Filling an entry at the close of a bar that passed 4 minutes ago would book a price this
//    bot could never actually have gotten — that's fabricated profit. So: entries are only taken from the
//    NEWEST closed bar and filled at the current price. Entry signals on bars we slept through are counted and
//    reported ("3 entries missed while not looking"), never quietly taken.
// 2. EXITS ARE DIFFERENT, ON PURPOSE. A stop-loss/take-profit is a resting order — it really would have
//    filled at its level while we were away, so those replay against the historical bars. A strategy exit
//    (e.g. "MA crossed back down") found on a bar we slept through IS honored, but filled at the CURRENT
//    price, because that's what a late-but-real exit looks like. Missing an exit entirely would be worse.
// 3. SENTIMENT DOES NOT GATE TRADES BY DEFAULT. Every bot's params were grid-searched and validated on real
//    history with sentiment OFF. Letting a Reddit/news score block entries live would mean running a
//    configuration that was never validated. So sentiment is computed and displayed, but not allowed to
//    block or force a trade unless sentiment_gates_trades is turned on in config.json.
// ---------------------------------------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync } from "fs";
import { MABreak, Scalper, PaperBroker, RiskManager, ExposureRegistry, SentimentEngine, TIMEFRAME_MS, ema, sma } from "./engine.mjs";

const STRATEGIES = { ma_break: MABreak, scalper: Scalper };
const money = x => (x < 0 ? "-$" : "$") + Math.abs(x).toFixed(2);
const fmt = (x, d = 6) => x == null ? "—" : (+x).toPrecision(d);

const config = JSON.parse(readFileSync(new URL("./config.json", import.meta.url)));
const STATE_PATH = new URL("./state.json", import.meta.url);
const LOG_PATH = new URL("./log.json", import.meta.url);
const saved = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH)) : {};
let logLines = existsSync(LOG_PATH) ? JSON.parse(readFileSync(LOG_PATH)) : [];
// Carried between runs so a condition that doesn't change (e.g. "Reddit blocks this server") is logged once
// when it starts and once when it clears — not 288 times a day, which would bury every real trade.
const meta = saved.__meta || { feeds: {}, source: {} };
const nextMeta = { feeds: {}, source: {} };

function log(level, title, body) { logLines.push({ ts: Date.now(), level, title, body: body || "" }); }
// Only log a recurring condition when it CHANGES state. Returns true if it logged.
function logOnChange(key, status, level, title, body) {
  nextMeta.feeds[key] = status;
  if (meta.feeds?.[key] === status) return false;
  log(level, title, body); return true;
}

// ---------- data: real market candles, no synthetic/fabricated data anywhere ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchBinance(symbol, tf, limit) {
  let out = [], remaining = limit, cursor = null;
  while (remaining > 0) {
    const n = Math.min(1000, remaining), u = new URL("https://api.binance.us/api/v3/klines");
    u.searchParams.set("symbol", symbol); u.searchParams.set("interval", tf); u.searchParams.set("limit", n); if (cursor) u.searchParams.set("endTime", cursor);
    const r = await fetch(u); if (!r.ok) throw new Error(`binance ${r.status}`);
    const rows = await r.json(); if (!rows.length) break;
    const page = rows.map(k => ({ ts: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
    out = page.concat(out); remaining -= page.length; cursor = page[0].ts - 1; if (page.length < n) break;
  }
  return out;
}

// Backup data source. Binance blocks plenty of datacenter IP ranges, and GitHub's runners are datacenter IPs —
// if that ever happens the bots would otherwise just stop dead. Kraken's public OHLC endpoint needs no key,
// covers every timeframe these bots use, and returns up to 720 candles. Prices are USD rather than USDT, so
// they differ from Binance by a hair (well inside the 0.05% slippage these bots already assume) — which is why
// the source used is recorded in state.json and shown on the dashboard instead of being hidden.
const KRAKEN_PAIR = { BTCUSDT: "XBTUSD", ETHUSDT: "ETHUSD", SOLUSDT: "SOLUSD", DOGEUSDT: "XDGUSD", ADAUSDT: "ADAUSD", XRPUSDT: "XRPUSD", LTCUSDT: "LTCUSD", AVAXUSDT: "AVAXUSD" };
const KRAKEN_INTERVAL = { "1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "1d": 1440 };
async function fetchKraken(symbol, tf, limit) {
  const pair = KRAKEN_PAIR[symbol], interval = KRAKEN_INTERVAL[tf];
  if (!pair || !interval) throw new Error(`kraken: no mapping for ${symbol} ${tf}`);
  const u = new URL("https://api.kraken.com/0/public/OHLC");
  u.searchParams.set("pair", pair); u.searchParams.set("interval", String(interval));
  const r = await fetch(u); if (!r.ok) throw new Error(`kraken ${r.status}`);
  const j = await r.json();
  if (j.error?.length) throw new Error(`kraken: ${j.error.join(", ")}`);
  const key = Object.keys(j.result || {}).find(k => k !== "last");
  if (!key) throw new Error("kraken: empty result");
  // [time(sec), open, high, low, close, vwap, volume, count]
  return j.result[key].map(k => ({ ts: k[0] * 1000, open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[6] })).slice(-limit);
}

// Unlike the browser (one long-lived tab, worth caching bars between polls), each cron tick is a fresh
// process — so fetch the bot's full lookback window fresh every run. Simpler, and always correct.
async function getBars(symbol, tf, lookback) {
  const want = lookback + 5, ms = TIMEFRAME_MS[tf], now = Date.now();
  const closedOnly = bars => bars.filter(b => b.ts + ms <= now);
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {            // one retry: transient 5xx/429 are common
    try {
      const bars = closedOnly(await fetchBinance(symbol, tf, want));
      if (bars.length) return { bars, source: "binance.us" };
      lastErr = new Error("binance returned no closed bars");
    } catch (e) { lastErr = e; }
    if (attempt === 0) await sleep(1500);
  }
  try {
    const bars = closedOnly(await fetchKraken(symbol, tf, want));
    if (bars.length) return { bars, source: "kraken" };
    lastErr = new Error("kraken returned no closed bars");
  } catch (e) { lastErr = new Error(`${lastErr?.message || lastErr}; kraken fallback also failed: ${e.message || e}`); }
  throw lastErr;
}

// ---------- sentiment text: Reddit + RSS. Running server-side removes the CORS blocks the browser hit. ----------
const seenText = new Set(); let textItems = [];
async function fetchReddit(sub) {
  const r = await fetch(`https://www.reddit.com/r/${sub}/new.json?limit=100&raw_json=1`, { headers: { "Accept": "application/json", "User-Agent": "cryptobots-cloud/1.0 (paper trading research)" } });
  if (!r.ok) throw new Error(`reddit ${r.status}`);
  const j = await r.json();
  return (j.data?.children || []).map(c => c.data).map(d => ({ text: `${d.title || ""}. ${(d.selftext || "").slice(0, 400)}`.replace(/^\. |\. $/g, ""), ts: Math.floor((d.created_utc || Date.now() / 1000) * 1000), source: `reddit:r/${sub}`, url: "https://www.reddit.com" + (d.permalink || ""), weight: Math.sqrt(Math.max(1, Math.min(+d.score || 1, 50))) }));
}
// Minimal, dependency-free RSS/Atom item extractor (Node has no DOMParser). Enough for the simple feeds in
// config.json — not a full XML parser, and doesn't need to be for title/description/link/date.
function parseRss(xml, src) {
  const items = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map(m => m[0]);
  const grab = (block, tag) => { const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i")); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : ""; };
  return items.map(block => {
    const title = grab(block, "title"), body = (grab(block, "description") || grab(block, "summary") || grab(block, "content")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
    const d = grab(block, "pubDate") || grab(block, "published") || grab(block, "updated"), ts = d ? Date.parse(d) || Date.now() : Date.now();
    const linkTag = block.match(/<link[^>]*href="([^"]+)"/i); const link = linkTag ? linkTag[1] : grab(block, "link");
    return title || body ? { text: body ? `${title}. ${body}` : title, ts, source: src, url: link, weight: 1 } : null;
  }).filter(Boolean);
}
async function fetchRss(url) {
  const r = await fetch(url, { headers: { "User-Agent": "cryptobots-cloud/1.0" } }); if (!r.ok) throw new Error(`rss ${r.status}`);
  return parseRss(await r.text(), "rss:" + url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]);
}
async function refreshText() {
  const subs = [...new Set(config.bots.filter(b => b.sentiment?.enabled).flatMap(b => b.sentiment.subreddits || []))];
  let added = 0, sources = 0;
  const push = it => { const k = it.url || it.text.slice(0, 120); if (!seenText.has(k)) { seenText.add(k); textItems.push(it); added++; } };
  for (const s of subs) {
    try { (await fetchReddit(s)).forEach(push); sources++; logOnChange(`reddit:${s}`, "ok", "info", `reddit r/${s} reachable again`, ""); }
    catch (e) { logOnChange(`reddit:${s}`, String(e.message || e), "info", `reddit r/${s} unavailable from this server`, `${e.message || e} — Reddit blocks most datacenter IPs. Sentiment is display-only, so this does not block any trade. Logged once, not every cycle.`); }
  }
  for (const u of config.news_feeds || []) {
    try { (await fetchRss(u)).forEach(push); sources++; logOnChange(`rss:${u}`, "ok", "info", "news feed reachable again", u); }
    catch (e) { logOnChange(`rss:${u}`, String(e.message || e), "info", "news feed unavailable", `${u}: ${e.message || e} — logged once, not every cycle.`); }
  }
  const cutoff = Date.now() - 48 * 36e5; textItems = textItems.filter(it => it.ts >= cutoff);
  return { added, sources };
}

// ---------- bots ----------
const registry = new ExposureRegistry();
const GATES = config.sentiment_gates_trades === true; // default: sentiment is display-only (see header note 3)
function makeBot(cfg) {
  const st = saved[cfg.name] || {};
  const StratClass = STRATEGIES[cfg.strategy] || MABreak;
  const b = {
    cfg, strategy: new StratClass(cfg.params),
    broker: new PaperBroker(cfg.broker?.starting_cash ?? 10000, cfg.broker?.fee_pct ?? 0.10, cfg.broker?.slippage_pct ?? 0.05),
    risk: new RiskManager(cfg.risk, registry),
    // one engine per bot: two bots on the same symbol with different sentiment windows would otherwise
    // pollute each other's attention history and produce a meaningless z-score for both
    sentiment: new SentimentEngine(),
    lastBarTs: st.lastBarTs || 0, last: st.last || {}, explain: st.explain || null, lastSignal: st.lastSignal || null,
    source: st.source || null, missed: 0, snap: null,
  };
  if (st.broker) { b.broker.cash = st.broker.cash; b.broker.starting_cash = st.broker.starting_cash; b.broker.positions = st.broker.positions || {}; b.broker.trades = st.broker.trades || []; }
  if (st.risk) { b.risk.daily = st.risk.daily || {}; b.risk.cooldownUntil = st.risk.cooldownUntil || 0; }
  if (st.attention) b.sentiment.attention.h[cfg.symbol] = st.attention;
  return b;
}
const bots = config.bots.map(makeBot);

function persist(cycleTs) {
  const out = { __meta: { ...nextMeta, lastCycleTs: cycleTs, sentiment_gates_trades: GATES } };
  for (const b of bots) out[b.cfg.name] = {
    lastBarTs: b.lastBarTs, last: b.last, explain: b.explain, lastSignal: b.lastSignal, source: b.source, missedEntries: b.missed,
    sentiment: b.snap ? { polarity: b.snap.polarity, n_mentions: b.snap.n_mentions, attention_z: b.snap.attention_z, risk_flag: b.snap.risk_flag, risk_reasons: b.snap.risk_reasons } : null,
    broker: { cash: b.broker.cash, starting_cash: b.broker.starting_cash, positions: b.broker.positions, trades: b.broker.trades.slice(-200) },
    risk: { daily: b.risk.daily, cooldownUntil: b.risk.cooldownUntil },
    attention: (b.sentiment.attention.h[b.cfg.symbol] || []).slice(-96),
  };
  writeFileSync(STATE_PATH, JSON.stringify(out, null, 2));
  // Trim so routine info lines can never evict the things worth reading. Trades/signals/alerts are the record
  // of what the bots actually did; info is just chatter about feeds.
  const important = logLines.filter(l => l.level !== "info").slice(-250);
  const chatter = logLines.filter(l => l.level === "info").slice(-50);
  writeFileSync(LOG_PATH, JSON.stringify([...important, ...chatter].sort((a, b) => a.ts - b.ts), null, 2));
}

const ctxFor = (b, cfg, sc) => ({
  position: b.broker.position(cfg.symbol), sentiment: b.snap,
  sentiment_enabled: GATES && !!sc.enabled,          // display-only unless explicitly turned into a gate
  min_polarity: sc.min_polarity ?? -0.2, min_attention_z: sc.min_attention_z ?? -1.0,
  block_on_risk_flag: GATES && sc.block_on_risk_flag !== false,
});

async function stepBot(b, nowMs) {
  const cfg = b.cfg, sc = cfg.sentiment || {};
  let bars, source;
  try { ({ bars, source } = await getBars(cfg.symbol, cfg.timeframe, cfg.lookback_bars || 300)); }
  catch (e) { logOnChange(`data:${cfg.name}`, String(e.message || e), "alert", `[${cfg.name}] no market data`, `${e.message || e} — both Binance.US and the Kraken fallback failed. This bot did nothing this cycle; balances are untouched.`); return; }
  logOnChange(`data:${cfg.name}`, `ok:${source}`, "info", `[${cfg.name}] data source: ${source}`, source === "kraken" ? "Binance.US wasn't reachable from this server, so prices came from Kraken (USD rather than USDT — a few hundredths of a percent apart)." : "");
  b.source = source;
  nextMeta.source[cfg.name] = source;
  if (!bars.length) { log("alert", `[${cfg.name}] no bars`, "data source returned nothing"); return; }

  const last = bars[bars.length - 1], price = last.close, barMs = TIMEFRAME_MS[cfg.timeframe];
  const closes = bars.map(x => x.close);
  if (cfg.strategy === "scalper") b.last = { price, ts: last.ts, fast: price, slow: ema(closes, +cfg.params.ema_len).at(-1), label: `vs EMA${cfg.params.ema_len}`, aboveNote: "price above EMA", belowNote: "price below EMA" };
  else { const f = cfg.params.ma_type === "ema" ? ema : sma; b.last = { price, ts: last.ts, fast: f(closes, +cfg.params.fast).at(-1), slow: f(closes, +cfg.params.slow).at(-1), label: "MA gap", aboveNote: "fast above slow", belowNote: "fast below slow" }; }

  if (sc.enabled) {
    b.snap = b.sentiment.snapshot(cfg.symbol, sc.keywords || [], textItems, nowMs, (sc.window_hours || 6) * 36e5);
    const pos = b.broker.position(cfg.symbol);
    if (GATES && pos && b.snap.risk_flag && sc.block_on_risk_flag !== false) { act(b, { action: "close", reason: `risk news: ${b.snap.risk_reasons[0].slice(0, 100)}` }, price, nowMs); return; }
  }

  // Live "what am I doing right now" status — recomputed every cycle. Diagnostic-only: explain() mirrors the
  // strategy's math read-only and can never place or change a trade.
  if (b.strategy.explain) {
    try { b.explain = { ...b.strategy.explain(bars, ctxFor(b, cfg, sc)), ts: nowMs }; }
    catch (e) { b.explain = { state: "watching", text: "(status unavailable: " + (e.message || e) + ")", ts: nowMs }; }
  }

  if (last.ts === b.lastBarTs) return;
  const newBars = b.lastBarTs ? bars.filter(x => x.ts > b.lastBarTs) : [last];
  let missedEntries = 0;

  for (const nb of newBars) {
    // Resting stop-loss / take-profit orders: these really would have filled at their level while we were
    // away, so they replay against the historical bar. This is the one place historical prices are correct.
    const tr = b.broker.onBar(cfg.symbol, nb);
    if (tr) { b.risk.recordTrade(tr, barMs); log("trade", `[${cfg.name}] ${tr.exit_reason} hit`, `${cfg.symbol} pnl ${money(tr.pnl)} (${tr.pnl_pct.toFixed(2)}%)`); }
    b.lastBarTs = nb.ts;
    if (nb === last) break; // newest bar gets full handling below, against the live price

    // A bar we slept through. Exits are honored (late but real, filled at the current price). Entries are
    // NOT — taking one would mean booking a price that had already passed. They're counted and reported.
    const sig = b.strategy.onBar(bars.slice(0, bars.indexOf(nb) + 1), ctxFor(b, cfg, sc));
    if (!sig) continue;
    if (sig.action === "close" && b.broker.position(cfg.symbol)) act(b, sig, price, nowMs, nb.ts);
    else if (sig.action === "buy") missedEntries++;
  }

  const sig = b.strategy.onBar(bars, ctxFor(b, cfg, sc));
  if (sig) act(b, sig, price, nowMs);

  if (missedEntries) {
    b.missed = (b.missed || 0) + missedEntries;
    log("alert", `[${cfg.name}] ${missedEntries} entry signal(s) missed between checks`,
      `${missedEntries} buy signal(s) fired on ${cfg.timeframe} bars that closed while this ran only every few minutes. They were NOT taken: filling them now at a price that already passed would book profit this bot could never have gotten. This is the real cost of checking on a schedule instead of continuously — running total for this bot: ${b.missed}.`);
  }
}

function act(b, sig, price, nowMs, staleBarTs = null) {
  const cfg = b.cfg, eq = b.broker.equity({ [cfg.symbol]: price }), s = b.snap;
  const sent = s ? ` | sentiment pol ${s.polarity.toFixed(2)} z ${s.attention_z.toFixed(2)} n=${s.n_mentions}${GATES ? "" : " (display only)"}` : "";
  const lateNote = staleBarTs ? `\nnote: this signal fired on the ${new Date(staleBarTs).toISOString()} bar and is being acted on now, at the current price — not at that bar's price.` : "";
  b.lastSignal = { ts: nowMs, action: sig.action, reason: sig.reason };
  if (sig.action === "skip") log("info", `[${cfg.name}] setup skipped`, `${cfg.symbol} @ ${fmt(price)} — ${sig.reason}${sent}`);
  else if (sig.action === "update_stop") { const pos = b.broker.position(cfg.symbol); if (pos && sig.stop_loss != null) { if (cfg.mode === "paper") { pos.stop_loss = sig.stop_loss; log("info", `[${cfg.name}] stop moved`, sig.reason); } else log("signal", `[${cfg.name}] MOVE STOP (your call)`, sig.reason); } }
  else if (sig.action === "buy") {
    const [ok, why] = b.risk.canOpen(nowMs, eq), [qty, note] = ok ? b.risk.size(eq, price, sig.stop_loss, sig.confidence) : [0, why];
    const plan = `${cfg.symbol} @ ${fmt(price)} · stop ${fmt(sig.stop_loss)} · target ${fmt(sig.take_profit)} · size ${qty.toPrecision(4)} (~${money(qty * price)})\nwhy: ${sig.reason}${sent}\nsizing: ${note}`;
    if (cfg.mode === "paper" && ok && qty > 0) { b.broker.marketBuy(cfg.symbol, qty, price, nowMs, sig.stop_loss, sig.take_profit, sig.reason); log("trade", `[${cfg.name}] PAPER BUY`, plan); }
    else if (cfg.mode === "paper") log("alert", `[${cfg.name}] buy blocked by risk`, `${plan}\nblocked: ${ok ? note : why}`);
    else log("signal", `[${cfg.name}] BUY SIGNAL (your call)`, plan);
  } else if (sig.action === "close") {
    if (cfg.mode === "paper") { const tr = b.broker.close(cfg.symbol, price, nowMs, sig.reason); if (tr) { b.risk.recordTrade(tr, TIMEFRAME_MS[cfg.timeframe]); log("trade", `[${cfg.name}] PAPER CLOSE`, `${cfg.symbol} @ ${fmt(price)} pnl ${money(tr.pnl)} (${tr.pnl_pct.toFixed(2)}%)\nwhy: ${sig.reason}${lateNote}`); } }
    else log("signal", `[${cfg.name}] EXIT SIGNAL (your call)`, `${cfg.symbol} @ ${fmt(price)} — ${sig.reason}${sent}${lateNote}`);
  }
}

async function runOnce() {
  const now = Date.now();
  let feeds = { added: 0, sources: 0 };
  try { feeds = await refreshText(); } catch (e) { log("alert", "feeds failed", String(e.message || e)); }
  for (const b of bots) {
    try { await stepBot(b, now); } catch (e) { log("alert", `[${b.cfg.name}] error`, String(e.message || e)); }
    const price = b.last.price; if (price) registry.update(b.cfg.name, b.broker.equity({ [b.cfg.symbol]: price }), b.broker.exposure({ [b.cfg.symbol]: price }));
  }
  persist(now);
  const total = bots.reduce((a, b) => a + (b.last.price ? b.broker.equity({ [b.cfg.symbol]: b.last.price }) : b.broker.cash), 0);
  const sources = [...new Set(bots.map(b => b.source).filter(Boolean))].join("+") || "none";
  console.log(`cycle done — ${bots.length} bots via ${sources}, ${feeds.sources} text feeds (+${feeds.added} items), total equity ${money(total)}, ${new Date(now).toISOString()}`);
}

await runOnce();
