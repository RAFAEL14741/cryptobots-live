// Rafael's exact question: "what's a good coin to buy right now for 5-min candles over 10 mins?"
// A 10-minute hold on 5-minute candles is a 2-candle trade. So: measure, on real recent data, how far
// these coins actually move in any given 2-candle window, and compare that to the 0.25% it costs to get
// in and out. Also compute the win rate you'd need just to break even at that cost.
const SYMS = ["DOGEUSDT","SOLUSDT","BTCUSDT","ETHUSDT","XRPUSDT","SHIBUSDT","PEPEUSDT","BONKUSDT","AVAXUSDT","LTCUSDT","ADAUSDT"];
const COST = 0.25;      // 0.1% fee in + 0.1% fee out + ~0.05% slippage
const HOLD = 2;         // 2 x 5-minute candles = 10 minutes

async function klines(s, n = 1000) {
  const u = new URL("https://api.binance.us/api/v3/klines");
  u.searchParams.set("symbol", s); u.searchParams.set("interval", "5m"); u.searchParams.set("limit", n);
  const r = await fetch(u); if (!r.ok) throw new Error(r.status);
  return (await r.json()).map(k => ({ high: +k[2], low: +k[3], close: +k[4] }));
}
const median = a => { const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; };

console.log(`\n5-minute candles, ${HOLD}-candle hold (10 minutes). Round trip costs ${COST}%.\n`);
console.log("coin        median 10min move   % of windows beating the fee   need to win   your edge");
const rows = [];
for (const s of SYMS) {
  let b; try { b = await klines(s); } catch (e) { console.log(`${s}: unavailable`); continue; }
  if (b.length < 100) continue;
  const moves = [];
  for (let i = HOLD; i < b.length; i++) moves.push(Math.abs((b[i].close - b[i-HOLD].close) / b[i-HOLD].close * 100));
  const med = median(moves);
  const beat = moves.filter(m => m > COST).length / moves.length * 100;
  // If your average win and average loss are both about one median move, the win rate you need to
  // break even after cost is (move + cost) / (2 * move).
  const need = (med + COST) / (2 * med) * 100;
  rows.push({ s, med, beat, need });
  console.log(`${s.padEnd(11)} ${med.toFixed(3)}%              ${beat.toFixed(1).padStart(5)}%                    ${need > 100 ? "impossible" : need.toFixed(0)+"%"}      ${(50 - need).toFixed(0)}%`);
}
rows.sort((a,b) => a.need - b.need);
console.log(`\nleast-bad of a bad set: ${rows[0].s} still needs to be right ${rows[0].need > 100 ? "more than 100%" : rows[0].need.toFixed(0)+"%"} of the time`);
console.log(`hours of 5-min data checked per coin: ${(1000*5/60).toFixed(0)}`);
