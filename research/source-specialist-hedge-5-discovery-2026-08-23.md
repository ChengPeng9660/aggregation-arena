# Source-Specialist Hedge-5 exploration — 2026-08-23

## Result in one sentence

Conditioning online expert weights on the official ForecastBench source creates
the first challenger that simultaneously has the best confirmation average
point estimate and the highest confirmation pair-SOTA rate, while preserving a
positive gain for historically strong pairs.

## Interpretation boundary

This is a phase-2 post-hoc exploration. The source/type specialist families
were proposed after inspecting earlier confirmation results. Candidate IDs are
selected using pre-cutoff data only, but the later block is a **secondary
confirmation**, not a new independent OOS result. Another future resolved block
is required before production deployment or a paper-level superiority claim.

No website or production leaderboard code was changed.

## Algorithm: Source-Specialist Hedge-5 (SSH-5)

For each exact model pair and official ForecastBench source, SSH-5 maintains
strictly-prior cumulative Raw Brier losses for five strategies:

1. Historical Best;
2. No-Dependence-4;
3. GapSafe-DASH-2 G5;
4. Full-7; and
5. Two-model Hedge.

For source `s`, expert `k`, and forecast date `t`, define

```text
adjusted_loss[s,k,t]
  = source_loss[s,k,t]
  + 200 * global_loss[k,t] / global_feedback[t]

weight[s,k,t]
  proportional to exp(-0.5 * adjusted_loss[s,k,t])

SSH5_prediction[t]
  = sum_k weight[s,k,t] * expert_prediction[k,t]
```

The 200 pseudo-observations shrink sparse source states toward the pair's
global expert performance. The fixed learning rate is `eta = 0.5`, motivated by
the exp-concavity of bounded square loss. Because feedback is delayed by actual
resolution dates, this report does not claim a no-delay regret theorem.

Every date-`t` weight uses only targets with official `resolution_date < t`.
Current outcomes never enter current predictions.

## Evaluation protocol

- Official processed ForecastBench archive SHA-256:
  `df42f18ea07e8a496329ce17daff2c1663caa05818cbc8c799860672e268c3d7`.
- Frozen 421-pair cohort; exact model names preserved.
- Canonical target key:
  `forecast_due_date + source + id + resolution_date`.
- Discovery: 21 dates through 2026-03-29, 1,567 pair-date cells, 1,620,526
  pair-target evaluations.
- Secondary confirmation: 9 later dates, 211 cells, 167,577 evaluations, 91
  observed frozen pairs.
- 54 phase-2 candidate methods.
- 20,000 paired forecast-date bootstrap draws.
- Primary metric: target-weighted Raw Brier; lower is better.

## Discovery selection

SSH-5 (`fixed-hedge-source5-e0p5-p200p0`) is selected twice from discovery
data: strongest-Q1 champion and balanced-rank champion.

| Method | Overall Brier | Historical-Q1 gain | Pair SOTA |
|---|---:|---:|---:|
| **SSH-5** | **0.1538074** | **+0.0011764** | **306/421 (72.7%)** |
| Full-7 | 0.1538525 | +0.0007681 | 283/421 (67.2%) |
| No-Dependence-4 | 0.1538672 | +0.0010366 | 292/421 (69.4%) |
| GapSafe G5 | 0.1540306 | +0.0010600 | 306/421 (72.7%) |

The type-level analogue is the discovery overall champion, but the fine source
specialist has stronger Q1 performance and a better balanced rank.

## Secondary confirmation

| Method | Overall Brier | Gain vs historical best | Historical-Q1 gain | Pair SOTA |
|---|---:|---:|---:|---:|
| **SSH-5** | **0.1555106** | **+0.0022628** | +0.0027207 | **68/91 (74.7%)** |
| No-Dependence-4 | 0.1555570 | +0.0022165 | +0.0030091 | 62/91 (68.1%) |
| GapSafe G5 | 0.1556907 | +0.0020828 | +0.0026695 | 65/91 (71.4%) |
| Full-7 | 0.1557148 | +0.0020587 | **+0.0031686** | 56/91 (61.5%) |

