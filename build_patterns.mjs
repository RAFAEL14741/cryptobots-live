// Builds the honest version of "tell me if I should buy or sell."
//
// I cannot predict the future and I will not pretend to. What I CAN do is measure, from real history:
// "every other time this coin's chart looked the way it looks right now, what actually happened next?"
// That is a real, checkable number instead of a guess — and it comes with a sample size so you can see
// how much to trust it.
//
// How a chart's "look" is described, deliberately kept to two coarse features so it can't be curve-fit:
//   1. how far the fast MA is from the slow MA, measured in ATR (volatility) units so it means the same
//      thing on DOGE at $0.08 as on BTC at $76,000
//   2. whether price is above or below its 200-bar line (the big-picture trend)
// That's ~10 x 2 = 20 buckets. With thousands of bars per coin each bucket holds a real sample.
//
// For each bucket it records what happened over the next 12 candles, and — this is the part that keeps it
// honest — it compares that to the coin's OWN baseline. If a coin goes up 52% of the time in general and
// a bucket goes up 54%, that bucket tells you nothing. A bucket only gets called a lean when its 95%
// confidence interval clears the baseline entirely.
import { sma, ema, atr } from "./engine.mjs";
import { readFileSync, writeFileSync } from "fs";

const cfg = JSON.parse(readFileSync("config.json", "utf8"));
const WANT = { "1m": 20000, "5m": 12000, "15m": 10000, "1h": 8000, "4h": 3000, "1d": 1200 };
const HORIZON = 12;                  // candles to look forward
const GAP_EDGES = [-3, -2, -1, -0.5, 0, 0.5, 1, 2, 3];   // gap measured in ATRs
const TREND_LEN = 200;

async function fetchBinance(symbol, tf, limit) {
  let out = [], remaining = limit, cursor = null;
  while (remaining > 0) {
    const n = Math.min(1000, remaining), u = new URL("https://api.binance.us/api/v3/klines");
    u.searchParams.set("symbol", symbol); u.searchParams.set("interval", tf); u.searchParams.set("limit", n);
    if (cursor) u.searchParams.set("endTime", cursor);
    const r = await fetch(u); if (!r.ok) throw new Error(`binance ${r.status}`);
    const rows = await r.json(); if (!rows.length) break;
    const page = rows.map(k => ({ ts: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
    out = page.concat(out); remaining -= page.length; cursor = page[0].ts - 1; if (page.length < n) break;
    await new Promise(r => setTimeout(r, 55));
  }
  return out;
}

function wilson(succ, n, z = 1.96) {
  if (!n) return [0, 100];
  const p = succ / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const m = (z / d) * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - m) * 100), Math.min(100, (c + m) * 100)];
}
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const r2 = v => Math.round(v * 100) / 100;

// Which bucket does a given gap-in-ATRs fall into? Returned as a stable string key.
export function bucketOf(gapAtr, aboveTrend) {
  let i = 0;
  while (i < GAP_EDGES.length && gapAtr >= GAP_EDGES[i]) i++;
  return `g${i}_${aboveTrend ? "up" : "dn"}`;
}
const bucketLabel = key => {
  const [g, t] = key.split("_");
  const i = +g.slice(1);
  const lo = i === 0 ? null : GAP_EDGES[i - 1], hi = i >= GAP_EDGES.length ? null : GAP_EDGES[i];
  const range = lo === null ? `below ${hi} ATR` : hi === null ? `above ${lo} ATR` : `${lo} to ${hi} ATR`;
  return `fast MA ${range} from slow, price ${t === "up" ? "above" : "below"} the ${TREND_LEN}-bar line`;
};

const out = {};
for (const b of cfg.bots) {
  if (b.strategy !== "ma_break") continue;   // the scalper reads the chart differently
  let bars;
  try { bars = await fetchBinance(b.symbol, b.timeframe, WANT[b.timeframe] || 3000); }
  catch (e) { console.log(`${b.name}: fetch failed — ${e.message}`); continue; }
  if (bars.length < 600) { console.log(`${b.name}: only ${bars.length} bars, not enough history`); continue; }

  const closes = bars.map(x => x.close);
  const f = b.params.ma_type === "ema" ? ema : sma;
  const fast = f(closes, +b.params.fast), slow = f(closes, +b.params.slow);
  const a = atr(bars, +b.params.atr_len), trend = sma(closes, TREND_LEN);

  const buckets = {}, allFwd = [];
  const start = Math.max(+b.params.slow, +b.params.atr_len, TREND_LEN) + 1;
  for (let i = start; i < bars.length - HORIZON; i++) {
    if (fast[i] == null || slow[i] == null || a[i] == null || trend[i] == null || !a[i]) continue;
    const gapAtr = (fast[i] - slow[i]) / a[i];
    const key = bucketOf(gapAtr, closes[i] > trend[i]);
    // Forward return: close now -> close HORIZON candles later. Features use only data up to i.
    const fwd = (closes[i + HORIZON] - closes[i]) / closes[i] * 100;
    (buckets[key] ||= []).push(fwd);
    allFwd.push(fwd);
  }
  if (!allFwd.length) { console.log(`${b.name}: no usable bars`); continue; }

  // The coin's own normal behaviour — the yardstick every bucket gets measured against.
  const baseUp = allFwd.filter(x => x > 0).length / allFwd.length * 100;
  const baseMed = median(allFwd);

  const packed = {};
  for (const [key, arr] of Object.entries(buckets)) {
    if (arr.length < 30) continue;                       // too few examples to mean anything
    const up = arr.filter(x => x > 0).length;
    const pctUp = up / arr.length * 100;
    const [lo, hi] = wilson(up, arr.length);
    // A bucket only "leans" if its whole confidence range sits clear of how the coin normally behaves.
    let lean = "no different from usual";
    if (lo > baseUp) lean = "leans up";
    else if (hi < baseUp) lean = "leans down";
    packed[key] = {
      n: arr.length, pct_up: r2(pctUp), lo: r2(lo), hi: r2(hi),
      median_fwd: r2(median(arr)), mean_fwd: r2(arr.reduce((x, y) => x + y, 0) / arr.length),
      lean, label: bucketLabel(key),
    };
  }

  out[b.name] = {
    symbol: b.symbol, timeframe: b.timeframe, horizon_bars: HORIZON,
    bars_studied: allFwd.length,
    days_studied: Math.round((bars[bars.length - 1].ts - bars[0].ts) / 864e5),
    baseline_pct_up: r2(baseUp), baseline_median_fwd: r2(baseMed),
    gap_edges: GAP_EDGES, trend_len: TREND_LEN,
    buckets: packed,
  };
  const leaning = Object.values(packed).filter(p => p.lean !== "no different from usual").length;
  console.log(`${b.name.padEnd(12)} ${allFwd.length} bars studied, ${Object.keys(packed).length} patterns with a real sample, ${leaning} that actually differ from this coin's normal (baseline up ${r2(baseUp)}%)`);
}

writeFileSync("patterns.json", JSON.stringify(out, null, 2));
console.log("\nwrote patterns.json");
