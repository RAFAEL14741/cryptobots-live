// CONTROLLED follow-up to timeframe_experiment.mjs, built to answer the two fair objections to it:
//
//   1. "You compared 14 days of 1m data against 334 days of 4h data — that's different market regimes,
//       not a timeframe effect." -> This run uses ONE identical 90-day calendar window for every timeframe.
//
//   2. "You claim fees are the mechanism, but you never ran it without fees." -> Every grid runs TWICE:
//       once with the real 0.1%/side + 0.05% slippage, once with fees and slippage set to exactly zero.
//       If the zero-fee version at 1m is healthy and the real-fee version is not, cost IS the mechanism.
//       If the zero-fee version is ALSO bad, then the strategy simply doesn't work on fast bars and the
//       cost story is the wrong explanation. Either way we learn which, instead of assuming.
//
// It also reports the honest summary stats the first version got wrong: the TRAIN-SELECTED config's
// out-of-sample result (what you'd actually ship) rather than the average of 144 mostly-junk configs,
// plus buy-and-hold over the identical window so "it lost money" can be compared to "so did just holding".
import { MABreak, runBacktest } from "./engine.mjs";
import { writeFileSync } from "fs";

const SYMBOL = process.argv[2] || "DOGEUSDT";
const DAYS = 90;
const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h"];
const TF_MS = { "1m": 6e4, "5m": 3e5, "15m": 9e5, "1h": 36e5, "4h": 144e5 };
const REAL_FEES = { starting_cash: 10000, fee_pct: 0.10, slippage_pct: 0.05 };
const NO_FEES = { starting_cash: 10000, fee_pct: 0, slippage_pct: 0 };
// Sizing is held constant across timeframes on purpose. With the default 1%-risk sizing, a 1m bar's tiny
// ATR makes the position-size formula demand many times equity and slam into the 25% cap every trade,
// while a 4h bar rarely hits it -- so the timeframes would be running different leverage and the
// comparison would be measuring that instead of bar size. Forcing every trade to the same 25% notional
// makes bar size the only thing that differs.
const FLAT_RISK = { risk_per_trade_pct: 1000, max_position_pct: 25, max_daily_loss_pct: 100, cooldown_bars: 0, max_total_exposure_pct: 100 };

const END = Date.now();
const START = END - DAYS * 864e5;

async function fetchWindow(symbol, tf) {
  const need = Math.ceil((END - START) / TF_MS[tf]);
  let out = [], cursor = END;
  while (out.length < need) {
    const u = new URL("https://api.binance.us/api/v3/klines");
    u.searchParams.set("symbol", symbol); u.searchParams.set("interval", tf);
    u.searchParams.set("limit", 1000); u.searchParams.set("endTime", cursor);
    const r = await fetch(u); if (!r.ok) throw new Error(`binance ${r.status}`);
    const rows = await r.json(); if (!rows.length) break;
    const page = rows.map(k => ({ ts: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
    out = page.concat(out);
    cursor = page[0].ts - 1;
    if (page.length < 1000 || page[0].ts <= START) break;
    await new Promise(r => setTimeout(r, 55));
  }
  return out.filter(b => b.ts >= START);
}

const FAST = [7, 10, 15], SLOW = [20, 25, 50], MA_TYPE = ["sma", "ema"], BREAK = [0, 0.2], TP = [2, 3], SL = [1.5, 2];
function* configs() {
  for (const fast of FAST) for (const slow of SLOW) if (fast < slow)
    for (const ma_type of MA_TYPE) for (const break_pct of BREAK) for (const tp_atr of TP) for (const sl_atr of SL)
      yield { fast, slow, ma_type, break_pct, tp_atr, sl_atr, atr_len: 14, trend_filter_len: 0, trail_atr: 0 };
}

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const atrPct = bars => {
  // Average true range as a % of price -- the size of a move the strategy actually trades, which is the
  // right thing to compare a fixed cost against (a single bar's median move is not: a trade spans many bars).
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1].close;
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - p), Math.abs(b.low - p)) / p * 100);
  }
  return mean(trs);
};

// Pick the config that looked best on TRAIN only, then report how that one config did on TEST.
// That is what shipping actually looks like -- you never get to pick using the test data.
function trainSelected(bars, tf, brokerCfg) {
  const si = Math.floor(bars.length * 0.7), train = bars.slice(0, si), test = bars.slice(si);
  let best = null;
  const testReturns = [];
  for (const params of configs()) {
    const mTr = runBacktest(new MABreak(params), train, SYMBOL, tf, brokerCfg, FLAT_RISK, null, {}).metrics;
    const mTe = runBacktest(new MABreak(params), test, SYMBOL, tf, brokerCfg, FLAT_RISK, null, {}).metrics;
    testReturns.push(mTe.total_return_pct);
    if (mTr.n_trades < 5) continue;
    // Selection rule uses TRAIN ONLY. Expectancy per trade, not total return, so a config isn't
    // rewarded merely for trading more often.
    if (!best || mTr.expectancy_pct > best.mTr.expectancy_pct) best = { params, mTr, mTe };
  }
  const bh = test.length ? (test[test.length - 1].close / test[0].close - 1) * 100 : 0;
  return { best, avgTest: mean(testReturns), pctPositive: testReturns.filter(r => r > 0).length / testReturns.length * 100, buyHold: bh, trainBars: train.length, testBars: test.length };
}

