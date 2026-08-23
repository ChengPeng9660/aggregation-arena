#!/usr/bin/env python3
"""Explore a strictly-online AA over a small frozen router set.

The meta learner receives forecasts from five aggregation routers selected
before this phase.  It updates router losses only after resolution_date is
strictly earlier than the current forecast date.  Candidate meta learners
vary only the expert subset, feedback scope, memory, and conservative shrink.
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


P5 = load_module("contextual_phase5", "explore-contextual-aa-router.py")
PH4 = P5.PH4
PH3 = P5.PH3
PH2 = P5.PH2
EXP = P5.EXP
BASE = P5.BASE

HSQAA = P5.HSQAA_BALANCED
SSAA_MEAN = PH4.SSAA_MEAN
SSAA_SOTA = PH4.SSAA_SOTA
DASH_HEDGE_2 = "full-7"
CONTEXT_OVERALL = "context-aa-full-l100p0-p200p0-s1p0"
CONTEXT_BALANCED = "context-aa-full-l100p0-p50p0-s1p0"
ROUTERS = (
    HSQAA,
    SSAA_MEAN,
    SSAA_SOTA,
    DASH_HEDGE_2,
    CONTEXT_OVERALL,
    CONTEXT_BALANCED,
)
ROUTER_SETS = {
    "core2": (HSQAA, SSAA_MEAN),
    "strong2": (HSQAA, DASH_HEDGE_2),
    "frontier4": (HSQAA, SSAA_MEAN, SSAA_SOTA, DASH_HEDGE_2),
    "selected6": ROUTERS,
}
SCOPES = ("global", "type", "source")
MEMORIES = ("cumulative", "recent90")
SHRINKS = (0.75, 1.0)
ETA = 2.0
LOCAL_PSEUDO = 200.0
RECENT_DECAY = 0.90

CONTROLS = P5.CONTROLS + (CONTEXT_OVERALL, CONTEXT_BALANCED)


def token(value: float) -> str:
    return str(value).replace(".", "p")


def candidate_names() -> list[str]:
    names = list(CONTROLS)
    for router_set in ROUTER_SETS:
        for scope in SCOPES:
            for memory in MEMORIES:
                for shrink in SHRINKS:
                    names.append(
                        f"meta-aa-{router_set}-{scope}-{memory}-"
                        f"e{token(ETA)}-s{token(shrink)}"
                    )
    return names


METHODS = candidate_names()


@dataclass
class MetaPending:
    resolution_date: str
    outcome: float
    source: str
    question_type: str
    routers: tuple[float, ...]


@dataclass
class PoolStats:
    global_loss: np.ndarray = field(default_factory=lambda: np.zeros(len(ROUTERS)))
    global_n: float = 0.0
    source_loss: dict[str, np.ndarray] = field(default_factory=dict)
    source_n: dict[str, float] = field(default_factory=dict)
    type_loss: dict[str, np.ndarray] = field(default_factory=dict)
    type_n: dict[str, float] = field(default_factory=dict)


@dataclass
class MetaState:
    cumulative: PoolStats = field(default_factory=PoolStats)
    recent90: PoolStats = field(default_factory=PoolStats)
    pending: list[MetaPending] = field(default_factory=list)
    settled: int = 0


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
        default=Path("output/research/online-meta-aa-2026-08-23.json"),
    )
    parser.add_argument("--bootstrap-reps", type=int, default=20_000)
    parser.add_argument("--seed", type=int, default=20_260_829)
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_loss(container: dict, key) -> np.ndarray:
    if key not in container:
        container[key] = np.zeros(len(ROUTERS), dtype=float)
    return container[key]


def decay_stats(stats: PoolStats, decay: float) -> None:
    stats.global_loss *= decay
    stats.global_n *= decay
    for values in stats.source_loss.values():
        values *= decay
    for key in list(stats.source_n):
        stats.source_n[key] *= decay
    for values in stats.type_loss.values():
        values *= decay
    for key in list(stats.type_n):
        stats.type_n[key] *= decay


def add_observation(stats: PoolStats, pending: MetaPending) -> None:
    loss = (np.asarray(pending.routers, dtype=float) - pending.outcome) ** 2
    stats.global_loss += loss
    stats.global_n += 1.0
    ensure_loss(stats.source_loss, pending.source)[:] += loss
    stats.source_n[pending.source] = stats.source_n.get(pending.source, 0.0) + 1.0
    ensure_loss(stats.type_loss, pending.question_type)[:] += loss
    stats.type_n[pending.question_type] = stats.type_n.get(pending.question_type, 0.0) + 1.0


def settle_meta(state: MetaState, date: str) -> None:
    # Decay once per forecast date before adding newly observable feedback.
    decay_stats(state.recent90, RECENT_DECAY)
    keep: list[MetaPending] = []
    for pending in state.pending:
        if pending.resolution_date >= date:
            keep.append(pending)
            continue
        add_observation(state.cumulative, pending)
        add_observation(state.recent90, pending)
        state.settled += 1
    state.pending = keep


def scoped_loss(
    stats: PoolStats,
    scope: str,
    source: str,
    question_type: str,
) -> np.ndarray:
    if scope == "global":
        return stats.global_loss.copy()
    if scope == "source":
        local = stats.source_loss.get(source)
        local_n = stats.source_n.get(source, 0.0)
    elif scope == "type":
        local = stats.type_loss.get(question_type)
        local_n = stats.type_n.get(question_type, 0.0)
    else:
        raise RuntimeError(scope)
    # local_n is retained for audit and guards a missing local vector.  The
    # specialist score is cumulative local loss plus a fixed global-average
    # prior, matching the earlier source-specialist AA construction.
    if local is None or local_n <= 0.0:
        local = np.zeros(len(ROUTERS), dtype=float)
    if stats.global_n <= 0.0:
        return local.copy()
    return local + LOCAL_PSEUDO * stats.global_loss / stats.global_n


def meta_candidates(
    state: MetaState,
    targets: list,
    router_predictions: dict[str, np.ndarray],
) -> dict[str, np.ndarray]:
    result: dict[str, np.ndarray] = {}
    router_matrix = np.vstack([router_predictions[name] for name in ROUTERS])
    router_index = {name: index for index, name in enumerate(ROUTERS)}
    for set_name, names in ROUTER_SETS.items():
        selected = np.asarray([router_index[name] for name in names], dtype=int)
        strategies = [router_matrix[index] for index in selected]
        for scope in SCOPES:
            for memory in MEMORIES:
                stats = getattr(state, memory)
                prediction = np.empty(len(targets), dtype=float)
                if scope == "global":
                    loss = scoped_loss(stats, scope, "", "")[selected]
                    prediction[:] = PH3.square_aa_prediction(strategies, loss, ETA)
                else:
                    labels = [
                        target.source if scope == "source"
                        else PH2.question_type(target.source)
                        for target in targets
                    ]
                    for label in sorted(set(labels)):
                        indices = np.asarray([
                            index for index, value in enumerate(labels) if value == label
                        ], dtype=int)
                        source = label if scope == "source" else ""
                        question_type = label if scope == "type" else ""
                        loss = scoped_loss(
                            stats, scope, source, question_type
                        )[selected]
                        prediction[indices] = PH3.square_aa_prediction(
                            [strategy[indices] for strategy in strategies], loss, ETA
                        )
                anchor = router_predictions[HSQAA]
                for shrink in SHRINKS:
                    result[
                        f"meta-aa-{set_name}-{scope}-{memory}-"
                        f"e{token(ETA)}-s{token(shrink)}"
                    ] = anchor + shrink * (prediction - anchor)
    expected = set(METHODS) - set(CONTROLS)
    if set(result) != expected:
        raise RuntimeError(
            f"meta candidate mismatch: missing={expected-set(result)}, "
            f"extra={set(result)-expected}"
        )
    return result


def method_family(method: str) -> str:
    if method.startswith("meta-aa-"):
        pieces = method.split("-")
        # meta-aa-{set}-{scope}-{memory}-e2p0-s{shrink}
        return "-".join(pieces[:-1])
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
    context_state = P5.ContextState()
    meta_state = MetaState()
    records: list[dict] = []
    source_records: list[dict] = []

    for date in sorted(targets_by_date):
        current = targets_by_date[date]
        for state in pair_states.values():
            PH2.settle(state, date)
        PH4.settle_population(hierarchy_state, date)
        P5.settle_context(context_state, date)
        settle_meta(meta_state, date)
        context_models = P5.fitted_models(context_state)

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
                    name: next(
                        source[name] for source in prediction_sources if name in source
                    )
                    for name in P5.CONTROLS
                }
                features = P5.feature_matrix(
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
                contextual = P5.contextual_candidates(
                    pair_state,
                    context_models,
                    features,
                    common,
                    method_predictions["historical-best"],
                    strategies,
                )
                method_predictions[CONTEXT_OVERALL] = contextual[CONTEXT_OVERALL]
                method_predictions[CONTEXT_BALANCED] = contextual[CONTEXT_BALANCED]
                method_predictions.update(meta_candidates(
                    meta_state,
                    common,
                    {name: method_predictions[name] for name in ROUTERS},
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
                    context_state.pending.append(P5.ContextPending(
                        target.resolution_date,
                        target.outcome,
                        tuple(float(value) for value in features[index]),
                        tuple(float(value[index]) for value in strategies),
                    ))
                    meta_state.pending.append(MetaPending(
                        target.resolution_date,
                        target.outcome,
                        target.source,
                        PH2.question_type(target.source),
                        tuple(
                            float(method_predictions[name][index]) for name in ROUTERS
                        ),
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
                "meta_feedback": int(meta_state.settled),
                "loss_model_a": float(np.mean((first - outcomes) ** 2)),
                "loss_model_b": float(np.mean((second - outcomes) ** 2)),
            }
            for method in METHODS:
                row[f"loss_{method}"] = float(
                    np.mean((method_predictions[method] - outcomes) ** 2)
                )
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
                for method in METHODS:
                    source_row[f"loss_{method}"] = float(np.mean(
                        (method_predictions[method][mask] - outcomes[mask]) ** 2
                    ))
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
            "advantageVsHSQAA": BASE.bootstrap(
                confirmation, HSQAA, method,
                args.bootstrap_reps, args.seed + 100 + index,
            ),
            "historicallyStrongQ1Gain": BASE.bootstrap(
                prior_q1, "historical-best", method,
                args.bootstrap_reps, args.seed + 200 + index,
            ),
            "historicallyStrongQ1AdvantageVsSSAA": BASE.bootstrap(
                prior_q1, SSAA_MEAN, method,
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
        "schemaVersion": "1.0.0-online-meta-aa",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "status": "post_hoc_phase6_mechanism_check_future_confirmation_required",
        "protocol": {
            "developmentCutoff": args.development_cutoff,
            "confirmationCutoff": args.confirmation_cutoff,
            "selection": (
                "development selects Pareto meta families; internal validation "
                "selects exact objective-specific configurations"
            ),
            "outcomeVisibility": "resolution_date strictly earlier than forecast date",
            "routerOrder": list(ROUTERS),
            "routerSets": {name: list(values) for name, values in ROUTER_SETS.items()},
            "scopes": list(SCOPES),
            "memories": {
                "cumulative": "all strictly observable router losses",
                "recent90": "0.90 decay once per forecast date before settlement",
            },
            "eta": ETA,
            "localPseudoCount": LOCAL_PSEUDO,
            "anchor": HSQAA,
            "populationUnit": "pair-target, matching the evaluation estimand",
            "warning": (
                "family was proposed after phase-5 inspection; later-block "
                "results are exploratory rather than independent OOS"
            ),
        },
        "audit": {
            **archive_audit,
            "parameterSha256": sha256(args.parameters),
            "fixedPairs": len(pairs),
            "candidateMethods": len(METHODS),
            "metaCandidates": len(METHODS) - len(CONTROLS),
            "settledMetaFeedback": meta_state.settled,
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
                    HSQAA, SSAA_MEAN, SSAA_SOTA,
                    CONTEXT_OVERALL, CONTEXT_BALANCED,
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
            for sample in (
                "development", "internal-validation", "secondary-confirmation"
            )
        },
        "confirmationCIs": result["selectedConfirmationCIs"],
    }, indent=2))


if __name__ == "__main__":
    main()
