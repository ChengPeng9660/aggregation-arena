# HSLOP meta-aggregation exploration — 2026-08-23

## Question

Can the probability-safe HSLOP-2 Pareto candidates be combined to improve:

1. overall average Raw Brier;
2. already-strong-pair Raw Brier; or
3. the frequency with which the aggregation is better than all current replay baselines?

The historical answer is **yes for all three objectives, but with different candidates**. No single method simultaneously maximizes overall mean, overall pair coverage, strongest-group mean, and strongest-group coverage.

## Audit and status

This experiment uses the same audited replay as the underlying HSLOP-2 study:

- 81 models, 8,620 events, 25 source dates;
- 421 eligible unordered pairs;
- 1,567 scored pair-date cells and 465,074 pair-target evaluations;
- 21 scored dates;
- date-t predictions and selector weights are frozen before date-t outcomes;
- cross-pair model, provider, calibration, and skill snapshots explicitly satisfy `historyLastDate < forecastDate`;
- score is target-weighted Raw Brier; adjusted BI is unavailable in this artifact.

The meta-family and its weights were explored on the same replay. Results are post-hoc discovery, not independent OOS confirmation. No production leaderboard code or score was changed.

Reproduce with:

```bash
node scripts/explore-quality-aware-dash.mjs
```

## Experts

The meta-layer combines four probability-safe HSLOP experts:

1. balanced HSLOP-2;
2. coverage HSLOP-2;
3. strongest-group HSLOP-2; and
4. dependence-gated D-HSLOP-2.

The online selectors also include DASH-No-Dependence-4 as a safety expert. Fixed mixtures require no revealed outcomes at prediction time. Global FTL and Hedge update only after each forecast date resolves.

## Pareto results

“SOTA” means Raw Brier no higher than the best of DASH-No-Dependence-4, Two-model Hedge, DASH-Full-7, and DASH-Core-5 for the indicated unit. The machine-readable output additionally reports strictly-better counts to expose exact fallback ties.

| Objective and method | Overall ↓ | Strongest Q1 ↓ | Late 11 dates ↓ | Date SOTA | Pair SOTA | Q1 pair SOTA |
|---|---:|---:|---:|---:|---:|---:|
| No-Dependence-4 | 0.1570555 | 0.1502738 | 0.1560272 | reference | reference | reference |
| Base balanced HSLOP-2 | 0.1530530 | 0.1492285 | 0.1546088 | 17/21 | 284/421 | 88/118 |
| Base coverage HSLOP-2 | 0.1532103 | 0.1492730 | 0.1545553 | 17/21 | **296/421** | 89/118 |
| Global FTL, d=0.5 | 0.1529419 | 0.1493077 | 0.1546432 | 16/21 | 288/421 | 87/118 |
| **Stable online: global Hedge, d=0.5, eta=1** | 0.1529697 | 0.1492331 | 0.1545426 | 17/21 | 289/421 | 90/118 |
| **Balanced fixed: 55% coverage + 45% strong** | 0.1529700 | 0.1491887 | 0.1545315 | **17/21** | 286/421 | 93/118 |
| Previous support gate: No-Dependence cold start + balanced fixed | 0.1528035 | 0.1491887 | 0.1543450 | **17/21** | 281/421 (279 strict) | 93/118 |
| Calibrated cold start + balanced fixed | 0.1527558 | 0.1491887 | 0.1542916 | 17/21 | 308/421 strict | 93/118 |
| **Strongest mean: 25% balanced + 75% strong** | 0.1531663 | **0.1491539** | 0.1548858 | 15/21 | 275/421 | 93/118 |
| **Strongest SOTA: 30% balanced + 70% strong** | 0.1531409 | 0.1491545 | 0.1548506 | 15/21 | 277/421 | **94/118** |
| **Unified mean: calibrated cold start + 10% skill prior** | **0.1527308** | **0.1491364** | 0.1542810 | 16/21 | 305/421 | **97/118** |
| **Unified coverage: calibrated cold start + 30% skill prior** | 0.1529359 | 0.1491568 | **0.1541566** | **18/21** | **314/421** | **97/118** |
| **Online overall: calibrated cold start + skill-share FTL** | **0.1526547** | 0.1491655 | 0.1541957 | **18/21** | 310/421 | 95/118 |
| **Online balanced: calibrated cold start + skill-share Hedge** | 0.1527286 | **0.1491365** | 0.1542098 | 17/21 | 310/421 | **97/118** |
| **Strong coverage: rolling Q1 proxy + skill-share FTL** | 0.1526559 | 0.1491804 | 0.1541972 | **18/21** | 311/421 | **98/118** |

