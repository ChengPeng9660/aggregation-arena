# DASH expert-subset ablation — 2026-08-23

## Question

Does replacing the seven-expert DASH-Hedge-2 pool with a smaller set of historically strong experts improve its forecast-date replay performance?

## Status and interpretation boundary

This is a post-hoc historical ablation, not an independent out-of-sample result. The Core variants were proposed after inspecting the existing method summary. They must be frozen and evaluated on future data or a separately protected holdout before confirmatory claims.

No production leaderboard code was changed. The experiment is reproducible with:

```bash
node scripts/evaluate-dash-expert-subsets.mjs
```

The machine-readable result is written to `output/research/dash-expert-subsets-2026-08-23.json` and is intentionally ignored by Git.

## Protocol

- Input: `public/forecastbench/history.json` and `public/forecastbench/dash2-history.json`.
- 81 exact model names, 8,620 source events, and 25 source forecast dates.
- 421 eligible unordered model pairs.
- 1,567 parameter-supported pair-date cells.
- 465,074 pair-target evaluations on 21 scored dates, from 2025-04-13 through 2026-03-29.
- Predictions for every date are frozen before any outcome from that date updates the experts.
- Evaluation includes only pair-date cells with published parameters trained on strictly earlier forecast dates.
- Score: target-weighted Raw Brier. Difficulty-adjusted BI is not available in this Historical Arena artifact.
- Uncertainty: 20,000 paired forecast-date bootstrap draws. This remains descriptive because dates contain repeated events and pair evaluations share models.

The implementation reproduces the prior results to six decimals: Full-7 0.157139, Two-model Hedge 0.157194, SafeMix-2 0.158019, CPTEC 0.158061, Log-odds 0.158525, Equal Mean 0.158836, historical best 0.159045, and Piecewise Odds 0.159545.

## Variants

| Variant | Experts |
|---|---|
| DASH-Full-7 | Model A, Model B, Equal Mean, Log-odds, CPTEC, Piecewise Odds, SafeMix-2 |
| DASH-Core-5 | Model A, Model B, Two-model Hedge, SafeMix-2, CPTEC |
| DASH-Core-4 | Model A, Model B, Two-model Hedge, SafeMix-2 |
| DASH-No-Dependence-4 | Model A, Model B, Two-model Hedge, CPTEC |

## Main results

| Method | Raw Brier ↓ | Difference vs Full-7 | Pair wins vs Full-7 |
|---|---:|---:|---:|
| DASH-No-Dependence-4 | **0.1570555** | **−0.0000838** | 237 / 421 (56.3%) |
| DASH-Core-5 | 0.1571164 | −0.0000229 | 215 / 421 (51.1%) |
| DASH-Full-7 | 0.1571393 | reference | — |
| Two-model Hedge | 0.1571936 | +0.0000543 | — |
| DASH-Core-4 | 0.1573582 | +0.0002189 | 194 / 421 (46.1%) |

Positive Full-7-minus-comparison differences mean the compact comparison is better.

- Core-5 vs Full-7: +0.0000229; date-bootstrap 95% interval [−0.0002676, +0.0003384].
- No-Dependence-4 vs Full-7: +0.0000838; date-bootstrap 95% interval [−0.0001534, +0.0003299].
- No-Dependence-4 vs Core-5: +0.0000608; date-bootstrap 95% interval [−0.0000262, +0.0001305].
- No-Dependence-4 vs Two-model Hedge: +0.0001381; date-bootstrap 95% interval [−0.0000170, +0.0002857].
- Core-5 is better than Core-4 by 0.0002419; its interval [0.0000720, 0.0003902] excludes zero. This means CPTEC adds value to the A/B + Hedge + SafeMix core in this replay.

None of the headline improvements over Full-7 or Two-model Hedge has a two-sided 95% interval excluding zero.

## Does aggregation still help the strongest pairs?

Yes. The primary stratification uses only information available before each scored forecast date: for every pair-date cell, take the lower cumulative Raw Brier of its two constituent models on common targets from strictly earlier dates, then split the 1,567 cells into quartiles. Q1 is the historically strongest group. The reference is the constituent selected by that same strictly-prior score, so this comparison remains outcome-blind at prediction time.

