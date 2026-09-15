// cryptobots browser engine — a line-for-line port of the Python engine (strategy, paper broker, risk,
// backtest, sentiment). Verified against the Python version on identical data by web/test_parity.mjs.
// No live trading exists here either: modes are "signal" and "paper" only.

export const TIMEFRAME_MS = { "1m": 6e4, "5m": 3e5, "15m": 9e5, "30m": 18e5, "1h": 36e5, "2h": 72e5, "4h": 144e5, "6h": 216e5, "12h": 432e5, "1d": 864e5 };

// ---------- indicators ----------
export function sma(v, n) { const out = new Array(v.length).fill(null); let s = 0; for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= n) s -= v[i - n]; if (i >= n - 1) out[i] = s / n; } return out; }
export function ema(v, n) { const out = new Array(v.length).fill(null); if (v.length < n) return out; const k = 2 / (n + 1); let e = v.slice(0, n).reduce((a, b) => a + b, 0) / n; out[n - 1] = e; for (let i = n; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; } return out; }
export function atr(bars, n) {
  const trs = bars.map((b, i) => i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)));
  const out = new Array(bars.length).fill(null); if (bars.length < n) return out;
  let a = trs.slice(0, n).reduce((x, y) => x + y, 0) / n; out[n - 1] = a;
  for (let i = n; i < bars.length; i++) { a = (a * (n - 1) + trs[i]) / n; out[i] = a; }
  return out;
}

// ---------- sentiment ----------
export const LEXICON = { bullish: .7, moon: .6, mooning: .7, pump: .4, pumping: .5, rally: .6, rallies: .6, surge: .6, surges: .6, soar: .6, soars: .6, breakout: .5, ath: .6, "all-time high": .7, adoption: .5, partnership: .5, upgrade: .4, listing: .5, listed: .4, buy: .3, buying: .3, long: .2, green: .3, gains: .5, profit: .4, undervalued: .5, accumulate: .4, accumulating: .4, "whales buying": .6, "etf approved": .8, approval: .5, recover: .4, recovery: .4, rebound: .5, strong: .3, "support holds": .4, hodl: .3, "diamond hands": .4, lfg: .5, wagmi: .4, "🚀": .6, "📈": .5, "💎": .3, "🔥": .3,
  bearish: -.7, dump: -.6, dumping: -.7, crash: -.8, crashes: -.8, crashing: -.8, plunge: -.7, plunges: -.7, tank: -.6, tanking: -.7, collapse: -.8, sell: -.3, selling: -.3, "sell-off": -.6, selloff: -.6, short: -.2, red: -.3, loss: -.4, losses: -.5, overvalued: -.5, bubble: -.5, fud: -.3, fear: -.4, panic: -.7, liquidation: -.6, liquidations: -.6, liquidated: -.6, rug: -.9, rugpull: -.9, "rug pull": -.9, scam: -.9, hack: -.9, hacked: -.9, exploit: -.8, exploited: -.8, delist: -.9, delisted: -.9, delisting: -.9, lawsuit: -.6, sued: -.6, ban: -.6, banned: -.6, sec: -.3, investigation: -.5, fraud: -.8, halt: -.6, halted: -.6, outage: -.5, bankrupt: -.9, bankruptcy: -.9, insolvent: -.9, ngmi: -.4, rekt: -.6, "📉": -.5, "💀": -.4, "🩸": -.5 };
