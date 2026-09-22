# Crypto research v2 — frozen protocol

Written 2026-09-10 before downloading or viewing this experiment's results.

Purpose: test slower, cost-aware crypto rules; no promise of profitability and no automatic live activation. The previous 2026 experiment is already observed and is not a fresh holdout.

## Data and separation

- Bybit linear USDT perpetual BTC, ETH, SOL, chosen for a focused liquid universe, not by measured strategy returns. This is still a present-day survivor selection.
- Fifteen-minute candles, 2025-01-01 through 2026-01-01 exclusive; 30 preceding days for indicator warmup. Actual historical funding, using contract candle open as funding mark approximation.
- Development: January–June 2025. Validation: July–December 2025, accounts reset, indicators retain past history. This is a separate retrospective historical validation, not a prospective test after today's research decisions.
- All four candidates frozen below. Select by highest development mean net R, at least 30 trades, positive net return, profit factor >=1.15, max drawdown <=15%. If none qualify: select none. Report all validation results, do not substitute a validation winner. No parameter search or revisions after results.

## Rules

All decisions use fully closed 1h candles; 4h EMA20/EMA50 direction uses only complete 4h candles. 1h ATR14 uses Wilder smoothing. Efficiency is absolute 24h displacement divided by sum of absolute hourly changes.

1. **Breakout**: close beyond previous 24 hourly highs/lows, matching 4h close/EMA20/EMA50 direction, volume >=1.2 times previous 24h average. Stop 2 ATR, target 4R, trailing 3 ATR from closed hourly close, max holding 72h.
2. **Pullback**: matching 4h trend, current hour touches EMA20 and closes back on trend side, close advances in trend direction. Stop beyond last six hourly lows/highs plus 0.1 ATR; distance 1.5–4 ATR. Target 3R, max holding 48h.
3. **Range**: efficiency <0.2, previous close outside its 24h mean +/-2 population standard deviations and current close reenters its band. Target current 24h mean; stop 1.5 ATR. Max holding 24h.
4. **Regime**: breakout only at efficiency >=0.35, range only below 0.2; otherwise no entry. Same component exits. This fixed combination is a separate candidate, not a tuned selector.

## Execution and account

- Entry at next 15m open with adverse slippage, revalidate direction/geometry. Fixed targets/stops from signal; reject initial stop distance outside 0.5–6% of entry or below five times estimated round-trip costs. Require >=1.5 net reward/risk after fees/slippage.
- 0.055% taker fee per side; 5bp slippage per side, separate 10bp stress rerun. Funding charged only on positions already open at funding timestamp; positive funding paid by longs and received by shorts.
- 0.5% current equity risk including estimated stop exit cost; notional capped at 2x equity. One position across three symbols. Highest expected net reward/risk first, then BTC/ETH/SOL tie order. Six-hour cooldown per coin following exit. No same-bar reentry after exit.
- Stops before targets if both touched; gaps through stop fill at worse open. Stop updated from closed hour applies only to next execution bar. Time exit at next bar open after deadline, with gap-through-stop precedence. No intrabar stop revision.
- Start 100 per period/cost/candidate. Account arithmetic is uncapped synthetic P/L; negative equity halts. Low leverage is an exposure cap, not an exact exchange margin/liquidation model. No mark-price, liquidation-tier, spread, queue, market-impact or minimum-order-size model.
- Max drawdown sampled every 15m close after estimated closing costs. Period end closes remaining positions.

## Reporting and gates

Report returns, drawdown, trades, PF, net R, fees, funding, gross before fees/funding (still includes slippage), monthly and coin concentration, and removal of five best trades. Weekly block bootstrap 95% mean-R intervals, including inactive weeks, is exploratory, not corrected for four comparisons.

A candidate is only eligible for future paper testing if selected on development and validation return >0, PF>=1.15, >=30 trades, drawdown <=15%, positive under double slippage and after removing five best trades, positive in at least two coins and three months. These gates are research heuristics, not proof of future profitability. No qualifying candidate means keep it out of the live signal/account code.

Sources: [Bybit candles](https://bybit-exchange.github.io/docs/v5/market/kline), [funding](https://bybit-exchange.github.io/docs/v5/market/history-fund-rate). Historical momentum findings motivate investigation, not these parameters or claimed profitability: [Liu and Tsyvinski](https://www.nber.org/papers/w24877).
