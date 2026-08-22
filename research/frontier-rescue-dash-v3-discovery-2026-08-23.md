# Frontier-Rescue DASH V3 discovery

## Status

This is a post-hoc discovery replay, not an independent OOS result. V1 and V2 remain unchanged. V3 is frozen only as a set of secondary challengers for future dates; it does not replace the V2 primary candidates.

All date-t predictions, pair states, KNN histories, and cross-pair snapshots are frozen before any date-t outcome is applied. Hyperparameters were selected using the same historical block, so the incremental estimates are selection-biased until confirmed on dates strictly after 2026-03-29.

## Objective

V3 asks whether a conservative, pair-adaptive rescue layer can:

1. reduce overall target-weighted Raw Brier beyond V2;
2. further improve pairs that already contain a historically strong model;
3. preserve or raise pair-wise SOTA coverage.

The strongest-Q1 evaluation set remains the lowest quartile of pair-date cells by the better constituent model's strictly-prior cumulative Raw Brier. It is an evaluation label only and is never used as a deployment-time label.

## Mechanism

For every input pair, the rescue layer tracks strictly-prior cumulative losses for:

- the frozen V2 anchor;
- No-Dependence-4;
- Two-Model Hedge;
- Full-7;
- Core-5.

Before 1,000 common historical target evaluations, V3 returns the V2 anchor. Afterwards, it identifies the historically best incumbent baseline. It activates only when that baseline's prior average Brier is lower than the V2 anchor by a frozen margin. The output is a frozen partial blend between the anchor and that baseline.

This is not manual pair selection: every pair receives the same rule, and no current outcome or list of known failure pairs enters prediction.

## Main results

Lower Raw Brier is better. Strict SOTA means strictly lower pair-level Raw Brier than the best of the four incumbent baselines.

| Method | Overall Raw Brier | Strongest-Q1 Raw Brier | Late Raw Brier | Pair SOTA | Strongest-Q1 pair SOTA |
|---|---:|---:|---:|---:|---:|
| V2 joint | 0.1526369 | 0.1491292 | 0.1541758 | 311/421 | 100/118 |
| **V3 overall**: margin 0.00050, rescue 37.5% | **0.1526290** | 0.1491302 | **0.1541669** | 311/421 | 100/118 |
| **V3 balanced**: margin 0.00015, rescue 25% | **0.1526332** | **0.1491259** | **0.1541717** | **312/421** | 100/118 |
| V2 coverage | 0.1526594 | 0.1491883 | 0.1542011 | 313/421 | 101/118 |
| **V3 coverage**: margin 0.00015, rescue 12.5% | **0.1526567** | **0.1491863** | **0.1541980** | 313/421 | **101/118** |
| V2 strongest mean | 0.1527231 | 0.1491176 | 0.1542724 | 306/421 | 100/118 |
| V3 strongest-mean diagnostic: margin 0.00015, rescue 50% | 0.1527248 | **0.1491125** | 0.1542743 | 306/421 | 99/118 |

The balanced candidate is the cleanest joint Pareto improvement: it lowers both overall and strongest-Q1 mean Brier, gains one all-pair SOTA unit, and loses none. It does not increase strongest-Q1 coverage beyond 100/118.

The coverage candidate retains the current empirical ceiling of 101/118 (85.6%) while slightly improving all three mean endpoints. The strongest-mean diagnostic is not frozen as a finalist because its lower strongest-Q1 mean comes with one lost strongest-Q1 SOTA pair.

## Incremental evidence versus V2

Date-block bootstrap comparisons all retain zero in their 95% intervals:

- V3 overall versus V2 joint, overall improvement 0.00000791; 95% CI [-0.00002705, 0.00004595], probability positive 0.630;
- V3 balanced versus V2 joint, overall improvement 0.00000370; 95% CI [-0.00002377, 0.00003242], probability positive 0.570;
- V3 balanced versus V2 joint, strongest-Q1 improvement 0.00000328; 95% CI [-0.00000458, 0.00001326], probability positive 0.665;
- V3 coverage versus V2 coverage, strongest-Q1 improvement 0.00000201; 95% CI [-0.00000138, 0.00000621], probability positive 0.850.

These are new historical point estimates, not statistically confirmed improvements.

Pair transitions are conservative:

- V3 overall versus V2 joint: 311 preserved, zero gained, zero lost;
- V3 balanced versus V2 joint: 311 preserved, one gained, zero lost;
- V3 balanced strongest-Q1 versus V2 joint: 100 preserved, zero gained, zero lost;
- V3 coverage versus V2 coverage: 101 preserved, zero gained, zero lost.

## Trailing-window stress test

- Last eight dates: V3 overall improves overall Brier from 0.1552132 to 0.1552055; V3 balanced reaches 0.1552103. V3 coverage improves from 0.1552439 to 0.1552413.
- Last eight dates with strongest-Q1 cells: the V3 strongest-mean diagnostic improves from 0.1497938 to 0.1497840; V3 balanced improves from 0.1498124 to 0.1498065; V3 coverage improves from 0.1499077 to 0.1499042.
- Last five dates: every V3 challenger is slightly worse than its corresponding V2 anchor. Strongest-Q1 support is only 8,197 target evaluations over two dates.
- Last three dates contain no replay-wide strongest-Q1 cells.

The mixed five-date and eight-date results are the main reason V3 remains a secondary challenger rather than replacing V2.

## Negative results

- Strictly-prior KNN rescue using quality, quality gap, safeAlpha, support, and same-provider status did not exceed 101/118 strongest-Q1 SOTA and did not create a new mean Pareto point.
- Model-endpoint rescue states, including a symmetric average of both constituent endpoints, did not exceed 101/118 and did not improve the direct pair-rescue frontier.
- The post-hoc legal-method oracle remains 118/118, confirming that the remaining gap is a selection problem; it is not a deployable result.

## Interpretation

The result supports a limited claim: conservative pair-history adaptation can make the already-strong V2 frontier marginally better without manually choosing pairs or observing current outcomes. It does not support a claim of large improvement or persistent dominance.

The 101/118 strongest-Q1 coverage result should be treated as the current empirical ceiling of the tested deployable selectors. The 118/118 oracle is only an upper bound. Achieving a materially higher persistent SOTA rate likely requires richer pre-outcome signals or genuinely new post-cutoff data, not more threshold search on this replay.

## Future confirmation contract

- Freeze the three secondary challengers named in the V3 manifest.
- Do not retune the 1,000-support threshold, margins, blend shares, expert set, or V2 anchors after observing new outcomes.
- Use only forecast dates strictly after 2026-03-29.
- Report at 3, 5, 8, and 10 new scored dates; five dates are the minimum primary readout.
- Report every V2 comparator, V3 challenger, endpoint, gained/lost transition, and regression.
- Promote V3 over V2 only if the corresponding primary endpoint improves without a material SOTA-coverage regression.