SSH-5's gain versus the deployable historical-best constituent is
`+0.0022628`, with 95% date-bootstrap interval
`[+0.0010326, +0.0028494]`.

Its historical-Q1 gain is `+0.0027207`, with interval
`[+0.0004722, +0.0031336]`.

### Paired average comparisons

- versus No-Dependence-4: advantage `+0.0000463`, interval
  `[-0.0000229, +0.0002741]`;
- versus GapSafe G5: advantage `+0.0001800`, interval
  `[+0.0001205, +0.0003326]`;
- versus Full-7: advantage `+0.0002042`, interval
  `[-0.0001014, +0.0004723]`.

Thus SSH-5 significantly improves over GapSafe G5 on average. Its point
estimate also improves over No-Dependence-4 and Full-7, but those two intervals
still cross zero.

## Pair-SOTA set dominance

SSH-5 does not obtain 68 wins by trading away old winning pairs:

| Control | Both win | SSH-5 only | Control only | Neither |
|---|---:|---:|---:|---:|
| No-Dependence-4 | 62 | **6** | **0** | 23 |
| GapSafe G5 | 65 | **3** | **0** | 23 |
| Full-7 | 55 | **13** | 1 | 22 |

On this confirmation block, SSH-5's strict pair-win set is a superset of both
No-Dependence-4 and GapSafe G5. This is descriptive secondary evidence, not a
future guarantee.

## Source and event-type diagnosis

### Broad question types

| Type | Pair-target evaluations | SSH-5 gain vs historical best | SSH-5 advantage vs NoDep4 |
|---|---:|---:|---:|
| Dataset | 144,099 | +0.002357 | +0.000055 |
| Market | 23,478 | +0.001684 | -0.000009 |

SSH-5 improves over historical best in both broad types. Its average advantage
over No-Dependence-4 is concentrated in Dataset questions; Market performance
is essentially tied.

### Fine official sources

SSH-5 improves over No-Dependence-4 on ACLED, FRED, DBnomics, Manifold, and
INFER. It is worse on Wikipedia, Yahoo Finance, Polymarket, and Metaculus. The
fine source pattern explains why the source specialist generalizes better than
the coarser Dataset/Market specialist.

The result supports an operational interpretation of the earlier cross-event
dependence finding: aggregation strategy rankings are not invariant across
event sources, so source-conditioned expert weights can exploit persistent
regime structure better than one global pool.

## Remaining failure mode

In the realized strongest Q1, SSH-5 has gain `-0.0003401` versus the ex-post
better constituent, with interval `[-0.0012630, +0.0000772]`. Therefore it does
not prove oracle dominance or “always SOTA.”

The strongest supported claim is:

> Source-conditioned online expert weighting improves the empirical
> average/SOTA frontier and preserves gains among historically strong model
> pairs, but does not guarantee dominance over the constituent that turns out
> to be best.

## Recommended freeze

Freeze the exact challenger:

```text
Source-Specialist Hedge-5
eta = 0.5
global pseudo-count = 200
experts = Historical Best, NoDep4, GapSafe G5, Full-7, Two-model Hedge
```

Do not tune `eta`, pseudo-count, source taxonomy, or expert list on subsequent
outcomes. Evaluate this exact rule on the next official resolved rounds.

## Reproduction

```bash
/Users/pcc/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  scripts/explore-mixable-source-frontier.py \
  --archive /tmp/forecastbench-processed-2026-08-23-a.tar.gz \
  --output output/research/mixable-source-frontier-2026-08-23.json
```

- script SHA-256:
  `08c1d62bdc4402dc5f7041763cf0eddc9037264cb2cdf2dc320bb5a5643a8bea`;
- full result SHA-256:
  `16ac5964cd5999c66b8ebf2152dbb437e7ccf459bed7454e206d56f17fb6e9b1`;
- repeated-run SHA-256 after removing only `generatedAt`:
  `5a887eaa1352abfb48f71fa06e00244e225d8c51c6f93fcaafb8574427a2aff2`.

