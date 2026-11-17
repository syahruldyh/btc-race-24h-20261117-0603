[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/syahruldyh/btc-race-24h-20261117-0603/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/syahruldyh/btc-race-24h-20261117-0603/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
Entry for the [btc-race-24h-20261117-0603 bounty](https://make.fun/bounty/btc-race-24h-20261117-0603) on make.fun.

# Hybrid Dip + Breakout Bot — BTC Race 24h

A bot that trades cbBTC against USDC, one minute at a time, on a
$1,000 paper account. It only ever buys; it never shorts, never uses
leverage, and never holds more than one position.

## The idea

A flat, choppy day does not reward chasing every wiggle — each round
trip costs roughly 26 basis points in fees, slippage and pool impact,
so a trade has to catch a move clearly bigger than that. This bot
therefore waits for two kinds of moments and ignores everything else:

1. **A dip that has stopped falling.** When the close drops far below
   its 60-minute average and the latest low is no lower than the one
   before it, the bot buys with the full cash balance. The distance
   that counts as "far" adapts to how jumpy the market has been: at
   least 0.70% under the average, more when recent one-minute returns
   have been wild. The wildness is measured on a window that ends 29
   bars ago, so the dip itself cannot push its own bar higher.
2. **A genuine breakout.** When the close prints above the highest
   high of the last 120 minutes, closes higher than the previous bar,
   and sits at least 1.50% above where it was an hour ago, the bot
   buys with half the cash. Breakouts whipsaw more than dips, so they
   get half the size and a slightly wider trailing stop.

The two legs share one wallet: entries only happen while flat, so
they can never stack exposure. After a buy fills the bot waits 60
bars before the next entry; after a sell fills it waits 30 bars. If
the running equity drawdown ever passes 10%, it stops opening new
trades entirely (the competition's own guardrail is 25%).

## Exits

Every position leaves the same way, whichever leg opened it:

- take profit at +1.60% from the fill price,
- trailing stop 0.80% under the best close since the fill (1.00% for
  breakout entries),
- hard stop at -2.00% from the fill price.

Whichever trips first sells the whole position.

## The last-resort trade

If bar 1200 of the window arrives and no buy has ever filled, the bot
tries one small 15% position toward the one-trade guardrail. It is
only an attempt — the order can still be rejected, so it does not
guarantee the window ends with a trade. On any window where the dip or
breakout legs fire, this never happens. The position exits under the
same rules as any other trade.

## How it runs

The bot speaks the `agent-fun/bars-replay/v1` protocol through the
kit's SDK shim (copied byte-for-byte into `vendor/`). It reads one
closed bar per batch, decides from completed bars only, and its
orders fill at the next bar's open. It uses no clock, no network, no
files outside the repository and no randomness, so the same bars
always produce the same orders. Entry prices are taken from the fills
the harness reports, never from the close the decision was made on,
and the bot never sends a second order while the previous one's fill
has not been reported yet.

No new trade is opened during warm-up batches or in the last 40
scored bars, and every order carries a 150 bp maximum slippage from
the last close seen.

## Files

- `main.ts` — the whole bot.
- `vendor/makefun-bars.ts` — the kit's protocol shim, unchanged.
- `README.md` — this file.
- `LICENSE` — MIT.
