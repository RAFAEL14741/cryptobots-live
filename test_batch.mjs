// Can one Google News query cover several coins at once? 13 separate per-coin requests every 5 minutes
// would be ~3,700 requests a day and would get throttled. Batched OR-queries keep it to a handful.
const BATCHES = {
  "majors":  'bitcoin OR ethereum OR solana OR "litecoin" OR cardano OR XRP OR avalanche',
  "memes":   'dogecoin OR "shiba inu" OR "pepe coin" OR bonk OR "brett crypto" OR "toshi crypto" OR "mew crypto"',
  "risk":    'crypto hack OR exploit OR rugpull OR delisting OR "trading halted" OR SEC lawsuit crypto',
};
const COINS = ["doge","dogecoin","shib","shiba","pepe","bonk","solana","sol ","bitcoin","btc","ethereum","brett","toshi","mew","avax","xrp","litecoin","cardano","ada "];
function items(xml) {
  const out = []; const re = /<item[\s\S]*?<\/item>/gi; let m;
  while ((m = re.exec(xml))) {
    const t = (m[0].match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
    const d = (m[0].match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || [])[1] || "";
    out.push({ t: t.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").trim(), d });
  }
  return out;
}
for (const [name, q] of Object.entries(BATCHES)) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  const r = await fetch(url, { headers: { "User-Agent": "cryptobots-cloud/1.0" } });
  const body = await r.text();
  const it = items(body);
  const hits = it.filter(x => COINS.some(c => x.t.toLowerCase().includes(c)));
  // how fresh is this feed? news older than a day is context, not a signal
  const now = Date.now();
  const fresh = it.filter(x => x.d && (now - Date.parse(x.d)) < 24 * 3600e3).length;
  console.log(`${name.padEnd(8)} HTTP ${r.status} | ${it.length} items | ${hits.length} name a coin | ${fresh} from the last 24h`);
  for (const h of hits.slice(0, 3)) console.log(`         - ${h.t.slice(0, 85)}`);
  console.log(`         url length ${url.length} chars`);
}
