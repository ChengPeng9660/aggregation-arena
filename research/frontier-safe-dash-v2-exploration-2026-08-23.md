# Frontier-Safe DASH V2 discovery

## Status

This is a post-hoc discovery replay, not an independent OOS result. All date-t predictions and selector states are frozen before any date-t outcomes are applied, but the mechanism family and hyperparameters were selected on the same historical block. The existing V1 freeze remains unchanged.

## Research objective

V2 targets two questions simultaneously:

1. Can the overall target-weighted Raw Brier improve beyond the V1 overall champion?
2. Can aggregation lift pairs that already contain historically strong models, while retaining a high SOTA rate?

The strongest-Q1 evaluation set is the lowest quartile of pair-date cells by the better constituent model's strictly-prior cumulative Raw Brier. This label is used only for evaluation. The deployable gate uses rolling thresholds computed from earlier dates.

## Mechanism

The core frontier expert set contains four incumbent controls plus the V1 strongest-group method:

- No-Dependence-4;
- Two-Model Hedge;
- Full-7;
- Core-5;
- `support-gate-nHistory-t1000-modelcal-skill-strong-w0p1`.

The contextual FTL state uses four rolling buckets formed by:

- whether the strictly-prior model-quality gap is below or above its prior-date median;
- whether strictly-prior `safeAlpha` is below or above its prior-date median.

Within each bucket it follows the discounted historical loss leader with discount 0.8. With no feedback, it defaults to the V1 strongest-group method. In this replay it selected the V1 method for 440,566/465,074 target evaluations and Two-Model Hedge for 24,508/465,074; no other incumbent was selected.

The joint method then applies a second rolling quality gate:

- cells at or below the prior-date median quality use contextual FTL;
- other cells use the V1 overall champion.

No current-date outcome, final Q1 label, model release date after the forecast, or future cross-pair observation enters either decision.

## Main results

Lower Raw Brier is better. Strict SOTA means strictly lower Raw Brier than the best of No-Dependence-4, Two-Model Hedge, Full-7, and Core-5.

| Method | Overall Raw Brier | Strongest-Q1 Raw Brier | Late Raw Brier | Date SOTA | Pair SOTA | Strongest-Q1 pair SOTA |
|---|---:|---:|---:|---:|---:|---:|
| V1 overall champion | 0.1526547 | 0.1491655 | 0.1541957 | 18/21 | 310/421 | 95/118 |
| V1 strongest-mean champion | 0.1527308 | 0.1491364 | 0.1542810 | 16/21 | 305/421 | 97/118 |
| V1 strongest-coverage champion | 0.1526559 | 0.1491804 | 0.1541972 | 18/21 | 311/421 | 98/118 |
| **V2 joint champion: rolling 50% gate** | **0.1526369** | **0.1491292** | **0.1541758** | **18/21** | **311/421** | **100/118** |
| V2 strongest-coverage: rolling 40% gate | 0.1526594 | 0.1491883 | 0.1542011 | 18/21 | **313/421** | **101/118** |
| V2 strongest-mean: rolling 50% gate + V1 strong fallback | 0.1527231 | **0.1491176** | 0.1542724 | 16/21 | 306/421 | 100/118 |

Relative to No-Dependence-4, the V2 joint champion reduces overall Raw Brier from 0.1570555 to 0.1526369 and strongest-Q1 Raw Brier from 0.1502738 to 0.1491292.

## Incremental evidence versus V1

For the V2 joint champion versus the corresponding V1 champions:

- overall improvement: 0.00001780; date-block bootstrap 95% CI [-0.00000238, 0.00003284], probability positive 0.960;
- late-half improvement: 0.00001994; 95% CI [-0.00000168, 0.00003662], probability positive 0.963;
- strongest-Q1 improvement: 0.00000724; 95% CI [-0.00003177, 0.00006785], probability positive 0.547.

These are promising point estimates, but none is independently confirmed. The strongest-Q1 block has only nine scored dates.

The V2 joint method preserves 97 strongest-Q1 SOTA pairs from the V1 strongest-mean method, gains three, and loses none. Across all 421 pairs it preserves 308 V1-overall SOTA pairs, gains three, and loses two. The 40% coverage method preserves all 98 strongest-Q1 SOTA pairs from the V1 coverage method, gains three, and loses none.

## Trailing-window stress test

- Last eight dates: V2 joint overall Raw Brier 0.1552132 versus 0.1552423 for the V1 overall champion; both are Date-SOTA on 7/8 dates.
- Last eight dates with strongest-Q1 cells: V2 joint 0.1498124 versus 0.1498241 for the V1 strongest-mean champion; both are SOTA on 5/5 available dates.
- Last five dates: V2 joint 0.1555231 versus 0.1555407 for the V1 overall champion; both are SOTA on 4/5 dates.
- Last three dates contain no replay-wide strongest-Q1 cells; strongest-Q1 results are unavailable, not zero.

## Negative and diagnostic results

- Simply adding more incumbent methods to global or pair-specific Hedge did not improve the V1 Pareto frontier.
- Model- and provider-scoped frontier states did not create a new Pareto point.
- Low-dimensional contextual Hedge reached 98/118 strongest-Q1 pair SOTA but did not improve the strongest-Q1 mean.
- A post-hoc per-pair oracle over existing legal candidates reaches 118/118 strongest-Q1 pair SOTA and recovers all 21 V1 strongest-mean failures. This is an upper-bound diagnostic only; it shows that selection, rather than a missing prediction primitive, is the main remaining bottleneck.

## Interpretation

The discovery evidence supports a two-level claim:

1. A rolling contextual selector can lift the already-strong frontier rather than merely rescue weak model pairs.
2. A rolling median quality gate can combine that frontier specialization with the V1 overall champion and improve all three point estimates: overall mean, strongest-group mean, and strongest-group SOTA coverage.

The incremental advantage over V1 is small and was selected on the same replay. It must be presented as a frozen V2 hypothesis until evaluated on forecast dates strictly after 2026-03-29.

## Future confirmation contract

- Freeze the three named V2 candidates and every parameter before reading new outcomes.
- Do not retune the 0.4/0.5 quality quantiles, 0.8 discount, context definition, expert set, or fallback methods.
- Use only forecast dates strictly after 2026-03-29 for confirmation.
- Report at 3, 5, 8, and 10 new scored dates; treat five new dates as the minimum primary readout.
- Report all endpoints and regressions, including overall Raw Brier, strongest-Q1 Raw Brier, date SOTA, pair SOTA, strongest-Q1 pair SOTA, and transitions relative to frozen V1.
