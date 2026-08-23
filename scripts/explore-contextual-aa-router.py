#!/usr/bin/env python3
"""Explore a strictly-online contextual loss router over five aggregators.

For each expert, an online ridge model predicts square loss from source,
strictly-prior pair metrics, feedback size, and current forecast disagreement.
The predicted losses enter the source-specialist AA posterior as a contextual
pseudo-sample.  Only feedback with resolution_date earlier than the current
forecast date is fitted.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

sys.dont_write_bytecode = True


def load_module(name: str, filename: str):
    path = Path(__file__).with_name(filename)
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot import {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


PH4 = load_module("hierarchical_phase4", "explore-hierarchical-quality-aa.py")
PH3 = PH4.PH3
PH2 = PH4.PH2
EXP = PH4.EXP
BASE = PH4.BASE

HSQAA_BALANCED = "hier-aa-source-q2-5-e2p0-p50p0-s1p0"
HSQAA_OVERALL = "hier-aa-source-q4-5-e1p0-p500p0-s1p0"
CONTROLS = (
    "historical-best",
    "two-model-hedge",
    "full-7",
    "no-dependence-4",
    "nodep-gap-g5p0",
    PH3.SSH5,
    PH4.SSAA_MEAN,
    PH4.SSAA_SOTA,
    HSQAA_BALANCED,
    HSQAA_OVERALL,
)
FEATURE_SETS = ("compact", "full")
RIDGE_LAMBDAS = (100.0, 1000.0, 10_000.0)
CONTEXT_PSEUDOS = (10.0, 50.0, 200.0, 500.0)
SHRINKS = (0.75, 1.0)
ETA = 2.0
SOURCE_ORDER = tuple(sorted(BASE.DATASET_SOURCES | BASE.MARKET_SOURCES))

FEATURE_NAMES = (
    "intercept",
    *(f"source:{source}" for source in SOURCE_ORDER),
    "quality_strength",
    "bi_gap_scaled",
    "feedback_fraction",
    "pog_percentile",
    "lift_percentile",
    "corr_percentile",
    "safe_alpha",
    "model_disagreement",
    "model_extremity",
    "expert_std",
    "expert_range",
    "quality_x_disagreement",
    "quality_x_expert_std",
    "pog_x_disagreement",
    "gap_x_disagreement",
)
COMPACT_NAMES = {
    "intercept",
    *(f"source:{source}" for source in SOURCE_ORDER),
    "quality_strength",
    "bi_gap_scaled",
    "feedback_fraction",
    "model_disagreement",
    "expert_std",
}
FEATURE_INDICES = {
    "compact": np.asarray([
        index for index, name in enumerate(FEATURE_NAMES) if name in COMPACT_NAMES
    ], dtype=int),
    "full": np.arange(len(FEATURE_NAMES), dtype=int),
}


def token(value: float) -> str:
    return str(value).replace(".", "p")


def candidate_names() -> list[str]:
    names = list(CONTROLS)
    for feature_set in FEATURE_SETS:
        for ridge_lambda in RIDGE_LAMBDAS:
            for pseudo in CONTEXT_PSEUDOS:
                for shrink in SHRINKS:
                    names.append(
                        f"context-aa-{feature_set}-l{token(ridge_lambda)}-"
                        f"p{token(pseudo)}-s{token(shrink)}"
                    )
    return names


METHODS = candidate_names()


@dataclass
class ContextPending:
    resolution_date: str
    outcome: float
    features: tuple[float, ...]
    strategies: tuple[float, ...]


@dataclass
class ContextState:
    xtx: np.ndarray = field(
        default_factory=lambda: np.zeros((len(FEATURE_NAMES), len(FEATURE_NAMES)), dtype=float)
    )
    xty: np.ndarray = field(
        default_factory=lambda: np.zeros((len(FEATURE_NAMES), 5), dtype=float)
    )
    feedback: int = 0
    pending: list[ContextPending] = field(default_factory=list)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument(
        "--parameters", type=Path,
        default=Path("public/forecastbench/dash2-history.json"),
    )
    parser.add_argument("--development-cutoff", default="2025-12-21")
    parser.add_argument("--confirmation-cutoff", default="2026-03-29")
    parser.add_argument(
        "--output", type=Path,
        default=Path("output/research/contextual-aa-router-2026-08-23.json"),
    )
    parser.add_argument("--bootstrap-reps", type=int, default=20_000)
    parser.add_argument("--seed", type=int, default=20_260_828)
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def settle_context(state: ContextState, date: str) -> None:
    keep: list[ContextPending] = []
    for pending in state.pending:
        if pending.resolution_date >= date:
            keep.append(pending)
            continue
        features = np.asarray(pending.features, dtype=float)
        losses = (np.asarray(pending.strategies, dtype=float) - pending.outcome) ** 2
        state.xtx += np.outer(features, features)
        state.xty += np.outer(features, losses)
        state.feedback += 1
    state.pending = keep


def fitted_models(state: ContextState) -> dict[tuple[str, float], np.ndarray]:
    result = {}
    for feature_set in FEATURE_SETS:
        indices = FEATURE_INDICES[feature_set]
        xtx = state.xtx[np.ix_(indices, indices)]
        xty = state.xty[indices]
        for ridge_lambda in RIDGE_LAMBDAS:
            penalized = xtx + ridge_lambda * np.eye(len(indices))
            result[(feature_set, ridge_lambda)] = np.linalg.solve(penalized, xty)
    return result


def feature_matrix(
    targets: list,
    first: np.ndarray,
    second: np.ndarray,
    strategies: list[np.ndarray],
    metric: dict,
    quality_percentile: float,
    pog_percentile: float,
    lift_percentile: float,
    corr_percentile: float,
    alpha: float,
) -> np.ndarray:
    n = len(targets)
    sources = [target.source for target in targets]
    source_columns = np.asarray([
        [1.0 if source == named else 0.0 for named in SOURCE_ORDER]
        for source in sources
    ], dtype=float)
    quality_strength = np.full(n, 1.0 - quality_percentile)
    gap = np.full(n, math.tanh(float(metric["bi_gap"]) / 5.0))
    feedback = np.full(n, min(1.0, math.log1p(int(metric["n"])) / math.log1p(5000)))
    pog = np.full(n, pog_percentile)
    lift = np.full(n, lift_percentile)
    corr = np.full(n, corr_percentile)
    safe_alpha = np.full(n, alpha)
    disagreement = np.abs(first - second)
    extremity = 2.0 * np.abs(0.5 * (first + second) - 0.5)
    expert_matrix = np.vstack(strategies).T
    expert_std = np.std(expert_matrix, axis=1)
    expert_range = np.max(expert_matrix, axis=1) - np.min(expert_matrix, axis=1)
    return np.column_stack((
        np.ones(n),
        source_columns,
        quality_strength,
        gap,
        feedback,
        pog,
        lift,
        corr,
        safe_alpha,
        disagreement,
        extremity,
        expert_std,
        expert_range,
        quality_strength * disagreement,
        quality_strength * expert_std,
        pog * disagreement,
        gap * disagreement,
    ))


def contextual_square_aa(
    strategies: list[np.ndarray], adjusted_loss: np.ndarray, eta: float
) -> np.ndarray:
    predictions = np.vstack([np.asarray(strategy, dtype=float) for strategy in strategies])
    if adjusted_loss.shape != predictions.shape:
        raise RuntimeError((adjusted_loss.shape, predictions.shape))
    scores = -eta * adjusted_loss
    log_weights = scores - PH3.logsumexp(scores, axis=0)[None, :]
    generalized_zero = -PH3.logsumexp(
        log_weights - eta * predictions**2, axis=0
    ) / eta
    generalized_one = -PH3.logsumexp(
        log_weights - eta * (1.0 - predictions) ** 2, axis=0
    ) / eta
    return np.clip((1.0 + generalized_zero - generalized_one) / 2.0, 0.0, 1.0)


def contextual_candidates(
    pair_state,
    models: dict[tuple[str, float], np.ndarray],
    features: np.ndarray,
    targets: list,
    historical: np.ndarray,
    strategies: list[np.ndarray],
) -> dict[str, np.ndarray]:
    result: dict[str, np.ndarray] = {}
    global_loss = pair_state.phase1.frontier_loss
    global_n = pair_state.phase1.frontier_n
    for feature_set in FEATURE_SETS:
        indices = FEATURE_INDICES[feature_set]
        design = features[:, indices]
        for ridge_lambda in RIDGE_LAMBDAS:
            contextual_loss = np.clip(
                design @ models[(feature_set, ridge_lambda)], 0.0, 1.0
            ).T
            for pseudo in CONTEXT_PSEUDOS:
                prediction = np.empty(len(targets), dtype=float)
                for source in sorted({target.source for target in targets}):
                    selected = np.asarray([
                        index for index, target in enumerate(targets)
                        if target.source == source
                    ], dtype=int)
                    pair_adjusted = PH2.specialist_loss(
                        pair_state.source_loss.get(source),
                        pair_state.source_n.get(source, 0),
                        global_loss,
                        global_n,
                        200.0,
                    )
                    adjusted = pair_adjusted[:, None] + pseudo * contextual_loss[:, selected]
                    prediction[selected] = contextual_square_aa(
                        [strategy[selected] for strategy in strategies], adjusted, ETA
                    )
                for shrink in SHRINKS:
                    result[
                        f"context-aa-{feature_set}-l{token(ridge_lambda)}-"
                        f"p{token(pseudo)}-s{token(shrink)}"
                    ] = historical + shrink * (prediction - historical)
    expected = set(METHODS) - set(CONTROLS)
    if set(result) != expected:
        raise RuntimeError(
            f"context candidate mismatch: missing={expected-set(result)}, "
            f"extra={set(result)-expected}"
        )
    return result


def method_family(method: str) -> str:
    for feature_set in FEATURE_SETS:
        if method.startswith(f"context-aa-{feature_set}-"):
            return f"context-aa-{feature_set}"
    return method


def validation_pool(summary: dict) -> tuple[list[str], list[str]]:
    champions = EXP.select_discovery_champions(summary)
    families = sorted({method_family(method) for method in champions["paretoFront"]})
    choices = sorted(
        method for method in METHODS
        if method in CONTROLS or method_family(method) in families
    )
    return families, choices


def run(args: argparse.Namespace) -> dict:
    pairs = BASE.read_fixed_pairs(args.parameters)
    fixed_models = {model for pair in pairs for model in pair}
    targets_by_date, archive_audit = BASE.load_official_targets(args.archive, fixed_models)
    pair_states = {pair: PH2.State() for pair in pairs}
    hierarchy_state = PH4.PopulationState()
    context_state = ContextState()
    records: list[dict] = []
    source_records: list[dict] = []

    for date in sorted(targets_by_date):
        current = targets_by_date[date]
        for state in pair_states.values():
            PH2.settle(state, date)
        PH4.settle_population(hierarchy_state, date)
        settle_context(context_state, date)
        models = fitted_models(context_state)

        pair_rounds = {}
        metrics = {}
        for pair in pairs:
            common = [
                target for target in current
                if pair[0] in target.forecasts and pair[1] in target.forecasts
            ]
            if common:
                pair_rounds[pair] = common
            metric = BASE.pair_metrics(pair_states[pair].phase1.base)
            if metric is not None and len(common) >= 30:
                metrics[pair] = metric

        pog_pct = BASE.percentile(
            {pair: float(metric["pog"]) for pair, metric in metrics.items()}
        ) if metrics else {}
        quality_pct = BASE.percentile(
            {pair: float(metric["prior_quality"]) for pair, metric in metrics.items()},
            ascending=True,
        ) if metrics else {}
        finite_lift = {
            pair: float(metric["lift"]) for pair, metric in metrics.items()
            if math.isfinite(float(metric["lift"]))
        }
        finite_corr = {
            pair: float(metric["corr"]) for pair, metric in metrics.items()
            if math.isfinite(float(metric["corr"]))
        }
        lift_pct = BASE.percentile(finite_lift, ascending=False) if finite_lift else {}
        corr_pct = BASE.percentile(finite_corr, ascending=False) if finite_corr else {}

        for pair, common in pair_rounds.items():
            pair_state = pair_states[pair]
            metric = metrics.get(pair)
            alpha = 0.0
            if metric is not None:
                complementarity = float(np.mean((
                    pog_pct[pair], lift_pct.get(pair, 0.5), corr_pct.get(pair, 0.5)
                )))
                alpha = float(np.clip(
                    complementarity
                    * math.exp(-float(metric["bi_gap"]) / 2.0)
                    * min(1.0, int(metric["n"]) / 500.0),
                    0.0,
                    1.0,
                ))
            first = np.asarray([target.forecasts[pair[0]] for target in common])
            second = np.asarray([target.forecasts[pair[1]] for target in common])
            outcomes = np.asarray([target.outcome for target in common])

            if metric is not None:
                phase2_predictions, vectors, strategies = PH2.candidate_predictions(
                    pair_state, common, first, second, metric, alpha, pog_pct[pair]
                )
                phase3_predictions = PH3.aa_candidates(
                    pair_state, common, phase2_predictions["historical-best"], strategies
                )
                q2, q4 = PH4.quality_labels(quality_pct[pair])
                hierarchy_predictions = PH4.hierarchical_candidates(
                    pair_state,
                    hierarchy_state,
                    common,
                    phase2_predictions["historical-best"],
                    strategies,
                    q2,
                    q4,
                )
                prediction_sources = (
                    phase2_predictions, phase3_predictions, hierarchy_predictions
                )
                method_predictions = {
                    name: next(source[name] for source in prediction_sources if name in source)
                    for name in CONTROLS
                }
                features = feature_matrix(
                    common,
                    first,
                    second,
                    strategies,
                    metric,
                    quality_pct[pair],
                    pog_pct[pair],
                    lift_pct.get(pair, 0.5),
                    corr_pct.get(pair, 0.5),
                    alpha,
                )
                method_predictions.update(contextual_candidates(
                    pair_state,
                    models,
                    features,
                    common,
                    method_predictions["historical-best"],
                    strategies,
                ))
            else:
                base_predictions, vectors = BASE.vector_and_predictions(
                    pair_state.phase1.base, first, second, None, 0.0
                )
                historical = base_predictions["historical-best"]
                strategies = [
                    historical,
                    base_predictions["no-dependence-4"],
                    historical,
                    base_predictions["full-7"],
                    base_predictions["two-model-hedge"],
                ]
                method_predictions = {
                    "historical-best": historical,
                    "no-dependence-4": base_predictions["no-dependence-4"],
                }
                features = None
                q2, q4 = "unknown", "unknown"

            for index, target in enumerate(common):
                pair_state.phase1.pending.append(EXP.Pending(
                    target.resolution_date,
                    target.outcome,
                    float(first[index]),
                    float(second[index]),
                    date,
                    {
                        variant: tuple(float(values[index]) for values in vector)
                        for variant, vector in vectors.items()
                    },
                    float(method_predictions["historical-best"][index]),
                    float(method_predictions["no-dependence-4"][index]),
                    tuple(float(value[index]) for value in strategies),
                ))
                pair_state.pending.append(PH2.SpecialistPending(
                    target.resolution_date,
                    target.outcome,
                    target.source,
                    PH2.question_type(target.source),
                    float(first[index]),
                    float(second[index]),
                    tuple(float(value[index]) for value in strategies),
                ))
                if metric is not None and features is not None:
                    hierarchy_state.pending.append(PH4.PopulationPending(
                        target.resolution_date,
                        target.outcome,
                        target.source,
                        q2,
                        q4,
                        tuple(float(value[index]) for value in strategies),
                    ))
                    context_state.pending.append(ContextPending(
                        target.resolution_date,
                        target.outcome,
                        tuple(float(value) for value in features[index]),
                        tuple(float(value[index]) for value in strategies),
                    ))

            if metric is None:
                continue
            if date <= args.development_cutoff:
                sample = "development"
            elif date <= args.confirmation_cutoff:
                sample = "internal-validation"
            else:
                sample = "secondary-confirmation"
            row = {
                "date": date,
                "sample": sample,
                "pair": f"{pair[0]} | {pair[1]}",
                "n": len(common),
                "prior_quality": float(metric["prior_quality"]),
                "quality_percentile": float(quality_pct[pair]),
                "context_feedback": int(context_state.feedback),
                "loss_model_a": float(np.mean((first - outcomes) ** 2)),
                "loss_model_b": float(np.mean((second - outcomes) ** 2)),
            }
            for method, prediction in method_predictions.items():
                if method in METHODS:
                    row[f"loss_{method}"] = float(np.mean((prediction - outcomes) ** 2))
            required = {f"loss_{method}" for method in METHODS}
            if set(row) >= required:
                records.append(row)
                sources = np.asarray([target.source for target in common], dtype=object)
                for source in sorted(set(sources.tolist())):
                    mask = sources == source
                    source_row = {
                        "date": date,
                        "sample": sample,
                        "pair": row["pair"],
                        "source": source,
                        "question_type": PH2.question_type(source),
                        "n": int(np.sum(mask)),
                        "loss_model_a": float(np.mean((first[mask] - outcomes[mask]) ** 2)),
                        "loss_model_b": float(np.mean((second[mask] - outcomes[mask]) ** 2)),
                    }
                    for method, prediction in method_predictions.items():
                        if method in METHODS:
                            source_row[f"loss_{method}"] = float(
                                np.mean((prediction[mask] - outcomes[mask]) ** 2)
                            )
                    source_records.append(source_row)

    frame = pd.DataFrame(records)
    samples = {
        name: frame[frame["sample"] == name].copy()
        for name in ("development", "internal-validation", "secondary-confirmation")
    }
    if any(part.empty for part in samples.values()):
        raise RuntimeError({name: len(part) for name, part in samples.items()})

    EXP.METHODS = METHODS
    summaries = {name: EXP.sample_summary(part) for name, part in samples.items()}
    development_champions = EXP.select_discovery_champions(summaries["development"])
    development_families, pool = validation_pool(summaries["development"])
    preconfirmation = PH3.choose_from_shortlist(summaries["internal-validation"], pool)
    selected = sorted(set(preconfirmation.values()) | set(CONTROLS))
    confirmation = samples["secondary-confirmation"]
    prior_q1 = EXP.add_prior_quartile(confirmation)
    prior_q1 = prior_q1[prior_q1.prior_quartile == "Q1 strongest"]
    ex_post_q1 = EXP.add_ex_post_quality(confirmation)
    ex_post_q1 = ex_post_q1[ex_post_q1.ex_post_quartile == "Q1 strongest"]
    cis = {
        method: {
            "gainVsHistoricalBest": BASE.bootstrap(
                confirmation, "historical-best", method,
                args.bootstrap_reps, args.seed + index,
            ),
            "advantageVsHSQAA5Balanced": BASE.bootstrap(
                confirmation, HSQAA_BALANCED, method,
                args.bootstrap_reps, args.seed + 100 + index,
            ),
            "historicallyStrongQ1Gain": BASE.bootstrap(
                prior_q1, "historical-best", method,
                args.bootstrap_reps, args.seed + 200 + index,
            ),
            "historicallyStrongQ1AdvantageVsSSAA5Mean": BASE.bootstrap(
                prior_q1, PH4.SSAA_MEAN, method,
                args.bootstrap_reps, args.seed + 250 + index,
            ),
            "realizedStrongestQ1Gain": BASE.bootstrap(
                ex_post_q1, "ex-post-best", method,
                args.bootstrap_reps, args.seed + 300 + index,
            ),
        }
        for index, method in enumerate(selected)
    }
    source_frame = pd.DataFrame(source_records)
    confirmation_sources = source_frame[
        source_frame["sample"] == "secondary-confirmation"
    ].copy()
    result = {
        "schemaVersion": "1.0.0-contextual-aa-router",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "status": "post_hoc_phase5_mechanism_check_future_confirmation_required",
        "protocol": {
            "developmentCutoff": args.development_cutoff,
            "confirmationCutoff": args.confirmation_cutoff,
            "selection": (
                "development selects Pareto feature families; internal validation "
                "selects exact objective-specific configurations"
            ),
            "outcomeVisibility": "resolution_date strictly earlier than forecast date",
            "contextFeatures": list(FEATURE_NAMES),
            "featureSets": {
                name: [FEATURE_NAMES[index] for index in FEATURE_INDICES[name]]
                for name in FEATURE_SETS
            },
            "lossModel": "one global online ridge square-loss predictor per aggregation expert",
            "predictionClipping": "contextual predicted expert losses clipped to [0,1]",
            "populationUnit": "pair-target, matching the evaluation estimand",
            "warning": (
                "family was proposed after phase-4 secondary-confirmation inspection; "
                "later-block results are exploratory"
            ),
        },
        "audit": {
            **archive_audit,
            "parameterSha256": sha256(args.parameters),
            "fixedPairs": len(pairs),
            "candidateMethods": len(METHODS),
            "contextDimension": len(FEATURE_NAMES),
            "allFeedbackStrictlyPreResolution": True,
        },
        "developmentChampions": development_champions,
        "developmentParetoFamilies": development_families,
        "validationPool": pool,
        "preConfirmationChampions": preconfirmation,
        "samples": summaries,
        "selectedConfirmationCIs": cis,
        "confirmationPairWinComparisons": {
            method: {
                control: PH2.pair_win_comparison(confirmation, method, control)
                for control in (
                    HSQAA_BALANCED, PH4.SSAA_MEAN, PH4.SSAA_SOTA,
                    PH3.SSH5, "no-dependence-4", "full-7",
                )
                if method != control
            }
            for method in selected
        },
        "confirmationSourceSlices": PH2.slice_summary(
            confirmation_sources, "source", selected
        ),
        "confirmationQuestionTypeSlices": PH2.slice_summary(
            confirmation_sources, "question_type", selected
        ),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    return result


def main() -> None:
    args = parse_args()
    result = run(args)
    selected = sorted(set(result["preConfirmationChampions"].values()) | set(CONTROLS))
    print(json.dumps({
        "output": str(args.output.resolve()),
        "audit": result["audit"],
        "developmentChampions": result["developmentChampions"],
        "developmentParetoFamilies": result["developmentParetoFamilies"],
        "preConfirmationChampions": result["preConfirmationChampions"],
        "selected": {
            sample: {
                method: {
                    "overall": result["samples"][sample]["overall"][method],
                    "q1": result["samples"][sample]["q1Strongest"][method],
                    "pairSota": result["samples"][sample]["pairSota"][method],
                }
                for method in selected
            }
            for sample in ("development", "internal-validation", "secondary-confirmation")
        },
        "confirmationCIs": result["selectedConfirmationCIs"],
    }, indent=2))


if __name__ == "__main__":
    main()
