# Source-Specialist AA-5 phase-3 exploration — 2026-08-23

## Result in one sentence

Replacing SSH-5's final linear expert average with the square-loss
generalized-prediction substitution produces a new mean-optimal challenger,
SSAA-5 Mean, while a separately selected shrinkage configuration raises the
pair-SOTA rate to 76.9%; the two configurations form a real performance/SOTA
trade-off rather than one universal winner.

## Interpretation boundary

This is a **post-hoc phase-3 mechanism check**. The square-AA family was
proposed after inspecting the earlier SSH-5 secondary-confirmation result.
The nested development/internal-validation selection is stricter than the
earlier sweep, but the 2026-03-29+ block remains secondary evidence rather
than a new independent OOS test. Both exact configurations must remain frozen
until a future official resolved block is available.

No website or production leaderboard code was changed.

## Algorithm

The five experts are unchanged from SSH-5:

1. Historical Best;
2. No-Dependence-4;
3. GapSafe G5;
4. Full-7; and
5. Two-model Hedge.

For exact model pair, source `s`, and expert `k`, the strictly-prior adjusted
loss is

```text
L'[s,k,t] = source_loss[s,k,t]
          + pseudo_count * global_loss[k,t] / global_feedback[t].
```

With learning rate `eta`, normalize

```text
w[k,t] proportional to exp(-eta * L'[s,k,t]).
```

For current expert probabilities `p[k,t]`, define

```text
g(y) = -(1 / eta) * log(sum_k w[k,t] * exp(-eta * (y-p[k,t])^2))
q_AA = clip((1 + g(0) - g(1)) / 2, 0, 1).
```

The final prediction is

```text
q = HistoricalBest + shrink * (q_AA - HistoricalBest).
```

At forecast date `t`, all state contains only events with official
`resolution_date < t`; the current outcome is never used to form `q`.

## Two frozen objectives

| Name | Exact ID | eta | pseudo-count | shrink | Objective |
|---|---|---:|---:|---:|---|
| **SSAA-5 Mean** | `square-aa-source5-e2p0-p200p0-s1p0` | 2 | 200 | 1.00 | lowest average Brier / strong-Q1 |
| **SSAA-5 SOTA** | `square-aa-source5-e2p0-p50p0-s0p75` | 2 | 50 | 0.75 | highest strict pair-SOTA rate |

SSAA-5 Mean is the recommended primary challenger. SSAA-5 SOTA is an
objective-specific frontier point, not an overall replacement.

## Nested temporal selection

- Development: 14 dates, 448 pair-date cells, 536,418 pair-target
  evaluations, 214 observed frozen pairs.
- Internal validation: 7 later dates, 1,119 cells, 1,084,108 evaluations,
  348 pairs.
- Secondary confirmation: 9 later dates, 211 cells, 167,577 evaluations,
  91 pairs.
- Frozen cohort: 421 exact unordered model pairs.
- Candidate methods: 54.
- Bootstrap: 20,000 paired forecast-date draws.
- Primary metric: target-weighted Raw Brier; lower is better.

Development selected global-5 and source-5 square-AA as the two Pareto
mechanism families. Internal validation then selected exact configurations by
objective before the secondary block was summarized:

| Internal-validation objective | Selected ID |
|---|---|
| Overall | SSAA-5 Mean |
| Strong Q1 | SSAA-5 Mean |
| Pair SOTA | SSAA-5 SOTA |
| Balanced ranks | `square-aa-source5-e1p0-p200p0-s1p0` |

## Secondary-confirmation results

| Method | Raw Brier | Gain vs historical best | Historical-Q1 gain | Pair SOTA | Macro pair gain vs ex-post best |
|---|---:|---:|---:|---:|---:|
| **SSAA-5 Mean** | **0.1554507** | **+0.0023227** | +0.0027702 | 68/91 (74.7%) | **+0.0007377** |
| SSH-5 | 0.1555106 | +0.0022628 | +0.0027207 | 68/91 (74.7%) | +0.0006735 |
| No-Dependence-4 | 0.1555570 | +0.0022165 | +0.0030091 | 62/91 (68.1%) | +0.0006335 |
| Full-7 | 0.1557148 | +0.0020587 | **+0.0031686** | 56/91 (61.5%) | +0.0004389 |
| **SSAA-5 SOTA** | 0.1557360 | +0.0020374 | +0.0022336 | **70/91 (76.9%)** | +0.0004498 |

