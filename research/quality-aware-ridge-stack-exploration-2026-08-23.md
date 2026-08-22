# Quality-aware two-model aggregation exploration — 2026-08-23

## Research question

Can a two-model aggregation method improve both:

1. average performance across all eligible model pairs; and
2. performance for pairs that already contain a historically strong model?

The answer in this historical replay is **yes, descriptively**. The best balanced candidate is a quality-gated ridge stack, provisionally named **Quality-Aware Ridge Stack-2 (QAR-Stack-2)**. It improves the overall and strongest-quartile Raw Brier relative to the current DASH-No-Dependence-4 baseline. It is not yet an independently validated production method.

## Status and interpretation boundary

This is a post-hoc candidate search, not an independent out-of-sample result. Every date-level prediction uses only outcomes from strictly earlier forecast dates, so the replay itself respects the intended online information boundary. However, the candidate family and hyperparameters were selected after comparing results on this same replay. QAR-Stack-2 must be frozen before a future or separately protected confirmatory evaluation.

No production leaderboard code or score was changed. Reproduce the experiment with:

```bash
node scripts/explore-quality-aware-dash.mjs
```

The machine-readable output is written to `output/research/quality-aware-dash-exploration-2026-08-23.json` and is intentionally ignored by Git.

## Audit

- Inputs: `public/forecastbench/history.json` and `public/forecastbench/dash2-history.json`.
- 81 exact model names, 8,620 source events, and 25 source forecast dates.
- 421 eligible unordered model pairs.
- 1,567 scored pair-date cells and 465,074 pair-target evaluations.
- 21 scored forecast dates.
- Every date-t forecast is frozen before any date-t outcome updates pair-level or cross-pair state.
- The published history hash and the strictly-prior-history audit flag are checked before evaluation.
- Primary score: target-weighted Raw Brier. Difficulty-adjusted BI is unavailable in this artifact.

## Defining an already-strong group without seeing current outcomes

For each pair and forecast date, define prior quality as

\[
s_{ij,t}=\min\{\bar L_{i,<t},\bar L_{j,<t}\},
\]

where each cumulative Raw Brier uses only common targets from forecast dates strictly earlier than date \(t\). Lower is better. The strongest group, Q1, is the lowest quartile of the 1,567 scored pair-date cells under this feature. It contains 391 cells, 122,284 target evaluations, 118 distinct pairs, and observations on 9 scored dates.

This is a deployable stratification feature because it does not use the current outcome. It differs from grouping pairs by their ex-post test score, which would leak evaluation outcomes.

## Candidate: QAR-Stack-2

At forecast date \(t\), compute the rolling 40th percentile \(\tau_t\) of prior-quality values observed in pair-date cells strictly before \(t\).

For pairs on the strong side, \(s_{ij,t}\leq\tau_t\), use a conservative simplex ridge pool:

\[
q_t=w_t p_{i,t}+(1-w_t)p_{j,t},
\]

where \(w_t\in[0,1]\) minimizes historical pair-level squared error with ridge penalty \(20(w-0.5)^2\). This protects strong forecasts against aggressive extrapolation.

For the remaining pairs, use a pair-specific affine ridge stack:

\[
q_t=\operatorname{clip}_{[0,1]}
\left(\beta_0+\beta_i p_{i,t}+\beta_jp_{j,t}\right).
\]

The coefficients are estimated from strictly prior pair history, with ridge penalty \(\lambda=1\) toward \((0,0.5,0.5)\). Historical sufficient statistics receive a per-forecast-date discount of 0.95. Thus recent evidence matters more, but the experiment shows that stronger forgetting factors of 0.8 and 0.5 reduce late-period stability.

The gate, thresholds, regression coefficients, and constituent quality scores are all computed without date-t outcomes.

## Main result

| Method | Overall Raw Brier ↓ | Strongest Q1 ↓ | Late 11 dates ↓ | Date SOTA | Pair SOTA | Q1 pair SOTA |
|---|---:|---:|---:|---:|---:|---:|
| Historical-best constituent | 0.1590451 | 0.1522342 | — | — | — | — |
| DASH-Full-7 | 0.1571393 | 0.1504442 | 0.1561107 | reference set | reference set | reference set |
| DASH-No-Dependence-4 | 0.1570555 | 0.1502738 | **0.1560272** | reference set | reference set | reference set |
| Average-only champion, q=0.25 | **0.1553283** | 0.1501508 | 0.1560664 | 14/21 (66.7%) | 161/421 (38.2%) | 32/118 (27.1%) |
| **QAR-Stack-2, q=0.40** | 0.1553548 | **0.1499704** | **0.1559965** | **14/21 (66.7%)** | **188/421 (44.7%)** | **55/118 (46.6%)** |

“SOTA” here has a deliberately narrow operational meaning: strictly lower Raw Brier than the best of the four current replay baselines—DASH-No-Dependence-4, Two-model Hedge, DASH-Full-7, and DASH-Core-5. It is not a claim against every published forecast-aggregation algorithm.

