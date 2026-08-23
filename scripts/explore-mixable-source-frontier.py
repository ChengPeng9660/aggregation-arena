#!/usr/bin/env python3
"""Explore fixed-rate and source-conditioned safe aggregation frontiers.

This phase-2 sweep reuses the frozen resolution-aware data protocol. Candidate
selection is confined to dates on or before the cutoff; later dates are only
summarized after discovery champion IDs are fixed.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import sys
from collections import defaultdict
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


EXP = load_module("safe_frontier_phase1", "explore-safe-frontier-resolution-aware.py")
BASE = EXP.BASE
ETAS = (0.05, 0.1, 0.25, 0.5, 1.0)
SPECIALIST_ETAS = (0.1, 0.25, 0.5)
PSEUDO_COUNTS = (0.0, 50.0, 200.0)
RIDGE_LAMBDAS = (0.1, 1.0, 5.0, 20.0)
CONTROLS = ("historical-best", "two-model-hedge", "full-7", "no-dependence-4", "nodep-gap-g5p0")


def token(value: float) -> str:
    return str(value).replace(".", "p")


def method_names() -> list[str]:
    methods = list(CONTROLS)
    methods += [f"fixed-hedge-global5-e{token(eta)}" for eta in ETAS]
    methods += [f"fixed-hedge-global3-e{token(eta)}" for eta in ETAS]
    methods += [f"fixed-hedge-ab-e{token(eta)}" for eta in ETAS]
    methods += [
        f"fixed-hedge-source5-e{token(eta)}-p{token(pseudo)}"
        for eta in SPECIALIST_ETAS for pseudo in PSEUDO_COUNTS
    ]
    methods += [
        f"fixed-hedge-type5-e{token(eta)}-p{token(pseudo)}"
        for eta in SPECIALIST_ETAS for pseudo in PSEUDO_COUNTS
    ]
    methods += [
        f"ridge-source-l{token(ridge_lambda)}-s{token(shrink)}"
        for ridge_lambda in RIDGE_LAMBDAS for shrink in (0.5, 1.0)
    ]
    methods += [
        f"ridge-type-l{token(ridge_lambda)}-s{token(shrink)}"
        for ridge_lambda in RIDGE_LAMBDAS for shrink in (0.5, 1.0)
    ]
    return methods


METHODS = method_names()
PHASE1_METHODS = tuple(EXP.METHODS)


@dataclass
class SpecialistPending:
    resolution_date: str
    outcome: float
    source: str
    question_type: str
    first: float
    second: float
    strategies: tuple[float, ...]


@dataclass
class State:
    phase1: object = field(default_factory=EXP.State)
    pending: list[SpecialistPending] = field(default_factory=list)
    source_loss: dict[str, np.ndarray] = field(default_factory=dict)
    source_n: dict[str, int] = field(default_factory=dict)
    type_loss: dict[str, np.ndarray] = field(default_factory=dict)
    type_n: dict[str, int] = field(default_factory=dict)
    source_stats: dict[str, np.ndarray] = field(default_factory=dict)
    type_stats: dict[str, np.ndarray] = field(default_factory=dict)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--parameters", type=Path, default=Path("public/forecastbench/dash2-history.json"))
    parser.add_argument("--cutoff", default="2026-03-29")
    parser.add_argument("--output", type=Path, default=Path("output/research/mixable-source-frontier-2026-08-23.json"))
    parser.add_argument("--bootstrap-reps", type=int, default=20_000)
    parser.add_argument("--seed", type=int, default=20_260_825)
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def question_type(source: str) -> str:
    if source in BASE.DATASET_SOURCES:
        return "Dataset"
    if source in BASE.MARKET_SOURCES:
        return "Market"
    raise RuntimeError(f"Unknown source: {source}")


def ensure_loss(container: dict[str, np.ndarray], key: str) -> np.ndarray:
    if key not in container:
        container[key] = np.zeros(5, dtype=float)
    return container[key]


def ensure_stats(container: dict[str, np.ndarray], key: str) -> np.ndarray:
    if key not in container:
        container[key] = np.zeros(3, dtype=float)  # sum d^2, sum d(y-b), n
    return container[key]


def settle(state: State, date: str) -> None:
    EXP.settle(state.phase1, date)
    keep = []
    for pending in state.pending:
        if pending.resolution_date >= date:
            keep.append(pending)
            continue
        outcome = pending.outcome
        losses = (np.asarray(pending.strategies) - outcome) ** 2
        ensure_loss(state.source_loss, pending.source)[:] += losses
        state.source_n[pending.source] = state.source_n.get(pending.source, 0) + 1
        ensure_loss(state.type_loss, pending.question_type)[:] += losses
        state.type_n[pending.question_type] = state.type_n.get(pending.question_type, 0) + 1
        difference = pending.first - pending.second
        residual = outcome - pending.second
        source_stats = ensure_stats(state.source_stats, pending.source)
        source_stats += np.asarray([difference * difference, difference * residual, 1.0])
        type_stats = ensure_stats(state.type_stats, pending.question_type)
        type_stats += np.asarray([difference * difference, difference * residual, 1.0])
    state.pending = keep


def fixed_weights(loss: np.ndarray, eta: float) -> np.ndarray:
    scores = -eta * np.asarray(loss, dtype=float)
    scores -= float(np.max(scores))
    values = np.exp(scores)
    return values / float(np.sum(values))


def specialist_loss(
    local_loss: np.ndarray | None,
    local_n: int,
    global_loss: np.ndarray,
    global_n: int,
    pseudo_count: float,
) -> np.ndarray:
    local = np.zeros_like(global_loss) if local_loss is None else local_loss
    if pseudo_count <= 0.0 or global_n <= 0:
        return local
    return local + pseudo_count * global_loss / global_n


def global_ridge_weight(base_state, best_side: str) -> float:
    first = np.asarray(base_state.history_first)
    second = np.asarray(base_state.history_second)
    outcome = np.asarray(base_state.history_outcome)
    if len(outcome) == 0:
        return 1.0 if best_side == "a" else 0.0
    difference = first - second
    denominator = float(np.dot(difference, difference))
    if denominator <= 1e-15:
        return 1.0 if best_side == "a" else 0.0
    return float(np.clip(np.dot(difference, outcome - second) / denominator, 0.0, 1.0))


def local_ridge_weight(stats: np.ndarray | None, prior: float, ridge_lambda: float) -> float:
    if stats is None:
        return prior
    denominator = float(stats[0]) + ridge_lambda
    if denominator <= 1e-15:
        return prior
    return float(np.clip((float(stats[1]) + ridge_lambda * prior) / denominator, 0.0, 1.0))


def weighted_prediction(strategies: list[np.ndarray], weights: np.ndarray) -> np.ndarray:
    return sum(float(weights[index]) * prediction for index, prediction in enumerate(strategies))


def candidate_predictions(
    state: State,
    targets: list,
    first: np.ndarray,
    second: np.ndarray,
    metric: dict,
    alpha: float,
    pog_percentile: float,
) -> tuple[dict[str, np.ndarray], dict[str, list[np.ndarray]], list[np.ndarray]]:
    phase1_predictions, vectors, strategies = EXP.predictions(
        state.phase1, first, second, metric, alpha, pog_percentile
    )
    result = {method: phase1_predictions[method] for method in CONTROLS}
    global_loss = state.phase1.frontier_loss
    global_n = state.phase1.frontier_n
    for eta in ETAS:
        result[f"fixed-hedge-global5-e{token(eta)}"] = weighted_prediction(
            strategies, fixed_weights(global_loss, eta)
        )
        result[f"fixed-hedge-global3-e{token(eta)}"] = weighted_prediction(
            strategies[:3], fixed_weights(global_loss[:3], eta)
        )
        result[f"fixed-hedge-ab-e{token(eta)}"] = (
            fixed_weights(state.phase1.base.full_loss[:2], eta)[0] * first
            + fixed_weights(state.phase1.base.full_loss[:2], eta)[1] * second
        )

    for eta in SPECIALIST_ETAS:
        for pseudo in PSEUDO_COUNTS:
            source_values = np.empty(len(targets), dtype=float)
            type_values = np.empty(len(targets), dtype=float)
            for index, target in enumerate(targets):
                source = target.source
                type_name = question_type(source)
                source_adjusted = specialist_loss(
                    state.source_loss.get(source), state.source_n.get(source, 0),
                    global_loss, global_n, pseudo,
                )
                type_adjusted = specialist_loss(
                    state.type_loss.get(type_name), state.type_n.get(type_name, 0),
                    global_loss, global_n, pseudo,
                )
                source_values[index] = sum(
                    float(weight) * float(strategy[index])
                    for weight, strategy in zip(fixed_weights(source_adjusted, eta), strategies)
                )
                type_values[index] = sum(
                    float(weight) * float(strategy[index])
                    for weight, strategy in zip(fixed_weights(type_adjusted, eta), strategies)
                )
            result[f"fixed-hedge-source5-e{token(eta)}-p{token(pseudo)}"] = source_values
            result[f"fixed-hedge-type5-e{token(eta)}-p{token(pseudo)}"] = type_values

    historical = phase1_predictions["historical-best"]
    global_weight = global_ridge_weight(state.phase1.base, str(metric["best_side"]))
    for ridge_lambda in RIDGE_LAMBDAS:
        source_ridge = np.empty(len(targets), dtype=float)
        type_ridge = np.empty(len(targets), dtype=float)
        for index, target in enumerate(targets):
            source = target.source
            type_name = question_type(source)
            source_weight = local_ridge_weight(state.source_stats.get(source), global_weight, ridge_lambda)
            type_weight = local_ridge_weight(state.type_stats.get(type_name), global_weight, ridge_lambda)
            source_ridge[index] = source_weight * first[index] + (1.0 - source_weight) * second[index]
            type_ridge[index] = type_weight * first[index] + (1.0 - type_weight) * second[index]
        for shrink in (0.5, 1.0):
            result[f"ridge-source-l{token(ridge_lambda)}-s{token(shrink)}"] = historical + shrink * (source_ridge - historical)
            result[f"ridge-type-l{token(ridge_lambda)}-s{token(shrink)}"] = historical + shrink * (type_ridge - historical)
    if set(result) != set(METHODS):
        raise RuntimeError(f"Candidate mismatch: missing={set(METHODS)-set(result)}, extra={set(result)-set(METHODS)}")
    return result, vectors, strategies


def pair_win_comparison(frame: pd.DataFrame, first_method: str, second_method: str) -> dict:
    counts = {"both": 0, "firstOnly": 0, "secondOnly": 0, "neither": 0}
    for _, group in frame.groupby("pair", observed=True):
        risk_a = float(np.average(group.loss_model_a, weights=group.n))
        risk_b = float(np.average(group.loss_model_b, weights=group.n))
        baseline = min(risk_a, risk_b)
        first_risk = float(np.average(group[f"loss_{first_method}"], weights=group.n))
        second_risk = float(np.average(group[f"loss_{second_method}"], weights=group.n))
        first_win = first_risk < baseline - 1e-15
        second_win = second_risk < baseline - 1e-15
        if first_win and second_win:
            counts["both"] += 1
        elif first_win:
            counts["firstOnly"] += 1
        elif second_win:
            counts["secondOnly"] += 1
        else:
            counts["neither"] += 1
    return {"first": first_method, "second": second_method, "pairs": int(frame.pair.nunique()), **counts}


def slice_summary(frame: pd.DataFrame, column: str, methods: list[str]) -> dict:
    result = {}
    for label, group in frame.groupby(column, observed=True):
        method_rows = {}
        for method in methods:
            method_rows[method] = {
                "brier": float(np.average(group[f"loss_{method}"], weights=group.n)),
                "gainVsHistoricalBest": float(np.average(group["loss_historical-best"] - group[f"loss_{method}"], weights=group.n)),
                "advantageVsNoDependence4": float(np.average(group["loss_no-dependence-4"] - group[f"loss_{method}"], weights=group.n)),
            }
        result[str(label)] = {
            "cells": int(len(group)), "targetEvaluations": int(group.n.sum()),
            "pairs": int(group.pair.nunique()), "dates": int(group.date.nunique()),
            "methods": method_rows,
        }
    return result


def run(args: argparse.Namespace) -> dict:
    pairs = BASE.read_fixed_pairs(args.parameters)
    fixed_models = {model for pair in pairs for model in pair}
    targets_by_date, archive_audit = BASE.load_official_targets(args.archive, fixed_models)
    states = {pair: State() for pair in pairs}
    records = []
    source_records = []

    for date in sorted(targets_by_date):
        current = targets_by_date[date]
        for state in states.values():
            settle(state, date)
        pair_rounds = {}
        metrics = {}
        for pair in pairs:
            common = [target for target in current if pair[0] in target.forecasts and pair[1] in target.forecasts]
            if common:
                pair_rounds[pair] = common
            metric = BASE.pair_metrics(states[pair].phase1.base)
            if metric is not None and len(common) >= 30:
                metrics[pair] = metric
        pog_pct = BASE.percentile({pair: float(metric["pog"]) for pair, metric in metrics.items()}) if metrics else {}
        finite_lift = {pair: float(metric["lift"]) for pair, metric in metrics.items() if math.isfinite(float(metric["lift"]))}
        finite_corr = {pair: float(metric["corr"]) for pair, metric in metrics.items() if math.isfinite(float(metric["corr"]))}
        lift_pct = BASE.percentile(finite_lift, ascending=False) if finite_lift else {}
        corr_pct = BASE.percentile(finite_corr, ascending=False) if finite_corr else {}

        for pair, common in pair_rounds.items():
            state = states[pair]
            metric = metrics.get(pair)
            alpha = 0.0
            if metric is not None:
                complementarity = float(np.mean((pog_pct[pair], lift_pct.get(pair, 0.5), corr_pct.get(pair, 0.5))))
                alpha = float(np.clip(
                    complementarity * math.exp(-float(metric["bi_gap"]) / 2.0) * min(1.0, int(metric["n"]) / 500.0),
                    0.0, 1.0,
                ))
            first = np.asarray([target.forecasts[pair[0]] for target in common])
            second = np.asarray([target.forecasts[pair[1]] for target in common])
            outcomes = np.asarray([target.outcome for target in common])
            if metric is not None:
                method_predictions, vectors, strategies = candidate_predictions(
                    state, common, first, second, metric, alpha, pog_pct[pair]
                )
            else:
                base_predictions, vectors = BASE.vector_and_predictions(state.phase1.base, first, second, None, 0.0)
                historical = base_predictions["historical-best"]
                strategies = [historical, base_predictions["no-dependence-4"], historical, base_predictions["full-7"], base_predictions["two-model-hedge"]]
                method_predictions = {"historical-best": historical, "no-dependence-4": base_predictions["no-dependence-4"]}
            for index, target in enumerate(common):
                state.phase1.pending.append(EXP.Pending(
                    target.resolution_date, target.outcome, float(first[index]), float(second[index]), date,
                    {variant: tuple(float(values[index]) for values in vector) for variant, vector in vectors.items()},
                    float(method_predictions["historical-best"][index]), float(method_predictions["no-dependence-4"][index]),
                    tuple(float(value[index]) for value in strategies),
                ))
                state.pending.append(SpecialistPending(
                    target.resolution_date, target.outcome, target.source, question_type(target.source),
                    float(first[index]), float(second[index]), tuple(float(value[index]) for value in strategies),
                ))
            if metric is None:
                continue
            row = {
                "date": date, "sample": "discovery" if date <= args.cutoff else "confirmation",
                "pair": f"{pair[0]} | {pair[1]}", "n": len(common),
                "prior_quality": float(metric["prior_quality"]),
                "loss_model_a": float(np.mean((first - outcomes) ** 2)),
                "loss_model_b": float(np.mean((second - outcomes) ** 2)),
            }
            for method, prediction in method_predictions.items():
                row[f"loss_{method}"] = float(np.mean((prediction - outcomes) ** 2))
            records.append(row)
            sources = np.asarray([target.source for target in common], dtype=object)
            for source in sorted(set(sources.tolist())):
                mask = sources == source
                source_row = {
                    "date": date, "sample": row["sample"], "pair": row["pair"],
                    "source": source, "question_type": question_type(source), "n": int(np.sum(mask)),
                    "loss_model_a": float(np.mean((first[mask] - outcomes[mask]) ** 2)),
                    "loss_model_b": float(np.mean((second[mask] - outcomes[mask]) ** 2)),
                }
                for method, prediction in method_predictions.items():
                    source_row[f"loss_{method}"] = float(np.mean((prediction[mask] - outcomes[mask]) ** 2))
                source_records.append(source_row)

    frame = pd.DataFrame(records)
    discovery = frame[frame["sample"] == "discovery"].copy()
    confirmation = frame[frame["sample"] == "confirmation"].copy()
    source_frame = pd.DataFrame(source_records)
    confirmation_sources = source_frame[source_frame["sample"] == "confirmation"].copy()
    # Phase-1 predictions validate against their own frozen registry. Switch
    # the shared summary helpers only after all predictions have been formed.
    EXP.METHODS = METHODS
    discovery_summary = EXP.sample_summary(discovery)
    champions = EXP.select_discovery_champions(discovery_summary)
    confirmation_summary = EXP.sample_summary(confirmation)
    selected = sorted(
        set(champions[key] for key in ("overall", "strongQ1", "pairSota", "balanced"))
        | {"no-dependence-4", "nodep-gap-g5p0", "full-7"}
    )
    prior_q1 = EXP.add_prior_quartile(confirmation)
    prior_q1 = prior_q1[prior_q1.prior_quartile == "Q1 strongest"]
    ex_post_q1 = EXP.add_ex_post_quality(confirmation)
    ex_post_q1 = ex_post_q1[ex_post_q1.ex_post_quartile == "Q1 strongest"]
    confirmation_cis = {
        method: {
            "gainVsHistoricalBest": BASE.bootstrap(confirmation, "historical-best", method, args.bootstrap_reps, args.seed + index),
            "advantageVsNoDependence4": BASE.bootstrap(confirmation, "no-dependence-4", method, args.bootstrap_reps, args.seed + 100 + index),
            "advantageVsGapSafeG5": BASE.bootstrap(confirmation, "nodep-gap-g5p0", method, args.bootstrap_reps, args.seed + 150 + index),
            "advantageVsFull7": BASE.bootstrap(confirmation, "full-7", method, args.bootstrap_reps, args.seed + 175 + index),
            "historicallyStrongQ1Gain": BASE.bootstrap(prior_q1, "historical-best", method, args.bootstrap_reps, args.seed + 200 + index),
            "realizedStrongestQ1Gain": BASE.bootstrap(ex_post_q1, "ex-post-best", method, args.bootstrap_reps, args.seed + 300 + index),
        }
        for index, method in enumerate(selected)
    }
    result = {
        "schemaVersion": "1.0.0-mixable-source-frontier",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "status": "post_hoc_phase2_candidate_search_future_confirmation_required",
        "protocol": {
            "cutoff": args.cutoff,
            "selection": "discovery dates only",
            "outcomeVisibility": "resolution_date strictly earlier than forecast date",
            "frontierExperts": ["historical-best", "no-dependence-4", "GapSafe-G5", "full-7", "two-model-hedge"],
            "specialists": ["global", "Dataset/Market", "official source"],
            "warning": "phase-2 families were proposed after inspecting earlier confirmation results",
        },
        "audit": {
            **archive_audit, "parameterSha256": sha256(args.parameters), "fixedPairs": len(pairs),
            "candidateMethods": len(METHODS), "allFeedbackStrictlyPreResolution": True,
        },
        "discoveryChampions": champions,
        "discovery": discovery_summary,
        "confirmation": confirmation_summary,
        "selectedConfirmationCIs": confirmation_cis,
        "confirmationPairWinComparisons": {
            method: {
                control: pair_win_comparison(confirmation, method, control)
                for control in ("no-dependence-4", "nodep-gap-g5p0", "full-7")
                if method != control
            }
            for method in selected
        },
        "confirmationSourceSlices": slice_summary(confirmation_sources, "source", selected),
        "confirmationQuestionTypeSlices": slice_summary(confirmation_sources, "question_type", selected),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    return result


def main() -> None:
    args = parse_args()
    result = run(args)
    selected = sorted(
        set(result["discoveryChampions"][key] for key in ("overall", "strongQ1", "pairSota", "balanced"))
        | {"no-dependence-4", "nodep-gap-g5p0", "full-7"}
    )
    print(json.dumps({
        "output": str(args.output.resolve()), "audit": result["audit"],
        "discoveryChampions": result["discoveryChampions"],
        "selectedDiscovery": {method: {
            "overall": result["discovery"]["overall"][method],
            "q1": result["discovery"]["q1Strongest"][method],
            "pairSota": result["discovery"]["pairSota"][method],
        } for method in selected},
        "selectedConfirmation": {method: {
            "overall": result["confirmation"]["overall"][method],
            "q1": result["confirmation"]["q1Strongest"][method],
            "pairSota": result["confirmation"]["pairSota"][method],
            "ci": result["selectedConfirmationCIs"][method],
        } for method in selected},
    }, indent=2))


if __name__ == "__main__":
    main()
