# DASH compact-subset resolution-aware confirmation — 2026-08-23

## Confirmatory question

After freezing the DASH expert subsets on data through 2026-03-29, do the
compact pools continue to improve two-model forecasts on later official
ForecastBench rounds? In particular:

1. does aggregation improve pairs whose constituents looked strongest before
   the forecast date; and
2. is that improvement larger than for weaker pairs?

## Status

This is a frozen, post-cutoff, resolution-aware confirmation. It is not another
candidate search. No Historical Arena production code or leaderboard scores
were changed.

The official processed forecast-set archive was downloaded from
<https://www.forecastbench.org/assets/data/processed-forecast-sets/processed_forecast_sets.tar.gz>.
Its SHA-256 is
`df42f18ea07e8a496329ce17daff2c1663caa05818cbc8c799860672e268c3d7`.
The exact 421-pair cohort comes from the pre-cutoff
`public/forecastbench/dash2-history.json` artifact (SHA-256
`6787ef970d2f03e920db32c1bb991ad0c1911a5a404484c2ce4dd6c6483a9ab1`).

## Leakage control

- The cutoff is 2026-03-29.
- At forecast date `t`, pair metrics, model weights, and meta-expert weights use
  only targets whose official `resolution_date < t`.
- Current forecasts are frozen before current outcomes are read.
- A current target enters learning only after its own resolution date.
- The canonical target key is `forecast_due_date + source + id +
  resolution_date`; composite information-structure questions remain excluded.
- Prompt/configuration variants of one exact provider base model are averaged.
- The primary score is target-weighted Raw Brier; lower is better.

This is stricter than a forecast-round replay that immediately reveals every
outcome from the previous forecast round.

## Confirmatory support

- 9 post-cutoff forecast dates, 2026-04-12 through 2026-08-02;
- 211 eligible frozen pair-date cells;
- 167,577 pair-target evaluations;
- 91 of the frozen 421 pairs observed at least once;
- 21 stable pairs observed on at least three post-cutoff dates.

Coverage declines because ForecastBench's submitted model roster changes over
time: the nine dates contain 91, 78, 21, 6, 6, 6, 1, 1, and 1 eligible frozen
pairs. The official archive snapshot also right-censors targets that had not yet
resolved by 2026-08-23.

## Overall result

| Method | Raw Brier | Gain vs historical-best constituent |
|---|---:|---:|
| Historical-best constituent | 0.1577735 | reference |
| Two-model Hedge | 0.1558838 | +0.0018897 |
| DASH-Full-7 | 0.1557148 | +0.0020587 |
| DASH-Core-5 | 0.1557216 | +0.0020519 |
| DASH-Core-4 | 0.1562060 | +0.0015675 |
| **DASH-No-Dependence-4** | **0.1555570** | **+0.0022165** |

For No-Dependence-4, the date-bootstrap 95% interval for gain over the
strictly-prior historical-best constituent is `[+0.0007439, +0.0028512]`.
It beats the ex-post better constituent for 62/91 pairs (68.1%), with macro
pair gain `+0.0006335`.

No-Dependence-4 is `0.0001578` better than Full-7 on this block, but the 95%
date-bootstrap interval is `[-0.0001692, +0.0003255]`. The compact pool is the
point-estimate winner, not a statistically resolved replacement for Full-7.

On the stable 21-pair cohort, No-Dependence-4 has Brier `0.1594147` versus
`0.1619005` for the historical-best constituent, a gain of `+0.0024858`.

## Do already-strong pairs improve?

The operational strong group uses no test outcomes: pair-date cells are ranked
by the better constituent's strictly-prior Raw Brier. Q1 is the lowest (best)
quartile.

| Prior-quality group | Cells | Targets | Historical best | Full-7 gain | No-Dependence-4 gain |
|---|---:|---:|---:|---:|---:|
| Q1 strongest | 53 | 42,034 | 0.1593447 | +0.0031686 | **+0.0030091** |
| Q2 | 53 | 41,264 | 0.1559819 | +0.0014653 | +0.0014399 |
| Q3 | 52 | 41,634 | 0.1540104 | +0.0013914 | +0.0018890 |
| Q4 weakest | 53 | 42,645 | 0.1616322 | +0.0021902 | +0.0025065 |

For No-Dependence-4, Q1's gain interval is
`[+0.0004933, +0.0034455]`. Therefore, aggregation does improve the group that
looked strongest using information available at prediction time.

Q1's gain is numerically `0.0005027` larger than Q4's, but the interval for
that gain difference is `[-0.0048844, +0.0015656]`. The data do not establish
that stronger pairs benefit more. The quartile ordering is not monotone.

## Does aggregation beat the constituent that was actually best afterward?

This diagnostic uses test outcomes to rank pairs and is not deployable. In the
ex-post strongest quartile (23 pairs, only 2 represented forecast dates), the
better constituent has Brier `0.1462309`:

- No-Dependence-4 has `0.1464215`, a loss of `0.0001906`; its gain interval is
  `[-0.0011162, +0.0002278]`.
- Full-7 has `0.1467374`, a loss of `0.0005066`; its gain interval is
  `[-0.0015980, -0.0000131]`.

Thus the confirmatory data support “historically strong pairs also benefit,”
but not “the aggregation always beats the single model that turns out to be
best.” A ceiling effect remains visible for the truly best realized pairs.

## Paper-safe conclusion

The strongest supported claim is:

> In a frozen, resolution-aware post-cutoff evaluation, compact DASH lowers
> Raw Brier relative to the constituent selected from strictly prior outcomes,
> including within the historically strongest quartile. The magnitude of the
> gain is not monotone in constituent quality, and the method does not reliably
> dominate the ex-post best constituent in the realized strongest quartile.

This result supports aggregation as a deployable hedge against model-selection
error. It does not support a per-pair oracle-dominance guarantee.

## Reproduction

```bash
/Users/pcc/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  scripts/confirm-dash-subsets-resolution-oos.py \
  --archive /tmp/forecastbench-processed-2026-08-23-a.tar.gz \
  --output output/research/dash-subsets-resolution-oos-2026-08-23.json
```

The complete generated result has SHA-256
`6114d6d042df97119875ed6df8f45d2fb7467fc4ac46d01c41e9a7626565f5eb`.
Two complete runs were identical after removing only `generatedAt`; the
sanitized SHA-256 was
`c14f5884b498efd0a047df4b9f5b1c75ac1d22523eb3b3166e746d640c5a1772`.