export const RISK_TERMS = ["hack", "hacked", "exploit", "exploited", "rug", "rugpull", "rug pull", "delist", "delisted", "delisting", "halt", "halted", "bankrupt", "bankruptcy", "insolvent", "fraud", "lawsuit", "sec sues", "sec charges", "seized", "frozen", "outage"];
const NEGATORS = new Set(["not", "no", "never", "isn't", "isnt", "wasn't", "wasnt", "don't", "dont", "doesn't", "doesnt", "won't", "wont", "can't", "cant", "without", "hardly", "ain't", "aint"]);
const INTENS = { very: 1.3, huge: 1.3, massive: 1.4, extremely: 1.4, insane: 1.3, big: 1.2, major: 1.2, mega: 1.3, super: 1.2, totally: 1.2, absolutely: 1.3 };
const PHRASES = Object.keys(LEXICON).filter(k => k.includes(" ")).sort((a, b) => b.length - a.length);
const TOKEN_RE = /[a-z0-9\-']+|[\u{1F300}-\u{1FAFF}]/gu;
const rxEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function scoreText(text) {
  let t = text.toLowerCase(), total = 0, hits = 0;
  for (const ph of PHRASES) if (t.includes(ph)) { total += LEXICON[ph]; hits++; t = t.split(ph).join(" "); }
  const toks = t.match(TOKEN_RE) || [];
  toks.forEach((tok, i) => {
    let s = LEXICON[tok]; if (s === undefined) return;
    const win = toks.slice(Math.max(0, i - 3), i);
    if (win.some(w => NEGATORS.has(w))) s = -s * 0.8;
    for (const w of win) if (INTENS[w]) s *= INTENS[w];
    total += s; hits++;
  });
  const c = hits ? total / Math.sqrt(total * total + 4) : 0;
  return Math.max(-1, Math.min(1, c));
}
export function riskTermsIn(text) { const t = text.toLowerCase(); return RISK_TERMS.filter(term => new RegExp("\\b" + rxEsc(term) + "\\b").test(t)); }
export function mentions(items, keywords) { if (!keywords.length) return []; const re = new RegExp("\\b(" + keywords.map(k => rxEsc(k.toLowerCase())).join("|") + ")\\b"); return items.filter(it => re.test(it.text.toLowerCase())); }

export class AttentionTracker {
  constructor(history = 96) { this.h = {}; this.n = history; }
  update(symbol, count) {
    const h = this.h[symbol] || (this.h[symbol] = []); let z = 0;
    if (h.length >= 5) { const mean = h.reduce((a, b) => a + b, 0) / h.length; const sd = Math.sqrt(h.reduce((a, b) => a + (b - mean) ** 2, 0) / h.length) || Math.max(1, mean * 0.25); z = (count - mean) / sd; }
    h.push(count); if (h.length > this.n) h.shift();
    return Math.max(-5, Math.min(5, z));
  }
  seed(symbol, counts) { const h = this.h[symbol] || (this.h[symbol] = []); for (const c of counts) { h.push(c); if (h.length > this.n) h.shift(); } }
}
export class SentimentEngine {
  constructor(att) { this.attention = att || new AttentionTracker(); }
  snapshot(symbol, keywords, items, nowMs, windowMs) {
    const recent = items.filter(it => nowMs - it.ts <= windowMs), hits = mentions(recent, keywords), hl = Math.max(windowMs / 2, 1);
    let num = 0, den = 0; const scored = [], reasons = [];
    for (const it of hits) { const age = Math.max(0, nowMs - it.ts), w = (it.weight ?? 1) * Math.pow(0.5, age / hl), s = scoreText(it.text); num += w * s; den += w; scored.push([s, it]); for (const term of riskTermsIn(it.text)) reasons.push(`${term}: ${it.text.slice(0, 90)}`); }
    const z = this.attention.update(symbol, hits.length);
    scored.sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]));
    return { symbol, ts: nowMs, polarity: +(den ? num / den : 0).toFixed(4), n_mentions: hits.length, attention_z: +z.toFixed(3), risk_flag: reasons.length > 0, risk_reasons: reasons.slice(0, 5), top_items: scored.slice(0, 5).map(p => p[1]) };
  }
}

