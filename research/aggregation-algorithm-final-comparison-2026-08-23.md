# Aggregation algorithm comparison — stopped frontier, 2026-08-23

## Bottom line

New-algorithm exploration stopped at the user's request after phase 6.

If one algorithm must be chosen now, choose **HSQAA-5 Balanced**:

```text
hier-aa-source-q2-5-e2p0-p50p0-s1p0
```

It is the most defensible single algorithm because it improves mean Raw Brier
over SSAA-5 Mean in all three temporal blocks, has a strictly positive paired
secondary interval, retains a 74.7% pair-SOTA rate, and remains positive in
the historically strongest quartile.

There is no single method that is best on every objective:

| Objective | Current choice | Secondary evidence |
|---|---|---:|
| Recommended single algorithm | **HSQAA-5 Balanced** | Brier **0.1554384**, 68/91 pair wins |
| Lowest pre-selected secondary point | HSQAA overall track | Brier 0.1554275; research track only |
| Defensible historically-strong-Q1 choice | **SSAA-5 Mean** | Q1 gain +0.0027702 |
| Highest secondary historical-Q1 point | DASH-Hedge-2 | Q1 gain +0.0031686; not temporally stable |
| Highest pair-SOTA rate | **SSAA-5 SOTA** | **70/91 = 76.9%** |

The phrase “pair SOTA” means that the aggregate strictly beats the realized
better constituent model for that model pair on the evaluated block.

## Evaluation boundary

- Official processed ForecastBench archive: 2,177 JSON files and 4,222,491
  resolved provider rows scanned.
- Frozen exact-model cohort: 421 model pairs.
- Canonical target key:
  `forecast_due_date + source + id + resolution_date`.
- Outcome visibility: only feedback with
  `resolution_date < forecast_date` may update an algorithm.
- Metric: target-weighted **Raw Brier**, not difficulty-adjusted BI.
- Development: 14 dates, 448 pair-date cells, 536,418 pair-target evaluations,
  214 observed frozen pairs.
- Internal validation: 7 later dates, 1,119 cells, 1,084,108 evaluations,
  348 pairs.
- Secondary evidence: 9 later dates, 211 cells, 167,577 evaluations, 91 pairs.

The secondary block has been inspected repeatedly during algorithm
development. It is secondary evidence, not independent future OOS.

## Same-sample secondary comparison

The first table contains the principal baselines and frozen challengers.

| Algorithm | Raw Brier | Gain vs historical best | Historical-Q1 gain | Pair SOTA | Macro pair gain | Ex-post-Q1 gain |
|---|---:|---:|---:|---:|---:|---:|
| Historical best | 0.1577735 | +0.0000000 | +0.0000000 | 0/91 (0.0%) | -0.0015846 | -0.0015326 |
| Two-model Hedge | 0.1558838 | +0.0018897 | +0.0027734 | 65/91 (71.4%) | +0.0003432 | -0.0001046 |
| DASH-Hedge-2 (`full-7`) | 0.1557148 | +0.0020587 | **+0.0031686** | 56/91 (61.5%) | +0.0004389 | -0.0005066 |
| NoDep-DASH-4 | 0.1555570 | +0.0022165 | +0.0030091 | 62/91 (68.1%) | +0.0006335 | -0.0001906 |
| GapSafe-G5 | 0.1556907 | +0.0020828 | +0.0026695 | 65/91 (71.4%) | +0.0005093 | -0.0001836 |
| SSH-5 | 0.1555106 | +0.0022628 | +0.0027207 | 68/91 (74.7%) | +0.0006735 | -0.0003401 |
| SSAA-5 Mean | 0.1554507 | +0.0023227 | +0.0027702 | 68/91 (74.7%) | +0.0007377 | -0.0004125 |
| **HSQAA-5 Balanced** | **0.1554384** | **+0.0023350** | **+0.0027936** | **68/91 (74.7%)** | **+0.0007495** | -0.0004010 |
| SSAA-5 SOTA | 0.1557360 | +0.0020374 | +0.0022336 | **70/91 (76.9%)** | +0.0004498 | -0.0004307 |

`two-model-hedge` is not DASH-Hedge-2. It is the exponential-weights pool of
the two constituent models. The leaderboard's DASH-Hedge-2 is the `full-7`
expert pool.

## Why HSQAA-5 Balanced is the recommended winner

Against SSAA-5 Mean, its overall Raw Brier is:

| Block | HSQAA-5 Balanced | SSAA-5 Mean | HSQAA advantage |
|---|---:|---:|---:|
| Development | 0.1608085 | 0.1608190 | +0.0000104 |
| Internal validation | 0.1502059 | 0.1502090 | +0.0000031 |
| Secondary | **0.1554384** | 0.1554507 | **+0.0000123** |

