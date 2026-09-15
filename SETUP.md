# Getting the bots running on GitHub (free, doesn't stop)

This turns the bots' "brain" over to GitHub's own servers, so they keep checking the market on a schedule
whether or not your Mac or Chrome is on. Free, no credit card. About 5 minutes of clicking, once.

## 1. Create a GitHub account (skip if you have one)
Go to github.com → Sign up. Free plan, no card needed.

## 2. Create a new repository
Click the **+** in the top right → **New repository**.
- Name it something like `cryptobots-live`
- Keep it **Public** (this is what makes GitHub Actions free with no minute limit, and lets the dashboard
  read the bots' data with no login)
- Do **not** check "Add a README" — leave it empty
- Click **Create repository**

## 3. Upload the files
On the new repo's empty page, click **"uploading an existing file"**.
Unzip `cryptobots-cloud.zip` and drag in these 7 files (not the zip itself):
`config.json`, `engine.mjs`, `run.mjs`, `package.json`, `state.json`, `log.json`, `index.html`
Scroll down, click **Commit changes**.

## 4. Add the one file GitHub needs to run it on a schedule
This one's inside a folder starting with a dot, which is easy to miss when dragging from Finder — easier to
just create it directly on GitHub:
- Click **Add file → Create new file**
- In the "Name your file" box, type exactly: `.github/workflows/run-bots.yml` (the slashes create the folders
  for you)
- Open `run-bots.yml` from the unzipped folder, copy its contents, paste into the box
- Click **Commit changes**

## 5. Run it once to check it works
- Click the **Actions** tab near the top of the repo
- Click **"Run bots"** in the left sidebar, then the **"Run workflow"** button on the right, then the green
  **Run workflow** button in the dropdown
- Wait ~30 seconds, refresh — you should see a run with a green checkmark. Click into it if you want to see
  what it did.
- After that it repeats automatically every ~5 minutes, forever, for free — you don't need to touch anything.

## 6. Watch the bots
Open `index.html` (double-click it — works straight from your Downloads/Desktop folder, no server needed).
Type your repo as `yourusername/cryptobots-live` in the box at the top and click Save. It'll show live prices,
balances, trades and the "what it's doing right now" status for all 10 bots, refreshing every 30 seconds.

## How it keeps the numbers honest

Three rules are built into `run.mjs` on purpose. They're why the balances mean something:

**No time-travel fills.** Checking every 5 minutes means a 1-minute bot can wake up with several bars already
closed. Buying at the close of a bar that passed four minutes ago would book a price the bot could never have
gotten. So entries are only taken from the newest closed bar, at the current price. Entry signals that fired
while it wasn't looking are counted and shown on the card ("3 entry signals skipped"), never quietly taken.
That number is the real cost of checking on a schedule — it should be visible, not hidden.

**Exits work differently, deliberately.** A stop-loss or take-profit is a resting order: it really would have
filled at its level while nobody was watching, so those replay against the historical bar. A strategy exit
(like "the MA crossed back down") found on a missed bar is still honored, but filled at the current price —
that's what a late-but-real exit looks like. Missing an exit entirely would be worse than a late one.

**Sentiment doesn't block trades.** Every bot's params were grid-searched on real history with sentiment off.
Letting a Reddit score block entries live would mean running a setup that was never validated. So sentiment is
computed and displayed, but can't block a trade. Set `"sentiment_gates_trades": true` in `config.json` to turn
it back into a filter — just know that's then an unvalidated change layered on validated params.

## If Binance is unreachable

GitHub's runners are datacenter IPs, and exchanges sometimes block those. If Binance.US fails twice in a row,
each bot automatically falls back to Kraken's public API (no key needed). Verified against the live API: all 8
coins and all 4 timeframes work, bar timestamps line up exactly with Binance's, and prices differ by 0.02–0.36%
(Kraken quotes USD, Binance quotes USDT). Whichever source was used is recorded per bot and shown on the
dashboard, so you always know where a number came from. If both fail, that bot does nothing that cycle and says
so — it never guesses a price.

## Changing a bot's settings later
Ask Claude, or edit `config.json` directly on GitHub (click the file, click the pencil icon, change a value,
commit) — takes effect on the next 5-minute cycle. Balances and trade history live in `state.json` and are
never touched by a config change.