For SSAA-5 Mean:

- gain versus historical best: `+0.0023227`, 95% date-bootstrap interval
  `[+0.0013614, +0.0029333]`;
- advantage versus SSH-5: `+0.0000599`, interval
  `[+0.0000177, +0.0001350]`;
- historical-Q1 gain: `+0.0027702`, interval
  `[+0.0004173, +0.0032204]`.

For SSAA-5 SOTA:

- gain versus historical best: `+0.0020374`, interval
  `[+0.0010830, +0.0024961]`;
- disadvantage versus SSH-5 on average: `-0.0002254`, interval
  `[-0.0003677, -0.0000314]`;
- historical-Q1 gain: `+0.0022336`, interval
  `[+0.0003999, +0.0025692]`.

Thus the SOTA configuration buys two additional pair wins at a statistically
detectable average-score cost. It should be used only when pair win rate is
the declared objective.

## Pair win-set diagnosis

SSAA-5 Mean versus SSH-5 has 67 joint wins, one SSAA-only win, one SSH-only
win, and 22 pairs where neither beats the ex-post better constituent. Its
74.7% rate therefore matches SSH-5 but has a larger macro pair gain.

SSAA-5 SOTA versus SSH-5 has 66 joint wins, four SSAA-SOTA-only wins, two
SSH-only wins, and 19 failures by both. Relative to No-Dependence-4, it has
60 joint wins, ten SSAA-SOTA-only wins, two control-only wins, and 19 failures
by both.

Neither configuration guarantees dominance over the eventual best
constituent.

## Source and type diagnosis

SSAA-5 Mean improves over SSH-5 in both broad types:

| Type | SSAA-5 Mean Brier | Gain vs historical best | Advantage vs NoDep4 |
|---|---:|---:|---:|
| Dataset | 0.1534427 | +0.0024244 | +0.0001226 |
| Market | 0.1677752 | +0.0016988 | +0.0000059 |

Across the nine fine official sources, SSAA-5 Mean is better than SSH-5 on
ACLED, FRED, Metaculus, Polymarket, and Yahoo Finance, and worse on DBnomics,
INFER, Manifold, and Wikipedia. It beats historical best on eight of nine
sources; INFER remains the exception. The aggregate improvement is therefore
not driven by one broad event type.

## Remaining failure mode

In the realized ex-post strongest Q1, SSAA-5 Mean has gain `-0.0004125`
versus the constituent that turns out to be better, with interval
`[-0.0014904, +0.0000748]`. SSAA-5 SOTA is also negative there. The data still
do not support “always SOTA,” oracle dominance, or the claim that stronger
pairs necessarily receive larger gains.

The strongest supported claim is:

> Source-specific square-loss substitution improves the average aggregation
> frontier beyond linear SSH-5, while explicit shrinkage can trade average
> score for a higher pair-SOTA rate; both preserve positive gains for
> historically strong pairs but neither dominates the ex-post best model.

## Reproduction

```bash
/Users/pcc/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  scripts/explore-square-aa-source-frontier.py \
  --archive /tmp/forecastbench-processed-2026-08-23-a.tar.gz \
  --output output/research/square-aa-source-frontier-2026-08-23.json
```

- official archive SHA-256:
  `df42f18ea07e8a496329ce17daff2c1663caa05818cbc8c799860672e268c3d7`;
- frozen pair-parameter SHA-256:
  `6787ef970d2f03e920db32c1bb991ad0c1911a5a404484c2ce4dd6c6483a9ab1`;
- script SHA-256:
  `3ae658c0054c9e2daed1635aa49d9904ac5e93e2c0eeaeb6309f535bf77b8b55`;
- full generated result SHA-256:
  `80efd1f928c84e6d39943f2e6aa5f813648cb79a658784e42b6ee24fca65ab8f`;
- generated result after deleting only `generatedAt`:
  `c50a1e9ed98849c68784dde808342c4ce2ccaa0d20a047f51461585c34433302`.
