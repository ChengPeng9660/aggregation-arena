# Contextual AA router phase-5 exploration — 2026-08-23

## Decision in one sentence

Reject the current global ridge-loss contextual router as a new challenger:
development and internal validation select contextual configurations, but
those exact configurations fail to improve the frozen HSQAA/SSAA frontier on
the secondary block, and the apparently excellent post-hoc compact settings
demonstrate hyperparameter instability rather than confirmable progress.

## Interpretation boundary

This is a **post-hoc phase-5 mechanism check** proposed after phase 4. The
later block is secondary evidence, not independent OOS. No contextual method
is promoted, frozen for production, or added to the website.

## Router definition

The router does not predict the binary outcome. It fits one global online
ridge model per aggregation expert to predict that expert's square loss from
features available before the current outcome:

- official ForecastBench source;
- strictly-prior pair quality percentile;
- strictly-prior BI gap and effective feedback size;
- strictly-prior POG, high-loss-lift, loss-correlation percentiles, and
  SafeMix alpha in the full feature set;
- current two-model disagreement and extremity; and
- current dispersion/range among the five aggregation experts.

At forecast date `t`, ridge sufficient statistics contain only pair-targets
with `resolution_date < t`. Predicted expert losses are clipped to `[0,1]`,
multiplied by a context pseudo-count, added to the source-specialist pair loss,
and converted to a probability using the square-loss AA substitution.

Two fixed feature families were explored:

- compact: 15 features;
- full: 25 features including complementarity and interactions.

The search used ridge penalties `{100, 1000, 10000}`, context pseudo-counts
`{10, 50, 200, 500}`, and shrinkage `{0.75, 1.0}`, for 48 contextual variants
and 58 methods including controls.

## Nested temporal selection

- Development: 14 dates, 448 pair-date cells, 536,418 pair-target evaluations,
  214 observed frozen pairs.
- Internal validation: 7 later dates, 1,119 cells, 1,084,108 evaluations,
  348 pairs.
- Secondary confirmation: 9 later dates, 211 cells, 167,577 evaluations,
  91 pairs.

Development admitted both compact and full feature families. Internal
validation selected:

| Objective | Selected method |
|---|---|
| Overall | `context-aa-full-l100p0-p200p0-s1p0` |
| Strong Q1 | SSAA-5 Mean, unchanged |
| Pair SOTA | SSAA-5 SOTA, unchanged |
| Balanced ranks | `context-aa-full-l100p0-p50p0-s1p0` |

The contextual family therefore failed to replace the existing strong-Q1 or
pair-SOTA champions before secondary results were read.

## Exact selected-config results

| Method | Block | Raw Brier | Historical-Q1 gain | Pair SOTA | Macro pair gain |
|---|---|---:|---:|---:|---:|
| Context overall | Development | 0.1607720 | +0.0015049 | 154/214 | +0.0018632 |
| Context overall | Internal validation | **0.1501670** | +0.0011639 | 268/348 | +0.0010612 |
| Context overall | Secondary | 0.1555300 | +0.0028856 | 66/91 | +0.0006426 |
| Context balanced | Development | 0.1607831 | +0.0016062 | 154/214 | +0.0018367 |
| Context balanced | Internal validation | 0.1501742 | +0.0012228 | 273/348 | +0.0010644 |
| Context balanced | Secondary | 0.1554509 | +0.0028626 | 68/91 | +0.0007323 |
| **HSQAA-5 Balanced** | Secondary | **0.1554384** | +0.0027936 | 68/91 | **+0.0007495** |
| SSAA-5 SOTA | Secondary | 0.1557360 | +0.0022336 | **70/91** | +0.0004498 |

The internally selected overall configuration is worse than HSQAA-5 Balanced
by `-0.0000915` on the secondary block, with paired interval
`[-0.0001928, +0.0000283]`. It also loses two strict pair wins.

