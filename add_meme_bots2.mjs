// Round 2: adds the bots that actually cleared the bar from meme_search2_results.json.
// Picked one timeframe per coin (the steadier one when both existed), matching the profit-factor and
// trade-count range of the bots already shipped (shib_1h/pepe_4h/bonk_4h: test n=8-14, test pf 1.3-1.7).
//
// Rejected on purpose despite technically passing the script's train/test-positive filter:
//   NEIRO   - 0 configs passed either timeframe, no real edge found.
//   POPCAT  - test profit factor 21-28x off only 6-7 trades. That's not an edge, that's one huge trade
//             carrying the whole result -- same trap as WIF/FLOKI before it.
//   PNUT    - test n=4, too thin to trust.
//   MOODENG - test n=3-4, AND a 144% train return that's almost certainly one outlier pump, not a pattern.
//   TURBO   - test n=5 with a 6.97x profit factor is still too thin to separate real edge from luck.
import { readFileSync, writeFileSync } from "fs";
const cfg = JSON.parse(readFileSync("config.json", "utf8"));
const results = JSON.parse(readFileSync("meme_search2_results.json", "utf8"));

const TO_ADD = [
  { name: "mew_4h", symbol: "MEWUSDT", timeframe: "4h", key: "MEWUSDT_4h" },
  { name: "brett_4h", symbol: "BRETTUSDT", timeframe: "4h", key: "BRETTUSDT_4h" },
  { name: "toshi_1h", symbol: "TOSHIUSDT", timeframe: "1h", key: "TOSHIUSDT_1h" },
];

const round2 = v => Math.round(v * 100) / 100;
const toValidatedSplit = m => ({
  n_trades: m.n_trades, win_rate_pct: round2(m.win_rate_pct), total_return_pct: round2(m.total_return_pct),
  profit_factor: m.profit_factor === Infinity ? 99 : round2(m.profit_factor),
  max_drawdown_pct: round2(m.max_drawdown_pct), buy_hold_pct: round2(m.buy_hold_pct),
});

for (const b of TO_ADD) {
  if (cfg.bots.some(x => x.name === b.name)) { console.log(`${b.name} already exists, skipping`); continue; }
  const r = results[b.key];
  cfg.bots.push({
    name: b.name, symbol: b.symbol, timeframe: b.timeframe, strategy: "ma_break", mode: "signal",
    lookback_bars: 300,
    params: r.top.params,
    broker: { starting_cash: 10000, fee_pct: 0.1, slippage_pct: 0.05 },
    risk: {},
    sentiment: { enabled: true, keywords: [b.symbol.replace("USDT", "").toLowerCase()], subreddits: ["CryptoCurrency", "CryptoMarkets", "SatoshiStreetBets"], window_hours: 6, min_polarity: -0.2, min_attention_z: -1, block_on_risk_flag: true },
    validated: {
      as_of: new Date().toISOString().slice(0, 10),
      train: toValidatedSplit(r.top.train),
      test: toValidatedSplit(r.top.test),
    },
  });
  console.log(`added ${b.name}: train n=${r.top.train.n_trades} win=${r.top.train.win_rate_pct.toFixed(0)}% / test n=${r.top.test.n_trades} win=${r.top.test.win_rate_pct.toFixed(0)}%`);
}

writeFileSync("config.json", JSON.stringify(cfg, null, 2) + "\n");
console.log("bot count now:", cfg.bots.length);
