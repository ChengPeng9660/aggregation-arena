# Probability-safe hierarchical two-model aggregation — 2026-08-23

## Outcome

This follow-up improves both objectives posed for two-model aggregation:

1. lower average Raw Brier across all eligible pairs; and
2. larger, more reliable gains for pairs that already contain a historically strong model.

The strongest balanced candidate is provisionally named **Hierarchical Safe Log-Odds Pool-2 (HSLOP-2)**. A dependence-gated variant, **D-HSLOP-2**, has the lowest historical mean. Both are research candidates, not independently confirmed or deployed methods.

## Information boundary and audit

- Inputs: `public/forecastbench/history.json` and `public/forecastbench/dash2-history.json`.
- 81 exact model names, 8,620 events, 25 source forecast dates, and 421 eligible unordered pairs.
- 1,567 scored pair-date cells, 465,074 pair-target evaluations, and 21 scored dates.
- Every date-t prediction is frozen before any date-t outcome updates pair, group, quality, or dependence state.
- The published history hash and strictly-prior-history audit flag are checked before evaluation.
- Score: target-weighted **Raw Brier**. Difficulty-adjusted BI is unavailable in this artifact.
- The candidate family and hyperparameters were compared on this same replay. The results are post-hoc discovery, not independent OOS evidence.
- No production leaderboard code or score was changed.

Reproduce with:

```bash
node scripts/explore-quality-aware-dash.mjs
```

Machine-readable output is written to `output/research/quality-aware-dash-exploration-2026-08-23.json` and is intentionally ignored by Git.

## Algorithm family

For model forecasts p_i and p_j, HSLOP-2 estimates a grouped log-odds pool from strictly earlier outcomes:

\[
q_{ij,t}=\sigma\!\left(\beta_0+\beta_i\operatorname{logit}(p_{i,t})+\beta_j\operatorname{logit}(p_{j,t})\right).
\]

The coefficients are fitted by penalized logistic regression, with a per-forecast-date history discount of 0.95. Source- or question-type-specific coefficients shrink toward a pair-global log-odds fit. The logistic link guarantees q in (0,1), so the method never clips an out-of-range prediction.

Before routing a pair-date cell, define its quality using only earlier common outcomes:

\[
s_{ij,t}=\min\{\bar L_{i,<t},\bar L_{j,<t}\}.
\]

Lower is better. Rolling quality thresholds use pair-date cells observed strictly before date t.

The balanced HSLOP-2 rule is:

- strongest rolling 20%: conservative pair-specific convex ridge pool, penalty 20;
- next 30%: Dataset/Market-type log-odds pool, penalty 5;
- remaining 50%: official-source log-odds pool, penalty 20.

D-HSLOP-2 uses the same structure and additionally routes the middle-quality group with the published strictly-prior `safeAlpha` dependence feature. `safeAlpha` synthesizes Adjusted POG, High-Loss Lift, Adjusted-Loss Correlation, historical quality gap, and support. In the selected historical rule, middle-quality cells below 0.35 use the type pool and the others use the source pool.

## Main results

“SOTA” below means Raw Brier no higher than the best of the four current replay baselines: DASH-No-Dependence-4, Two-model Hedge, DASH-Full-7, and DASH-Core-5. These probability-safe candidates do not exactly copy a baseline, so their reported no-worse and strictly-better counts coincide. It is not a claim against every published method.

| Method | Overall ↓ | Strongest Q1 ↓ | Late 11 dates ↓ | Date SOTA | Pair SOTA | Q1 pair SOTA |
|---|---:|---:|---:|---:|---:|---:|
| Historical-best constituent | 0.1590451 | 0.1522342 | — | — | — | — |
| DASH-Full-7 | 0.1571393 | 0.1504442 | 0.1561107 | reference | reference | reference |
| DASH-No-Dependence-4 | 0.1570555 | 0.1502738 | 0.1560272 | reference | reference | reference |
| Bounded source convex pool | 0.1562475 | 0.1495090 | 0.1553016 | 16/21 | 271/421 | 72/118 |
| **D-HSLOP-2, overall champion** | **0.1530265** | 0.1492566 | 0.1546093 | 16/21 | 282/421 | 87/118 |
| **HSLOP-2, balanced** | 0.1530530 | **0.1492285** | 0.1546088 | **17/21** | 284/421 | 88/118 |
| HSLOP-2, coverage | 0.1532103 | 0.1492730 | **0.1545553** | **17/21** | **296/421** | **89/118** |
| HSLOP-2, strongest-Q1 | 0.1533316 | **0.1491604** | 0.1550975 | 15/21 | 265/421 | **89/118** |

