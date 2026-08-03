from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class RunRecord:
    model: str
    provider: str = ""
    category: str = ""
    http_status: int = 0
    status: str = ""
    correct: bool = False
    error_class: str = ""
    error: str = ""
    latency_ms: int = 0
    ttft_ms: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    invalid_tool_args: int = 0
    repair_attempts: int = 0

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "RunRecord":
        model = str(raw.get("model", "")).strip()
        if not model:
            raise ValueError("run is missing model")
        return cls(
            model=model,
            provider=str(raw.get("provider", "")),
            category=str(raw.get("category", "")),
            http_status=_int(raw.get("http_status")),
            status=str(raw.get("status", "")),
            correct=bool(raw.get("correct", False)),
            error_class=str(raw.get("error_class", "")),
            error=str(raw.get("error", "")),
            latency_ms=_int(raw.get("latency_ms")),
            ttft_ms=_int(raw.get("ttft_ms")),
            input_tokens=_int(raw.get("input_tokens")),
            output_tokens=_int(raw.get("output_tokens")),
            invalid_tool_args=_int(raw.get("invalid_tool_args")),
            repair_attempts=_int(raw.get("repair_attempts")),
        )


@dataclass
class ModelSummary:
    model: str
    provider: str
    runs: int
    provider_success_rate: float
    correct_rate: float
    tool_success_rate: float
    tool_schema_error_rate: float
    repair_success_rate: float
    average_latency_ms: int
    p50_latency_ms: int
    p95_latency_ms: int
    average_ttft_ms: int
    categories: dict[str, float] = field(default_factory=dict)
    failures: dict[str, int] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "model": self.model,
            "provider": self.provider,
            "runs": self.runs,
            "provider_success_rate": self.provider_success_rate,
            "correct_rate": self.correct_rate,
            "tool_success_rate": self.tool_success_rate,
            "tool_schema_error_rate": self.tool_schema_error_rate,
            "repair_success_rate": self.repair_success_rate,
            "average_latency_ms": self.average_latency_ms,
            "p50_latency_ms": self.p50_latency_ms,
            "p95_latency_ms": self.p95_latency_ms,
            "average_ttft_ms": self.average_ttft_ms,
            "categories": self.categories,
            "failures": self.failures,
        }


def _int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"expected integer, got {value!r}") from exc
