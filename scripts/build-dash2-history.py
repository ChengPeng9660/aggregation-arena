#!/usr/bin/env python3
"""Build the compact, audited prior-date parameter table used by Historical Arena."""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
from pathlib import Path


FIELDS = [
    "date",
    "history_last_date",
    "model_a",
    "model_b",
    "n_history",
    "n_history_dates",
    "history_best_side",
    "safe_alpha",
]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--history", type=Path, default=Path("public/forecastbench/history.json"))
    parser.add_argument("--output", type=Path, default=Path("public/forecastbench/dash2-history.json"))
    args = parser.parse_args()

    metadata = json.loads(args.metadata.read_text())
    history = json.loads(args.history.read_text())
    history_hash = sha256(args.history)
    source_hash = sha256(args.source)
    expected_source = metadata["output_files"][args.source.name]["sha256"]
    if history_hash != metadata["input_sha256"]:
        raise RuntimeError("Historical panel hash does not match the audited experiment")
    if source_hash != expected_source:
        raise RuntimeError("Pair-date source hash does not match the audited experiment")

    model_order = {str(model["id"]): index for index, model in enumerate(history["models"])}
    records: list[list[object]] = []
    seen: set[tuple[str, str, str]] = set()
    with gzip.open(args.source, "rt", newline="") as handle:
        for row in csv.DictReader(handle):
            model_a = row["model_a"]
            model_b = row["model_b"]
            date = row["date"]
            history_last_date = row["history_last_date"]
            key = (model_a, model_b, date)
            if key in seen:
                raise RuntimeError(f"Duplicate pair-date record: {key}")
            seen.add(key)
            if model_a not in model_order or model_b not in model_order:
                raise RuntimeError(f"Unknown model in pair-date record: {key}")
            if model_order[model_a] >= model_order[model_b]:
                raise RuntimeError(f"Non-canonical model order: {key}")
            if history_last_date >= date:
                raise RuntimeError(f"Current/future outcome leakage in record: {key}")
            n_history = int(row["n_history"])
            n_history_dates = int(row["n_history_dates"])
            alpha = float(row["safe_alpha"])
            best_side = row["history_best_side"]
            if n_history < int(metadata["config"]["min_history_targets"]):
                raise RuntimeError(f"Insufficient history in released record: {key}")
            if n_history_dates < int(metadata["config"]["min_history_dates"]):
                raise RuntimeError(f"Insufficient dates in released record: {key}")
            if best_side not in {"a", "b"} or not 0.0 <= alpha <= 1.0:
                raise RuntimeError(f"Invalid parameters in released record: {key}")
            records.append([
                date,
                history_last_date,
                model_a,
                model_b,
                n_history,
                n_history_dates,
                best_side,
                alpha,
            ])

    records.sort(key=lambda row: (row[0], model_order[str(row[2])], model_order[str(row[3])]))
    payload = {
        "schema_version": "1.0.0",
        "protocol": metadata["protocol"],
        "outcome_visibility": "strictly_prior_forecast_dates_only",
        "history_sha256": history_hash,
        "source_pair_date_sha256": source_hash,
        "fields": FIELDS,
        "config": {
            key: metadata["config"][key]
            for key in [
                "min_history_targets",
                "min_history_dates",
                "min_test_targets",
                "dependence_support_scale",
                "quality_gap_scale",
                "high_loss_threshold",
                "cptec_weight",
                "piecewise_threshold",
            ]
        },
        "audit": {
            "records": len(records),
            "unique_pairs": len({(row[2], row[3]) for row in records}),
            "date_min": min(row[0] for row in records),
            "date_max": max(row[0] for row in records),
            "all_history_dates_strictly_prior": True,
        },
        "records": records,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, separators=(",", ":"), allow_nan=False) + "\n")
    print(json.dumps(payload["audit"], indent=2))


if __name__ == "__main__":
    main()
