from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

from .models import ModelSummary, RunRecord

TOOL_CATEGORIES = {"tools", "custom_tools", "coding"}


def load_runs(path: Path) -> tuple[dict[str, Any], list[RunRecord]]:
    document = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        raise ValueError("benchmark document must be a JSON object")
    raw_runs = document.get("runs")
    if not isinstance(raw_runs, list):
        raise ValueError("benchmark document must contain a runs array")
    return document, [RunRecord.from_dict(raw) for raw in raw_runs]


def summarize(runs: Iterable[RunRecord]) -> list[ModelSummary]:
    grouped: dict[str, list[RunRecord]] = defaultdict(list)
    for run in runs:
        grouped[run.model].append(run)

    summaries: list[ModelSummary] = []
    for model, model_runs in sorted(grouped.items()):
        latencies = [run.latency_ms for run in model_runs if run.latency_ms > 0]
        ttfts = [run.ttft_ms for run in model_runs if run.ttft_ms > 0]
        tool_runs = [run for run in model_runs if run.category in TOOL_CATEGORIES]
        repairs = sum(run.repair_attempts for run in tool_runs)
        repaired_successfully = sum(run.repair_attempts for run in tool_runs if run.correct)
        categories: dict[str, float] = {}
        by_category: dict[str, list[RunRecord]] = defaultdict(list)
        for run in model_runs:
            by_category[run.category].append(run)
        for category, category_runs in sorted(by_category.items()):
            categories[category] = _rate(sum(run.correct for run in category_runs), len(category_runs))

        failures = Counter(run.error_class or "incorrect" for run in model_runs if not run.correct)
        summaries.append(ModelSummary(
            model=model,
            provider=model_runs[0].provider,
            runs=len(model_runs),
            provider_success_rate=_rate(sum(200 <= run.http_status < 300 for run in model_runs), len(model_runs)),
            correct_rate=_rate(sum(run.correct for run in model_runs), len(model_runs)),
            tool_success_rate=_rate(sum(run.correct for run in tool_runs), len(tool_runs)),
            tool_schema_error_rate=_rate(sum(run.invalid_tool_args for run in tool_runs), max(1, len(tool_runs))),
            repair_success_rate=_rate(repaired_successfully, repairs),
            average_latency_ms=_average(latencies),
            p50_latency_ms=_percentile(latencies, 0.50),
            p95_latency_ms=_percentile(latencies, 0.95),
            average_ttft_ms=_average(ttfts),
            categories=categories,
            failures=dict(sorted(failures.items())),
        ))
    return summaries


def build_report(document: dict[str, Any], summaries: list[ModelSummary]) -> str:
    lines = [
        "# ACC model-routing analysis",
        "",
        f"Generated from profile: `{document.get('profile', 'unknown')}`  ",
        "Analysis engine: `acc-eval` (Python)  ",
        "",
        "| Model | Runs | Provider success | Correct | Tool success | Avg latency | P50 | P95 | Avg TTFT |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for summary in summaries:
        lines.append(
            f"| {summary.model} | {summary.runs} | {summary.provider_success_rate:.1f}% | "
            f"{summary.correct_rate:.1f}% | {summary.tool_success_rate:.1f}% | "
            f"{summary.average_latency_ms} ms | {summary.p50_latency_ms} ms | "
            f"{summary.p95_latency_ms} ms | {summary.average_ttft_ms} ms |"
        )
    lines.extend(["", "## Failure classes", ""])
    any_failures = False
    for summary in summaries:
        for failure, count in summary.failures.items():
            any_failures = True
            lines.append(f"- `{summary.model}`: `{failure}` ({count})")
    if not any_failures:
        lines.append("No incorrect runs recorded.")
    return "\n".join(lines) + "\n"


def analyze(input_path: Path, output_dir: Path) -> tuple[Path, Path]:
    document, runs = load_runs(input_path)
    summaries = summarize(runs)
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / "python-results.json"
    markdown_path = output_dir / "python-report.md"
    enriched = dict(document)
    enriched["analysis_engine"] = "acc-eval"
    enriched["analysis"] = [summary.as_dict() for summary in summaries]
    json_path.write_text(json.dumps(enriched, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    markdown_path.write_text(build_report(document, summaries), encoding="utf-8")
    return json_path, markdown_path


def _rate(numerator: int, denominator: int) -> float:
    return round(numerator * 100 / denominator, 2) if denominator else 0.0


def _average(values: list[int]) -> int:
    return round(sum(values) / len(values)) if values else 0


def _percentile(values: list[int], quantile: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    position = (len(ordered) - 1) * quantile
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    fraction = position - lower
    return round(ordered[lower] + (ordered[upper] - ordered[lower]) * fraction)