Relative to No-Dependence-4, the balanced fixed mixture:

- reduces overall Raw Brier by 0.0040856, or 2.60%;
- reduces strongest-Q1 Raw Brier by 0.0010851, or 0.72%;
- wins on 302 of 421 exact pairs;
- wins on 103 of 118 strongest-group pairs;
- is current-baseline SOTA on 17 of 21 dates; and
- is current-baseline SOTA on 7 of 8 strongest-group dates in the late half.

The strongest-SOTA mixture wins against No-Dependence-4 on 105 of 118 strongest-group pairs and is current-baseline SOTA on 94 of 118. That 79.7% coverage equals the ex-post union coverage of the four underlying HSLOP experts, so this fixed mixture reaches the full observed strong-pair coverage ceiling of the current expert set.

## Uncertainty

Paired forecast-date bootstrap, 20,000 draws:

| Comparison | Estimated Raw Brier reduction | 95% interval | P(reduction > 0) |
|---|---:|---:|---:|
| Balanced fixed mixture vs No-Dependence-4, overall | 0.0040856 | [0.0012812, 0.0086018] | 99.8% |
| Balanced fixed mixture vs No-Dependence-4, strongest Q1 | 0.0010851 | [0.0003942, 0.0017190] | 100.0% |
| Strongest-mean mixture vs No-Dependence-4, strongest Q1 | 0.0011199 | [0.0004065, 0.0018239] | 100.0% |
| Calibrated support gate vs No-Dependence-4, overall | 0.0042998 | [0.0018204, 0.0085628] | 100.0% |
| Calibrated support gate vs previous No-Dependence support gate, overall | 0.0000477 | [-0.0000815, 0.0001880] | 74.8% |
| Unified mean gate vs No-Dependence-4, overall | 0.0043248 | [0.0017642, 0.0086815] | 100.0% |
| Unified mean gate vs previous calibrated gate, overall | 0.0000250 | [-0.0001723, 0.0002550] | 58.6% |
| 10% skill mixture vs previous strongest-mean mixture, strongest Q1 | 0.0000175 | [-0.0000300, 0.0000522] | 79.5% |
| Online FTL gate vs fixed 10% mean gate, overall | 0.0000761 | [-0.0002362, 0.0003059] | 69.3% |
| Online Hedge gate vs fixed 10% mean gate, overall | 0.0000022 | [-0.0001763, 0.0001359] | 50.0% |
| Balanced fixed mixture vs base balanced HSLOP-2, overall | 0.0000830 | [-0.0000753, 0.0002595] | 84.9% |

The gain over No-Dependence-4 is stable in the historical date bootstrap. The much smaller incremental gains from meta-aggregation, calibrated fallback, and hierarchical skill mixing are not independently resolved and must not be presented as confirmed.

## Why global FTL lowers the historical mean

With discount 0.5, the global follow-the-leader selector chooses one expert for all pair-targets on each date using discounted losses from strictly earlier dates. Its 21-date trace is:

- first scored date: balanced HSLOP-2;
- most dates from late April through early November 2025: strongest-group HSLOP-2;
- late November through December 2025: D-HSLOP-2;
- January through mid-February 2026: coverage HSLOP-2;
- March 2026: strongest-group HSLOP-2.

No-Dependence-4 is never selected. This temporal regime switching explains the lowest overall historical mean, but the chosen discount is post-hoc and its strongest-group and coverage metrics are worse than the fixed balanced mixture. Global FTL should remain an average-score challenger, not the primary paper candidate.

## Coverage ceiling and stopping rule

Across the four underlying HSLOP experts:

- at least one is pair-SOTA for 308 of 421 pairs, an ex-post union ceiling of 73.2%;
- all four are pair-SOTA for 251 of 421 pairs;
- at least one is strongest-pair SOTA for 94 of 118 pairs, an ex-post union ceiling of 79.7%;
- all four are strongest-pair SOTA for 82 of 118 pairs.

The base coverage expert was the best single method for overall pair-SOTA at 296/421 = 70.3%, and pair-specific FTL and Hedge did not beat it. The hierarchical skill experiment validates the stopping rule: a genuinely different cross-pair skill signal raises the observed frontier beyond the old four-expert union, to 314/421 overall and 98/118 in the strongest quartile. Selector complexity over the old expert set was not the missing ingredient.

## Cold-start support gate and a smaller expert set

