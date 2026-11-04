// For a set-and-forget trade: what a bracket (stop + target) would look like RIGHT NOW on these coins,
// sized by the same ATR rules Rafael's own bots use. No opinion about direction here -- this only answers
// "if I take a position, where do the exits go so I don't have to watch it?"
const SYMS = ["DOGEUSDT", "SOLUSDT"];
const TFS = ["1h", "4h"];

async function klines(s, tf, n = 200) {
  const u = new URL("https://api.binance.us/api/v3/klines");
  u.searchParams.set("symbol", s); u.searchParams.set("interval", tf); u.searchParams.set("limit", n);
  const r = await fetch(u); if (!r.ok) throw new Error(r.status);
  return (await r.json()).map(k => ({ ts: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
}
function atr(bars, n = 14) {
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1].close;
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - p), Math.abs(b.low - p)));
  }
  const last = tr.slice(-n);
  return last.reduce((a, b) => a + b, 0) / last.length;
}
const sma = (v, n) => v.slice(-n).reduce((a, b) => a + b, 0) / n;

for (const s of SYMS) {
  const t = await (await fetch(`https://api.binance.us/api/v3/ticker/24hr?symbol=${s}`)).json();
  const px = +t.lastPrice;
  console.log(`\n===== ${s} =====`);
  console.log(`price ${px}   24h ${(+t.priceChangePercent).toFixed(2)}%   range ${(+t.lowPrice)} - ${(+t.highPrice)}`);
  console.log(`24h volume ${(+t.quoteVolume / 1e6).toFixed(1)}M USDT   spread ${(((+t.askPrice - +t.bidPrice) / +t.bidPrice) * 100).toFixed(4)}%`);
  for (const tf of TFS) {
    const b = await klines(s, tf);
    const closes = b.map(x => x.close);
    const a = atr(b), aPct = a / px * 100;
    const ma50 = sma(closes, 50), ma200 = sma(closes, 200);
    // The project's own rule of thumb: stop 1.5 ATR below, target 3 ATR above -> 1:2 risk/reward.
    const stop = px - 1.5 * a, tgt = px + 3 * a;
    console.log(`  ${tf}: ATR ${a.toPrecision(4)} (${aPct.toFixed(2)}% of price) | price vs 50-bar ${(px / ma50 - 1) * 100 >= 0 ? "+" : ""}${((px / ma50 - 1) * 100).toFixed(2)}% | vs 200-bar ${((px / ma200 - 1) * 100).toFixed(2)}%`);
    console.log(`     bracket -> stop ${stop.toPrecision(6)} (-${(1.5 * aPct).toFixed(2)}%)   target ${tgt.toPrecision(6)} (+${(3 * aPct).toFixed(2)}%)   risk:reward 1:2`);
  }
}