// ---------- strategy ----------
export const MA_BREAK_DEFAULTS = { fast: 7, slow: 25, ma_type: "sma", break_pct: 0.05, tp_atr: 3.0, sl_atr: 1.5, atr_len: 14, trend_filter_len: 0, trail_atr: 0 };
export function sentimentAllowsLong(ctx) {
  if (!ctx.sentiment_enabled || !ctx.sentiment) return [true, "sentiment off"];
  const s = ctx.sentiment;
  if (ctx.block_on_risk_flag && s.risk_flag) return [false, `risk flag: ${s.risk_reasons[0] || "bad news"}`];
  if (s.n_mentions > 0 && s.polarity < ctx.min_polarity) return [false, `polarity ${s.polarity.toFixed(2)} < ${ctx.min_polarity.toFixed(2)}`];
  if (s.attention_z < ctx.min_attention_z) return [false, `attention z ${s.attention_z.toFixed(2)} < ${ctx.min_attention_z.toFixed(2)}`];
  return [true, `sentiment ok (pol ${s.polarity.toFixed(2)}, z ${s.attention_z.toFixed(2)}, n=${s.n_mentions})`];
}
export class MABreak {
  constructor(params) { this.p = { ...MA_BREAK_DEFAULTS, ...(params || {}) }; }
  get warmup() { return Math.max(+this.p.slow, +this.p.atr_len, +this.p.trend_filter_len) + 2; }
  onBar(bars, ctx) {
    const p = this.p; if (bars.length < this.warmup) return null;
    const closes = bars.map(b => b.close), f = p.ma_type === "ema" ? ema : sma;
    const fast = f(closes, +p.fast), slow = f(closes, +p.slow), a = atr(bars, +p.atr_len), L = bars.length - 1;
    const f0 = fast[L], s0 = slow[L], f1 = fast[L - 1], s1 = slow[L - 1], a0 = a[L];
    if ([f0, s0, f1, s1, a0].some(x => x === null || x === undefined)) return null;
    const gap = (f0 - s0) / s0 * 100, crossUp = f1 <= s1 && f0 > s0, crossDown = f1 >= s1 && f0 < s0, price = bars[L].close, tf = +p.trend_filter_len;
    if (!ctx.position) {
      if (crossUp && gap > +p.break_pct) {
        if (tf) { const tr = sma(closes, tf)[L]; if (tr === null || price <= tr) return { action: "skip", reason: `MA cross up (gap ${gap.toFixed(2)}%) but below ${tf}-bar trend MA`, confidence: 0 }; }
        const [ok, why] = sentimentAllowsLong(ctx);
        if (!ok) return { action: "skip", reason: `MA cross up (gap ${gap.toFixed(2)}%) but ${why}`, confidence: 0 };
        const conf = (ctx.sentiment_enabled && ctx.sentiment && ctx.sentiment.attention_z > 1.5) ? 1.15 : 1.0;
        return { action: "buy", reason: `MA${p.fast}>${p.slow} cross, gap ${gap.toFixed(2)}% | ${why}`, confidence: conf, stop_loss: price - +p.sl_atr * a0, take_profit: price + +p.tp_atr * a0 };
      }
      return null;
    }
    if (crossDown) return { action: "close", reason: `MA cross down (gap ${gap.toFixed(2)}%)`, confidence: 1 };
    if (ctx.sentiment_enabled && ctx.sentiment && ctx.sentiment.risk_flag && ctx.block_on_risk_flag) return { action: "close", reason: `risk flag while long: ${ctx.sentiment.risk_reasons[0].slice(0, 80)}`, confidence: 1 };
    const trail = +p.trail_atr;
    if (trail > 0) {
      const since = bars.filter(b => b.ts >= ctx.position.entry_ts).map(b => b.high); if (!since.length) since.push(bars[L].high);
      const ns = Math.max(...since) - trail * a0;
      if (ctx.position.stop_loss === null || ctx.position.stop_loss === undefined || ns > ctx.position.stop_loss) return { action: "update_stop", reason: `trail stop → ${ns.toPrecision(6)}`, confidence: 1, stop_loss: ns };
    }
    return null;
  }
  // Diagnostic-only: describes the CURRENT state in plain language, whether or not onBar produced a signal.
  // Called every poll cycle so the UI can show "what it's doing right now" instead of going quiet between
  // trades. Never affects trading — mirrors onBar's math read-only and must never throw on bad/short data.
  explain(bars, ctx) {
    const p = this.p;
    if (bars.length < this.warmup) return { state: "warming_up", text: `warming up — ${bars.length}/${this.warmup} bars of history collected` };
    const closes = bars.map(b => b.close), f = p.ma_type === "ema" ? ema : sma;
    const fast = f(closes, +p.fast), slow = f(closes, +p.slow), L = bars.length - 1;
    const f0 = fast[L], s0 = slow[L], f1 = fast[L - 1], s1 = slow[L - 1], price = bars[L].close;
    if ([f0, s0, f1, s1].some(x => x == null)) return { state: "warming_up", text: "warming up — indicators not ready yet" };
    const gap = (f0 - s0) / s0 * 100, crossUp = f1 <= s1 && f0 > s0, crossDown = f1 >= s1 && f0 < s0;
    if (ctx.position) {
      const pos = ctx.position, unrealPct = (price - pos.entry_price) / pos.entry_price * 100;
      let text = `holding since $${(+pos.entry_price).toPrecision(6)} — now ${unrealPct >= 0 ? "+" : ""}${unrealPct.toFixed(2)}%. `;
      text += crossDown ? `MA${p.fast}/${p.slow} just crossed back down — closing on this check.` : `watching for the ${p.fast}/${p.slow} MA to cross back down (gap ${gap.toFixed(2)}% now).`;
      text += ` Stop $${pos.stop_loss != null ? (+pos.stop_loss).toPrecision(6) : "—"}, target $${pos.take_profit != null ? (+pos.take_profit).toPrecision(6) : "—"}${+p.trail_atr > 0 ? `, trailing ${p.trail_atr}×ATR` : ""}.`;
      return { state: "in_position", text };
    }
    const need = +p.break_pct; let text;
    if (crossUp && gap > need) text = `MA just crossed up with a ${gap.toFixed(2)}% gap (past the ${need}% trigger) — buying this check unless sentiment/trend blocks it.`;
    else if (gap > need) text = `fast MA is ${gap.toFixed(2)}% above slow (past the ${need}% bar), but there's no fresh cross right now — this only fires on the bar it first crosses.`;
    else if (gap > 0) text = `fast MA ${gap.toFixed(2)}% above slow MA — needs a cross with the gap over ${need}% (${(need - gap).toFixed(2)}pts short).`;
    else text = `fast MA ${Math.abs(gap).toFixed(2)}% below slow MA — needs to cross above first, then clear ${need}%.`;
    if (+p.trend_filter_len) { const tr = sma(closes, +p.trend_filter_len)[L]; if (tr != null) text += price > tr ? ` Price is above the ${p.trend_filter_len}-bar trend filter (ok).` : ` Price is below the ${p.trend_filter_len}-bar trend filter (would block a buy even on a good cross).`; }
    return { state: "watching", text };
  }
}