Failure-pair inspection shows a strong support imbalance: the 113 pairs missed by every base HSLOP expert have median 501 evaluated targets, versus 1,234.5 for the 308 covered pairs. This motivated a strictly-prior gate that uses No-Dependence-4 below 1,000 common historical targets and the balanced fixed HSLOP mixture thereafter.

The gate falls back on 137 of 1,567 pair-date cells and 35,935 of 465,074 target evaluations. It reaches 0.1528035 overall and 0.1543450 on the late half while leaving strongest-Q1 performance unchanged at 0.1491887. At that stage it was the historical overall-mean champion, but overall strict pair-SOTA fell to 279/421 = 66.3%, below the base coverage expert's 296/421. The gate therefore solved a target-weighted cold-start loss problem, not the pair-coverage objective. Exact fallback ties are reported separately and are not counted as strictly better.

Against No-Dependence-4, its overall date-bootstrap reduction is 0.0042521 with interval [0.0018203, 0.0085050]. Its incremental reduction versus the balanced fixed mixture is 0.0001665 with interval [-0.0004230, 0.0009202], so the cold-start increment itself remains unconfirmed.

The follow-up experiment tested whether DASH should receive every candidate method or only a small set of complementary specialists. A new cold-start expert estimates 10-bin calibration from strictly earlier dates at the provider and individual-model levels, conditions those statistics on the official source, applies the pair's strictly-prior ridge weight, and then shrinks the result 50% toward No-Dependence-4. Used globally, this expert harms strongest-Q1 performance, so it is not admitted as a general expert. It is used only below 1,000 prior common targets; above the threshold, the gate uses the 55% coverage + 45% strong HSLOP mixture.

This two-expert gate became the next historical overall-mean candidate:

- overall Raw Brier 0.1527558, a reduction of 0.0042998 or 2.74% versus No-Dependence-4;
- late-half Raw Brier 0.1542916;
- strongest-Q1 Raw Brier unchanged at 0.1491887, a reduction of 0.0010851 or 0.72% versus No-Dependence-4;
- strictly SOTA on 308/421 pairs and 93/118 strongest-Q1 pairs;
- better than No-Dependence-4 on 329/421 exact pairs and 103/118 strongest-Q1 pairs; and
- cold-start routing on 137/1,567 pair-date cells and 35,935/465,074 target evaluations.

The incremental improvement over the previous support gate is only 0.0000477, with paired-date bootstrap interval [-0.0000815, 0.0001880]. The result is promising discovery evidence for a smaller, specialized expert set, not confirmation that the calibrated fallback is superior. Its 308/421 strict pair-SOTA count matched the observed ex-post union ceiling of the four base HSLOP experts, motivating a genuinely new expert rather than further selector tuning.

## Hierarchical cross-pair skill prior

The new expert estimates each model's discounted Raw Brier from strictly earlier dates, shrinks model estimates toward provider estimates and provider estimates toward the global panel, and conditions the hierarchy on the official source. For a given pair, the lower estimated Brier receives a larger logistic prior weight; the pair's own strictly-prior linear-pool estimate is then ridge-shrunk toward that prior. This transfers information to pairs with limited shared history without using current outcomes.

The direct skill pool is not competitive alone: its overall Raw Brier is 0.1567236 and strongest-Q1 Raw Brier is 0.1498224. Its errors are nevertheless complementary. Mixing only 10% of it into the previous strong-coverage HSLOP expert lowers strongest-Q1 Raw Brier to 0.1491364 and raises strongest-Q1 pair-SOTA from 94/118 to 97/118. A 30% share maximizes observed coverage among the tested frozen shares.

Combining the calibrated cold-start branch with these mature-pair mixtures yields two new modes:

- **Unified mean mode, 10% skill:** 0.1527308 overall, 0.1491364 strongest-Q1, 305/421 pair-SOTA, and 97/118 strongest-Q1 pair-SOTA. It beats No-Dependence-4 on 328/421 pairs and 108/118 strongest pairs.
- **Unified coverage mode, 30% skill:** 0.1529359 overall, 0.1491568 strongest-Q1, 18/21 date-SOTA, 314/421 pair-SOTA, 97/118 strongest-Q1 pair-SOTA, and 9/11 late-date SOTA.

The unified mean mode improves historical overall and strongest-Q1 means simultaneously. However, its incremental reductions versus the previous champions are only 0.0000250 overall and 0.0000175 in strongest-Q1, and both paired-date bootstrap intervals cross zero. The larger coverage changes are new discovery evidence, not independent confirmation.

