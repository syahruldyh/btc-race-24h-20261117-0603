// Hybrid dip + breakout bot for the 24h cbBTC race.
//
// Idea in one paragraph: most of the money in a choppy 24h window comes
// from buying a sharp pullback after it stops falling and riding the
// snap-back, and the rest comes from catching a genuine upside break
// when one finally shows up. So this bot has two ways in, one shared
// wallet, and no way to be in twice at once: entries only ever happen
// while flat, a dip entry takes the whole cash pile, a breakout entry
// takes half, and a tiny last-resort entry exists only so the bot never
// ends a dead window with zero fills. Every exit is mechanical: take
// profit, trail the peak, or stop out. Nothing here reads the clock,
// the network, or the environment; the only inputs are closed bars and
// the fills the harness reports, so the same bars always give the same
// orders.
//
// Costs that shape every number below: a full-size round trip pays
// about 26 bps (4 bps fee + 2 bps modelled slippage + roughly 7 bps of
// pool impact on each side at this depth), so a trade must catch a move
// clearly bigger than that. The take-profit sits at +1.60% and the
// trailing stop at 0.80% (1.00% for breakouts), both far above the
// round-trip cost, while the dip trigger sits at 0.70% below the
// 60-minute average, scaled up when the market has been jumpy.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- Dip leg -------------------------------------------------------------
// Buy when the close sits this far under its 60-bar average, but only
// after the fall has paused: the latest low must not be lower than the
// one before it. The distance is not a fixed line in the sand: it is
// the larger of a 70 bp floor and eight times the recent one-minute
// return dispersion, capped at 130 bp. The dispersion is measured on a
// window that ends 29 bars ago, so the dip itself cannot inflate it
// and raise its own bar. In a quiet market the floor binds; in a jumpy
// one the bar rises and noise dips stop qualifying.
const DIP_AVG_BARS = 60;
const DIP_FLOOR_BPS = 70;
const DIP_VOL_MULT = 8;
const DIP_VOL_CAP_BPS = 130;
const DIP_VOL_BARS = 120;
const DIP_VOL_LAG_BARS = 30;

// --- Breakout leg --------------------------------------------------------
// Buy only a real break, not a wiggle: the close must print above the
// highest high of the last 120 bars, close higher than the previous
// bar, and sit at least 1.50% above where it was 60 bars ago. Half
// size, because upside chases whipsaw more than dips do.
const BREAK_HIGH_BARS = 120;
const BREAK_MOM_BARS = 60;
const BREAK_MOM_BPS = 150;
const BREAK_SIZE_NUM = 1;
const BREAK_SIZE_DEN = 2;

// --- Exits ---------------------------------------------------------------
// Take profit at +1.60% from the fill. Trail 0.80% under the best close
// since the fill (1.00% for breakout entries, which run hotter). Hard
// stop at -2.00% from the fill. Whichever trips first sells everything.
const TAKE_PROFIT_BPS = 160;
const TRAIL_DIP_BPS = 80;
const TRAIL_BREAK_BPS = 100;
const HARD_STOP_BPS = 200;

// --- Discipline ----------------------------------------------------------
// Shared exposure cap: entries only happen while flat, so the two legs
// can never stack. After a buy fills, wait 60 bars before the next
// entry; after a sell fills, wait 30 bars, so the bot cannot re-enter
// the same chop it just left. Stop opening new trades once the running
// equity drawdown passes 10%, far inside the 25% guardrail. Never open
// a trade in the last 40 scored bars: there would be no room left to
// exit it on purpose.
const BUY_COOLDOWN_BARS = 60;
const EXIT_COOLDOWN_BARS = 30;
const MAX_DRAWDOWN_BPS = 1000;
const NO_ENTRY_AFTER_SCORED_BAR = 1400;

// --- Participation fallback ----------------------------------------------
// If bar 1200 of the scored window arrives with zero filled buys, take
// one small 15% position toward the one-trade guardrail. It only
// tries: the order can still be rejected, so it guarantees nothing. It exits
// under the same rules as any other trade. On a lively window this
// never fires.
const FALLBACK_SCORED_BAR = 1200;
const FALLBACK_SIZE_NUM = 15;
const FALLBACK_SIZE_DEN = 100;

// An order may fill up to 150 bp away from the last close we were sent;
// the modelled slippage and the order's own impact count toward that,
// and the biggest one-minute move in the dev window was 45 bp.
const MAX_SLIPPAGE_BPS = 150;

// --- Small helpers -------------------------------------------------------

