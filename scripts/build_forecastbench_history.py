#!/usr/bin/env python3
"""Build a compact multi-provider ForecastBench aggregation panel.

Question text comes from the official ForecastBench question sets. Forecasts
come from the full resolved marginal-prediction panel (3.8M+ rows), which safely
expands ForecastBench's joint questions back to their component events. Prompt/configuration variants
of the same provider model are collapsed to one base-forecaster probability per
target. Composite information-structure questions are excluded from this public
binary-event leaderboard; they can be added later as a separate research track.
"""

from __future__ import annotations

import csv
import json
import re
from collections import defaultdict
from pathlib import Path


ROOT = Path("/Users/pcc/Desktop/forecast dependence/forecastbench_downloads_2026-04-15")
FORECAST_SOURCE = ROOT / "output/resolved_only_dataset/period_type_predictions_long.csv"
QUESTION_ROOT = Path("/Users/pcc/Desktop/forecast dependence/forecastbench_downloads_2026-06-25/repo/forecastbench-datasets/datasets/question_sets")
OUTPUT = Path(__file__).resolve().parents[1] / "public/forecastbench/history.json"

ALLOWED_PROVIDERS = {
    "Anthropic", "OpenAI", "Google", "Meta", "DeepSeek", "Mistral",
    "Mistral AI", "Qwen", "Moonshot", "xAI", "Z.ai", "Minimax",
}
MIN_MODEL_EVENTS = 250

def slug(value: str) -> str:
    return re.sub(r"-+", "-", "".join(ch.lower() if ch.isalnum() else "-" for ch in value)).strip("-")


def base_model(organization: str, display_model: str) -> tuple[str, str]:
    organization = "Mistral" if organization == "Mistral AI" else organization
    # ForecastBench suffixes describe prompting and imputation, not model identity.
    model = re.sub(r"\s*\([^)]*\)\s*$", "", display_model).strip()
    return organization, model


def category_for(source: str, question: str) -> str:
    text = question.lower()
    if source in {"yfinance", "fred", "dbnomics"} or any(word in text for word in ("stock price", "inflation", "gdp", "interest rate", "unemployment", "recession")):
        return "Economics & Finance"
    if source == "acled" or any(word in text for word in ("war", "ceasefire", "military", "conflict", "sanction", "invasion")):
        return "Conflict & Geopolitics"
    if any(word in text for word in ("election", "president", "parliament", "prime minister", "government", "congress")):
        return "Politics & Geopolitics"
    if any(word in text for word in ("temperature", "rainfall", "hurricane", "climate", "weather", "wildfire")):
        return "Climate & Weather"
    if any(word in text for word in ("championship", "tournament", "league", "world cup", "nba", "nfl", "mlb", "goal", "match")):
        return "Sports"
    if any(word in text for word in ("ai model", "artificial intelligence", "spacex", "launch", "technology", "openai")):
        return "AI & Technology"
    if any(word in text for word in ("disease", "vaccine", "health", "virus", "cancer", "fda", "clinical trial")):
        return "Health & Science"
    if any(word in text for word in ("film", "movie", "album", "award", "oscar", "grammy", "celebrity")):
        return "Entertainment & Culture"
    return "Other"


