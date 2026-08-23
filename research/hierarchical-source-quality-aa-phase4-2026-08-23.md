# Hierarchical Source-Quality AA phase-4 exploration — 2026-08-23

## Result in one sentence

Sharing strictly-prior expert losses across model pairs in the same official
source and historical-quality regime produces a small but temporally stable
balanced improvement over SSAA-5 Mean; it does not replace the existing
strong-Q1 or high-SOTA champions and therefore does not solve oracle dominance.

## Interpretation boundary

This is a **post-hoc phase-4 mechanism check**. The cross-pair hierarchy was
proposed after inspecting SSAA-5's secondary-confirmation results. Development
and internal validation determine the exact objective-specific IDs without
using later outcomes, but the 2026-03-29+ block is still secondary evidence.
A future official resolved block is required for an independent claim.

No website or production leaderboard code was changed.

## Mechanism

The five experts and square-loss substitution are identical to SSAA-5. For
each exact pair and source, first form the SSAA pair-specific adjusted loss:

```text
pair_adjusted_loss[k]
  = pair_source_loss[k]
  + 200 * pair_global_loss[k] / pair_global_feedback.
```

At each forecast date, rank currently eligible pairs by the better
constituent's strictly-prior Raw Brier. The hierarchy stores cross-pair
pair-target expert losses for:

- source only;
- source × strong/weak half (`q2`); and
- source × quality quartile (`q4`).

For hierarchy cell `h`, add a frozen pseudo-count of its historical mean:

```text
hierarchical_loss[k]
  = pair_adjusted_loss[k]
  + population_pseudo_count * population_mean_loss[h,k].
```

The current prediction then uses the square-loss generalized-prediction
substitution with the frozen learning rate. All population and pair states use
only events with `resolution_date < current forecast date`.

The population unit is pair-target expert loss, matching the evaluation
estimand. Statistical uncertainty is nevertheless bootstrapped by forecast
date, not by treating repeated pair-target observations as independent.

## Nested temporal protocol

- Development: 14 dates, 448 pair-date cells, 536,418 pair-target evaluations,
  214 observed frozen pairs.
- Internal validation: 7 later dates, 1,119 cells, 1,084,108 evaluations,
  348 pairs.
- Secondary confirmation: 9 later dates, 211 cells, 167,577 evaluations,
  91 pairs.
- Frozen cohort: 421 exact unordered model pairs.
- Candidate methods: 56.
- Bootstrap: 20,000 paired forecast-date draws.
- Primary metric: target-weighted Raw Brier; lower is better.

Development selected source-only, source-q2, source-q4, and SSAA-5 Mean as
Pareto mechanism families. Internal validation selected:

| Objective | Selected method |
|---|---|
| Overall | `hier-aa-source-q4-5-e1p0-p500p0-s1p0` |
| Strong Q1 | SSAA-5 Mean, unchanged |
| Pair SOTA | SSAA-5 SOTA, unchanged |
| Balanced ranks | `hier-aa-source-q2-5-e2p0-p50p0-s1p0` |

## Recommended phase-4 challenger

The recommended new challenger is **HSQAA-5 Balanced**:

```text
id = hier-aa-source-q2-5-e2p0-p50p0-s1p0
quality regime = source × strictly-prior strong/weak half
learning rate = 2
pair-global pseudo-count = 200
population pseudo-count = 50
shrink = 1
```

It is preferred over the phase-4 overall-track ID because its mean advantage
has the same sign in all three temporal blocks and its secondary paired
interval is entirely positive.

## Results across all three temporal blocks

### Overall Raw Brier

| Block | HSQAA-5 Balanced | SSAA-5 Mean | Advantage |
|---|---:|---:|---:|
| Development | 0.1608085 | 0.1608190 | +0.0000104 |
| Internal validation | 0.1502059 | 0.1502090 | +0.0000031 |
| Secondary confirmation | **0.1554384** | 0.1554507 | **+0.0000123** |

On secondary confirmation, the paired date-bootstrap interval for the mean
advantage is `[+0.0000036, +0.0000222]`.

### Historical strong-Q1 gain

| Block | HSQAA-5 Balanced | SSAA-5 Mean | Difference |
|---|---:|---:|---:|
| Development | +0.0016296 | +0.0016449 | -0.0000154 |
| Internal validation | +0.0012464 | +0.0012566 | -0.0000102 |
| Secondary confirmation | **+0.0027936** | +0.0027702 | **+0.0000234** |

