#!/usr/bin/env python3
"""Resolution-aware post-cutoff confirmation of frozen DASH expert subsets.

The script consumes ForecastBench's official processed forecast-set archive,
keeps the exact model-pair cohort frozen in ``dash2-history.json``, and delays
all learning until a target's resolution date is strictly earlier than the
next forecast date.  It never uses a current target outcome to form a current
prediction or weight.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import tarfile
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd


EXPERTS = {
    "full-7": ("model-a", "model-b", "equal-mean", "log-odds", "cptec", "piecewise-odds", "safemix-2"),
    "core-5": ("model-a", "model-b", "two-model-hedge", "safemix-2", "cptec"),
    "core-4": ("model-a", "model-b", "two-model-hedge", "safemix-2"),
    "no-dependence-4": ("model-a", "model-b", "two-model-hedge", "cptec"),
}
METHODS = ("historical-best", "two-model-hedge", *EXPERTS.keys())
DATASET_SOURCES = {"acled", "dbnomics", "fred", "wikipedia", "yfinance"}
MARKET_SOURCES = {"infer", "manifold", "metaculus", "polymarket"}
EPS = 1e-3


@dataclass
class Target:
    date: str
    source: str
    resolution_date: str
    outcome: float
    forecasts: dict[str, float]


@dataclass
class Pending:
    resolution_date: str
    outcome: float
    first: float
    second: float
    forecast_date: str
    vectors: dict[str, tuple[float, ...]]


@dataclass
class PairState:
    full_loss: np.ndarray = field(default_factory=lambda: np.zeros(7, dtype=float))
    full_n: int = 0
    meta_loss: dict[str, np.ndarray] = field(
        default_factory=lambda: {
            name: np.zeros(len(experts), dtype=float)
            for name, experts in EXPERTS.items()
            if name != "full-7"
        }
    )
    meta_n: dict[str, int] = field(
        default_factory=lambda: {name: 0 for name in EXPERTS if name != "full-7"}
    )
    history_first: list[float] = field(default_factory=list)
    history_second: list[float] = field(default_factory=list)
    history_outcome: list[float] = field(default_factory=list)
    history_dates: list[str] = field(default_factory=list)
    pending: list[Pending] = field(default_factory=list)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--parameters", type=Path, default=Path("public/forecastbench/dash2-history.json"))
    parser.add_argument("--cutoff", default="2026-03-29")
    parser.add_argument("--output", type=Path, default=Path("output/research/dash-subsets-resolution-oos-2026-08-23.json"))
    parser.add_argument("--bootstrap-reps", type=int, default=20_000)
    parser.add_argument("--seed", type=int, default=20_260_823)
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def slug(value: str) -> str:
    return re.sub(r"-+", "-", "".join(ch.lower() if ch.isalnum() else "-" for ch in value)).strip("-")


def provider_for(model: str) -> str | None:
    lowered = model.lower()
    rules = (
        ("Anthropic", ("claude",)), ("OpenAI", ("gpt", "o1", "o3", "o4")),
        ("Google", ("gemini",)), ("Meta", ("llama", "meta-llama")),
        ("DeepSeek", ("deepseek",)), ("Mistral", ("mistral", "mixtral", "magistral")),
        ("Qwen", ("qwen", "qwq")), ("Moonshot", ("kimi",)),
        ("xAI", ("grok",)), ("Z.ai", ("glm",)), ("Minimax", ("minimax",)),
    )
    return next((provider for provider, prefixes in rules if lowered.startswith(prefixes)), None)


def model_id(display_model: str) -> str | None:
    provider = provider_for(display_model)
    if provider is None:
        return None
    name = re.sub(r"\s*\([^)]*\)\s*$", "", display_model).strip()
    return slug(f"{provider}-{name}")


def target_key(date: str, row: dict) -> tuple[str, str, str, str]:
    return (date, str(row["source"]).lower(), str(row["id"]), str(row["resolution_date"])[:10])


def read_fixed_pairs(parameters_path: Path) -> list[tuple[str, str]]:
    parameters = json.loads(parameters_path.read_text())
    fields = {name: index for index, name in enumerate(parameters["fields"])}
    pairs = {
        (str(row[fields["model_a"]]), str(row[fields["model_b"]]))
        for row in parameters["records"]
    }
    return sorted(pairs)


def load_official_targets(archive: Path, fixed_models: set[str]) -> tuple[dict[str, list[Target]], dict]:
    accumulators: dict[tuple[str, str, str, str], dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    outcomes: dict[tuple[str, str, str, str], float] = {}
    files = rows = retained_rows = 0
    dates: set[str] = set()
    with tarfile.open(archive, "r:gz") as handle:
        # Iterate in physical tar order. Sorting compressed members would make
        # extractfile repeatedly seek and re-decompress the large stream.
        for member in handle:
            if not member.isfile() or not member.name.endswith(".json"):
                continue
            stream = handle.extractfile(member)
            if stream is None:
                continue
            payload = json.load(stream)
            date = str(payload["forecast_due_date"])[:10]
            current_model = model_id(str(payload.get("model") or ""))
            files += 1
            if current_model not in fixed_models:
                continue
            dates.add(date)
            for row in payload.get("forecasts", []):
                rows += 1
                # Composite information-structure questions are a separate
                # track in the released Historical Arena panel.
                if isinstance(row.get("id"), list):
                    continue
                if row.get("resolved") is not True or row.get("forecast") is None:
                    continue
                outcome = float(row["resolved_to"])
                if outcome not in (0.0, 1.0):
                    raise RuntimeError(f"Non-binary resolved target in {member.name}: {outcome}")
                key = target_key(date, row)
                if key in outcomes and outcomes[key] != outcome:
                    raise RuntimeError(f"Inconsistent outcome for {key}")
                outcomes[key] = outcome
                accumulators[key][current_model].append(float(row["forecast"]))
                retained_rows += 1

    by_date: dict[str, list[Target]] = defaultdict(list)
    for key, model_values in accumulators.items():
        date, source, _, resolution_date = key
        if source not in DATASET_SOURCES | MARKET_SOURCES:
            raise RuntimeError(f"Unknown official ForecastBench source: {source}")
        forecasts = {model: float(np.mean(values)) for model, values in model_values.items()}
        by_date[date].append(Target(date, source, resolution_date, outcomes[key], forecasts))
    for date in by_date:
        by_date[date].sort(key=lambda target: (target.source, target.resolution_date, sorted(target.forecasts)))
    audit = {
        "archiveSha256": sha256(archive),
        "jsonFiles": files,
        "resolvedProviderRowsScanned": rows,
        "resolvedFixedModelRowsRetained": retained_rows,
        "forecastDates": len(by_date),
        "firstForecastDate": min(by_date),
        "lastForecastDate": max(by_date),
        "canonicalTargetKey": "forecast_due_date + source + id + resolution_date",
        "variantRule": "arithmetic mean across prompt/configuration variants within exact provider base model",
    }
    return dict(by_date), audit


def clipped(value: np.ndarray | float) -> np.ndarray:
    return np.clip(np.asarray(value, dtype=float), EPS, 1.0 - EPS)


def logit(value: np.ndarray | float) -> np.ndarray:
    probability = clipped(value)
    return np.log(probability / (1.0 - probability))


def logistic(value: np.ndarray | float) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.asarray(value, dtype=float)))


def weights(loss: np.ndarray, n: int) -> np.ndarray:
    eta = math.sqrt(8.0 * math.log(len(loss)) / max(1, n))
    scores = -eta * loss
    scores -= float(np.max(scores))
    values = np.exp(scores)
    return values / float(np.sum(values))


def cptec(first: np.ndarray, second: np.ndarray) -> np.ndarray:
    return logistic(0.56 * logit(first) + 0.44 * logit(second))


def piecewise(first: np.ndarray, second: np.ndarray) -> np.ndarray:
    combined = logit(first) + logit(second)
    boundary = math.log(5.0)
    pooled = np.where(combined <= -boundary, combined + boundary / 2.0,
                      np.where(combined >= boundary, combined - boundary / 2.0, combined / 2.0))
    return logistic(pooled)


def percentile(values: dict[tuple[str, str], float], *, ascending: bool = True) -> dict[tuple[str, str], float]:
    series = pd.Series(values, dtype=float)
    return series.rank(method="average", ascending=ascending, pct=True).to_dict()


def pair_metrics(state: PairState) -> dict[str, float | int | str] | None:
    n = len(state.history_outcome)
    if n < 200 or len(set(state.history_dates)) < 3:
        return None
    first = np.asarray(state.history_first)
    second = np.asarray(state.history_second)
    outcome = np.asarray(state.history_outcome)
    loss_a = (first - outcome) ** 2
    loss_b = (second - outcome) ** 2
    risk_a, risk_b = float(np.mean(loss_a)), float(np.mean(loss_b))
    high_a, high_b = loss_a > 0.25, loss_b > 0.25
    marginal_a, marginal_b = float(np.mean(high_a)), float(np.mean(high_b))
    lift = float(np.mean(high_a & high_b) / (marginal_a * marginal_b)) if marginal_a and marginal_b else math.nan
    corr = float(np.corrcoef(loss_a, loss_b)[0, 1]) if np.std(loss_a) > 1e-15 and np.std(loss_b) > 1e-15 else math.nan
    bi_a = 100.0 * (1.0 - math.sqrt(max(0.0, risk_a)))
    bi_b = 100.0 * (1.0 - math.sqrt(max(0.0, risk_b)))
    return {
        "n": n,
        "dates": len(set(state.history_dates)),
        "risk_a": risk_a,
        "risk_b": risk_b,
        "best_side": "a" if risk_a <= risk_b else "b",
        "prior_quality": min(risk_a, risk_b),
        "bi_gap": abs(bi_a - bi_b),
        "pog": min(risk_a, risk_b) - float(np.mean(np.minimum(loss_a, loss_b))),
        "lift": lift,
        "corr": corr,
    }


def settle(state: PairState, date: str) -> None:
    keep: list[Pending] = []
    for pending in state.pending:
        if pending.resolution_date >= date:
            keep.append(pending)
            continue
        outcome = pending.outcome
        full = np.asarray(pending.vectors["full-7"])
        state.full_loss += (full - outcome) ** 2
        state.full_n += 1
        for variant in EXPERTS:
            if variant == "full-7":
                continue
            vector = np.asarray(pending.vectors[variant])
            state.meta_loss[variant] += (vector - outcome) ** 2
            state.meta_n[variant] += 1
        state.history_first.append(pending.first)
        state.history_second.append(pending.second)
        state.history_outcome.append(outcome)
        state.history_dates.append(pending.forecast_date)
    state.pending = keep


def vector_and_predictions(
    state: PairState,
    first: np.ndarray,
    second: np.ndarray,
    metric: dict[str, float | int | str] | None,
    alpha: float,
) -> tuple[dict[str, np.ndarray], dict[str, list[np.ndarray]]]:
    model_weights = weights(state.full_loss[:2], state.full_n)
    two_model = model_weights[0] * first + model_weights[1] * second
    if metric is not None and metric["best_side"] == "b":
        historical_best, cptec_prediction = second, cptec(second, first)
    else:
        historical_best, cptec_prediction = first, cptec(first, second)
    equal = 0.5 * (first + second)
    log_odds = logistic(0.5 * (logit(first) + logit(second)))
    piecewise_prediction = piecewise(first, second)
    safemix = (1.0 - alpha) * historical_best + alpha * two_model if metric is not None else equal
    named = {
        "model-a": first, "model-b": second, "equal-mean": equal,
        "log-odds": log_odds, "cptec": cptec_prediction,
        "piecewise-odds": piecewise_prediction, "safemix-2": safemix,
        "two-model-hedge": two_model,
    }
    vectors = {variant: [named[name] for name in expert_names] for variant, expert_names in EXPERTS.items()}
    predictions = {"historical-best": historical_best, "two-model-hedge": two_model}
    for variant, vector in vectors.items():
        loss = state.full_loss if variant == "full-7" else state.meta_loss[variant]
        n = state.full_n if variant == "full-7" else state.meta_n[variant]
        meta_weights = weights(loss, n)
        predictions[variant] = sum(meta_weights[index] * value for index, value in enumerate(vector))
    return predictions, vectors


def aggregate(rows: pd.DataFrame) -> dict:
    n = int(rows.n.sum())
    result = {"cells": int(len(rows)), "targetEvaluations": n, "pairs": int(rows.pair.nunique()), "dates": int(rows.date.nunique())}
    for method in METHODS:
        brier = float(np.average(rows[f"loss_{method}"], weights=rows.n))
        result[method] = {
            "brier": brier,
            "gainVsHistoricalBest": float(np.average(rows["loss_historical-best"] - rows[f"loss_{method}"], weights=rows.n)),
        }
    return result


def pair_summary(rows: pd.DataFrame, method: str) -> dict:
    records = []
    for pair, group in rows.groupby("pair", observed=True):
        n = int(group.n.sum())
        loss_a = float(np.average(group.loss_model_a, weights=group.n))
        loss_b = float(np.average(group.loss_model_b, weights=group.n))
        loss_method = float(np.average(group[f"loss_{method}"], weights=group.n))
        records.append((pair, n, min(loss_a, loss_b) - loss_method, min(loss_a, loss_b), loss_method, int(group.date.nunique())))
    return {
        "pairs": len(records),
        "strictlyBetterPairs": sum(gain > 1e-15 for _, _, gain, _, _, _ in records),
        "nonWorsePairs": sum(gain >= -1e-15 for _, _, gain, _, _, _ in records),
        "macroMeanGainVsExPostBest": float(np.mean([record[2] for record in records])),
        "topGains": [
            {"pair": pair, "targets": n, "dates": dates, "gain": gain, "exPostBestBrier": best, "methodBrier": risk}
            for pair, n, gain, best, risk, dates in sorted(records, key=lambda record: record[2], reverse=True)[:10]
        ],
        "largestLosses": [
            {"pair": pair, "targets": n, "dates": dates, "gain": gain, "exPostBestBrier": best, "methodBrier": risk}
            for pair, n, gain, best, risk, dates in sorted(records, key=lambda record: record[2])[:10]
        ],
    }


def bootstrap(rows: pd.DataFrame, baseline: str, comparison: str, reps: int, seed: int) -> dict:
    by_date = rows.assign(
        difference=(rows[f"loss_{baseline}"] - rows[f"loss_{comparison}"]) * rows.n
    ).groupby("date", observed=True).agg(difference=("difference", "sum"), n=("n", "sum")).reset_index()
    rng = np.random.default_rng(seed)
    draws = np.empty(reps)
    for index in range(reps):
        selected = rng.integers(0, len(by_date), len(by_date))
        draws[index] = by_date.difference.to_numpy()[selected].sum() / by_date.n.to_numpy()[selected].sum()
    return {
        "estimate": float(np.average(rows[f"loss_{baseline}"] - rows[f"loss_{comparison}"], weights=rows.n)),
        "ci95": [float(np.quantile(draws, 0.025)), float(np.quantile(draws, 0.975))],
        "probabilityPositive": float(np.mean(draws > 0)),
        "unit": "forecast_date",
    }


def bootstrap_gain_difference(
    first_group: pd.DataFrame,
    second_group: pd.DataFrame,
    baseline: str,
    comparison: str,
    reps: int,
    seed: int,
) -> dict:
    def date_totals(frame: pd.DataFrame) -> dict[str, tuple[float, int]]:
        grouped = frame.assign(
            difference=(frame[f"loss_{baseline}"] - frame[f"loss_{comparison}"]) * frame.n
        ).groupby("date", observed=True).agg(difference=("difference", "sum"), n=("n", "sum"))
        return {str(date): (float(row.difference), int(row.n)) for date, row in grouped.iterrows()}

    first = date_totals(first_group)
    second = date_totals(second_group)
    dates = sorted(set(first) | set(second))
    rng = np.random.default_rng(seed)
    draws = []
    for _ in range(reps):
        sampled = [dates[index] for index in rng.integers(0, len(dates), len(dates))]
        first_difference = sum(first.get(date, (0.0, 0))[0] for date in sampled)
        first_n = sum(first.get(date, (0.0, 0))[1] for date in sampled)
        second_difference = sum(second.get(date, (0.0, 0))[0] for date in sampled)
        second_n = sum(second.get(date, (0.0, 0))[1] for date in sampled)
        if first_n and second_n:
            draws.append(first_difference / first_n - second_difference / second_n)
    estimate = (
        float(np.average(first_group[f"loss_{baseline}"] - first_group[f"loss_{comparison}"], weights=first_group.n))
        - float(np.average(second_group[f"loss_{baseline}"] - second_group[f"loss_{comparison}"], weights=second_group.n))
    )
    return {
        "estimate": estimate,
        "ci95": [float(np.quantile(draws, 0.025)), float(np.quantile(draws, 0.975))],
        "probabilityPositive": float(np.mean(np.asarray(draws) > 0)),
        "estimand": "first-group gain minus second-group gain",
        "unit": "forecast_date",
    }


def ex_post_quality_quartiles(rows: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    pair_rows = []
    best_side: dict[str, str] = {}
    for pair, group in rows.groupby("pair", observed=True):
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
    augmented = rows.copy()
    augmented["ex_post_quality_quartile"] = augmented.pair.map(labels)
    augmented["loss_ex-post-best"] = np.where(
        augmented.pair.map(best_side) == "a", augmented.loss_model_a, augmented.loss_model_b
    )
    result = {}
    for label, group in augmented.groupby("ex_post_quality_quartile", observed=True):
        summary = {
            "cells": int(len(group)), "targetEvaluations": int(group.n.sum()),
            "pairs": int(group.pair.nunique()), "dates": int(group.date.nunique()),
            "ex-post-best": {"brier": float(np.average(group["loss_ex-post-best"], weights=group.n))},
        }
        for method in METHODS:
            summary[method] = {
                "brier": float(np.average(group[f"loss_{method}"], weights=group.n)),
                "gainVsExPostBest": float(np.average(group["loss_ex-post-best"] - group[f"loss_{method}"], weights=group.n)),
            }
        result[str(label)] = summary
    return augmented, result


def run(args: argparse.Namespace) -> dict:
    pairs = read_fixed_pairs(args.parameters)
    fixed_models = {model for pair in pairs for model in pair}
    targets_by_date, archive_audit = load_official_targets(args.archive, fixed_models)
    states = {pair: PairState() for pair in pairs}
    records: list[dict] = []
    coverage: list[dict] = []

    for date in sorted(targets_by_date):
        current = targets_by_date[date]
        for state in states.values():
            settle(state, date)

        pair_rounds: dict[tuple[str, str], list[Target]] = {}
        metrics: dict[tuple[str, str], dict] = {}
        for pair in pairs:
            common = [target for target in current if pair[0] in target.forecasts and pair[1] in target.forecasts]
            if common:
                pair_rounds[pair] = common
            metric = pair_metrics(states[pair])
            if metric is not None and len(common) >= 30:
                metrics[pair] = metric

        pog_pct = percentile({pair: float(metric["pog"]) for pair, metric in metrics.items()}) if metrics else {}
        finite_lift = {pair: float(metric["lift"]) for pair, metric in metrics.items() if math.isfinite(float(metric["lift"]))}
        finite_corr = {pair: float(metric["corr"]) for pair, metric in metrics.items() if math.isfinite(float(metric["corr"]))}
        lift_pct = percentile(finite_lift, ascending=False) if finite_lift else {}
        corr_pct = percentile(finite_corr, ascending=False) if finite_corr else {}

        scored_pairs = 0
        for pair, common in pair_rounds.items():
            state = states[pair]
            metric = metrics.get(pair)
            alpha = 0.0
            if metric is not None:
                complementarity = np.mean((pog_pct[pair], lift_pct.get(pair, 0.5), corr_pct.get(pair, 0.5)))
                alpha = float(np.clip(
                    complementarity * math.exp(-float(metric["bi_gap"]) / 2.0) * min(1.0, int(metric["n"]) / 500.0),
                    0.0,
                    1.0,
                ))
            first = np.asarray([target.forecasts[pair[0]] for target in common])
            second = np.asarray([target.forecasts[pair[1]] for target in common])
            outcomes = np.asarray([target.outcome for target in common])
            predictions, vectors = vector_and_predictions(state, first, second, metric, alpha)

            for index, target in enumerate(common):
                state.pending.append(Pending(
                    target.resolution_date, target.outcome, float(first[index]), float(second[index]), date,
                    {variant: tuple(float(values[index]) for values in vector) for variant, vector in vectors.items()},
                ))

            if date <= args.cutoff or metric is None:
                continue
            scored_pairs += 1
            record = {
                "date": date,
                "pair": f"{pair[0]} | {pair[1]}",
                "model_a": pair[0], "model_b": pair[1], "n": len(common),
                "prior_quality": float(metric["prior_quality"]), "safe_alpha": alpha,
                "history_targets": int(metric["n"]), "history_dates": int(metric["dates"]),
                "loss_model_a": float(np.mean((first - outcomes) ** 2)),
                "loss_model_b": float(np.mean((second - outcomes) ** 2)),
            }
            for method, prediction in predictions.items():
                record[f"loss_{method}"] = float(np.mean((prediction - outcomes) ** 2))
            records.append(record)
        if date > args.cutoff:
            coverage.append({"date": date, "resolvedTargets": len(current), "scoredFrozenPairs": scored_pairs})

    rows = pd.DataFrame(records)
    if rows.empty:
        raise RuntimeError("No post-cutoff frozen pair-date cells were eligible")
    ordered = rows.sort_values(["prior_quality", "date", "pair"]).reset_index(drop=True)
    ordered["prior_quality_quartile"] = pd.qcut(
        ordered.prior_quality.rank(method="first"), 4, labels=["Q1 strongest", "Q2", "Q3", "Q4 weakest"]
    )
    pair_dates = rows.groupby("pair", observed=True).date.nunique()
    stable_pairs = set(pair_dates[pair_dates >= 3].index)
    stable = rows[rows.pair.isin(stable_pairs)]

    overall = aggregate(rows)
    quartiles = {
        str(label): aggregate(group)
        for label, group in ordered.groupby("prior_quality_quartile", observed=True)
    }
    stable_result = aggregate(stable) if not stable.empty else None
    ex_post_rows, ex_post_quartiles = ex_post_quality_quartiles(rows)
    comparisons = {
        method: bootstrap(rows, "full-7", method, args.bootstrap_reps, args.seed + index)
        for index, method in enumerate(("core-5", "core-4", "no-dependence-4"))
    }
    gain_cis = {
        method: bootstrap(rows, "historical-best", method, args.bootstrap_reps, args.seed + 100 + index)
        for index, method in enumerate(METHODS)
        if method != "historical-best"
    }
    quartile_gain_cis = {
        str(label): {
            method: bootstrap(group, "historical-best", method, args.bootstrap_reps, args.seed + 200 + method_index)
            for method_index, method in enumerate(("full-7", "no-dependence-4"))
        }
        for label, group in ordered.groupby("prior_quality_quartile", observed=True)
    }
    q1 = ordered[ordered.prior_quality_quartile == "Q1 strongest"]
    q4 = ordered[ordered.prior_quality_quartile == "Q4 weakest"]
    strong_vs_weak = {
        method: bootstrap_gain_difference(
            q1, q4, "historical-best", method, args.bootstrap_reps, args.seed + 300 + method_index
        )
        for method_index, method in enumerate(("full-7", "no-dependence-4"))
    }
    ex_post_q1 = ex_post_rows[ex_post_rows.ex_post_quality_quartile == "Q1 strongest"]
    ex_post_gain_cis = {
        method: bootstrap(ex_post_q1, "ex-post-best", method, args.bootstrap_reps, args.seed + 400 + method_index)
        for method_index, method in enumerate(("full-7", "no-dependence-4"))
    }
    best_method = min(EXPERTS, key=lambda method: overall[method]["brier"])
    result = {
        "schemaVersion": "1.0.0-resolution-aware-confirmation",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "status": "frozen_post_cutoff_resolution_aware_confirmation",
        "protocol": {
            "cutoff": args.cutoff,
            "fixedPairCohort": "421 exact unordered model pairs from the pre-cutoff dash2-history artifact",
            "outcomeVisibility": "at forecast date t, weights and pair metrics use only targets with resolution_date < t",
            "currentRoundOutcomes": "never used to form current predictions; used only for offline scoring and released to learning after their resolution date",
            "primaryMetric": "target-weighted Raw Brier; lower is better",
            "strongGroup": "lowest quartile of post-cutoff pair-date cells by the better constituent's strictly-prior Raw Brier",
            "stableCohort": "frozen pairs scored on at least three post-cutoff forecast dates",
            "warning": "only the official archive snapshot's already-resolved targets are evaluable; later rounds are right-censored",
        },
        "audit": {
            **archive_audit,
            "parameterSha256": sha256(args.parameters),
            "fixedPairs": len(pairs),
            "postCutoffPairDateCells": int(len(rows)),
            "postCutoffTargetEvaluations": int(rows.n.sum()),
            "postCutoffDates": int(rows.date.nunique()),
            "postCutoffUniquePairs": int(rows.pair.nunique()),
            "stablePairs": len(stable_pairs),
            "allFeedbackStrictlyPreResolution": True,
        },
        "coverage": coverage,
        "overall": overall,
        "priorQualityQuartiles": quartiles,
        "priorQualityQuartileGainCIs": quartile_gain_cis,
        "strongVsWeakGainDifference": strong_vs_weak,
        "exPostQualityQuartiles": ex_post_quartiles,
        "exPostStrongestQ1GainCIs": ex_post_gain_cis,
        "stableCohort": stable_result,
        "full7Comparisons": comparisons,
        "gainVsHistoricalBestCIs": gain_cis,
        "pairSota": {method: pair_summary(rows, method) for method in EXPERTS},
        "bestCompactMethodByOverallBrier": best_method,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    return result


def main() -> None:
    args = parse_args()
    result = run(args)
    print(json.dumps({
        "output": str(args.output.resolve()),
        "audit": result["audit"],
        "coverage": result["coverage"],
        "bestCompactMethodByOverallBrier": result["bestCompactMethodByOverallBrier"],
        "overall": result["overall"],
        "priorQualityQuartiles": result["priorQualityQuartiles"],
    }, indent=2))


if __name__ == "__main__":
    main()