def load_questions() -> dict[tuple[str, str], str]:
    lookup: dict[tuple[str, str], str] = {}
    for path in sorted(QUESTION_ROOT.glob("*-llm.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        for question in payload["questions"]:
            if isinstance(question.get("id"), list):
                for component in question.get("combination_of") or []:
                    lookup[(payload["forecast_due_date"], str(component.get("id")))] = str(component.get("question") or "").strip()
            else:
                lookup[(payload["forecast_due_date"], str(question.get("id")))] = str(question.get("question") or "").strip()
    return lookup


def provider_for(model: str) -> str | None:
    lowered = model.lower()
    rules = [
        ("Anthropic", ("claude",)), ("OpenAI", ("gpt", "o1", "o3", "o4")),
        ("Google", ("gemini",)), ("Meta", ("llama", "meta-llama")),
        ("DeepSeek", ("deepseek",)), ("Mistral", ("mistral", "mixtral", "magistral")),
        ("Qwen", ("qwen", "qwq")), ("Moonshot", ("kimi",)),
        ("xAI", ("grok",)), ("Z.ai", ("glm",)), ("Minimax", ("minimax",)),
    ]
    return next((provider for provider, prefixes in rules if lowered.startswith(prefixes)), None)


def main() -> None:
    question_lookup = load_questions()
    targets: dict[str, dict] = {}
    values: dict[tuple[str, str], list[float | int]] = defaultdict(lambda: [0.0, 0])
    model_info: dict[str, dict] = {}
    raw_rows = matched_rows = 0

    with FORECAST_SOURCE.open("r", newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            raw_rows += 1
            if row["event_id"].lstrip().startswith("["):
                continue
            display_model = row["model_name"].strip()
            organization = provider_for(display_model)
            if not organization:
                continue
            forecast = row["forecast_prob"].strip()
            if not forecast:
                continue
            organization, model_name = base_model(organization, display_model)
            model_id = slug(f"{organization}-{model_name}")
            target_id = f"{row['date']}|{row['event_id']}"
            question_text = question_lookup.get((row["date"], row["event_id"]), f"ForecastBench event {row['event_id']}")
            question_text = question_text.replace("{forecast_due_date}", row["date"]).replace("{resolution_date}", "the resolution date")
            category = {
                "金融": "Economics & Finance", "冲突与地缘政治": "Conflict & Geopolitics",
                "政治与地缘政治": "Politics & Geopolitics", "天气与气候": "Climate & Weather",
                "医疗与生物": "Health & Biology", "医疗与科学": "Health & Science",
                "体育": "Sports", "AI与科技": "AI & Technology", "娱乐与文化": "Entertainment & Culture",
                "其他": "Other",
            }.get(row["event_type_main"], row["event_type_main"] or "Other")
            targets.setdefault(target_id, {
                "id": target_id, "date": row["date"], "source": "ForecastBench",
                "category": category, "question": question_text,
                "outcome": int(float(row["outcome"])), "forecasts": {},
            })
            accumulator = values[(target_id, model_id)]
            accumulator[0] += float(forecast)
            accumulator[1] += 1
            model_info.setdefault(model_id, {"id": model_id, "name": model_name, "organization": organization, "n": 0, "variants": set()})
            model_info[model_id]["variants"].add(display_model)
            matched_rows += 1

    coverage: dict[str, int] = defaultdict(int)
    for _, model_id in values:
        coverage[model_id] += 1
    keep = {model_id for model_id, count in coverage.items() if count >= MIN_MODEL_EVENTS}

    for (target_id, model_id), (total, count) in values.items():
        if model_id not in keep:
            continue
        targets[target_id]["forecasts"][model_id] = round(float(total) / int(count), 6)
        model_info[model_id]["n"] += 1

    events = sorted((event for event in targets.values() if event["forecasts"]), key=lambda event: (event["date"], event["id"]))
    model_rows = []
    for model_id in keep:
        info = model_info[model_id]
        model_rows.append({"id": model_id, "name": info["name"], "organization": info["organization"], "n": info["n"], "variants": len(info["variants"])})
    model_rows.sort(key=lambda model: (-model["n"], model["organization"], model["name"]))
    dates = sorted({event["date"] for event in events})
    providers = sorted({model["organization"] for model in model_rows})
    payload = {
        "meta": {
            "dataset": "ForecastBench full raw resolved multi-provider panel", "generated": "2026-08-08",
            "questionSource": "ForecastBench datasets/question_sets", "forecastSource": "resolved_only_dataset/period_type_predictions_long.csv", "license": "CC BY-SA 4.0",
            "rawSourceRows": raw_rows, "matchedForecastRows": matched_rows,
            "events": len(events), "models": len(model_rows), "providers": len(providers), "providerNames": providers,
            "rounds": len(dates), "firstRound": dates[0], "lastRound": dates[-1],
            "rule": "Available-case aggregation; prompt variants averaged within each provider base model.",
        },
        "models": model_rows,
        "events": events,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps(payload["meta"], indent=2))
    print("Top models:")
    for model in model_rows[:20]:
        print(f"  {model['organization']}: {model['name']} ({model['n']:,} events)")
    print(f"Wrote {OUTPUT} ({OUTPUT.stat().st_size / 1024 / 1024:.2f} MiB)")


if __name__ == "__main__":
    main()