The secondary strong-Q1 advantage interval is
`[+0.0000043, +0.0000251]`. However, the direction is not replicated in the
two pre-confirmation blocks, and internal validation retained SSAA-5 Mean as
the strong-Q1 champion. This is secondary evidence, not a claim of stable
strong-group superiority.

### Pair-SOTA behavior

HSQAA-5 Balanced and SSAA-5 Mean win the exact same 68 of 91 pairs on the
secondary block: 68 joint wins, zero exclusive wins by either method, and 23
failures by both. The hierarchy raises macro pair gain from `+0.0007377` to
`+0.0007495` without changing the 74.7% win rate.

SSAA-5 SOTA remains the high-rate champion at 70/91 (76.9%). The hierarchy
does not improve it.

## Secondary comparison table

| Method | Raw Brier | Gain vs historical best | Historical-Q1 gain | Pair SOTA | Macro pair gain |
|---|---:|---:|---:|---:|---:|
| **HSQAA-5 Balanced** | **0.1554384** | **+0.0023350** | +0.0027936 | 68/91 (74.7%) | **+0.0007495** |
| SSAA-5 Mean | 0.1554507 | +0.0023227 | +0.0027702 | 68/91 (74.7%) | +0.0007377 |
| SSH-5 | 0.1555106 | +0.0022628 | +0.0027207 | 68/91 (74.7%) | +0.0006735 |
| Full-7 | 0.1557148 | +0.0020587 | **+0.0031686** | 56/91 (61.5%) | +0.0004389 |
| SSAA-5 SOTA | 0.1557360 | +0.0020374 | +0.0022336 | **70/91 (76.9%)** | +0.0004498 |

## Source diagnosis

The balanced hierarchy improves over SSAA-5 Mean on Dataset questions but is
slightly worse on Market questions:

| Type | HSQAA-5 Balanced Brier | Gain vs historical best | Advantage vs NoDep4 |
|---|---:|---:|---:|
| Dataset | 0.1534262 | +0.0024409 | +0.0001391 |
| Market | 0.1677888 | +0.0016852 | -0.0000077 |

Relative to SSAA-5 Mean, it improves on ACLED, DBnomics, FRED, Metaculus,
Wikipedia, and Yahoo Finance, and is worse on INFER, Manifold, and Polymarket.
It beats historical best on eight of nine sources; INFER remains negative.

## Overall-track diagnostic

The internal-validation overall champion,
`hier-aa-source-q4-5-e1p0-p500p0-s1p0`, has the lowest secondary point
estimate (`0.1554275`) and a secondary strong-Q1 gain of `+0.0028763`.
However:

- its mean advantage over SSAA-5 Mean has interval
  `[-0.0000312, +0.0000739]`;
- its development Brier is slightly worse than SSAA-5 Mean; and
- it was not the internal-validation strong-Q1 champion.

It is frozen as an objective-specific research track, not promoted over the
more stable balanced challenger.

## What phase 4 rules out

The cross-pair hierarchy does not produce a new pre-confirmation strong-Q1
champion and does not produce a new pair-SOTA champion. Merely adding more
historical-quality bins or a larger population pseudo-count is therefore not
the most promising route to a large strong-group gain.

In the realized ex-post strongest Q1, HSQAA-5 Balanced has gain `-0.0004010`
versus the constituent that turns out to be better, with interval
`[-0.0014825, +0.0000880]`. “Always SOTA” remains unsupported.

The next mechanism should learn a richer contextual routing function using
strictly-prior features such as source, historical quality, BI gap,
complementarity, current disagreement, and effective feedback size, with its
entire feature set and model class selected before another future block.

## Reproduction

```bash
/Users/pcc/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  scripts/explore-hierarchical-quality-aa.py \
  --archive /tmp/forecastbench-processed-2026-08-23-a.tar.gz \
  --output output/research/hierarchical-quality-aa-2026-08-23.json
```

- official archive SHA-256:
  `df42f18ea07e8a496329ce17daff2c1663caa05818cbc8c799860672e268c3d7`;
- frozen pair-parameter SHA-256:
  `6787ef970d2f03e920db32c1bb991ad0c1911a5a404484c2ce4dd6c6483a9ab1`;
- script SHA-256:
  `7f679e03866201317e65c0da83fca66517cbd4920df9cc0edbf570544cd56b75`;
- full generated result SHA-256:
  `9961ad351f5df2657ea3c3d1ee1e04e1de9a1968b91e9966a19d49b09be22789`;
- generated result after deleting only `generatedAt`:
  `f697cc8709633f5fa3937ac13afcbc193f7c5fd736c2610b08a853a405213ea0`.