| Prior-quality group | Cells | Targets | Historical-best reference | Full-7 gain | Two-model Hedge gain | Core-5 gain | No-Dependence-4 gain |
|---|---:|---:|---:|---:|---:|---:|---:|
| Q1 strongest | 391 | 122,284 | 0.1522342 | +0.0017900 | **+0.0019692** | +0.0018440 | +0.0019604 |
| Q2 | 392 | 114,234 | 0.1564293 | **+0.0024162** | +0.0021929 | +0.0021957 | +0.0023758 |
| Q3 | 392 | 113,266 | 0.1580313 | +0.0010201 | +0.0011211 | **+0.0012716** | +0.0012166 |
| Q4 weakest | 392 | 115,290 | 0.1698571 | +0.0023932 | +0.0021059 | **+0.0023998** | +0.0023974 |

All entries are reductions in Raw Brier relative to the historical-best constituent; positive is better. In Q1, Two-model Hedge reaches 0.1502649 and No-Dependence-4 reaches 0.1502738. They improve the already-strong historical-best reference by 0.0019692 and 0.0019604, respectively. Thus aggregation is not merely repairing weak model pairs.

However, the gain is not monotone in constituent quality. For No-Dependence-4 the gains from Q1 through Q4 are 0.0019604, 0.0023758, 0.0012166, and 0.0023974. Q1 is not systematically larger than the weaker quartiles. Model quality alone therefore does not identify where aggregation has the most headroom; historical complementarity and the quality gap between the two models should be tested as additional axes.

As a descriptive ceiling-effect check, the 421 exact pairs were also grouped by the ex-post Raw Brier of their actually better constituent on the evaluation sample. This grouping uses test outcomes and cannot be used to choose a method in deployment.

| Realized pair-quality group | Pairs | Targets | Ex-post best constituent | Full-7 gain | Two-model Hedge gain | Core-5 gain | No-Dependence-4 gain |
|---|---:|---:|---:|---:|---:|---:|---:|
| Q1 strongest | 105 | 124,068 | 0.1493052 | +0.0007391 | +0.0008667 | +0.0008476 | **+0.0008909** |
| Q2 | 105 | 147,058 | 0.1546073 | +0.0008406 | +0.0009360 | +0.0009373 | **+0.0009979** |
| Q3 | 105 | 123,036 | 0.1619091 | +0.0014579 | +0.0013617 | +0.0015181 | **+0.0015568** |
| Q4 weakest | 106 | 70,912 | 0.1756824 | **+0.0022957** | +0.0016850 | +0.0019513 | +0.0020815 |

Here the absolute improvement generally grows toward weaker pairs. That is consistent with a ceiling effect: genuinely excellent constituents leave less reducible error. This ex-post table supports interpretation only; the prior-history table is the valid operational analysis.

## Temporal halves

| Method | Early 10 dates | Late 11 dates |
|---|---:|---:|
| DASH-Full-7 | 0.1656893 | 0.1561107 |
| DASH-Core-5 | 0.1653392 | 0.1561271 |
| DASH-Core-4 | **0.1650713** | 0.1564303 |
| DASH-No-Dependence-4 | 0.1656034 | **0.1560272** |

SafeMix-related compact variants help more in the smaller early period but lose ground in the much larger late period. This is consistent with a nonstationary expert-ranking problem and motivates Fixed-Share or specialist gating rather than permanent expert deletion.

## Conclusion

The proposed Core-5 is directionally better than Full-7, but the gain is negligible and statistically unresolved. The best observed compact set is No-Dependence-4, not Core-5, which means the current SafeMix dependence expert does not improve the compact meta-pool on average in this post-hoc replay. CPTEC clearly improves Core-4, so removing every nonlinear odds expert is not supported.

The strongest prior-quality quartile also benefits: Two-model Hedge and No-Dependence-4 lower Raw Brier by about 0.00197 versus its historical-best constituent. But stronger constituent quality does not predict larger aggregation gain. The paper should therefore make the narrower claim that the method can improve already-strong pairs, while treating quality and complementarity as distinct determinants of gain.

The next confirmatory experiment should freeze Full-7, Core-5, and No-Dependence-4 before observing new outcomes, then compare them in resolution-aware rolling OOS. A specialist version that activates SafeMix only under historically validated high-complementarity conditions is a more promising dependence-aware design than giving SafeMix unconditional expert status.
