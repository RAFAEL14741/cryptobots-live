// Rafael's question, tested properly: "most of them are green — shouldn't they be buying?"
//
// Right now 7 of 16 bots sit in "already crossed": the fast MA is ALREADY above the slow one (the bullish
// condition is TRUE) and they still won't buy, because the rule only fires on the exact bar where the lines
// cross. Miss that bar and the bot waits for the lines to cross back down and up again -- which can be weeks.
// brett_4h is currently 9% above with no gap requirement at all, and it is sitting out.
//
// So: is the strict rule actually earning that patience, or is it just missing money? Three entry rules,
// same exits, same fees, same chronological 70/30 split, every live bot's real settings:
//
//   A  CROSS ONLY (what's running now) -- buy only on the bar the lines cross, if the gap clears the threshold.
//   B  STAY LONG WHILE ABOVE           -- buy any time fast is above slow by the threshold, whenever that's true.
//   C  PRICE ABOVE THE LINE            -- the simplest "it's going up" rule: buy when price is over its slow MA.
//
// B is the one that answers his question directly: it's "if it's green, be in it."
import { sma, ema, atr, runBacktest } from "./engine.mjs";
import { readFileSync, writeFileSync } from "fs";

const cfg = JSON.parse(readFileSync("config.json", "utf8"));
const WANT = { "1m": 20000, "5m": 12000, "15m": 8000, "1h": 6300, "4h": 2000, "1d": 900 };

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

// Exits are identical across all three variants so the ONLY thing being compared is when you get in.
function exitSignal(p, bars, ctx, f0, s0, a0, L) {
  const crossDown = ctx.__f1 >= ctx.__s1 && f0 < s0;
  if (crossDown) return { action: "close", reason: "MA cross down", confidence: 1 };
  const trail = +p.trail_atr;
  if (trail > 0 && ctx.position) {
    const since = bars.filter(b => b.ts >= ctx.position.entry_ts).map(b => b.high);
    if (!since.length) since.push(bars[L].high);
    const ns = Math.max(...since) - trail * a0;
    if (ctx.position.stop_loss == null || ns > ctx.position.stop_loss) return { action: "update_stop", reason: "trail", confidence: 1, stop_loss: ns };
  }
  return null;
}

class Variant {
  constructor(params, mode) { this.p = params; this.mode = mode; }
  get warmup() { return Math.max(+this.p.slow, +this.p.atr_len) + 2; }
  onBar(bars, ctx) {
    const p = this.p; if (bars.length < this.warmup) return null;
    const closes = bars.map(b => b.close), f = p.ma_type === "ema" ? ema : sma;
    const fast = f(closes, +p.fast), slow = f(closes, +p.slow), a = atr(bars, +p.atr_len), L = bars.length - 1;
    const f0 = fast[L], s0 = slow[L], f1 = fast[L - 1], s1 = slow[L - 1], a0 = a[L];
    if ([f0, s0, f1, s1, a0].some(x => x == null)) return null;
    ctx.__f1 = f1; ctx.__s1 = s1;
    const gap = (f0 - s0) / s0 * 100, price = bars[L].close;
    const crossUp = f1 <= s1 && f0 > s0;

    if (ctx.position) return exitSignal(p, bars, ctx, f0, s0, a0, L);

    let enter = false;
    if (this.mode === "A") enter = crossUp && gap > +p.break_pct;                    // only on the cross bar
    else if (this.mode === "B") enter = f0 > s0 && gap > +p.break_pct;               // any time it's above
    else if (this.mode === "C") enter = price > s0;                                  // price over the slow line
    if (!enter) return null;
    return { action: "buy", reason: this.mode, confidence: 1, stop_loss: price - +p.sl_atr * a0, take_profit: price + +p.tp_atr * a0 };
  }
}

const brokerCfg = { starting_cash: 10000, fee_pct: 0.1, slippage_pct: 0.05 };
const r2 = v => Math.round(v * 100) / 100;
const rows = [];

for (const b of cfg.bots) {
  if (b.strategy !== "ma_break") continue;          // the scalper uses a different rule entirely
  let bars;
  try { bars = await fetchBinance(b.symbol, b.timeframe, WANT[b.timeframe] || 3000); }
  catch (e) { console.log(`${b.name}: fetch failed`); continue; }
  if (bars.length < 400) continue;
  const si = Math.floor(bars.length * 0.7), train = bars.slice(0, si), test = bars.slice(si);

  const out = { name: b.name, symbol: b.symbol, tf: b.timeframe };
  for (const mode of ["A", "B", "C"]) {
    const tr = runBacktest(new Variant(b.params, mode), train, b.symbol, b.timeframe, brokerCfg, {}, null, {}).metrics;
    const te = runBacktest(new Variant(b.params, mode), test, b.symbol, b.timeframe, brokerCfg, {}, null, {}).metrics;
    out[mode] = { train_n: tr.n_trades, train_ret: r2(tr.total_return_pct), test_n: te.n_trades, test_ret: r2(te.total_return_pct), test_exp: Math.round(te.expectancy_pct * 1000) / 1000, test_pf: te.profit_factor === Infinity ? 99 : r2(te.profit_factor), test_dd: r2(te.max_drawdown_pct) };
  }
  out.buy_hold = r2(test.length ? (test[test.length - 1].close / test[0].close - 1) * 100 : 0);
  rows.push(out);
  console.log(`${b.name.padEnd(12)} A(cross only) test n=${String(out.A.test_n).padStart(3)} ret=${String(out.A.test_ret).padStart(7)}%  |  B(stay long while above) n=${String(out.B.test_n).padStart(3)} ret=${String(out.B.test_ret).padStart(7)}%  |  C(price>MA) n=${String(out.C.test_n).padStart(3)} ret=${String(out.C.test_ret).padStart(7)}%  |  hold ${out.buy_hold}%`);
}

writeFileSync("entry_rule_results.json", JSON.stringify(rows, null, 2));

const sum = m => ({
  trades: rows.reduce((a, r) => a + r[m].test_n, 0),
  ret: rows.reduce((a, r) => a + r[m].test_ret, 0) / rows.length,
  exp: rows.reduce((a, r) => a + r[m].test_exp, 0) / rows.length,
  wins: rows.filter(r => r[m].test_ret > 0).length,
  dd: rows.reduce((a, r) => a + r[m].test_dd, 0) / rows.length,
});
console.log("\n===== ON DATA NONE OF THEM HAD EVER SEEN =====");
console.log("rule                        trades   avg return   avg per trade   bots profitable   avg worst drop");
for (const [m, label] of [["A", "A cross only (running now)"], ["B", "B stay long while above   "], ["C", "C price above the line    "]]) {
  const s = sum(m);
  console.log(`${label}  ${String(s.trades).padStart(5)}   ${s.ret >= 0 ? "+" : ""}${s.ret.toFixed(2)}%       ${s.exp >= 0 ? "+" : ""}${s.exp.toFixed(3)}%          ${s.wins}/${rows.length}            -${s.dd.toFixed(2)}%`);
}
console.log(`\njust holding the coins: ${(rows.reduce((a, r) => a + r.buy_hold, 0) / rows.length).toFixed(2)}% average`);
console.log("\ndone -- entry_rule_results.json");
