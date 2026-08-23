#!/usr/bin/env python3
"""Build pair-sharded HSQAA-5 Balanced predictions for Historical Arena.

The builder replays the frozen phase-4 algorithm against the official
ForecastBench processed archive.  Each forecast uses only outcomes with a
resolution date strictly earlier than its forecast date.  Supported
predictions are mapped back to the immutable public history event order and
written one file per validated model pair so the browser downloads only the
selected pair.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import sys
import tarfile
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

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


PH4 = load_module("hsqaa_phase4_builder", "explore-hierarchical-quality-aa.py")
PH3 = PH4.PH3
PH2 = PH4.PH2
EXP = PH4.EXP
BASE = PH4.BASE

METHOD_ID = "hier-aa-source-q2-5-e2p0-p50p0-s1p0"


@dataclass
class Target:
    date: str
    source: str
    event_id: str
    resolution_date: str
    outcome: float
    forecasts: dict[str, float]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument(
        "--parameters",
        type=Path,
        default=Path("public/forecastbench/dash2-history.json"),
    )
    parser.add_argument(
        "--history",
        type=Path,
        default=Path("public/forecastbench/history.json"),
    )
    parser.add_argument(
        "--output-index",
        type=Path,
        default=Path("public/forecastbench/hsqaa-history.json"),
    )
    parser.add_argument(
        "--output-directory",
        type=Path,
        default=Path("public/forecastbench/hsqaa"),
    )
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def compact_sha256(payload: object) -> str:
    encoded = json.dumps(
        payload, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def load_resolution_dates(
    archive: Path,
    last_date: str,
) -> tuple[dict[tuple[str, float], str], dict[str, set[float]], dict]:
    """Recover immutable resolution dates without importing archive forecasts."""
    resolution_sets: dict[tuple[str, float], set[str]] = defaultdict(set)
    outcomes_by_target: dict[str, set[float]] = defaultdict(set)
    files = rows = resolved_rows = 0
    with tarfile.open(archive, "r:gz") as handle:
        for member in handle:
            if not member.isfile() or not member.name.endswith(".json"):
                continue
            stream = handle.extractfile(member)
            if stream is None:
                continue
            payload = json.load(stream)
            date = str(payload["forecast_due_date"])[:10]
            files += 1
            if date > last_date:
                continue
            for row in payload.get("forecasts", []):
                rows += 1
                if isinstance(row.get("id"), list):
                    continue
                if row.get("resolved") is not True or row.get("forecast") is None:
                    continue
                outcome = float(row["resolved_to"])
                if outcome not in (0.0, 1.0):
                    raise RuntimeError(
                        f"Non-binary resolved target in {member.name}: {outcome}"
                    )
                source = str(row["source"]).lower()
                event_id = str(row["id"])
                resolution_date = str(row["resolution_date"])[:10]
                public_id = f"{date}|{source}|{event_id}"
                resolution_sets[(public_id, outcome)].add(resolution_date)
                outcomes_by_target[public_id].add(outcome)
                resolved_rows += 1

    resolutions = {
        key: max(values) for key, values in resolution_sets.items()
    }
    return resolutions, outcomes_by_target, {
        "archiveSha256": sha256(archive),
        "jsonFilesScanned": files,
        "providerRowsScannedThroughHistoryEnd": rows,
        "resolvedProviderRowsScannedThroughHistoryEnd": resolved_rows,
        "uniqueResolvedTargetOutcomeKeys": len(resolutions),
        "targetIdsWithMultipleOutcomes": sum(
            len(values) > 1 for values in outcomes_by_target.values()
        ),
        "targetOutcomesWithMultipleResolutionDates": sum(
            len(values) > 1 for values in resolution_sets.values()
        ),
        "resolutionDisambiguationRule": (
            "match public outcome, then use latest date to prevent early feedback"
        ),
        "resolutionJoinKey": "forecast_due_date + source + id",
    }


def pair_filename(pair: tuple[str, str]) -> str:
    digest = hashlib.sha256("\0".join(pair).encode("utf-8")).hexdigest()[:20]
    return f"pair-{digest}.json"


def run(args: argparse.Namespace) -> dict:
    history_bytes = args.history.read_bytes()
    history = json.loads(history_bytes)
    history_hash = hashlib.sha256(history_bytes).hexdigest()
    public_events = history["events"]
    public_index = {event["id"]: index for index, event in enumerate(public_events)}
    if len(public_index) != len(public_events):
        raise RuntimeError("Public history event IDs are not unique")
    last_date = str(history["meta"]["lastRound"])

    pairs = BASE.read_fixed_pairs(args.parameters)
    fixed_models = {model for pair in pairs for model in pair}
    public_models = {model["id"] for model in history["models"]}
    missing_models = sorted(fixed_models - public_models)
    if missing_models:
        raise RuntimeError(f"Frozen pair models missing from public history: {missing_models}")
    resolutions, archive_outcomes, archive_audit = load_resolution_dates(
        args.archive, last_date
    )
    targets_by_date: dict[str, list[Target]] = defaultdict(list)
    missing_resolutions: list[str] = []
    outcome_mismatches: list[str] = []
    for event in public_events:
        public_id = str(event["id"])
        outcome = float(event["outcome"])
        resolution_date = resolutions.get((public_id, outcome))
        if resolution_date is None:
            if public_id in archive_outcomes:
                outcome_mismatches.append(public_id)
            else:
                missing_resolutions.append(public_id)
            continue
        date = str(event["date"])
        source = str(event["sourceKey"])
        forecasts = {
            model: float(probability)
            for model, probability in event["forecasts"].items()
            if model in fixed_models
        }
        targets_by_date[date].append(Target(
            date,
            source,
            public_id.split("|", 2)[2],
            resolution_date,
            outcome,
            forecasts,
        ))
    for date in targets_by_date:
        targets_by_date[date].sort(
            key=lambda target: (target.source, target.event_id)
        )
    pair_states = {pair: PH2.State() for pair in pairs}
    population_state = PH4.PopulationState()
    predictions: dict[tuple[str, str], list[list[float | int]]] = {
        pair: [] for pair in pairs
    }
    supported_dates: dict[tuple[str, str], set[str]] = {
        pair: set() for pair in pairs
    }

    for date in sorted(targets_by_date):
        current = targets_by_date[date]
        for state in pair_states.values():
            PH2.settle(state, date)
        PH4.settle_population(population_state, date)

        pair_rounds: dict[tuple[str, str], list[Target]] = {}
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
        lift_pct = BASE.percentile(
            finite_lift, ascending=False
        ) if finite_lift else {}
        corr_pct = BASE.percentile(
            finite_corr, ascending=False
        ) if finite_corr else {}

        for pair, common in pair_rounds.items():
            state = pair_states[pair]
            metric = metrics.get(pair)
            alpha = 0.0
            if metric is not None:
                complementarity = float(np.mean((
                    pog_pct[pair],
                    lift_pct.get(pair, 0.5),
                    corr_pct.get(pair, 0.5),
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
            if metric is not None:
                phase2_predictions, vectors, strategies = PH2.candidate_predictions(
                    state, common, first, second, metric, alpha, pog_pct[pair]
                )
                q2, q4 = PH4.quality_labels(quality_pct[pair])
                hierarchical = PH4.hierarchical_candidates(
                    state,
                    population_state,
                    common,
                    phase2_predictions["historical-best"],
                    strategies,
                    q2,
                    q4,
                )
                hsqaa = hierarchical[METHOD_ID]
                supported_dates[pair].add(date)
                for index, target in enumerate(common):
                    public_id = f"{date}|{target.source}|{target.event_id}"
                    predictions[pair].append([
                        public_index[public_id], round(float(hsqaa[index]), 12)
                    ])
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
                q2, q4 = "unknown", "unknown"

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
                    float(
                        phase2_predictions["historical-best"][index]
                        if metric is not None else historical[index]
                    ),
                    float(
                        phase2_predictions["no-dependence-4"][index]
                        if metric is not None else base_predictions["no-dependence-4"][index]
                    ),
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
                if metric is not None:
                    population_state.pending.append(PH4.PopulationPending(
                        target.resolution_date,
                        target.outcome,
                        target.source,
                        q2,
                        q4,
                        tuple(float(value[index]) for value in strategies),
                    ))

    args.output_directory.mkdir(parents=True, exist_ok=True)
    pair_index = []
    total_records = 0
    total_bytes = 0
    for pair in pairs:
        rows = sorted(predictions[pair], key=lambda row: int(row[0]))
        if not rows:
            continue
        indices = [int(row[0]) for row in rows]
        if len(indices) != len(set(indices)):
            raise RuntimeError(f"Duplicate public event prediction for {pair}")
        filename = pair_filename(pair)
        payload = {
            "schema_version": "1.0.0",
            "method_id": METHOD_ID,
            "history_sha256": history_hash,
            "model_a": pair[0],
            "model_b": pair[1],
            "fallback": "equal-mean",
            "records": rows,
        }
        path = args.output_directory / filename
        path.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        size = path.stat().st_size
        total_bytes += size
        total_records += len(rows)
        pair_index.append([
            pair[0], pair[1], filename, len(rows),
            min(supported_dates[pair]), max(supported_dates[pair]),
            hashlib.sha256(path.read_bytes()).hexdigest(),
        ])

    index_payload = {
        "schema_version": "1.0.0",
        "method_id": METHOD_ID,
        "method_name": "HSQAA-5 Balanced",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "history_sha256": history_hash,
        "outcome_visibility": "resolution_date_strictly_before_forecast_date",
        "fallback": "equal-mean",
        "config": {
            "scope": "official-source-by-prior-quality-half",
            "experts": 5,
            "eta": 2.0,
            "pair_global_pseudo_count": 200.0,
            "population_pseudo_count": 50.0,
            "shrink": 1.0,
            "min_history_targets": 200,
            "min_history_dates": 3,
            "min_current_targets": 30,
        },
        "audit": {
            **archive_audit,
            "historyEvents": len(public_events),
            "historyLastRound": last_date,
            "historyForecastSource": "public/forecastbench/history.json",
            "resolutionDateSource": "official processed ForecastBench archive",
            "fixedPairs": len(pairs),
            "supportedPairs": len(pair_index),
            "supportedPredictions": total_records,
            "pairShardBytes": total_bytes,
            "historyEventsWithResolutionDates": sum(
                len(values) for values in targets_by_date.values()
            ),
            "missingResolutionDates": len(missing_resolutions),
            "missingResolutionRule": (
                "exclude from HSQAA feedback and use equal-mean fallback"
            ),
            "outcomeMismatches": len(outcome_mismatches),
            "outcomeMismatchRule": (
                "exclude from HSQAA feedback and use equal-mean fallback"
            ),
            "allFeedbackStrictlyPreResolution": True,
        },
        "fields": [
            "model_a", "model_b", "file", "supported_predictions",
            "date_min", "date_max", "sha256",
        ],
        "pairs": pair_index,
    }
    index_payload["content_sha256"] = compact_sha256(index_payload)
    args.output_index.write_text(
        json.dumps(index_payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    return index_payload


def main() -> None:
    args = parse_args()
    result = run(args)
    print(json.dumps({
        "output": str(args.output_index.resolve()),
        "method": result["method_name"],
        "historySha256": result["history_sha256"],
        "contentSha256": result["content_sha256"],
        "audit": result["audit"],
    }, indent=2))


if __name__ == "__main__":
    main()
