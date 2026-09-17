// Second honest grid search round: 8 more real meme/community coins on Binance.US that Rafael hasn't
// tested yet (similar profile to DOGE - community/meme driven, liquid enough to actually trade).
// Same exact methodology as the first search: chronological 70/30 split, MABreak strategy, only count
// a config as a candidate if it's positive on BOTH splits with a real trade count (not a handful of
// lucky trades dressed up as an edge).
import { MABreak, runBacktest } from "./engine.mjs";
import { writeFileSync } from "fs";

const SYMBOLS = ["NEIROUSDT", "MEWUSDT", "POPCATUSDT", "PNUTUSDT", "MOODENGUSDT", "TURBOUSDT", "BRETTUSDT", "TOSHIUSDT"];
const TIMEFRAMES = ["1h", "4h"];
const WANT_BARS = { "1h": 6300, "4h": 2000 };
const brokerCfg = { starting_cash: 10000, fee_pct: 0.10, slippage_pct: 0.05 };

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
    await new Promise(r => setTimeout(r, 80));
  }
  return out;
}

const FAST = [7, 10, 15], SLOW = [20, 25, 50], MA_TYPE = ["sma", "ema"], BREAK = [0, 0.2], TP = [2, 3], SL = [1.5, 2];
function* configs() {
  for (const fast of FAST) for (const slow of SLOW) if (fast < slow)
    for (const ma_type of MA_TYPE) for (const break_pct of BREAK) for (const tp_atr of TP) for (const sl_atr of SL)
      yield { fast, slow, ma_type, break_pct, tp_atr, sl_atr, atr_len: 14, trend_filter_len: 0, trail_atr: 0 };
}

const results = {};
for (const symbol of SYMBOLS) {
  for (const tf of TIMEFRAMES) {
    let bars;
    try { bars = await fetchBinance(symbol, tf, WANT_BARS[tf]); }
    catch (e) { console.log(`${symbol} ${tf}: fetch failed - ${e.message}`); continue; }
    if (bars.length < 300) { console.log(`${symbol} ${tf}: only ${bars.length} bars, skipping (not enough real history)`); continue; }
    const days = (bars[bars.length - 1].ts - bars[0].ts) / 864e5;
    const si = Math.floor(bars.length * 0.7), train = bars.slice(0, si), test = bars.slice(si);
    let tested = 0, passed = [];
    for (const params of configs()) {
      tested++;
      const mTrain = runBacktest(new MABreak(params), train, symbol, tf, brokerCfg, {}, null, {}).metrics;
      if (mTrain.n_trades < 8 || mTrain.total_return_pct <= 0) continue;
      const mTest = runBacktest(new MABreak(params), test, symbol, tf, brokerCfg, {}, null, {}).metrics;
      if (mTest.n_trades < 3 || mTest.total_return_pct <= 0) continue;
      passed.push({ params, mTrain, mTest });
    }
    console.log(`${symbol} ${tf}: ${days.toFixed(0)}d of data, ${tested} configs tested, ${passed.length} passed (${(passed.length/tested*100).toFixed(1)}%)`);
    if (passed.length) {
      passed.sort((a, b) => (b.mTrain.profit_factor + b.mTest.profit_factor) - (a.mTrain.profit_factor + a.mTest.profit_factor));
      const top = passed[0];
      console.log(`  best: fast=${top.params.fast} slow=${top.params.slow} ${top.params.ma_type} break=${top.params.break_pct}% tp=${top.params.tp_atr}atr sl=${top.params.sl_atr}atr`);
      console.log(`  train: n=${top.mTrain.n_trades} win=${top.mTrain.win_rate_pct.toFixed(0)}% return=${top.mTrain.total_return_pct.toFixed(2)}% pf=${top.mTrain.profit_factor.toFixed(2)}`);
      console.log(`  test:  n=${top.mTest.n_trades} win=${top.mTest.win_rate_pct.toFixed(0)}% return=${top.mTest.total_return_pct.toFixed(2)}% pf=${top.mTest.profit_factor.toFixed(2)}`);
      results[`${symbol}_${tf}`] = { symbol, tf, days: Math.round(days), tested, passedCount: passed.length, top: { params: top.params, train: top.mTrain, test: top.mTest } };
    }
  }
}
writeFileSync("meme_search2_results.json", JSON.stringify(results, null, 2));
console.log("\ndone -- see meme_search2_results.json");
