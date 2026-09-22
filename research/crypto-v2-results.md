# Crypto v2: slower, cost-aware strategies

Generated 2026-09-10T21:38:46.158Z. Research only; live strategy and account unchanged.

Development-selected candidate: **none**. All paper-test gates passed: **no**.

## Method

[Predeclared protocol](crypto-v2-protocol.md). Three Bybit linear perpetuals, BTC/ETH/SOL; 37,920 continuous 15m candles and 1,095 funding observations each. Closed 1h signals and closed 4h trend. 0.055% fees and 5bp adverse slippage per side, actual funding with candle-open mark approximation. Estimated risk including stop costs 0.5% of equity, exposure capped at 2x, one position. Results are synthetic.

This is fresh-to-this-experiment 2025 data, split chronologically; the strategy ideas were devised later in 2026. It is retrospective validation, not prospective evidence or a direct same-period comparison to the old strategy. Four attempts add selection bias. No parameter search was conducted.

## Development: January–June 2025

| Strategy | Trades | Net return | Max DD | PF | Net R/trade | Win rate |
|---|---:|---:|---:|---:|---:|---:|
| breakout | 100 | -0.84% | 6.36% | 0.97 | -0.011 | 28.0% |
| pullback | 113 | -4.88% | 9.91% | 0.86 | -0.084 | 33.6% |
| range | 2 | -0.03% | 0.77% | 0.93 | -0.032 | 50.0% |
| regime | 63 | -0.20% | 7.93% | 0.99 | 0.000 | 27.0% |

## Validation: July–December 2025

| Strategy | Trades | Net return | Max DD | PF | Net R/trade | Win rate |
|---|---:|---:|---:|---:|---:|---:|
| breakout | 87 | 1.43% | 8.01% | 1.06 | 0.038 | 35.6% |
| pullback | 113 | -11.30% | 15.28% | 0.70 | -0.208 | 30.1% |
| range | 2 | 0.26% | 0.79% | 1.51 | 0.262 | 50.0% |
| regime | 57 | 1.13% | 6.52% | 1.07 | 0.045 | 31.6% |

## Validation robustness

| Strategy | 95% weekly bootstrap net R | Double slippage return | P/L minus best 5 trades |
|---|---:|---:|---:|
| breakout | -0.224 to 0.317 | -0.01% | $-7.85 |
| pullback | -0.415 to 0.014 | -16.33% | $-17.99 |
| range | n/a | -0.50% | $0.00 |
| regime | -0.255 to 0.377 | -0.14% | $-7.83 |

Bootstrap uses 27 weekly blocks including inactive weeks, 4,000 deterministic resamples; approximate and not adjusted for multiple comparisons. Intervals are suppressed below 30 trades or three active weeks: the original calculation produced a misleading zero-width interval for two range trades in one week. This reporting correction was made after the first run; no trading rules, selection gates or P/L changed. Removing best trades subtracts realized trade P/L, without resizing later trades. Double slippage changes the entry filter and therefore trade selection.

## Validation attribution

### breakout

- Gross P/L before fees/funding, still after slippage: $4.14; fees: $2.53; net funding paid: $0.18.
- Coin P/L: SOL $-1.38, ETH $6.69, BTC $-3.88.
- Monthly P/L: 2025-07 $2.20, 2025-08 $2.47, 2025-09 $-0.11, 2025-10 $2.25, 2025-11 $-0.82, 2025-12 $-4.57.

### pullback

- Gross P/L before fees/funding, still after slippage: $-8.10; fees: $3.09; net funding paid: $0.11.
- Coin P/L: SOL $-9.25, ETH $0.99, BTC $-3.04.
- Monthly P/L: 2025-07 $2.53, 2025-08 $1.23, 2025-09 $-4.55, 2025-10 $-6.48, 2025-11 $0.32, 2025-12 $-4.36.

### range

- Gross P/L before fees/funding, still after slippage: $0.30; fees: $0.04; net funding paid: $-0.00.
- Coin P/L: SOL $0.76, ETH $-0.50.
- Monthly P/L: 2025-11 $0.26.

### regime

- Gross P/L before fees/funding, still after slippage: $2.84; fees: $1.54; net funding paid: $0.16.
- Coin P/L: ETH $3.62, SOL $-0.67, BTC $-1.82.
- Monthly P/L: 2025-07 $1.87, 2025-08 $0.91, 2025-09 $1.71, 2025-10 $0.78, 2025-11 $-0.39, 2025-12 $-3.74.

## Limits and reproduction

No order-book, tick sequencing, spread, minimum order size, mark-price liquidation or exchange margin-tier model. Stops precede targets on ambiguous candles; drawdown sampled at 15m closes, not every intrabar extreme. Risk sizing cannot prevent losses beyond a stop during gaps. Selected coins are current survivors. Funding timestamps/coverage and all price candles were validated; trade cash flows, capital reconciliation and nonoverlap were independently audited.

Run `node research/crypto-v2-data.mjs --download`, `node --test tests/crypto-v2.test.mjs`, then `node research/crypto-v2-backtest.mjs`. Raw histories, full trades, daily equity and SHA-256 fingerprints are local in `.matning/crypto-v2/`.

Sources: [Bybit candles](https://bybit-exchange.github.io/docs/v5/market/kline), [Bybit funding](https://bybit-exchange.github.io/docs/v5/market/history-fund-rate). [Historical momentum research](https://www.nber.org/papers/w24877) motivates testing; it does not validate these rules.
