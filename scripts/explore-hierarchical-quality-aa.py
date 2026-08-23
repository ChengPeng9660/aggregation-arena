#!/usr/bin/env python3
"""Explore cross-pair source-by-quality sharing for SSAA-5.

The hierarchy pools strictly resolved expert losses across model pairs in the
same official source and historical-quality regime.  Development selects
mechanism families, internal validation selects exact objective-specific
configurations, and the later block is reported only as secondary evidence.
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


PH3 = load_module("square_aa_phase3", "explore-square-aa-source-frontier.py")
PH2 = PH3.PH2
EXP = PH3.EXP
BASE = PH3.BASE

SSAA_MEAN = "square-aa-source5-e2p0-p200p0-s1p0"
SSAA_SOTA = "square-aa-source5-e2p0-p50p0-s0p75"
CONTROLS = (
    "historical-best",
    "two-model-hedge",
    "full-7",
    "no-dependence-4",
    "nodep-gap-g5p0",
    PH3.SSH5,
    SSAA_MEAN,
    SSAA_SOTA,
)
ETAS = (1.0, 2.0)
POPULATION_PSEUDOS = (50.0, 200.0, 500.0, 1000.0)
SHRINKS = (0.75, 1.0)
SCOPES = ("source", "source-q2", "source-q4")


def token(value: float) -> str:
    return str(value).replace(".", "p")


def candidate_names() -> list[str]:
    names = list(CONTROLS)
    for scope in SCOPES:
        for eta in ETAS:
            for pseudo in POPULATION_PSEUDOS:
                for shrink in SHRINKS:
                    names.append(
                        f"hier-aa-{scope}-5-e{token(eta)}-p{token(pseudo)}-s{token(shrink)}"
                    )
    return names


METHODS = candidate_names()


@dataclass
class PopulationPending:
    resolution_date: str
    outcome: float
    source: str
    q2: str
    q4: str
    strategies: tuple[float, ...]


@dataclass
class PopulationState:
    pending: list[PopulationPending] = field(default_factory=list)
    source_loss: dict[str, np.ndarray] = field(default_factory=dict)
    source_n: dict[str, int] = field(default_factory=dict)
    source_q2_loss: dict[tuple[str, str], np.ndarray] = field(default_factory=dict)
    source_q2_n: dict[tuple[str, str], int] = field(default_factory=dict)
    source_q4_loss: dict[tuple[str, str], np.ndarray] = field(default_factory=dict)
    source_q4_n: dict[tuple[str, str], int] = field(default_factory=dict)


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
        default=Path("output/research/hierarchical-quality-aa-2026-08-23.json"),
    )
    parser.add_argument("--bootstrap-reps", type=int, default=20_000)
    parser.add_argument("--seed", type=int, default=20_260_827)
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_loss(container: dict, key) -> np.ndarray:
    if key not in container:
        container[key] = np.zeros(5, dtype=float)
    return container[key]


def settle_population(state: PopulationState, date: str) -> None:
    keep: list[PopulationPending] = []
    for pending in state.pending:
        if pending.resolution_date >= date:
            keep.append(pending)
            continue
        losses = (np.asarray(pending.strategies) - pending.outcome) ** 2
        ensure_loss(state.source_loss, pending.source)[:] += losses
        state.source_n[pending.source] = state.source_n.get(pending.source, 0) + 1
        q2_key = (pending.source, pending.q2)
        ensure_loss(state.source_q2_loss, q2_key)[:] += losses
        state.source_q2_n[q2_key] = state.source_q2_n.get(q2_key, 0) + 1
        q4_key = (pending.source, pending.q4)
        ensure_loss(state.source_q4_loss, q4_key)[:] += losses
        state.source_q4_n[q4_key] = state.source_q4_n.get(q4_key, 0) + 1
    state.pending = keep


def quality_labels(percentile: float) -> tuple[str, str]:
    q2 = "strong-half" if percentile <= 0.5 else "weak-half"
    if percentile <= 0.25:
        q4 = "Q1"
    elif percentile <= 0.5:
        q4 = "Q2"
    elif percentile <= 0.75:
        q4 = "Q3"
    else:
        q4 = "Q4"
    return q2, q4


def population_mean(
    state: PopulationState,
    scope: str,
    source: str,
    q2: str,
    q4: str,
) -> np.ndarray | None:
    if scope == "source":
        loss = state.source_loss.get(source)
        n = state.source_n.get(source, 0)
    elif scope == "source-q2":
        key = (source, q2)
        loss = state.source_q2_loss.get(key)
        n = state.source_q2_n.get(key, 0)
    elif scope == "source-q4":
        key = (source, q4)
        loss = state.source_q4_loss.get(key)
        n = state.source_q4_n.get(key, 0)
    else:
        raise RuntimeError(scope)
    if loss is None or n <= 0:
        return None
    return loss / n


def hierarchical_candidates(
    pair_state,
    population_state: PopulationState,
    targets: list,
    historical: np.ndarray,
    strategies: list[np.ndarray],
    q2: str,
    q4: str,
) -> dict[str, np.ndarray]:
    result: dict[str, np.ndarray] = {}
    pair_global_loss = pair_state.phase1.frontier_loss
    pair_global_n = pair_state.phase1.frontier_n
    for scope in SCOPES:
        for eta in ETAS:
            for pseudo in POPULATION_PSEUDOS:
                prediction = np.empty(len(targets), dtype=float)
                for source in sorted({target.source for target in targets}):
                    indices = np.asarray([
                        index for index, target in enumerate(targets)
                        if target.source == source
                    ], dtype=int)
                    adjusted = PH2.specialist_loss(
                        pair_state.source_loss.get(source),
                        pair_state.source_n.get(source, 0),
                        pair_global_loss,
                        pair_global_n,
                        200.0,
                    )
                    shared = population_mean(
                        population_state, scope, source, q2, q4
                    )
                    if shared is not None:
                        adjusted = adjusted + pseudo * shared
                    prediction[indices] = PH3.square_aa_prediction(
                        [strategy[indices] for strategy in strategies],
                        adjusted,
                        eta,
                    )
                for shrink in SHRINKS:
                    result[
                        f"hier-aa-{scope}-5-e{token(eta)}-p{token(pseudo)}-s{token(shrink)}"
                    ] = historical + shrink * (prediction - historical)
    expected = set(METHODS) - set(CONTROLS)
    if set(result) != expected:
        raise RuntimeError(
            f"hierarchical candidate mismatch: missing={expected-set(result)}, "
            f"extra={set(result)-expected}"
        )
    return result


def method_family(method: str) -> str:
    for scope in SCOPES:
        if method.startswith(f"hier-aa-{scope}-5-"):
            return f"hier-aa-{scope}-5"
    return method


def validation_pool(summary: dict) -> tuple[list[str], list[str]]:
    champions = EXP.select_discovery_champions(summary)
    families = sorted({method_family(method) for method in champions["paretoFront"]})
    controls = set(CONTROLS)
    choices = sorted(
        method for method in METHODS
        if method in controls or method_family(method) in families
    )
    return families, choices


def choose_from_pool(summary: dict, choices: list[str]) -> dict:
    return PH3.choose_from_shortlist(summary, choices)


def run(args: argparse.Namespace) -> dict:
    pairs = BASE.read_fixed_pairs(args.parameters)
    fixed_models = {model for pair in pairs for model in pair}
    targets_by_date, archive_audit = BASE.load_official_targets(args.archive, fixed_models)
    pair_states = {pair: PH2.State() for pair in pairs}
    population_state = PopulationState()
    records: list[dict] = []
    source_records: list[dict] = []

    for date in sorted(targets_by_date):
        current = targets_by_date[date]
        for state in pair_states.values():
            PH2.settle(state, date)
        settle_population(population_state, date)

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
                method_predictions = {
                    name: (
                        phase2_predictions[name]
                        if name in phase2_predictions else phase3_predictions[name]
                    )
                    for name in CONTROLS
                }
                q2, q4 = quality_labels(quality_pct[pair])
                method_predictions.update(hierarchical_candidates(
                    pair_state,
                    population_state,
                    common,
                    method_predictions["historical-best"],
                    strategies,
                    q2,
                    q4,
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
                if metric is not None:
                    population_state.pending.append(PopulationPending(
                        target.resolution_date,
                        target.outcome,
                        target.source,
                        q2,
                        q4,
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
                "quality_q2": q2,
                "quality_q4": q4,
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
                        "quality_q4": q4,
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
    preconfirmation = choose_from_pool(summaries["internal-validation"], pool)
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
            "advantageVsSSAA5Mean": BASE.bootstrap(
                confirmation, SSAA_MEAN, method,
                args.bootstrap_reps, args.seed + 100 + index,
            ),
            "historicallyStrongQ1Gain": BASE.bootstrap(
                prior_q1, "historical-best", method,
                args.bootstrap_reps, args.seed + 200 + index,
            ),
            "historicallyStrongQ1AdvantageVsSSAA5Mean": BASE.bootstrap(
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
        "schemaVersion": "1.0.0-hierarchical-quality-aa",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "status": "post_hoc_phase4_mechanism_check_future_confirmation_required",
        "protocol": {
            "developmentCutoff": args.development_cutoff,
            "confirmationCutoff": args.confirmation_cutoff,
            "selection": (
                "development selects Pareto mechanism families; internal validation "
                "selects exact objective-specific configurations"
            ),
            "outcomeVisibility": "resolution_date strictly earlier than forecast date",
            "populationUnit": "pair-target expert loss, matching the evaluation estimand",
            "qualityRegime": (
                "current eligible-pair percentile of strictly-prior better-constituent Raw Brier"
            ),
            "warning": (
                "family was proposed after SSAA-5 secondary-confirmation inspection; "
                "later-block results are exploratory"
            ),
        },
        "audit": {
            **archive_audit,
            "parameterSha256": sha256(args.parameters),
            "fixedPairs": len(pairs),
            "candidateMethods": len(METHODS),
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
                for control in (SSAA_MEAN, SSAA_SOTA, PH3.SSH5, "no-dependence-4", "full-7")
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