// Scalper: the "in for a few minutes, out" style seen in short trading clips. Buys a short, fast pop above a
// very short EMA and ALWAYS exits within max_hold_bars bars no matter what (in addition to its tight stop/target) —
// that forced time exit is the whole point of this strategy, not a safety net on top of MABreak's hold-and-ride style.
// Included so you can see, with real numbers, what that trading style actually does: fees + spread on every
// trade, held for minutes, is a rough way to make money — this makes that concrete instead of theoretical.
export const SCALPER_DEFAULTS = { ema_len: 3, breakout_pct: 0.08, tp_pct: 0.15, sl_pct: 0.12, max_hold_bars: 3 };
export class Scalper {
  constructor(params) { this.p = { ...SCALPER_DEFAULTS, ...(params || {}) }; }
  get warmup() { return +this.p.ema_len + 3; }
  onBar(bars, ctx) {
    const p = this.p; if (bars.length < this.warmup) return null;
    const closes = bars.map(b => b.close), e = ema(closes, +p.ema_len), L = bars.length - 1;
    const e0 = e[L], e1 = e[L - 1], price = bars[L].close;
    if (e0 == null || e1 == null) return null;
    if (!ctx.position) {
      const gap = (price - e0) / e0 * 100;
      if (gap > +p.breakout_pct && e0 > e1) {
        const [ok, why] = sentimentAllowsLong(ctx);
        if (!ok) return { action: "skip", reason: `scalp pop ${gap.toFixed(2)}% above EMA${p.ema_len} but ${why}`, confidence: 0 };
        return { action: "buy", reason: `scalp: ${gap.toFixed(2)}% pop above EMA${p.ema_len} | ${why}`, confidence: 1,
          stop_loss: price * (1 - +p.sl_pct / 100), take_profit: price * (1 + +p.tp_pct / 100) };
      }
      return null;
    }
    const barMs = bars[L].ts - bars[L - 1].ts, heldBars = Math.round((bars[L].ts - ctx.position.entry_ts) / Math.max(1, barMs));
    if (heldBars >= +p.max_hold_bars) return { action: "close", reason: `time exit — held ${heldBars} bar(s), max is ${p.max_hold_bars}`, confidence: 1 };
    return null;
  }
  // Diagnostic-only, mirrors onBar's math read-only — see MABreak.explain for why this exists.
  explain(bars, ctx) {
    const p = this.p;
    if (bars.length < this.warmup) return { state: "warming_up", text: `warming up — ${bars.length}/${this.warmup} bars of history collected` };
    const closes = bars.map(x => x.close), e = ema(closes, +p.ema_len), L = bars.length - 1;
    const e0 = e[L], e1 = e[L - 1], price = bars[L].close;
    if (e0 == null || e1 == null) return { state: "warming_up", text: "warming up — EMA not ready yet" };
    if (ctx.position) {
      const pos = ctx.position, barMs = bars[L].ts - bars[L - 1].ts, heldBars = Math.round((bars[L].ts - pos.entry_ts) / Math.max(1, barMs)), unrealPct = (price - pos.entry_price) / pos.entry_price * 100;
      return { state: "in_position", text: `holding since $${(+pos.entry_price).toPrecision(6)} — now ${unrealPct >= 0 ? "+" : ""}${unrealPct.toFixed(2)}%, held ${heldBars}/${p.max_hold_bars} bar(s). Force-exits at bar ${p.max_hold_bars} no matter what, or sooner on stop $${pos.stop_loss != null ? (+pos.stop_loss).toPrecision(6) : "—"}/target $${pos.take_profit != null ? (+pos.take_profit).toPrecision(6) : "—"}.` };
    }
    const gap = (price - e0) / e0 * 100, rising = e0 > e1, need = +p.breakout_pct; let text;
    if (gap > need && rising) text = `price is ${gap.toFixed(2)}% above EMA${p.ema_len} and rising — buying this check unless sentiment blocks it.`;
    else if (gap > need) text = `price is ${gap.toFixed(2)}% above EMA${p.ema_len} (past the ${need}% bar), but the EMA isn't rising yet — waiting on that too.`;
    else if (gap > 0) text = `price ${gap.toFixed(2)}% above EMA${p.ema_len} — needs ${need}% and a rising EMA (${(need - gap).toFixed(2)}pts short).`;
    else text = `price ${Math.abs(gap).toFixed(2)}% below EMA${p.ema_len} — needs to pop above it and clear ${need}% first.`;
    return { state: "watching", text };
  }
}

