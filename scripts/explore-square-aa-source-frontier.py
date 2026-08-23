#!/usr/bin/env python3
"""Explore square-loss Aggregating Algorithm source specialists.

This phase-3 mechanism check keeps the resolution-aware ForecastBench protocol
from the frozen SSH-5 experiment.  It replaces the linear expert average with
the square-loss generalized-prediction substitution and uses a nested temporal
split inside the pre-cutoff block before inspecting the later block.

The family is post-hoc: it was proposed after the SSH-5 secondary-confirmation
result.  Consequently, even a favorable later-block result is exploratory and
requires a future independent confirmation.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import sys
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


PH2 = load_module("source_specialist_phase2", "explore-mixable-source-frontier.py")
EXP = PH2.EXP
BASE = PH2.BASE

SSH5 = "fixed-hedge-source5-e0p5-p200p0"
CONTROLS = (
    "historical-best",
    "two-model-hedge",
    "full-7",
    "no-dependence-4",
    "nodep-gap-g5p0",
    SSH5,
)
ETAS = (0.5, 1.0, 2.0)
PSEUDO_COUNTS = (0.0, 50.0, 200.0)
SHRINKS = (0.75, 1.0)


def token(value: float) -> str:
    return str(value).replace(".", "p")


def candidate_names() -> list[str]:
    names = list(CONTROLS)
    for scope in ("global", "source"):
        pseudos = (None,) if scope == "global" else PSEUDO_COUNTS
        for subset in (3, 5):
            for eta in ETAS:
                for pseudo in pseudos:
                    for shrink in SHRINKS:
                        suffix = "" if pseudo is None else f"-p{token(pseudo)}"
                        names.append(
                            f"square-aa-{scope}{subset}-e{token(eta)}{suffix}-s{token(shrink)}"
                        )
    return names


METHODS = candidate_names()


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
        default=Path("output/research/square-aa-source-frontier-2026-08-23.json"),
    )
    parser.add_argument("--bootstrap-reps", type=int, default=20_000)
    parser.add_argument("--seed", type=int, default=20_260_826)
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def logsumexp(values: np.ndarray, axis: int) -> np.ndarray:
    maximum = np.max(values, axis=axis, keepdims=True)
    return np.squeeze(maximum, axis=axis) + np.log(
        np.sum(np.exp(values - maximum), axis=axis)
    )


def square_aa_prediction(
    strategies: list[np.ndarray], cumulative_loss: np.ndarray, eta: float
) -> np.ndarray:
    """Return the square-loss generalized-prediction substitution.

    The current posterior depends only on cumulative losses released before
    the current forecast date.  The prediction uses no current outcome.
    """
    predictions = np.vstack([np.asarray(value, dtype=float) for value in strategies])
    scores = -eta * np.asarray(cumulative_loss, dtype=float)
    log_weights = scores - logsumexp(scores[:, None], axis=0)
    generalized_zero = -logsumexp(
        log_weights[:, None] - eta * predictions**2, axis=0
    ) / eta
    generalized_one = -logsumexp(
        log_weights[:, None] - eta * (1.0 - predictions) ** 2, axis=0
    ) / eta
    return np.clip((1.0 + generalized_zero - generalized_one) / 2.0, 0.0, 1.0)


def aa_candidates(
    state,
    targets: list,
    historical: np.ndarray,
    strategies: list[np.ndarray],
) -> dict[str, np.ndarray]:
    result: dict[str, np.ndarray] = {}
    global_loss = state.phase1.frontier_loss
    global_n = state.phase1.frontier_n
    for subset in (3, 5):
        selected_strategies = strategies[:subset]
        selected_global_loss = global_loss[:subset]
        for eta in ETAS:
            global_prediction = square_aa_prediction(
                selected_strategies, selected_global_loss, eta
            )
            for shrink in SHRINKS:
                result[
                    f"square-aa-global{subset}-e{token(eta)}-s{token(shrink)}"
                ] = historical + shrink * (global_prediction - historical)

            for pseudo in PSEUDO_COUNTS:
                source_prediction = np.empty(len(targets), dtype=float)
                for source in sorted({target.source for target in targets}):
                    indices = np.asarray(
                        [index for index, target in enumerate(targets) if target.source == source],
                        dtype=int,
                    )
                    adjusted = PH2.specialist_loss(
                        state.source_loss.get(source),
                        state.source_n.get(source, 0),
                        global_loss,
                        global_n,
                        pseudo,
                    )[:subset]
                    source_prediction[indices] = square_aa_prediction(
                        [strategy[indices] for strategy in selected_strategies],
                        adjusted,
                        eta,
                    )
                for shrink in SHRINKS:
                    result[
                        f"square-aa-source{subset}-e{token(eta)}-p{token(pseudo)}-s{token(shrink)}"
                    ] = historical + shrink * (source_prediction - historical)
    expected = set(METHODS) - set(CONTROLS)
    if set(result) != expected:
        raise RuntimeError(
            f"AA candidate mismatch: missing={expected-set(result)}, extra={set(result)-expected}"
        )
    return result


def pair_win_comparison(frame: pd.DataFrame, first: str, second: str) -> dict:
    return PH2.pair_win_comparison(frame, first, second)


def method_family(method: str) -> str:
    if method.startswith("square-aa-source5-"):
        return "square-aa-source5"
    if method.startswith("square-aa-global5-"):
        return "square-aa-global5"
    if method.startswith("square-aa-source3-"):
        return "square-aa-source3"
    if method.startswith("square-aa-global3-"):
        return "square-aa-global3"
    return method


def validation_pool(summary: dict) -> tuple[list[str], list[str]]:
    """Expand development Pareto mechanisms for internal hyperparameter choice."""
    champions = EXP.select_discovery_champions(summary)
    families = sorted({method_family(method) for method in champions["paretoFront"]})
    controls = {SSH5, "no-dependence-4", "full-7", "nodep-gap-g5p0"}
    choices = sorted(
        method for method in METHODS
        if method in controls or method_family(method) in families
    )
    return families, choices


def choose_from_shortlist(summary: dict, choices: list[str]) -> dict:
    overall = min(choices, key=lambda method: (summary["overall"][method]["brier"], method))
    strong = max(
        choices,
        key=lambda method: (
            summary["q1Strongest"][method]["gainVsHistoricalBest"], method
        ),
    )
    sota = max(
        choices,
        key=lambda method: (
            summary["pairSota"][method]["strictWinRate"],
            summary["pairSota"][method]["macroMeanGainVsExPostBest"],
            -summary["overall"][method]["brier"],
        ),
    )
    ranks = {}
    for name, values, ascending in (
        ("overall", {m: summary["overall"][m]["brier"] for m in choices}, True),
        (
            "strong",
            {m: summary["q1Strongest"][m]["gainVsHistoricalBest"] for m in choices},
            False,
        ),
        (
            "sota",
            {m: summary["pairSota"][m]["strictWinRate"] for m in choices},
            False,
        ),
    ):
        ranks[name] = pd.Series(values).rank(method="average", ascending=ascending).to_dict()
    balanced = min(
        choices,
        key=lambda method: (
            ranks["overall"][method] + ranks["strong"][method] + ranks["sota"][method],
            method,
        ),
    )
    return {"overall": overall, "strongQ1": strong, "pairSota": sota, "balanced": balanced}


def run(args: argparse.Namespace) -> dict:
    pairs = BASE.read_fixed_pairs(args.parameters)
    fixed_models = {model for pair in pairs for model in pair}
    targets_by_date, archive_audit = BASE.load_official_targets(args.archive, fixed_models)
    states = {pair: PH2.State() for pair in pairs}
    records: list[dict] = []
    source_records: list[dict] = []

    for date in sorted(targets_by_date):
        current = targets_by_date[date]
        for state in states.values():
            PH2.settle(state, date)

        pair_rounds = {}
        metrics = {}
        for pair in pairs:
            common = [
                target for target in current
                if pair[0] in target.forecasts and pair[1] in target.forecasts
            ]
            if common:
                pair_rounds[pair] = common
            metric = BASE.pair_metrics(states[pair].phase1.base)
            if metric is not None and len(common) >= 30:
                metrics[pair] = metric

        pog_pct = BASE.percentile(
            {pair: float(metric["pog"]) for pair, metric in metrics.items()}
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
            state = states[pair]
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
                    state, common, first, second, metric, alpha, pog_pct[pair]
                )
                method_predictions = {name: phase2_predictions[name] for name in CONTROLS}
                historical = method_predictions["historical-best"]
                method_predictions.update(
                    aa_candidates(state, common, historical, strategies)
                )
            else:
                base_predictions, vectors = BASE.vector_and_predictions(
                    state.phase1.base, first, second, None, 0.0
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

            for index, target in enumerate(common):
                state.phase1.pending.append(EXP.Pending(
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
                state.pending.append(PH2.SpecialistPending(
                    target.resolution_date,
                    target.outcome,
                    target.source,
                    PH2.question_type(target.source),
                    float(first[index]),
                    float(second[index]),
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
                "bi_gap": float(metric["bi_gap"]),
                "loss_model_a": float(np.mean((first - outcomes) ** 2)),
                "loss_model_b": float(np.mean((second - outcomes) ** 2)),
            }
            for method, prediction in method_predictions.items():
                if method in METHODS:
                    row[f"loss_{method}"] = float(np.mean((prediction - outcomes) ** 2))
            if set(row) >= {f"loss_{method}" for method in METHODS}:
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
    development_families, development_shortlist = validation_pool(
        summaries["development"]
    )
    preconfirmation = choose_from_shortlist(
        summaries["internal-validation"], development_shortlist
    )
    selected = sorted(
        set(preconfirmation.values())
        | {SSH5, "no-dependence-4", "full-7", "nodep-gap-g5p0"}
    )
    confirmation = samples["secondary-confirmation"]
    confirmation_sources = pd.DataFrame(source_records)
    confirmation_sources = confirmation_sources[
        confirmation_sources["sample"] == "secondary-confirmation"
    ].copy()
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
            "advantageVsSSH5": BASE.bootstrap(
                confirmation, SSH5, method,
                args.bootstrap_reps, args.seed + 100 + index,
            ),
            "historicallyStrongQ1Gain": BASE.bootstrap(
                prior_q1, "historical-best", method,
                args.bootstrap_reps, args.seed + 200 + index,
            ),
            "realizedStrongestQ1Gain": BASE.bootstrap(
                ex_post_q1, "ex-post-best", method,
                args.bootstrap_reps, args.seed + 300 + index,
            ),
        }
        for index, method in enumerate(selected)
    }
    win_sets = {
        method: {
            control: pair_win_comparison(confirmation, method, control)
            for control in (SSH5, "no-dependence-4", "nodep-gap-g5p0", "full-7")
            if method != control
        }
        for method in selected
    }
    result = {
        "schemaVersion": "1.0.0-square-aa-source-frontier",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "status": "post_hoc_phase3_mechanism_check_future_confirmation_required",
        "protocol": {
            "developmentCutoff": args.development_cutoff,
            "confirmationCutoff": args.confirmation_cutoff,
            "selection": (
                "development selects a shortlist; internal validation selects "
                "pre-confirmation champions; later block is inspected only afterward"
            ),
            "outcomeVisibility": "resolution_date strictly earlier than forecast date",
            "substitution": (
                "square-loss generalized prediction q=(1+g0-g1)/2, clipped to [0,1]"
            ),
            "warning": (
                "family was proposed after SSH-5 secondary-confirmation inspection; "
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
        "developmentShortlist": development_shortlist,
        "preConfirmationChampions": preconfirmation,
        "samples": summaries,
        "selectedConfirmationCIs": cis,
        "confirmationPairWinComparisons": win_sets,
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
    selected = sorted(
        set(result["preConfirmationChampions"].values())
        | {SSH5, "no-dependence-4", "full-7", "nodep-gap-g5p0"}
    )
    print(json.dumps({
        "output": str(args.output.resolve()),
        "audit": result["audit"],
        "developmentChampions": result["developmentChampions"],
        "developmentParetoFamilies": result["developmentParetoFamilies"],
        "developmentShortlist": result["developmentShortlist"],
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