Relative to DASH-No-Dependence-4, QAR-Stack-2:

- lowers overall Raw Brier by 0.0017007, or 1.08%;
- lowers strongest-Q1 Raw Brier by 0.0003034, or 0.20%;
- wins on 235 of 421 exact pairs (55.8%);
- wins on 80 of 118 strongest-group pairs (67.8%);
- is current-baseline SOTA on 188 of 421 pairs (44.7%); and
- is current-baseline SOTA on 55 of 118 strongest-group pairs (46.6%).

Relative to selecting the historically better constituent, QAR-Stack-2 lowers overall Raw Brier by 0.0036903 (2.32%) and strongest-Q1 Raw Brier by 0.0022637 (1.49%). Therefore the method is not merely repairing weak model pairs: it also improves pairs that already contain a strong constituent.

## Why not select the lowest overall score?

The q=0.25 candidate has the lowest observed overall Raw Brier, 0.1553283, but it is materially less attractive for the user’s second objective:

| Selection objective | q=0.25 average champion | q=0.40 QAR-Stack-2 |
|---|---:|---:|
| Overall Raw Brier | **0.1553283** | 0.1553548 |
| Strongest-Q1 Raw Brier | 0.1501508 | **0.1499704** |
| Late-half Raw Brier | 0.1560664 | **0.1559965** |
| Pair SOTA rate | 38.2% | **44.7%** |
| Strongest-Q1 pair SOTA rate | 27.1% | **46.6%** |

The overall-score cost of the balanced choice is only 0.0000265, while strongest-Q1 improves by 0.0001804 and Q1 pair SOTA rises by 19.5 percentage points. This is the observed Pareto trade-off: q=0.25 is the average-score champion, whereas q=0.40 is the defensible paper and product candidate when both average quality and strong-pair improvement matter.

## Uncertainty and stability

Paired forecast-date bootstrap, 20,000 draws:

| Comparison | Estimated Raw Brier reduction | 95% date-bootstrap interval | P(reduction > 0) |
|---|---:|---:|---:|
| QAR-Stack-2 vs No-Dependence-4, overall | 0.0017007 | [0.0002913, 0.0044311] | 99.5% |
| QAR-Stack-2 vs Full-7, overall | 0.0017845 | [0.0003114, 0.0044739] | 99.5% |
| QAR-Stack-2 vs No-Dependence-4, strongest Q1 | 0.0003034 | [0.0000025, 0.0006460] | 97.7% |

These intervals are descriptive. Pair observations share events and models, and the candidate was selected on the same replay.

The overall improvement is front-loaded. On the early 10 scored dates QAR-Stack-2 scores 0.1500211 versus 0.1656034 for No-Dependence-4, while on the late 11 dates it scores 0.1559965 versus 0.1560272. The late gain is positive but only 0.0000307. Selecting hyperparameters solely on the early half does not reproduce the large gain in the late half: the early-selected q=0.25, discount-0.5 candidate scores 0.1567274 late, worse than No-Dependence-4. This is the strongest reason not to call the present result independently OOS.

## What produces the gain?

A calibration-only control replaces the affine two-model stack with a ridge calibration of the No-Dependence-4 prediction while retaining the same q=0.40 quality gate. It scores:

- 0.1553980 overall;
- 0.1500869 in strongest Q1; and
- 0.1560156 in the late half.

QAR-Stack-2 is better by 0.0000432 overall and 0.0001164 in Q1. The overall difference has a date-bootstrap interval [−0.0001345, 0.0002111], so it is unresolved. The Q1 difference has interval [0.0000012, 0.0003043]. Across strongest-group pairs, the affine candidate is better on 73, worse on 20, with 25 ties.

The responsible interpretation is therefore:

- most of the roughly 1% overall gain over No-Dependence-4 is explained by learned historical calibration;
- the separate two-model affine structure appears to add value particularly for already-strong pairs; and
- a paper should not attribute the entire gain to correlation adaptation without a stronger dependence-specific ablation.

The affine model clips 13.2% of its predictions to [0,1]. Its pair-date coefficients occasionally leave the convex simplex, so coefficient constraints or logit-space stacking should be tested before production deployment.

## Research decision

Keep two frozen candidates with different labels:

1. **Average champion:** q=0.25, ridge-linear-20 / affine-discount-0.95-lambda-1. Use only when the sole objective is the lowest historical mean Raw Brier.
2. **Balanced research candidate, QAR-Stack-2:** q=0.40 with the same two component estimators. Use when the objective includes both average improvement and protection of already-strong pairs.

Do not deploy either candidate yet. The next confirmatory comparison should freeze QAR-Stack-2, the q=0.25 average champion, the calibration-only control, DASH-No-Dependence-4, and DASH-Full-7 before observing new resolved outcomes. Report overall and Q1 Raw Brier, pair win rate, current-baseline SOTA rate, and the late/future time block. A difficulty-adjusted BI analysis should be added when the required target metadata is available.