// ---------- paper broker ----------
export class PaperBroker {
  constructor(cash, feePct = 0.10, slipPct = 0.05) { this.cash = cash; this.starting_cash = cash; this.fee_pct = feePct; this.slippage_pct = slipPct; this.positions = {}; this.trades = []; }
  _fill(price, side) { const s = this.slippage_pct / 100; return side === "buy" ? price * (1 + s) : price * (1 - s); }
  _fee(n) { return n * this.fee_pct / 100; }
  position(sym) { return this.positions[sym] || null; }
  equity(prices) { let eq = this.cash; for (const [s, p] of Object.entries(this.positions)) eq += p.qty * (prices[s] ?? p.entry_price); return eq; }
  exposure(prices) { let e = 0; for (const [s, p] of Object.entries(this.positions)) e += p.qty * (prices[s] ?? p.entry_price); return e; }
  marketBuy(sym, qty, price, ts, stop = null, tp = null, reason = "") {
    if (this.positions[sym] || qty <= 0) return null;
    const fill = this._fill(price, "buy"); let notional = qty * fill, fee = this._fee(notional);
    if (notional + fee > this.cash) { qty = (this.cash / (1 + this.fee_pct / 100)) / fill * 0.999; notional = qty * fill; fee = this._fee(notional); if (qty <= 0) return null; }
    this.cash -= notional + fee;
    return this.positions[sym] = { symbol: sym, qty, entry_price: fill, entry_ts: ts, stop_loss: stop, take_profit: tp, entry_fee: fee, reason };
  }
  close(sym, price, ts, reason) {
    const pos = this.positions[sym]; if (!pos) return null; delete this.positions[sym];
    const fill = this._fill(price, "sell"), notional = pos.qty * fill, fee = this._fee(notional);
    this.cash += notional - fee;
    const fees = fee + pos.entry_fee, pnl = (fill - pos.entry_price) * pos.qty - fees, cost = pos.entry_price * pos.qty;
    const tr = { symbol: sym, qty: pos.qty, entry_price: pos.entry_price, exit_price: fill, entry_ts: pos.entry_ts, exit_ts: ts, fees, pnl, pnl_pct: cost ? pnl / cost * 100 : 0, exit_reason: reason, entry_reason: pos.reason };
    this.trades.push(tr); return tr;
  }
  onBar(sym, bar) {
    const pos = this.positions[sym]; if (!pos) return null;
    if (pos.stop_loss != null && bar.low <= pos.stop_loss) return this.close(sym, Math.min(pos.stop_loss, bar.open), bar.ts, "stop_loss");
    if (pos.take_profit != null && bar.high >= pos.take_profit) return this.close(sym, Math.max(pos.take_profit, bar.open), bar.ts, "take_profit");
    return null;
  }
}