Relative to DASH-No-Dependence-4, balanced HSLOP-2:

- reduces overall Raw Brier by 0.0040026, or 2.55%;
- reduces strongest-Q1 Raw Brier by 0.0010453, or 0.70%;
- beats the baseline on 301 of 421 exact pairs;
- beats it on 103 of 118 strongest-group pairs;
- is current-baseline SOTA on 17 of 21 dates and 7 of 9 strongest-group dates; and
- is current-baseline SOTA on 7 of 8 strongest-group dates in the late half.

D-HSLOP-2 improves the overall mean by another 0.0000264 but gives back 0.0000281 in strongest-Q1 Brier and has lower date/pair coverage. The observed overall advantage of the dependence gate over balanced HSLOP-2 has a date-bootstrap interval crossing zero. The dependence signal is therefore promising as a routing feature, but it is not yet a confirmed incremental contribution.

## Uncertainty

Paired forecast-date bootstrap, 20,000 draws:

| Comparison | Estimated Raw Brier reduction | 95% date-bootstrap interval | P(reduction > 0) |
|---|---:|---:|---:|
| D-HSLOP-2 vs No-Dependence-4, overall | 0.0040290 | [0.0012128, 0.0086679] | 99.8% |
| HSLOP-2 balanced vs No-Dependence-4, overall | 0.0040026 | [0.0011719, 0.0084831] | 99.8% |
| HSLOP-2 balanced vs No-Dependence-4, strongest Q1 | 0.0010453 | [0.0003529, 0.0016886] | 100.0% |
| Coverage HSLOP-2 vs No-Dependence-4, overall | 0.0038452 | [0.0015091, 0.0078374] | 100.0% |
| D-HSLOP-2 vs bounded convex control, overall | 0.0032210 | [0.0004193, 0.0075662] | 98.8% |
| D-HSLOP-2 vs legacy QAR-Stack-2, overall | 0.0023283 | [0.0001048, 0.0048981] | 98.0% |
| D-HSLOP-2 vs HSLOP-2, overall | 0.0000264 | [−0.0000313, 0.0001136] | 80.0% |

These intervals are descriptive because the family was designed on the same replay and pair observations share events and models.

## Does the improvement survive later dates?

Yes descriptively, more clearly than the earlier affine candidate. Balanced HSLOP-2 scores 0.1546088 on the last 11 dates versus 0.1560272 for No-Dependence-4, a reduction of 0.0014184. Its strongest-Q1 late score is 0.1494311, and it reaches current-baseline SOTA on 7 of 8 late Q1 dates.

As a limited temporal selection check, the candidate selected solely by early-half overall Brier within the expanded search scores 0.1552142 on the late half, still better than No-Dependence-4 by 0.0008130. This is not fully OOS because the expanded family itself was created after inspecting the replay, but it shows that the log-odds mechanism is not supported only by one post-hoc parameter setting.

## What the controls say about mechanism

The best source-specific convex pool is probability-safe and improves the baseline, but its overall Brier is only 0.1562475. The log-odds hierarchy reaches 0.1530265 without clipping. Therefore the large gain cannot be explained by hard probability clipping, and simple selection of a weight between the two forecasts is insufficient.

The evidence instead supports three components:

1. historical pair quality identifies where conservative aggregation protects already-good models;
2. source and Dataset/Market groups contain recurring calibration structure; and
3. log-odds pooling can correct group-specific confidence while preserving valid probabilities.

The incremental value of `safeAlpha` is much smaller than the value of the quality and group-calibration layers. A dependence-centered paper should therefore treat the present correlation gate as an ablation and hypothesis, not yet as the sole explanation for the aggregation gain.

## Freeze recommendation

Freeze three preregistered candidates for the next genuinely held-out dates:

1. **Primary: balanced HSLOP-2** — best joint choice for mean, strongest-group gain, late stability, and date coverage.
2. **Coverage HSLOP-2** — use when the main product objective is a high probability of beating the current baseline for an arbitrary pair.
3. **D-HSLOP-2** — dependence-specific challenger testing whether `safeAlpha` adds incremental value after quality and group calibration.

Keep DASH-No-Dependence-4, DASH-Full-7, the bounded convex source pool, and legacy QAR-Stack-2 as controls. The confirmatory report must retain overall and Q1 Raw Brier, date and pair SOTA rates, pair win counts, late/future performance, and difficulty-adjusted BI when that metadata becomes available.