The internally selected balanced configuration is worse than HSQAA-5
Balanced by `-0.0000125`, with interval
`[-0.0000424, +0.0000204]`. It has the exact same 68-pair win set as HSQAA but
a smaller macro pair gain.

Both selected contextual configurations have higher secondary historical-Q1
point estimates than SSAA-5 Mean, but their direct strong-Q1 advantage
intervals cross zero:

- overall configuration: `+0.0001154`, interval
  `[-0.0000267, +0.0001322]`;
- balanced configuration: `+0.0000924`, interval
  `[-0.0000373, +0.0001119]`.

Thus neither provides supported strong-group superiority.

## Why the best-looking contextual result is not promoted

After reading the secondary block, the best contextual point is

```text
context-aa-compact-l10000p0-p200p0-s1p0
```

with:

- Raw Brier `0.1553909`;
- historical-Q1 gain `+0.0029939`;
- 68/91 strict pair wins; and
- macro pair gain `+0.0007931`.

This would be the best average/Q1 joint point among the explored contextual
variants, but it was not selected by internal validation. In the two
pre-confirmation blocks its strong-Q1 gain was only `+0.0016196` and
`+0.0011684`, both below SSAA-5 Mean, while its secondary Q1 rises abruptly to
`+0.0029939`.

Promoting it now would be direct post-hoc selection on the supposed
confirmation block. It is recorded only as evidence that the contextual
mapping and/or regularization regime is non-stationary.

## Source diagnosis

The selected balanced contextual configuration is competitive on Dataset but
weaker on Market:

| Type | Context balanced Brier | Gain vs historical best | Advantage vs NoDep4 |
|---|---:|---:|---:|
| Dataset | 0.1534335 | +0.0024336 | +0.0001318 |
| Market | 0.1678333 | +0.0016407 | -0.0000523 |

Its weakest relative behavior appears on INFER and Manifold. This reinforces
the phase-4 finding that a single global contextual mapping does not transfer
uniformly between Dataset and Market regimes.

## Failure interpretation

The experiment rules out the current design, not all contextual routing.
Three likely causes are:

1. **Non-stationarity:** the context-to-expert-loss mapping changes between
   the internal and secondary blocks.
2. **Global pooling bias:** one coefficient matrix across all pairs and dates
   overweights Dataset observations and can underfit Market-specific behavior.
3. **Hyperparameter selection noise:** only seven internal-validation dates
   choose among two feature families and multiple regularization strengths.

The next justified mechanism is not a larger feature grid. It is an online
meta-AA over a very small frozen set of contextual and non-contextual routers,
including HSQAA-5 Balanced and the compact contextual family. This would adapt
between regimes using past realized router losses rather than selecting one
regularization setting forever.

## Oracle limitation

Both selected contextual methods remain negative versus the ex-post better
constituent in the realized strongest Q1, with intervals crossing zero.
“Always SOTA” remains unsupported.

## Reproduction

```bash
/Users/pcc/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  scripts/explore-contextual-aa-router.py \
  --archive /tmp/forecastbench-processed-2026-08-23-a.tar.gz \
  --output output/research/contextual-aa-router-2026-08-23.json
```

- official archive SHA-256:
  `df42f18ea07e8a496329ce17daff2c1663caa05818cbc8c799860672e268c3d7`;
- frozen pair-parameter SHA-256:
  `6787ef970d2f03e920db32c1bb991ad0c1911a5a404484c2ce4dd6c6483a9ab1`;
- script SHA-256:
  `3f8408667ca695588f9770480efd0b6f59c40054db93cb59dc9799599d6556ea`;
- full generated result SHA-256:
  `fa767039b25a3628383b4f089416f3586f9c8ff4972f27ead4e24d4111d1a869`;
- generated result after deleting only `generatedAt`:
  `7a8cce28bc5a63e09e17d7cc0bb959b6dfaa14e9cf57c7eac8cb5121da65c42c`.