// ---------- risk ----------
export const RISK_DEFAULTS = { risk_per_trade_pct: 1.0, max_position_pct: 25, max_daily_loss_pct: 3, cooldown_bars: 2, max_total_exposure_pct: 60 };
const dayOf = ts => new Date(ts).toISOString().slice(0, 10);
export class RiskManager {
  constructor(cfg, registry = null) { this.cfg = { ...RISK_DEFAULTS, ...(cfg || {}) }; this.registry = registry; this.daily = {}; this.cooldownUntil = 0; }
  recordTrade(tr, barMs) { const d = dayOf(tr.exit_ts); this.daily[d] = (this.daily[d] || 0) + tr.pnl; if (tr.pnl < 0) this.cooldownUntil = tr.exit_ts + this.cfg.cooldown_bars * barMs; }
  dailyPnl(ts) { return this.daily[dayOf(ts)] || 0; }
  canOpen(ts, equity) { if (ts < this.cooldownUntil) return [false, "cooldown after loss"]; if (equity > 0 && this.dailyPnl(ts) < -equity * this.cfg.max_daily_loss_pct / 100) return [false, `daily loss cap ${this.cfg.max_daily_loss_pct}% hit`]; return [true, "ok"]; }
  size(equity, entry, stop, conf = 1) {
    if (stop == null || stop >= entry || entry <= 0) return [0, "no valid stop below entry"];
    const riskAmt = equity * this.cfg.risk_per_trade_pct / 100 * Math.max(0, Math.min(conf, 1.5));
    let qty = riskAmt / (entry - stop), notional = qty * entry; const cap = equity * this.cfg.max_position_pct / 100;
    let note = `risk $${riskAmt.toFixed(2)} over stop dist ${((entry - stop) / entry * 100).toFixed(2)}%`;
    if (notional > cap) { qty = cap / entry; notional = cap; note += `; capped at ${this.cfg.max_position_pct}% of equity`; }
    if (this.registry && this.registry.totalEquity() > 0) { const room = this.registry.totalEquity() * this.cfg.max_total_exposure_pct / 100 - this.registry.totalExposure(); if (room <= 0) return [0, "global exposure cap reached"]; if (notional > room) { qty = room / entry; note += `; capped by global exposure (room $${room.toFixed(2)})`; } }
    return [qty, note];
  }
}
export class ExposureRegistry { constructor() { this.eq = {}; this.ex = {}; } update(b, e, x) { this.eq[b] = e; this.ex[b] = x; } totalEquity() { return Object.values(this.eq).reduce((a, b) => a + b, 0); } totalExposure() { return Object.values(this.ex).reduce((a, b) => a + b, 0); } }

