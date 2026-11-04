// Which news sources actually work from a datacenter IP (GitHub Actions), and which ones actually
// mention Rafael's specific coins? Reddit already fails this test -- it blocks datacenter IPs outright.
// A feed that returns 200 but never names DOGE or SHIB is useless to him no matter how good the site is.
const COINS = ["doge","dogecoin","shib","shiba","pepe","bonk","solana","sol ","bitcoin","btc","ethereum","brett","toshi","mew","avax","xrp","litecoin","cardano","ada "];

const CANDIDATES = [
  // general crypto press
  ["CoinDesk",        "https://www.coindesk.com/arc/outboundfeeds/rss/"],
  ["Cointelegraph",   "https://cointelegraph.com/rss"],
  ["Decrypt",         "https://decrypt.co/feed"],
  ["CryptoSlate",     "https://cryptoslate.com/feed/"],
  ["BeInCrypto",      "https://beincrypto.com/feed/"],
  ["NewsBTC",         "https://www.newsbtc.com/feed/"],
  ["AMBCrypto",       "https://ambcrypto.com/feed/"],
  ["CryptoBriefing",  "https://cryptobriefing.com/feed/"],
  ["Bitcoin.com",     "https://news.bitcoin.com/feed/"],
  ["CoinJournal",     "https://coinjournal.net/feed/"],
  ["ZyCrypto",        "https://zycrypto.com/feed/"],
  ["U.Today",         "https://u.today/rss"],
  ["TheDefiant",      "https://thedefiant.io/api/feed"],
  // coin-specific via Google News search (free, no key, per-coin)
  ["GNews:dogecoin",  "https://news.google.com/rss/search?q=dogecoin&hl=en-US&gl=US&ceid=US:en"],
  ["GNews:solana",    "https://news.google.com/rss/search?q=solana&hl=en-US&gl=US&ceid=US:en"],
  ["GNews:shiba",     "https://news.google.com/rss/search?q=shiba+inu+crypto&hl=en-US&gl=US&ceid=US:en"],
  ["GNews:hack",      "https://news.google.com/rss/search?q=crypto+hack+OR+exploit+OR+delisting&hl=en-US&gl=US&ceid=US:en"],
  // exchange announcements -- delistings and halts, the highest-value risk source
  ["Binance announce","https://www.binance.com/en/support/announcement/c-48?navId=48"],
];

function items(xml) {
  const out = [];
  const re = /<(item|entry)[\s\S]*?<\/(item|entry)>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const blk = m[0];
    const t = (blk.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
    out.push(t.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").trim());
  }
  return out;
}

for (const [name, url] of CANDIDATES) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(url, { headers: { "User-Agent": "cryptobots-cloud/1.0" }, signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) { console.log(`${name.padEnd(18)} HTTP ${r.status}  -- unusable`); continue; }
    const body = await r.text();
    const titles = items(body);
    if (!titles.length) { console.log(`${name.padEnd(18)} 200 but no RSS items parsed (${body.length} bytes) -- probably HTML, unusable`); continue; }
    const hits = titles.filter(t => COINS.some(c => t.toLowerCase().includes(c)));
    console.log(`${name.padEnd(18)} ${String(titles.length).padStart(3)} items | ${String(hits.length).padStart(3)} mention his coins | e.g. "${(hits[0] || titles[0]).slice(0, 70)}"`);
  } catch (e) {
    console.log(`${name.padEnd(18)} FAILED (${String(e.message || e).slice(0,40)}) -- unusable`);
  }
}