function average(values: number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

// Population dispersion of a list of returns, in basis points.
function dispersionBps(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = average(returns);
  let sq = 0;
  for (const r of returns) {
    const d = r - mean;
    sq += d * d;
  }
  return Math.sqrt(sq / returns.length);
}

// --- Bot state -----------------------------------------------------------
// All of this is rebuilt from the bars and fills the harness sends, so a
// replay over the same bars walks the same path every time.

const closes: number[] = [];
const highs: number[] = [];
const lows: number[] = [];
// One-minute log returns in basis points, aligned with closes.
const oneMinReturnsBps: number[] = [];

let scoredBars = 0;
let entryPrice = 0;
let peakSinceEntry = 0;
let entryLeg = '';
let filledBuys = 0;
let lastBuyBar = -1000000;
let lastExitBar = -1000000;
let peakEquity = 1000000000n;
// True from the batch an order is decided on until the batch its fill
// (or rejection) is reported. While it is set the bot sends nothing
// else, so a delayed fill report can never turn one decision into two
// orders for the same fill.
let awaitingFill = false;

function holding(state: BarsState): boolean {
  const pos = state.positions.get(SYMBOL);
  return pos !== undefined && pos.qty > 0n;
}

function dipThresholdBps(): number {
  const end = closes.length - DIP_VOL_LAG_BARS;
  const start = end - DIP_VOL_BARS;
  if (start < 0) return DIP_FLOOR_BPS;
  const window = oneMinReturnsBps.slice(start, end);
  const scaled = DIP_VOL_MULT * dispersionBps(window);
  if (scaled <= DIP_FLOOR_BPS) return DIP_FLOOR_BPS;
  if (scaled >= DIP_VOL_CAP_BPS) return DIP_VOL_CAP_BPS;
  return scaled;
}

// Fold the fills of the orders decided on the previous batch into our
// tracking. A filled buy fixes the entry price at the price the fill
// actually got (the next bar's open, moved by slippage and impact),
// never at the close we decided on. A filled sell clears the trade.
function applyFills(batch: Batch): void {
  for (const fill of batch.fills) {
    if (fill.symbol !== SYMBOL) continue;
    // Any report for our symbol, filled or rejected, answers the
    // order waiting on it.
    awaitingFill = false;
    if (fill.status !== 'filled') continue;
    if (fill.side === 'buy') {
      entryPrice = Number(fill.price);
      peakSinceEntry = entryPrice;
      filledBuys += 1;
      lastBuyBar = scoredBars;
    } else {
      entryPrice = 0;
      peakSinceEntry = 0;
      entryLeg = '';
      lastExitBar = scoredBars;
    }
  }
}

await runBars({
  onBatch(state, batch) {
    // Record the bar that just closed, from completed bars only.
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined) {
      const close = Number(bar.c);
      if (closes.length > 0) {
        oneMinReturnsBps.push(Math.log(close / closes[closes.length - 1]) * 10000);
      }
      closes.push(close);
      highs.push(Number(bar.h));
      lows.push(Number(bar.l));
    }
    if (!state.warmingUp) scoredBars += 1;
    if (state.equity > peakEquity) peakEquity = state.equity;

    applyFills(batch);

    // A batch with no bar for our symbol carries no new price: skip the
    // whole decision (no entry, no exit). The fills above were still
    // processed, and the batch still counted toward scoredBars, so the
    // fallback keeps running on batch count, not bar count.
    if (bar === undefined) return [];

    // Warm-up batches exist to build history from; orders decided on
    // one are rejected, so never send any.
    if (state.warmingUp) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const closeNum = Number(close);

    // One decision, one order: never stack a second order onto one
    // whose fill has not been reported yet.
    if (awaitingFill) return [];

    // --- Exits: only one position can exist, and it sells in full. ---
    if (holding(state) && entryPrice > 0) {
      if (closeNum > peakSinceEntry) peakSinceEntry = closeNum;
      const trail = entryLeg === 'bo' ? TRAIL_BREAK_BPS : TRAIL_DIP_BPS;
      const qty = state.positions.get(SYMBOL)!.qty;
      const shouldExit =
        closeNum < peakSinceEntry * (1 - trail / 10000) ||
        closeNum >= entryPrice * (1 + TAKE_PROFIT_BPS / 10000) ||
        closeNum < entryPrice * (1 - HARD_STOP_BPS / 10000);
      if (shouldExit) {
        awaitingFill = true;
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // --- Entries: only while flat, with every discipline gate shut. ---
    if (holding(state)) return [];
    if (scoredBars >= NO_ENTRY_AFTER_SCORED_BAR) return [];
    if (scoredBars - lastBuyBar <= BUY_COOLDOWN_BARS) return [];
    if (scoredBars - lastExitBar <= EXIT_COOLDOWN_BARS) return [];
    if (peakEquity > 0n && state.equity < (peakEquity * BigInt(10000 - MAX_DRAWDOWN_BPS)) / 10000n) {
      return [];
    }
    if (state.cash <= 0n) return [];

    const n = closes.length;
    const prevClose = n >= 2 ? closes[n - 2] : 0;

    // Dip leg: far enough under the 60-bar average, and the fall has
    // paused (the latest low is no lower than the one before it).
    if (n >= DIP_AVG_BARS) {
      const avg = average(closes.slice(n - DIP_AVG_BARS, n));
      const threshold = dipThresholdBps();
      if (
        closeNum < avg * (1 - threshold / 10000) &&
        lows[n - 1] >= lows[n - 2]
      ) {
        entryLeg = 'dip';
        awaitingFill = true;
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }

    // Breakout leg: a close above the 120-bar high, rising on the bar,
    // with at least +1.50% behind it over the last 60 bars. Half size.
    if (n > BREAK_HIGH_BARS && n > BREAK_MOM_BARS) {
      let highest = 0;
      for (let i = n - BREAK_HIGH_BARS - 1; i < n - 1; i += 1) {
        if (highs[i] > highest) highest = highs[i];
      }
      const momBps = (closeNum / closes[n - 1 - BREAK_MOM_BARS] - 1) * 10000;
      if (closeNum > highest && closeNum > prevClose && momBps >= BREAK_MOM_BPS) {
        entryLeg = 'bo';
        awaitingFill = true;
        const spend = (state.cash * BigInt(BREAK_SIZE_NUM)) / BigInt(BREAK_SIZE_DEN);
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }

    // Participation fallback: one small position if the window has been
    // dead and no buy has ever filled.
    if (scoredBars >= FALLBACK_SCORED_BAR && filledBuys === 0) {
      entryLeg = 'fb';
      awaitingFill = true;
      const spend = (state.cash * BigInt(FALLBACK_SIZE_NUM)) / BigInt(FALLBACK_SIZE_DEN);
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }

    return [];
  },
});