// ---------- backtest ----------
export function computeMetrics(trades, curve, startingCash, bars, timeframe, barsInMarket) {
  const n = trades.length, wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0), gl = -losses.reduce((a, t) => a + t.pnl, 0), ending = curve.length ? curve[curve.length - 1][1] : startingCash;
  let peak = -Infinity, mdd = 0; for (const [, eq] of curve) { peak = Math.max(peak, eq); mdd = Math.max(mdd, peak > 0 ? (peak - eq) / peak * 100 : 0); }
  const rets = []; for (let i = 1; i < curve.length; i++) if (curve[i - 1][1] > 0) rets.push(curve[i][1] / curve[i - 1][1] - 1);
  const bpy = 365 * 864e5 / TIMEFRAME_MS[timeframe]; let sharpe = 0;
  if (rets.length > 2) { const m = rets.reduce((a, b) => a + b, 0) / rets.length, sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / rets.length); if (sd > 0) sharpe = m / sd * Math.sqrt(bpy); }
  const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  return { n_trades: n, total_return_pct: (ending / startingCash - 1) * 100, buy_hold_pct: bars.length ? (bars[bars.length - 1].close / bars[0].close - 1) * 100 : 0, max_drawdown_pct: mdd, win_rate_pct: n ? wins.length / n * 100 : 0, avg_win_pct: mean(wins.map(t => t.pnl_pct)), avg_loss_pct: mean(losses.map(t => t.pnl_pct)), expectancy_pct: mean(trades.map(t => t.pnl_pct)), profit_factor: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0), sharpe, fees: trades.reduce((a, t) => a + t.fees, 0), exposure_pct: bars.length ? barsInMarket / bars.length * 100 : 0 };
}
export function runBacktest(strategy, bars, symbol, timeframe, brokerCfg = {}, riskCfg = {}, sentimentFn = null, gate = {}, window = null) {
  const broker = new PaperBroker(brokerCfg.starting_cash ?? 10000, brokerCfg.fee_pct ?? 0.10, brokerCfg.slippage_pct ?? 0.05), risk = new RiskManager(riskCfg), barMs = TIMEFRAME_MS[timeframe];
  window = window || Math.max(strategy.warmup * 3, 200);
  let pending = null, inMarket = 0, skipped = 0; const curve = [];
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (pending) {
      if (pending.action === "buy") { const [ok] = risk.canOpen(bar.ts, broker.equity({ [symbol]: bar.open })); if (ok) { const [qty] = risk.size(broker.equity({ [symbol]: bar.open }), bar.open, pending.stop_loss, pending.confidence); if (qty > 0) broker.marketBuy(symbol, qty, bar.open, bar.ts, pending.stop_loss, pending.take_profit, pending.reason); } }
      else if (pending.action === "close") { const tr = broker.close(symbol, bar.open, bar.ts, pending.reason); if (tr) risk.recordTrade(tr, barMs); }
      pending = null;
    }
    const tr = broker.onBar(symbol, bar); if (tr) risk.recordTrade(tr, barMs);
    if (i + 1 >= strategy.warmup) {
      const snap = sentimentFn ? sentimentFn(bar.ts) : null;
      const ctx = { position: broker.position(symbol), sentiment: snap, sentiment_enabled: !!sentimentFn, min_polarity: -0.2, min_attention_z: -1.0, block_on_risk_flag: true, ...gate };
      const sig = strategy.onBar(bars.slice(Math.max(0, i + 1 - window), i + 1), ctx);
      if (sig) { if (sig.action === "skip") skipped++; else if (sig.action === "update_stop") { const pos = broker.position(symbol); if (pos && sig.stop_loss != null) pos.stop_loss = sig.stop_loss; } else pending = sig; }
    }
    if (broker.position(symbol)) inMarket++;
    curve.push([bar.ts, broker.equity({ [symbol]: bar.close })]);
  }
  if (broker.position(symbol) && bars.length) { broker.close(symbol, bars[bars.length - 1].close, bars[bars.length - 1].ts, "end_of_data"); curve[curve.length - 1] = [bars[bars.length - 1].ts, broker.equity({})]; }
  const res = { symbol, timeframe, bars: bars.length, starting_cash: broker.starting_cash, ending_equity: curve.length ? curve[curve.length - 1][1] : broker.starting_cash, trades: broker.trades.slice(), equity_curve: curve, skipped_signals: skipped };
  res.metrics = computeMetrics(res.trades, curve, broker.starting_cash, bars, timeframe, inMarket);
  return res;
}

export function syntheticBars(n, timeframe = "1h", seed = 1, startPrice = 0.08) {
  // deterministic LCG so tests are reproducible in JS (not identical to Python's — parity tests share a JSON file instead)
  let s = seed >>> 0; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const gauss = (m, sd) => { const u = 1 - rnd(), v = rnd(); return m + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const tf = TIMEFRAME_MS[timeframe], out = []; let price = startPrice;
  for (let i = 0; i < n; i++) { const reg = Math.floor(i / 120) % 3, mu = [0.004, 0, -0.004][reg], o = price, c = o * Math.exp(gauss(mu, 0.02)); out.push({ ts: 17e11 + i * tf, open: o, high: Math.max(o, c) * (1 + Math.abs(gauss(0, 0.01))), low: Math.min(o, c) * (1 - Math.abs(gauss(0, 0.01))), close: c, volume: 1e6 }); price = c; }
  return out;
}
