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
| **Overall mean: support gate + balanced fixed** | **0.1528035** | 0.1491887 | **0.1543450** | **17/21** | 281/421 (279 strict) | 93/118 |
| **Strongest mean: 25% balanced + 75% strong** | 0.1531663 | **0.1491539** | 0.1548858 | 15/21 | 275/421 | 93/118 |
| **Strongest SOTA: 30% balanced + 70% strong** | 0.1531409 | 0.1491545 | 0.1548506 | 15/21 | 277/421 | **94/118** |

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
| Balanced fixed mixture vs base balanced HSLOP-2, overall | 0.0000830 | [-0.0000753, 0.0002595] | 84.9% |

The gain over No-Dependence-4 is stable in the historical date bootstrap. The much smaller incremental gain from meta-aggregation over base HSLOP-2 is not independently resolved and must not be presented as confirmed.

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

The base coverage expert remains the best single method for overall pair-SOTA at 296/421 = 70.3%. Pair-specific FTL and Hedge do not beat it. Therefore adding more selector complexity over this same expert set is unlikely to materially raise overall pair coverage; the remaining 12-pair oracle gap requires new predictive features or a genuinely different expert, not a more aggressive online selector.

## Cold-start support gate

Failure-pair inspection shows a strong support imbalance: the 113 pairs missed by every base HSLOP expert have median 501 evaluated targets, versus 1,234.5 for the 308 covered pairs. This motivated a strictly-prior gate that uses No-Dependence-4 below 1,000 common historical targets and the balanced fixed HSLOP mixture thereafter.

The gate falls back on 137 of 1,567 pair-date cells and 35,935 of 465,074 target evaluations. It reaches 0.1528035 overall and 0.1543450 on the late half while leaving strongest-Q1 performance unchanged at 0.1491887. It is the new historical overall-mean champion, but overall strict pair-SOTA falls to 279/421 = 66.3%, below the base coverage expert's 296/421. The gate therefore solves a target-weighted cold-start loss problem, not the pair-coverage objective. Exact fallback ties are reported separately and are not counted as strictly better.

Against No-Dependence-4, its overall date-bootstrap reduction is 0.0042521 with interval [0.0018203, 0.0085050]. Its incremental reduction versus the balanced fixed mixture is 0.0001665 with interval [-0.0004230, 0.0009202], so the cold-start increment itself remains unconfirmed.

## Freeze recommendation

For a future confirmatory block, freeze:

1. **Primary balanced candidate:** 55% coverage HSLOP + 45% strongest HSLOP.
2. **Overall-average challenger:** support gate at 1,000 prior common targets, then the balanced fixed mixture.
3. **Temporal selector challenger:** global FTL with discount 0.5.
4. **Stable online challenger:** global Hedge with discount 0.5 and eta scale 1.
5. **Strong-group coverage challenger:** 30% balanced HSLOP + 70% strongest HSLOP.
6. **Overall pair-coverage control:** base coverage HSLOP-2.

Retain No-Dependence-4, Full-7, the bounded convex source pool, and base balanced HSLOP-2 as controls. The next algorithmic work should target the 113 pairs for which none of the four HSLOP experts is SOTA, using strictly-prior pair/source/type/dependence features. It should not continue tuning selector learning rates on this replay.
