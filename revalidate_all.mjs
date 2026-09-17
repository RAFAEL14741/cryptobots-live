// Re-validates EVERY live bot against fresh real Binance.US data, using that bot's exact live parameters,
// and writes a richer `validated` block back into config.json so the dashboard can show honest odds instead
// of a bare win-rate number.
//
// The important addition is the Wilson 95% confidence interval on the test win rate. A bot that won 4 of 8
// trades has a "50% win rate", but with only 8 trades the true rate could honestly be anywhere from ~22% to
// ~78%. Printing "50%" alone is a lie of precision. The interval is the honest answer to Rafael's question
// "what is the probability, with evidence" -- it shows both the estimate AND how much to trust it.
//
// No parameters are re-tuned here. Re-tuning against fresh data then reporting the result as "validated"
// would be the exact overfitting trap this project exists to avoid. Each bot is scored on the settings it is
// actually running, and if a bot now fails, that gets reported rather than quietly re-fitted away.
import { MABreak, Scalper, runBacktest } from "./engine.mjs";
import { readFileSync, writeFileSync } from "fs";

const cfg = JSON.parse(readFileSync("config.json", "utf8"));
const WANT_BARS = { "1m": 20000, "5m": 12000, "15m": 8000, "1h": 6300, "4h": 2000, "1d": 900 };

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
    await new Promise(r => setTimeout(r, 60));
  }
  return out;
}

// Wilson score interval -- the right tool for a win rate from a small number of trades. The naive
// "p +/- 1.96*sqrt(p(1-p)/n)" breaks down badly at small n and can even produce impossible values below 0%
// or above 100%; Wilson stays inside [0,1] and stays honest when n is tiny.
function wilson(successes, n, z = 1.96) {
  if (!n) return { lo: 0, hi: 100 };
  const p = successes / n, d = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / d;
  const margin = (z / d) * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return { lo: Math.max(0, (center - margin) * 100), hi: Math.min(100, (center + margin) * 100) };
}

const r2 = v => Math.round(v * 100) / 100;
function pack(m) {
  const wins = Math.round(m.win_rate_pct / 100 * m.n_trades);
  const ci = wilson(wins, m.n_trades);
  return {
    n_trades: m.n_trades,
    win_rate_pct: r2(m.win_rate_pct),
    win_rate_lo: r2(ci.lo),          // with this few trades, the true win rate could be this low...
    win_rate_hi: r2(ci.hi),          // ...or this high. The gap IS the uncertainty.
    total_return_pct: r2(m.total_return_pct),
    profit_factor: m.profit_factor === Infinity ? 99 : r2(m.profit_factor),
    max_drawdown_pct: r2(m.max_drawdown_pct),
    buy_hold_pct: r2(m.buy_hold_pct),
    avg_win_pct: r2(m.avg_win_pct),
    avg_loss_pct: r2(m.avg_loss_pct),
    expectancy_pct: Math.round(m.expectancy_pct * 1000) / 1000, // avg P&L per trade, the number that matters
  };
}

function makeStrategy(b) {
  if (b.strategy === "scalper") return new Scalper(b.params);
  return new MABreak(b.params);
}

// Plain-English verdict, derived strictly from the numbers -- no opinion, no vibes.
function verdict(train, test) {
  if (test.n_trades < 5) return { tag: "thin", text: `only ${test.n_trades} unseen trades — not enough to judge either way` };
  if (test.total_return_pct <= 0 || test.profit_factor < 1) return { tag: "failing", text: `lost money on the ${test.n_trades} trades it hadn't seen — no evidence of an edge` };
  if (test.expectancy_pct <= 0) return { tag: "failing", text: `average trade loses ${Math.abs(test.expectancy_pct).toFixed(2)}% — no edge` };
  if (test.win_rate_lo < 30 && test.profit_factor < 1.3) return { tag: "weak", text: `positive, but the edge is small and the sample is thin` };
  return { tag: "holding", text: `made money on ${test.n_trades} trades it had never seen, average ${test.expectancy_pct > 0 ? "+" : ""}${test.expectancy_pct.toFixed(2)}% per trade` };
}

const report = [];
for (const b of cfg.bots) {
  let bars;
  try { bars = await fetchBinance(b.symbol, b.timeframe, WANT_BARS[b.timeframe] || 3000); }
  catch (e) { console.log(`${b.name}: fetch failed - ${e.message}`); continue; }
  if (bars.length < 300) { console.log(`${b.name}: only ${bars.length} bars, skipping`); continue; }

  const si = Math.floor(bars.length * 0.7), train = bars.slice(0, si), test = bars.slice(si);
  const brokerCfg = b.broker || { starting_cash: 10000, fee_pct: 0.1, slippage_pct: 0.05 };
  const mTrain = runBacktest(makeStrategy(b), train, b.symbol, b.timeframe, brokerCfg, {}, null, {}).metrics;
  const mTest = runBacktest(makeStrategy(b), test, b.symbol, b.timeframe, brokerCfg, {}, null, {}).metrics;

  const pTrain = pack(mTrain), pTest = pack(mTest);
  const v = verdict(pTrain, pTest);
  b.validated = {
    as_of: new Date().toISOString().slice(0, 10),
    data_days: Math.round((bars[bars.length - 1].ts - bars[0].ts) / 864e5),
    train: pTrain, test: pTest,
    verdict: v.tag, verdict_text: v.text,
  };
  report.push({ name: b.name, ...v, test: pTest });
  console.log(`${b.name.padEnd(16)} ${v.tag.toUpperCase().padEnd(8)} test n=${pTest.n_trades} win=${pTest.win_rate_pct}% (${pTest.win_rate_lo}-${pTest.win_rate_hi}%) ret=${pTest.total_return_pct}% pf=${pTest.profit_factor} exp=${pTest.expectancy_pct}%/trade`);
}

writeFileSync("config.json", JSON.stringify(cfg, null, 2) + "\n");
console.log("\n===== SUMMARY =====");
for (const tag of ["holding", "weak", "thin", "failing"]) {
  const g = report.filter(r => r.tag === tag);
  if (g.length) console.log(`${tag}: ${g.map(r => r.name).join(", ")}`);
}
writeFileSync("revalidation_report.json", JSON.stringify(report, null, 2));
