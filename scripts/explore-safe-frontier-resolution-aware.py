#!/usr/bin/env python3
"""Leakage-safe Pareto search for two-model aggregation challengers.

Candidate selection uses only forecast dates on or before the frozen cutoff.
Later dates are summarized only after the discovery champions are selected.
The official ForecastBench resolution date controls when every outcome becomes
available to pair metrics and online weights.
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


def load_confirmation_module():
    path = Path(__file__).with_name("confirm-dash-subsets-resolution-oos.py")
    spec = importlib.util.spec_from_file_location("dash_resolution_confirmation", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot import {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


BASE = load_confirmation_module()
BASE_METHODS = ("historical-best", "two-model-hedge", "full-7", "no-dependence-4")
SHRINKS = (0.1, 0.25, 0.5, 0.75)
ALPHA_SCALES = (0.5, 1.0, 2.0)
GAP_SCALES = (0.5, 1.0, 2.0, 5.0, 10.0, 20.0)
GAP_FLOORS = (0.25, 0.5, 0.75)
RIDGE_LAMBDAS = (0.1, 1.0, 5.0, 20.0, 100.0)
RIDGE_SHRINKS = (0.5, 0.75, 1.0)
GATE_Z = (0.0, 0.5, 1.0, 1.64)
DISAGREEMENT_THRESHOLDS = (0.05, 0.1, 0.2, 0.3)


def token(value: float) -> str:
    return str(value).replace(".", "p")


def candidate_names() -> list[str]:
    names = list(BASE_METHODS)
    names += [f"nodep-shrink-s{token(value)}" for value in SHRINKS]
    names += [f"nodep-alpha-a{token(value)}" for value in ALPHA_SCALES]
    names += [f"nodep-gap-g{token(value)}" for value in GAP_SCALES]
    names += [
        f"nodep-gap-floor-f{token(floor)}-g{token(scale)}"
        for floor in GAP_FLOORS for scale in (2.0, 5.0)
    ]
    names += [f"nodep-confidence-z{token(value)}" for value in GATE_Z]
    names += ["nodep-safe-hedge"]
    names += [f"ridge-l{token(value)}-s{token(shrink)}" for value in RIDGE_LAMBDAS for shrink in RIDGE_SHRINKS]
    names += [f"nodep-disagreement-t{token(value)}" for value in DISAGREEMENT_THRESHOLDS]
    names += [
        "nodep-pog-top-half", "nodep-pog-top-quartile",
        "full7-shrink-s0p5", "full7-shrink-s0p75",
        "frontier-ftl-5", "frontier-hedge-5", "frontier-hedge-3",
    ]
    return names


METHODS = candidate_names()


@dataclass
class Pending:
    resolution_date: str
    outcome: float
    first: float
    second: float
    forecast_date: str
    vectors: dict[str, tuple[float, ...]]
    historical_best: float
    no_dependence: float
    frontier_strategies: tuple[float, ...]


@dataclass
class State:
    base: object = field(default_factory=BASE.PairState)
    pending: list[Pending] = field(default_factory=list)
    historical_loss: float = 0.0
    nodep_loss: float = 0.0
    comparison_n: int = 0
    gain_sum: float = 0.0
    gain_square_sum: float = 0.0
    frontier_loss: np.ndarray = field(default_factory=lambda: np.zeros(5, dtype=float))
    frontier_n: int = 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--parameters", type=Path, default=Path("public/forecastbench/dash2-history.json"))
    parser.add_argument("--cutoff", default="2026-03-29")
    parser.add_argument("--output", type=Path, default=Path("output/research/safe-frontier-resolution-aware-discovery-2026-08-23.json"))
    parser.add_argument("--bootstrap-reps", type=int, default=20_000)
    parser.add_argument("--seed", type=int, default=20_260_824)
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def settle(state: State, date: str) -> None:
    keep = []
    for pending in state.pending:
        if pending.resolution_date >= date:
            keep.append(pending)
            continue
        outcome = pending.outcome
        full = np.asarray(pending.vectors["full-7"])
        state.base.full_loss += (full - outcome) ** 2
        state.base.full_n += 1
        for variant in BASE.EXPERTS:
            if variant == "full-7":
                continue
            vector = np.asarray(pending.vectors[variant])
            state.base.meta_loss[variant] += (vector - outcome) ** 2
            state.base.meta_n[variant] += 1
        state.base.history_first.append(pending.first)
        state.base.history_second.append(pending.second)
        state.base.history_outcome.append(outcome)
        state.base.history_dates.append(pending.forecast_date)
        historical_loss = (pending.historical_best - outcome) ** 2
        nodep_loss = (pending.no_dependence - outcome) ** 2
        gain = historical_loss - nodep_loss
        state.historical_loss += historical_loss
        state.nodep_loss += nodep_loss
        state.comparison_n += 1
        state.gain_sum += gain
        state.gain_square_sum += gain * gain
        state.frontier_loss += (np.asarray(pending.frontier_strategies) - outcome) ** 2
        state.frontier_n += 1
    state.pending = keep


def confidence_gate_weight(state: State, z: float) -> float:
    if state.comparison_n < 200:
        return 0.0
    mean = state.gain_sum / state.comparison_n
    variance = max(0.0, state.gain_square_sum / state.comparison_n - mean * mean)
    standard_error = math.sqrt(variance / state.comparison_n)
    return 1.0 if mean - z * standard_error > 0.0 else 0.0


def safe_hedge_weight(state: State) -> float:
    losses = np.asarray([state.historical_loss, state.nodep_loss])
    return float(BASE.weights(losses, state.comparison_n)[1])


def ridge_weight(state: State, best_side: str, ridge_lambda: float) -> float:
    first = np.asarray(state.base.history_first)
    second = np.asarray(state.base.history_second)
    outcome = np.asarray(state.base.history_outcome)
    difference = first - second
    prior = 1.0 if best_side == "a" else 0.0
    denominator = float(np.dot(difference, difference)) + ridge_lambda
    if denominator <= 1e-15:
        return prior
    numerator = float(np.dot(difference, outcome - second)) + ridge_lambda * prior
    return float(np.clip(numerator / denominator, 0.0, 1.0))


def predictions(
    state: State,
    first: np.ndarray,
    second: np.ndarray,
    metric: dict,
    alpha: float,
    pog_percentile: float,
) -> tuple[dict[str, np.ndarray], dict[str, list[np.ndarray]], list[np.ndarray]]:
    base_predictions, vectors = BASE.vector_and_predictions(state.base, first, second, metric, alpha)
    historical = base_predictions["historical-best"]
    nodep = base_predictions["no-dependence-4"]
    full7 = base_predictions["full-7"]
    result = {name: base_predictions[name] for name in BASE_METHODS}
    for shrink in SHRINKS:
        result[f"nodep-shrink-s{token(shrink)}"] = historical + shrink * (nodep - historical)
    for scale in ALPHA_SCALES:
        mix = min(1.0, scale * alpha)
        result[f"nodep-alpha-a{token(scale)}"] = historical + mix * (nodep - historical)
    for scale in GAP_SCALES:
        mix = math.exp(-float(metric["bi_gap"]) / scale)
        result[f"nodep-gap-g{token(scale)}"] = historical + mix * (nodep - historical)
    for floor in GAP_FLOORS:
        for scale in (2.0, 5.0):
            mix = floor + (1.0 - floor) * math.exp(-float(metric["bi_gap"]) / scale)
            result[f"nodep-gap-floor-f{token(floor)}-g{token(scale)}"] = historical + mix * (nodep - historical)
    for z in GATE_Z:
        mix = confidence_gate_weight(state, z)
        result[f"nodep-confidence-z{token(z)}"] = historical + mix * (nodep - historical)
    result["nodep-safe-hedge"] = historical + safe_hedge_weight(state) * (nodep - historical)
    for ridge_lambda in RIDGE_LAMBDAS:
        weight_a = ridge_weight(state, str(metric["best_side"]), ridge_lambda)
        ridge = weight_a * first + (1.0 - weight_a) * second
        for shrink in RIDGE_SHRINKS:
            result[f"ridge-l{token(ridge_lambda)}-s{token(shrink)}"] = historical + shrink * (ridge - historical)
    disagreement = np.abs(first - second)
    for threshold in DISAGREEMENT_THRESHOLDS:
        result[f"nodep-disagreement-t{token(threshold)}"] = np.where(disagreement >= threshold, nodep, historical)
    result["nodep-pog-top-half"] = nodep if pog_percentile >= 0.5 else historical
    result["nodep-pog-top-quartile"] = nodep if pog_percentile >= 0.75 else historical
    result["full7-shrink-s0p5"] = historical + 0.5 * (full7 - historical)
    result["full7-shrink-s0p75"] = historical + 0.75 * (full7 - historical)
    gap5 = result["nodep-gap-g5p0"]
    frontier = [historical, nodep, gap5, full7, base_predictions["two-model-hedge"]]
    ftl_index = int(np.argmin(state.frontier_loss))
    result["frontier-ftl-5"] = frontier[ftl_index]
    hedge5 = BASE.weights(state.frontier_loss, state.frontier_n)
    result["frontier-hedge-5"] = sum(hedge5[index] * value for index, value in enumerate(frontier))
    hedge3 = BASE.weights(state.frontier_loss[:3], state.frontier_n)
    result["frontier-hedge-3"] = sum(hedge3[index] * value for index, value in enumerate(frontier[:3]))
    if set(result) != set(METHODS):
        raise RuntimeError(f"Candidate mismatch: missing={set(METHODS)-set(result)}, extra={set(result)-set(METHODS)}")
    return result, vectors, frontier


def summarize(frame: pd.DataFrame) -> dict[str, dict]:
    result = {}
    for method in METHODS:
        result[method] = {
            "brier": float(np.average(frame[f"loss_{method}"], weights=frame.n)),
            "gainVsHistoricalBest": float(np.average(frame["loss_historical-best"] - frame[f"loss_{method}"], weights=frame.n)),
        }
    return result


def add_prior_quartile(frame: pd.DataFrame) -> pd.DataFrame:
    ordered = frame.sort_values(["prior_quality", "date", "pair"]).reset_index(drop=True).copy()
    ordered["prior_quartile"] = pd.qcut(
        ordered.prior_quality.rank(method="first"), 4,
        labels=["Q1 strongest", "Q2", "Q3", "Q4 weakest"],
    )
    return ordered


def pair_sota(frame: pd.DataFrame, method: str) -> dict:
    gains = []
    for _, group in frame.groupby("pair", observed=True):
        risk_a = float(np.average(group.loss_model_a, weights=group.n))
        risk_b = float(np.average(group.loss_model_b, weights=group.n))
        risk_method = float(np.average(group[f"loss_{method}"], weights=group.n))
        gains.append(min(risk_a, risk_b) - risk_method)
    return {
        "pairs": len(gains),
        "strictWins": sum(gain > 1e-15 for gain in gains),
        "strictWinRate": float(np.mean(np.asarray(gains) > 1e-15)),
        "macroMeanGainVsExPostBest": float(np.mean(gains)),
    }


def add_ex_post_quality(frame: pd.DataFrame) -> pd.DataFrame:
    pair_rows = []
    best_side = {}
    for pair, group in frame.groupby("pair", observed=True):
        risk_a = float(np.average(group.loss_model_a, weights=group.n))
        risk_b = float(np.average(group.loss_model_b, weights=group.n))
        side = "a" if risk_a <= risk_b else "b"
        best_side[str(pair)] = side
        pair_rows.append({"pair": str(pair), "best_risk": min(risk_a, risk_b)})
    pairs = pd.DataFrame(pair_rows).sort_values(["best_risk", "pair"]).reset_index(drop=True)
    pairs["quartile"] = pd.qcut(
        pairs.best_risk.rank(method="first"), 4,
        labels=["Q1 strongest", "Q2", "Q3", "Q4 weakest"],
    )
    labels = dict(zip(pairs.pair, pairs.quartile.astype(str), strict=True))
    augmented = frame.copy()
    augmented["ex_post_quartile"] = augmented.pair.map(labels)
    augmented["loss_ex-post-best"] = np.where(
        augmented.pair.map(best_side) == "a", augmented.loss_model_a, augmented.loss_model_b
    )
    return augmented


def summarize_ex_post(frame: pd.DataFrame) -> dict:
    result = {}
    for label, group in frame.groupby("ex_post_quartile", observed=True):
        methods = {}
        for method in METHODS:
            methods[method] = {
                "brier": float(np.average(group[f"loss_{method}"], weights=group.n)),
                "gainVsExPostBest": float(np.average(group["loss_ex-post-best"] - group[f"loss_{method}"], weights=group.n)),
            }
        result[str(label)] = {
            "audit": {"cells": int(len(group)), "targets": int(group.n.sum()), "pairs": int(group.pair.nunique()), "dates": int(group.date.nunique())},
            "exPostBestBrier": float(np.average(group["loss_ex-post-best"], weights=group.n)),
            "methods": methods,
        }
    return result


def sample_summary(frame: pd.DataFrame) -> dict:
    quartiled = add_prior_quartile(frame)
    ex_post = add_ex_post_quality(frame)
    q1 = quartiled[quartiled.prior_quartile == "Q1 strongest"]
    q4 = quartiled[quartiled.prior_quartile == "Q4 weakest"]
    overall = summarize(frame)
    q1_summary = summarize(q1)
    q4_summary = summarize(q4)
    return {
        "audit": {
            "cells": int(len(frame)), "targetEvaluations": int(frame.n.sum()),
            "pairs": int(frame.pair.nunique()), "dates": int(frame.date.nunique()),
            "dateMin": str(frame.date.min()), "dateMax": str(frame.date.max()),
        },
        "overall": overall,
        "q1Strongest": q1_summary,
        "q4Weakest": q4_summary,
        "exPostQualityQuartiles": summarize_ex_post(ex_post),
        "pairSota": {method: pair_sota(frame, method) for method in METHODS},
    }


def pareto_front(summary: dict) -> list[str]:
    methods = [method for method in METHODS if method != "historical-best"]
    front = []
    for method in methods:
        values = (
            summary["overall"][method]["brier"],
            -summary["q1Strongest"][method]["gainVsHistoricalBest"],
            -summary["pairSota"][method]["strictWinRate"],
        )
        dominated = False
        for other in methods:
            if other == method:
                continue
            candidate = (
                summary["overall"][other]["brier"],
                -summary["q1Strongest"][other]["gainVsHistoricalBest"],
                -summary["pairSota"][other]["strictWinRate"],
            )
            if all(first <= second + 1e-15 for first, second in zip(candidate, values)) and any(
                first < second - 1e-15 for first, second in zip(candidate, values)
            ):
                dominated = True
                break
        if not dominated:
            front.append(method)
    return sorted(front)


def select_discovery_champions(summary: dict) -> dict:
    choices = [method for method in METHODS if method != "historical-best"]
    overall = min(choices, key=lambda method: (summary["overall"][method]["brier"], method))
    strong = max(choices, key=lambda method: (summary["q1Strongest"][method]["gainVsHistoricalBest"], method))
    sota = max(choices, key=lambda method: (
        summary["pairSota"][method]["strictWinRate"],
        summary["pairSota"][method]["macroMeanGainVsExPostBest"],
        -summary["overall"][method]["brier"],
    ))
    ranks = {}
    for metric, values, ascending in (
        ("overall", {method: summary["overall"][method]["brier"] for method in choices}, True),
        ("strong", {method: summary["q1Strongest"][method]["gainVsHistoricalBest"] for method in choices}, False),
        ("sota", {method: summary["pairSota"][method]["strictWinRate"] for method in choices}, False),
    ):
        ranks[metric] = pd.Series(values).rank(method="average", ascending=ascending).to_dict()
    balanced = min(choices, key=lambda method: (ranks["overall"][method] + ranks["strong"][method] + ranks["sota"][method], method))
    return {"overall": overall, "strongQ1": strong, "pairSota": sota, "balanced": balanced, "paretoFront": pareto_front(summary)}


def run(args: argparse.Namespace) -> dict:
    pairs = BASE.read_fixed_pairs(args.parameters)
    fixed_models = {model for pair in pairs for model in pair}
    targets_by_date, archive_audit = BASE.load_official_targets(args.archive, fixed_models)
    states = {pair: State() for pair in pairs}
    records = []

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
            metric = BASE.pair_metrics(states[pair].base)
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
                method_predictions, vectors, frontier = predictions(state, first, second, metric, alpha, pog_pct[pair])
            else:
                base_predictions, vectors = BASE.vector_and_predictions(state.base, first, second, None, 0.0)
                method_predictions = {"historical-best": base_predictions["historical-best"], "no-dependence-4": base_predictions["no-dependence-4"]}
                frontier = [
                    base_predictions["historical-best"], base_predictions["no-dependence-4"],
                    base_predictions["historical-best"], base_predictions["full-7"],
                    base_predictions["two-model-hedge"],
                ]
            for index, target in enumerate(common):
                state.pending.append(Pending(
                    target.resolution_date, target.outcome, float(first[index]), float(second[index]), date,
                    {variant: tuple(float(values[index]) for values in vector) for variant, vector in vectors.items()},
                    float(method_predictions["historical-best"][index]), float(method_predictions["no-dependence-4"][index]),
                    tuple(float(value[index]) for value in frontier),
                ))
            if metric is None:
                continue
            row = {
                "date": date, "sample": "discovery" if date <= args.cutoff else "confirmation",
                "pair": f"{pair[0]} | {pair[1]}", "n": len(common),
                "prior_quality": float(metric["prior_quality"]), "bi_gap": float(metric["bi_gap"]),
                "safe_alpha": alpha, "history_targets": int(metric["n"]),
                "loss_model_a": float(np.mean((first - outcomes) ** 2)),
                "loss_model_b": float(np.mean((second - outcomes) ** 2)),
            }
            for method, prediction in method_predictions.items():
                row[f"loss_{method}"] = float(np.mean((prediction - outcomes) ** 2))
            records.append(row)

    frame = pd.DataFrame(records)
    discovery = frame[frame["sample"] == "discovery"].copy()
    confirmation = frame[frame["sample"] == "confirmation"].copy()
    discovery_summary = sample_summary(discovery)
    champions = select_discovery_champions(discovery_summary)
    confirmation_summary = sample_summary(confirmation)
    selected = sorted(
        set(champions[key] for key in ("overall", "strongQ1", "pairSota", "balanced"))
        | {"no-dependence-4", "nodep-gap-g5p0"}
    )
    confirmation_prior = add_prior_quartile(confirmation)
    confirmation_q1 = confirmation_prior[confirmation_prior.prior_quartile == "Q1 strongest"]
    confirmation_ex_post = add_ex_post_quality(confirmation)
    confirmation_ex_post_q1 = confirmation_ex_post[confirmation_ex_post.ex_post_quartile == "Q1 strongest"]
    confirmation_cis = {
        method: {
            "gainVsHistoricalBest": BASE.bootstrap(confirmation, "historical-best", method, args.bootstrap_reps, args.seed + index),
            "advantageVsNoDependence4": BASE.bootstrap(confirmation, "no-dependence-4", method, args.bootstrap_reps, args.seed + 100 + index),
            "historicallyStrongQ1Gain": BASE.bootstrap(confirmation_q1, "historical-best", method, args.bootstrap_reps, args.seed + 200 + index),
            "realizedStrongestQ1Gain": BASE.bootstrap(confirmation_ex_post_q1, "ex-post-best", method, args.bootstrap_reps, args.seed + 300 + index),
        }
        for index, method in enumerate(selected)
    }
    result = {
        "schemaVersion": "1.0.0-safe-frontier-discovery",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "status": "post_hoc_candidate_search_secondary_confirmation_required",
        "protocol": {
            "cutoff": args.cutoff,
            "selection": "champions and Pareto front computed from discovery rows only",
            "confirmationIsolation": "confirmation metrics are computed only after discovery champion IDs are frozen in memory",
            "outcomeVisibility": "resolution_date strictly earlier than forecast date",
            "candidateFamilies": ["fixed shrinkage", "dependence-alpha shrinkage", "quality-gap shrinkage", "confidence gate", "safe Hedge", "pair ridge-convex pool", "current-disagreement specialist", "prior-POG specialist"],
            "warning": "families were proposed after prior confirmation analysis; post-cutoff results are secondary, not a new independent confirmation",
        },
        "audit": {
            **archive_audit, "parameterSha256": sha256(args.parameters), "fixedPairs": len(pairs),
            "candidateMethods": len(METHODS), "allFeedbackStrictlyPreResolution": True,
        },
        "discoveryChampions": champions,
        "discovery": discovery_summary,
        "confirmation": confirmation_summary,
        "selectedConfirmationCIs": confirmation_cis,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    return result


def main() -> None:
    args = parse_args()
    result = run(args)
    selected = sorted(
        set(result["discoveryChampions"][key] for key in ("overall", "strongQ1", "pairSota", "balanced"))
        | {"no-dependence-4", "nodep-gap-g5p0"}
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