The secondary paired forecast-date interval for this advantage is
`[+0.0000036, +0.0000222]`. Its secondary gain over historical best is
`+0.0023350`, with interval `[+0.0012061, +0.0029543]`.

Its design also matches the empirical structure: it pools expert losses by
official source and strictly-prior strong/weak pair-quality half, while
retaining pair-local historical loss through shrinkage.

## The important qualifications

### Pure minimum-Brier point estimate

The internally selected HSQAA overall-track configuration

```text
hier-aa-source-q4-5-e1p0-p500p0-s1p0
```

has secondary Brier `0.1554275`, about `0.0000109` lower than HSQAA-5
Balanced. However, it was worse than SSAA-5 Mean in development and its
secondary advantage over SSAA has interval
`[-0.0000312, +0.0000739]`. The tiny point difference is not enough to replace
the more stable balanced configuration.

### Historically strong pairs

DASH-Hedge-2 has the highest secondary historical-Q1 gain, `+0.0031686`, but
its Q1 gain was only `+0.0006753` in development and `+0.0008941` in internal
validation. The late jump is not replicated. The defensible strong-Q1 choice
therefore remains SSAA-5 Mean, which was retained before reading the secondary
block.

HSQAA-5 Balanced has secondary Q1 gain `+0.0027936`, but its advantage over
SSAA changes direction across blocks. It is strong secondary evidence, not a
stable strong-group-superiority claim.

### Pair-SOTA rate

SSAA-5 SOTA wins 70/91 pairs, two more than HSQAA-5 Balanced. This is a real
rate/mean tradeoff: its Brier is worse by about `0.0002976`, and its macro pair
gain is lower. Use it only when pair win rate is the declared primary target.

### “Always SOTA” is not achieved

Every evaluated method is negative in the realized ex-post strongest Q1.
HSQAA-5 Balanced has ex-post-Q1 gain `-0.0004010`, with interval crossing
zero. The data do not support a guarantee that aggregation will always beat
the better constituent.

## Rejected and diagnostic-only results

Some later-block point estimates are lower than the recommended algorithm,
but they cannot be promoted because their exact IDs were favorable only after
secondary inspection or failed internal selection:

| Diagnostic only | Secondary Brier | Q1 gain | Pair SOTA | Why not promoted |
|---|---:|---:|---:|---|
| HSQAA overall track | 0.1554275 | +0.0028763 | 68/91 | less stable; CI vs SSAA crosses zero |
| Context compact post-hoc | 0.1553909 | +0.0029939 | 68/91 | exact ID not selected by internal validation |
| Meta-AA strong2 source/recent | 0.1553676 | +0.0028885 | 68/91 | worse than HSQAA by 0.0001727 internally |
| Meta-AA frontier4 source/recent | 0.1553645 | +0.0028863 | 68/91 | family not admitted by development Pareto selection |

The contextual family was rejected because its internally selected overall
and balanced configurations did not improve HSQAA on the secondary block.

The phase-6 online meta-AA family was also rejected. Development found
promising `HSQAA + DASH` source/recent variants, but internal validation chose
no meta method for overall, strong-Q1, pair-SOTA, or balanced objectives. The
best-looking recent-memory versions flip from favorable in development to
unfavorable internally and favorable again in secondary, which is regime
instability rather than a confirmed frontier improvement.

Phase 6 completed one full run and passed strict-visibility, manifest, and
algorithm invariants. A second full deterministic rerun was not started after
the user stopped new-algorithm exploration.

## Final recommendation

1. Use **HSQAA-5 Balanced** as the paper's main aggregation algorithm and the
   default single-method recommendation.
2. Report **SSAA-5 SOTA** as an explicitly rate-optimized variant.
3. Keep **SSAA-5 Mean** as the pre-confirmation strong-pair benchmark and
   report DASH-Hedge-2's larger secondary Q1 point as a robustness finding,
   not as the primary strong-pair algorithm.
4. Do not publish the contextual or meta post-hoc IDs as new SOTA methods.
5. Do not claim “always SOTA”; claim high pair-SOTA frequency and positive
   average gains, with exact rates and intervals.

## Frozen artifacts

- Phase 3 SSAA report: `research/source-specialist-aa-5-phase3-2026-08-23.md`.
- Phase 4 HSQAA report:
  `research/hierarchical-source-quality-aa-phase4-2026-08-23.md`.
- Phase 5 contextual report:
  `research/contextual-aa-router-phase5-2026-08-23.md`.
- Phase 6 meta script: `scripts/explore-online-meta-aa.py`.
- Phase 6 audit: `research/online-meta-aa-phase6-audit-2026-08-23.json`.
