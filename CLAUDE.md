# CLAUDE.md — cryptobots-live

**What:** Crypto signal + PAPER-trading bots run by GitHub Actions every 5 min. No live-money mode.
**Project card:** `projects/trading-bots.md` in the private vault repo `RAFAEL14741/claude-brain`. Read it first.

## How it works
- `.github/workflows/run-bots.yml` (schedule + manual dispatch only) runs `node run.mjs` and commits `state.json` / `log.json` back.
- Core: `engine.mjs` (rules), `run.mjs` (one cycle), `config.json` (bots). Dashboard: `index.html`. Setup: `SETUP.md`.
- Other `*.mjs` / `*_results.json` = one-off experiments.

## Rules
- The bot commits every ~5 min: always `git pull --rebase` before you push.
- PUBLIC repo: secret-scan before every push. No exchange keys, ever.
- Claude does not execute trades or give buy/sell calls. Education + bot code only.