## Strictly-prior online skill-share selection

Fixed 10% and 30% shares optimize different objectives. To avoid requiring one post-hoc share forever, the follow-up treats the frozen 10%, 20%, and 30% mixtures as three experts. Global FTL and Hedge update only after a forecast date resolves and use discount 0.5. The FTL trace selects 10% through most of 2025, switches briefly to 20%, uses 30% from December 2025 through February 2026, and returns to 10% in March 2026.

With the same calibrated fallback below 1,000 prior common targets:

- **Online overall FTL** reaches the lowest observed overall Raw Brier, 0.1526547, with 18/21 date-SOTA, 310/421 pair-SOTA, and 9/11 late-date SOTA.
- **Online balanced Hedge** nearly preserves the fixed 10% strongest-Q1 mean at 0.1491365 while increasing pair-SOTA from 305 to 310 and date-SOTA from 16 to 17.
- **Rolling-quality FTL** routes the strongest prior-quality quartile to fixed 10% and other mature pairs to FTL. It reaches 98/118 strongest-pair SOTA, 311/421 overall pair-SOTA, and 18/21 date-SOTA.

The online FTL reduction versus the fixed 10% gate is 0.0000761, but its paired-date interval [-0.0002362, 0.0003059] crosses zero. It is a stronger deployment-oriented candidate because its share selection is outcome-blind at prediction time and visibly adapts across regimes, not because the current replay independently proves the incremental gain.

## Does aggregation improve already-strong pairs more?

It improves them, but **not by a larger average margin**. Unified mean mode reduces Raw Brier by 2.75% overall and by 0.76% in the strongest quartile. Strong pairs have less remaining error to remove. Nevertheless, the improvement is unusually consistent: it beats No-Dependence-4 on 108/118 strongest-Q1 pairs, is strictly current-baseline SOTA on 97/118, and is current-baseline SOTA on 7/8 late strongest-group dates. The rolling-quality online mode raises strongest-pair coverage further to 98/118, at the cost of a higher strongest-Q1 mean.

## Frozen trailing-window stress test

The finalist set was frozen before inspecting these summaries. The windows contain the last 3, 5, and 8 scored dates and are not used to retune any share, threshold, or discount.

| Frozen finalist | Last 3 Raw Brier / Date-SOTA | Last 5 | Last 8 |
|---|---:|---:|---:|
| Online overall FTL | 0.1600940 / 2/3 | 0.1555407 / 4/5 | 0.1552423 / 7/8 |
| Fixed 10% strongest-mean | 0.1600940 / 2/3 | **0.1552343** / 4/5 | 0.1553361 / 5/8 |
| Fixed 30% overall-coverage | **0.1599528** / 2/3 | 0.1554569 / 4/5 | **0.1552010** / 7/8 |
| Rolling-quality FTL | 0.1600940 / 2/3 | 0.1555402 / 4/5 | 0.1552420 / 7/8 |
| Online Hedge | 0.1600257 / 2/3 | 0.1553034 / 4/5 | 0.1552571 / 6/8 |

The last-eight window contains five dates with strongest-Q1 cells; every frozen finalist is SOTA on all five. The last-five window contains two such dates; every finalist is SOTA on both. The last-three window has no cells belonging to the replay-wide strongest-Q1 definition and is explicitly reported as unavailable rather than zero. These are stability diagnostics on the discovery replay, not a substitute for future confirmation.

## Freeze recommendation

For a future confirmatory block, freeze:

1. **Online overall candidate:** calibrated fallback below 1,000 prior common targets; otherwise global FTL over frozen 10%, 20%, and 30% skill shares with discount 0.5.
2. **Strongest-mean candidate:** the fixed 10% skill-share gate.
3. **Overall pair-coverage candidate:** the fixed 30% skill-share gate.
4. **Strongest-pair coverage candidate:** rolling prior-quality quartile gate plus global skill-share FTL.
5. **Stable online candidate:** calibrated fallback plus global skill-share Hedge with discount 0.5 and eta scale 1.
6. **Primary controls:** the previous calibrated gate, 55/45 HSLOP mixture, No-Dependence-4, Full-7, and base coverage HSLOP-2.

Retain the previous No-Dependence support gate, No-Dependence-4, Full-7, the bounded convex source pool, and base balanced HSLOP-2 as controls. Freeze all calibration constants, mixture weights, and the 1,000-target threshold before the next confirmatory time block. Do not continue tuning selector learning rates on this replay.
