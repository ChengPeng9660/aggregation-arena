# Resolution-aware Safe Frontier exploration — 2026-08-23

## Objective

Search for a two-model aggregation rule that improves at least one of three
objectives without outcome leakage:

1. lower target-weighted average Raw Brier;
2. larger gain for the historically strongest Q1 pair-date cells; or
3. a higher fraction of model pairs that beat their ex-post better constituent.

## Interpretation boundary

This is a post-hoc challenger search. The candidate families were proposed
after inspecting the earlier post-cutoff confirmation, so the later block in
this report is a **secondary evaluation**, not a fresh independent OOS test.
Any selected challenger requires another future confirmation before production
or paper-level superiority claims.

No website or production leaderboard code was changed.

## Leakage-safe protocol

- Exact fixed cohort: 421 unordered model pairs from the frozen pre-cutoff
  `dash2-history.json` artifact.
- Discovery: 21 dates through 2026-03-29, 1,567 pair-date cells, 1,620,526
  pair-target evaluations.
- Secondary confirmation: 9 dates from 2026-04-12 through 2026-08-02, 211
  cells, 167,577 evaluations, and 91 observed frozen pairs.
- At forecast date `t`, every weight, quality feature, and candidate-selection
  statistic uses only targets with official `resolution_date < t`.
- Current-date outcomes are used only for offline scoring and enter learning
  after their own resolution dates.
- Champion IDs and the discovery Pareto front are computed from discovery rows
  before confirmation summaries are constructed.
- Score: target-weighted Raw Brier; lower is better.

## Candidate families

The sweep contains 54 methods across:

- fixed shrinkage toward the historical-best constituent;
- dependence-alpha and historical BI-gap shrinkage;
- confidence-gated aggregation;
- pair-specific safe Hedge;
- pair-specific ridge-convex pooling;
- current-disagreement specialists;
- prior-POG specialists; and
- pair-specific FTL/Hedge over Historical Best, No-Dependence-4, Gap-5,
  Full-7, and Two-model Hedge.

## Main new rule: GapSafe-DASH-2

Let `h_t` be the constituent selected by strictly-prior Raw Brier, let
`q_ND4,t` be No-Dependence-4, and let `DeltaBI_t` be the absolute strictly-prior
Brier Index difference between the two constituents. Define

```text
mix_t = exp(-DeltaBI_t / g)
q_GapSafe,t = h_t + mix_t * (q_ND4,t - h_t)
```

When the two models have similar prior quality, GapSafe retains most of the
aggregation. When one model is clearly better, it moves toward that model.
`g` is a transparent safety/coverage knob:

- smaller `g`: more conservative, usually higher pair-SOTA coverage but worse
  target-weighted average Brier;
- larger `g`: closer to No-Dependence-4, usually better average Brier but less
  protection against harmful mixing.

The `g=5` diagnostic point is referred to as **GapSafe-DASH-2 (G5)** below.

## Discovery results

The discovery-only champions are:

| Objective | Champion | Overall Brier | Strong-Q1 gain | Pair SOTA |
|---|---|---:|---:|---:|
| Overall | Full-7 | **0.1538525** | +0.0007681 | 283/421 (67.2%) |
| Strong Q1 | Gap-floor F0.5/G2 | 0.1540175 | **+0.0010828** | 306/421 (72.7%) |
| Pair SOTA | GapSafe G1 | 0.1548261 | +0.0007689 | **317/421 (75.3%)** |
| Balanced rank | Frontier-Hedge-5 | 0.1538914 | +0.0010800 | 303/421 (72.0%) |

No single method dominates all three discovery objectives. The Pareto front
contains Full-7, No-Dependence-4, Full-7 shrinkage, several gap/floor variants,
and Frontier-Hedge-5.

## Secondary confirmation results

| Method | Overall Brier | Gain vs historical best | Historical-Q1 gain | Pair SOTA |
|---|---:|---:|---:|---:|
| **No-Dependence-4** | **0.1555570** | **+0.0022165** | +0.0030091 | 62/91 (68.1%) |
| GapSafe-DASH-2 G5 | 0.1556907 | +0.0020828 | +0.0026695 | **65/91 (71.4%)** |
| Frontier-Hedge-5 | 0.1556838 | +0.0020896 | +0.0026402 | 61/91 (67.0%) |
| Full-7 | 0.1557148 | +0.0020587 | **+0.0031686** | 56/91 (61.5%) |

The result separates the objectives cleanly:

- **Best average:** No-Dependence-4 remains the lowest-Brier method.
- **Best historically strong Q1:** Full-7 remains best on this block.
- **Best pair-SOTA tradeoff:** GapSafe G5 reaches 65/91 strict pair wins,
  three more than No-Dependence-4 and nine more than Full-7, while retaining a
  lower overall Brier than Full-7.

For GapSafe G5:

- gain versus historical best is `+0.0020828`, with 95% date-bootstrap interval
  `[+0.0006165, +0.0026188]`;
- historical-Q1 gain is `+0.0026695`, with interval
  `[+0.0001411, +0.0030691]`;
- it pays `0.0001337` Brier relative to No-Dependence-4, and that average-score
  cost has interval `[+0.0000091, +0.0002446]` when written as a loss.

Thus G5 is not a free improvement. It exchanges a small but statistically
visible amount of average score for three additional strict pair wins.

## Does it protect the actually best models?

In the realized strongest Q1, GapSafe G5 has gain `-0.0001836` versus the
ex-post better constituent, with interval
`[-0.0010681, +0.0002162]`. It is less harmful than Full-7 (`-0.0005066`), but
it still does not establish oracle dominance.

Therefore:

- historically strong groups can be improved reliably;
- a higher pair-SOTA rate can be purchased with quality-gap shrinkage;
- “always beats the realized best model” remains unsupported.

## What the negative ablations say

Confidence gates, ridge-convex pools, and POG-only specialists did not become
discovery champions. Dependence-alpha shrinkage also failed to beat the simple
BI-gap frontier. This suggests that the current three dependence metrics are
useful for diagnosing aggregation headroom but are not yet sufficiently stable
as standalone deployment routers. Prior relative quality is the strongest
safety signal in this sweep.

## Recommended freeze

Keep two explicit operating points rather than claiming one universal winner:

1. **Average mode:** No-Dependence-4.
2. **High-SOTA mode:** GapSafe-DASH-2 G5.

Freeze G5 now and evaluate it on future official resolved rounds without
changing `g`. Frontier-Hedge-5 and the gap-floor family remain secondary
challengers, not production methods.

## Reproduction

```bash
/Users/pcc/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  scripts/explore-safe-frontier-resolution-aware.py \
  --archive /tmp/forecastbench-processed-2026-08-23-a.tar.gz \
  --output output/research/safe-frontier-resolution-aware-discovery-2026-08-23.json
```

- official archive SHA-256:
  `df42f18ea07e8a496329ce17daff2c1663caa05818cbc8c799860672e268c3d7`;
- script SHA-256:
  `f2c085a651c8ec5a90690e94888d1f1530d2a446ee8612efa137ba335d2f042e`;
- complete result SHA-256:
  `36d6e91b693a6f910c3e04d632fd5fd37632e724dfc98c7336ff928135204f1b`;
- repeated-run SHA-256 after removing only `generatedAt`:
  `2cc87d7f1ca3c562d12c538faf4c58cd20bed1401cf8d37120146c28fa864b13`.

