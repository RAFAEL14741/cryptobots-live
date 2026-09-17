// THE EXPERIMENT: does trading faster actually earn more?
// Rafael asked to make every bot trade every 1 minute "so we earn faster." Rather than guess, this runs the
// real numbers on real Binance.US data using the exact same engine, fees and split rules the live bots use.
//
// Part A — the cost table. For each timeframe, how far does price ACTUALLY move in one bar, versus how much a
//          round trip costs (0.1% fee x2 + 0.05% slippage = 0.25%)? If the fee is bigger than the typical
//          move, the strategy has to be superhuman just to break even. This part is period-independent -- it
//          doesn't depend on any strategy, tuning, or luck.
// Part B — the strategy sweep. Same MABreak grid at 1m/5m/15m/1h/4h, same chronological 70/30 split, same
//          "must be positive on BOTH splits" rule. Shows how out-of-sample results actually behave as the
//          bars get faster.
// Part C — do the engine's unused knobs help? Tests trend_filter_len (only buy above a long MA) and trail_atr
//          (trailing stop) out-of-sample, to see if they add real value or just more curve-fitting.
import { MABreak, runBacktest } from "./engine.mjs";
import { writeFileSync } from "fs";

const FEE_PCT = 0.10, SLIP_PCT = 0.05;
const ROUND_TRIP_COST = FEE_PCT * 2 + SLIP_PCT; // 0.25% -- pay the fee twice (in and out), slip once
const brokerCfg = { starting_cash: 10000, fee_pct: FEE_PCT, slippage_pct: SLIP_PCT };

const SYMBOLS = ["DOGEUSDT", "SOLUSDT", "BTCUSDT"];
const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h"];
const WANT = { "1m": 20000, "5m": 12000, "15m": 8000, "1h": 6300, "4h": 2000 };

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

const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// ---------- Part A: what does a bar actually move, vs what a trade costs ----------
function costTable(bars) {
  // |close-to-close move| per bar, in percent. Median is the honest "typical bar" -- the mean gets dragged
  // around by a handful of violent candles that you cannot count on catching.
  const moves = [];
  for (let i = 1; i < bars.length; i++) moves.push(Math.abs((bars[i].close - bars[i - 1].close) / bars[i - 1].close * 100));
  const med = median(moves), avg = moves.reduce((a, b) => a + b, 0) / moves.length;
  // How often is a single bar's move even bigger than the cost of the round trip?
  const pctBarsBeatingCost = moves.filter(m => m > ROUND_TRIP_COST).length / moves.length * 100;
  return { median_bar_move_pct: med, avg_bar_move_pct: avg, cost_in_bar_moves: ROUND_TRIP_COST / med, pct_bars_beating_cost: pctBarsBeatingCost };
}

// ---------- Part B/C: the grid ----------
const FAST = [7, 10, 15], SLOW = [20, 25, 50], MA_TYPE = ["sma", "ema"], BREAK = [0, 0.2], TP = [2, 3], SL = [1.5, 2];
function* baseConfigs() {
  for (const fast of FAST) for (const slow of SLOW) if (fast < slow)
    for (const ma_type of MA_TYPE) for (const break_pct of BREAK) for (const tp_atr of TP) for (const sl_atr of SL)
      yield { fast, slow, ma_type, break_pct, tp_atr, sl_atr, atr_len: 14, trend_filter_len: 0, trail_atr: 0 };
}
// Part C adds the two knobs the live bots mostly leave off.
function* extendedConfigs() {
  for (const base of baseConfigs())
    for (const trend_filter_len of [0, 50, 200]) for (const trail_atr of [0, 2])
      yield { ...base, trend_filter_len, trail_atr };
}

function sweep(bars, symbol, tf, gen, minTrainTrades, minTestTrades) {
  const si = Math.floor(bars.length * 0.7), train = bars.slice(0, si), test = bars.slice(si);
  let tested = 0, passed = [], allTest = [];
  for (const params of gen()) {
    tested++;
    const mTrain = runBacktest(new MABreak(params), train, symbol, tf, brokerCfg, {}, null, {}).metrics;
    const mTest = runBacktest(new MABreak(params), test, symbol, tf, brokerCfg, {}, null, {}).metrics;
    allTest.push(mTest.total_return_pct);
    if (mTrain.n_trades < minTrainTrades || mTrain.total_return_pct <= 0) continue;
    if (mTest.n_trades < minTestTrades || mTest.total_return_pct <= 0) continue;
    passed.push({ params, mTrain, mTest });
  }
  passed.sort((a, b) => (b.mTrain.profit_factor + b.mTest.profit_factor) - (a.mTrain.profit_factor + a.mTest.profit_factor));
  // The average test result across EVERY config is the honest picture. The single best one is always
  // flattering -- pick 144 lottery tickets and one of them looks like skill.
  const avgTest = allTest.reduce((a, b) => a + b, 0) / allTest.length;
  const pctConfigsPositive = allTest.filter(r => r > 0).length / allTest.length * 100;
  return { tested, passedCount: passed.length, top: passed[0] || null, avgTestReturn: avgTest, pctConfigsPositiveOnTest: pctConfigsPositive };
}