const results = {};
console.log(`\n=== ${SYMBOL}: identical ${DAYS}-day window for every timeframe, with and without fees ===`);
console.log(`window: ${new Date(START).toISOString().slice(0, 10)} -> ${new Date(END).toISOString().slice(0, 10)}\n`);

for (const tf of TIMEFRAMES) {
  let bars;
  try { bars = await fetchWindow(SYMBOL, tf); }
  catch (e) { console.log(`${tf}: fetch failed - ${e.message}`); continue; }
  if (bars.length < 300) { console.log(`${tf}: only ${bars.length} bars in the window — too few to split, skipping`); continue; }

  const a = atrPct(bars);
  const withFees = trainSelected(bars, tf, REAL_FEES);
  const noFees = trainSelected(bars, tf, NO_FEES);
  const costShare = 0.25 / a; // round-trip cost as a share of one ATR of movement

  results[tf] = {
    bars: bars.length, atr_pct: a, cost_per_atr: costShare, buy_hold_pct: withFees.buyHold,
    with_fees: withFees.best ? { params: withFees.best.params, train: withFees.best.mTr, test: withFees.best.mTe } : null,
    no_fees: noFees.best ? { params: noFees.best.params, train: noFees.best.mTr, test: noFees.best.mTe } : null,
    avg_test_with_fees: withFees.avgTest, avg_test_no_fees: noFees.avgTest,
    pct_positive_with_fees: withFees.pctPositive, pct_positive_no_fees: noFees.pctPositive,
  };

  const w = withFees.best, n = noFees.best;
  console.log(`--- ${tf} (${bars.length} bars, ATR ${a.toFixed(3)}% per bar, round trip costs ${costShare.toFixed(2)}x one ATR)`);
  console.log(`    buy & hold over the test stretch: ${withFees.buyHold.toFixed(2)}%`);
  if (w) console.log(`    WITH fees | train-picked config -> test: n=${w.mTe.n_trades} ret=${w.mTe.total_return_pct.toFixed(2)}% exp=${w.mTe.expectancy_pct.toFixed(3)}%/trade pf=${w.mTe.profit_factor.toFixed(2)}`);
  if (n) console.log(`    NO fees   | train-picked config -> test: n=${n.mTe.n_trades} ret=${n.mTe.total_return_pct.toFixed(2)}% exp=${n.mTe.expectancy_pct.toFixed(3)}%/trade pf=${n.mTe.profit_factor.toFixed(2)}`);
  if (w && n) {
    const drag = n.mTe.expectancy_pct - w.mTe.expectancy_pct;
    console.log(`    -> fees cost ${drag.toFixed(3)}% per trade. Gross edge without fees: ${n.mTe.expectancy_pct.toFixed(3)}%/trade.`);
    console.log(`    -> ${n.mTe.expectancy_pct > 0 ? "There IS a gross edge here" : "No gross edge even at zero cost"} — ${n.mTe.expectancy_pct > 0 && w.mTe.expectancy_pct <= 0 ? "FEES ARE WHAT KILL IT" : n.mTe.expectancy_pct <= 0 ? "so fees are not the whole story" : "and it survives fees"}`);
  }
  console.log(`    across all 144 configs: avg test ${withFees.avgTest.toFixed(2)}% with fees vs ${noFees.avgTest.toFixed(2)}% without; ${withFees.pctPositive.toFixed(0)}% vs ${noFees.pctPositive.toFixed(0)}% positive\n`);
}

writeFileSync(`controlled_${SYMBOL}.json`, JSON.stringify(results, null, 2));
console.log("===== SAME WINDOW, SAME SIZING, ONLY THE BAR LENGTH CHANGES =====");
console.log("tf    ATR/bar   cost/ATR   exp w/fees   exp no-fees   fee drag");
for (const tf of TIMEFRAMES) {
  const r = results[tf]; if (!r || !r.with_fees || !r.no_fees) continue;
  const w = r.with_fees.test.expectancy_pct, n = r.no_fees.test.expectancy_pct;
  console.log(`${tf.padEnd(5)} ${r.atr_pct.toFixed(3)}%    ${r.cost_per_atr.toFixed(2)}x      ${w >= 0 ? "+" : ""}${w.toFixed(3)}%      ${n >= 0 ? "+" : ""}${n.toFixed(3)}%      ${(n - w).toFixed(3)}%`);
}
console.log(`\ndone -- controlled_${SYMBOL}.json`);