const results = { cost_table: {}, timeframe_sweep: {}, knob_test: {} };

for (const symbol of SYMBOLS) {
  for (const tf of TIMEFRAMES) {
    let bars;
    try { bars = await fetchBinance(symbol, tf, WANT[tf]); }
    catch (e) { console.log(`${symbol} ${tf}: fetch failed - ${e.message}`); continue; }
    if (bars.length < 400) { console.log(`${symbol} ${tf}: only ${bars.length} bars, skipping`); continue; }
    const days = (bars[bars.length - 1].ts - bars[0].ts) / 864e5;

    const ct = costTable(bars);
    results.cost_table[`${symbol}_${tf}`] = { ...ct, bars: bars.length, days: Math.round(days) };
    console.log(`\n### ${symbol} ${tf} (${bars.length} bars, ${days.toFixed(0)}d)`);
    console.log(`  typical bar moves ${ct.median_bar_move_pct.toFixed(4)}% | round trip costs ${ROUND_TRIP_COST}% = ${ct.cost_in_bar_moves.toFixed(2)}x a typical bar`);
    console.log(`  only ${ct.pct_bars_beating_cost.toFixed(1)}% of bars even move more than the cost of trading them`);

    const sw = sweep(bars, symbol, tf, baseConfigs, 8, 3);
    results.timeframe_sweep[`${symbol}_${tf}`] = {
      days: Math.round(days), tested: sw.tested, passedCount: sw.passedCount,
      avgTestReturn: sw.avgTestReturn, pctConfigsPositiveOnTest: sw.pctConfigsPositiveOnTest,
      top: sw.top ? { params: sw.top.params, train: sw.top.mTrain, test: sw.top.mTest } : null,
    };
    console.log(`  grid: ${sw.passedCount}/${sw.tested} configs passed both splits | avg test return across ALL configs: ${sw.avgTestReturn.toFixed(2)}% | ${sw.pctConfigsPositiveOnTest.toFixed(0)}% of configs positive out-of-sample`);
    if (sw.top) console.log(`  best: train n=${sw.top.mTrain.n_trades} ret=${sw.top.mTrain.total_return_pct.toFixed(2)}% | test n=${sw.top.mTest.n_trades} ret=${sw.top.mTest.total_return_pct.toFixed(2)}% pf=${sw.top.mTest.profit_factor.toFixed(2)}`);

    // Part C only on the timeframes that are actually viable -- no point tuning knobs on a losing frequency.
    if (tf === "1h" || tf === "4h") {
      const ex = sweep(bars, symbol, tf, extendedConfigs, 8, 3);
      results.knob_test[`${symbol}_${tf}`] = {
        tested: ex.tested, passedCount: ex.passedCount, avgTestReturn: ex.avgTestReturn,
        pctConfigsPositiveOnTest: ex.pctConfigsPositiveOnTest,
        top: ex.top ? { params: ex.top.params, train: ex.top.mTrain, test: ex.top.mTest } : null,
        base_avgTestReturn: sw.avgTestReturn,
      };
      console.log(`  +knobs: ${ex.passedCount}/${ex.tested} passed | avg test ${ex.avgTestReturn.toFixed(2)}% (base was ${sw.avgTestReturn.toFixed(2)}%) -> knobs ${ex.avgTestReturn > sw.avgTestReturn ? "HELP" : "DO NOT HELP"}`);
      if (ex.top) console.log(`  best w/ knobs: trend_filter=${ex.top.params.trend_filter_len} trail=${ex.top.params.trail_atr} | test n=${ex.top.mTest.n_trades} ret=${ex.top.mTest.total_return_pct.toFixed(2)}% pf=${ex.top.mTest.profit_factor.toFixed(2)}`);
    }
  }
}

writeFileSync("timeframe_experiment_results.json", JSON.stringify(results, null, 2));
console.log("\n\n===== SUMMARY: cost of trading vs size of a typical move =====");
for (const tf of TIMEFRAMES) {
  const keys = Object.keys(results.cost_table).filter(k => k.endsWith(`_${tf}`));
  if (!keys.length) continue;
  const avgX = keys.reduce((a, k) => a + results.cost_table[k].cost_in_bar_moves, 0) / keys.length;
  const avgRet = keys.filter(k => results.timeframe_sweep[k]).reduce((a, k) => a + results.timeframe_sweep[k].avgTestReturn, 0) / keys.length;
  console.log(`${tf.padEnd(4)} | cost = ${avgX.toFixed(2)}x a typical bar move | avg out-of-sample return across all configs: ${avgRet.toFixed(2)}%`);
}
console.log("\ndone -- timeframe_experiment_results.json");
