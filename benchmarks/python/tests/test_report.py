import json
import tempfile
import unittest
from pathlib import Path

from acc_eval.report import analyze, build_report, summarize
from acc_eval.models import RunRecord


class ReportTests(unittest.TestCase):
    def test_summary_calculates_rates_and_percentiles(self):
        runs = [
            RunRecord(model="fake/model", provider="fake", category="reliability", http_status=200, correct=True, latency_ms=10),
            RunRecord(model="fake/model", provider="fake", category="reliability", http_status=200, correct=False, error_class="incorrect", latency_ms=30),
            RunRecord(model="fake/model", provider="fake", category="tools", http_status=500, correct=False, error_class="provider", latency_ms=50),
        ]
        summary = summarize(runs)[0]
        self.assertEqual(summary.runs, 3)
        self.assertEqual(summary.provider_success_rate, 66.67)
        self.assertEqual(summary.correct_rate, 33.33)
        self.assertEqual(summary.p50_latency_ms, 30)
        self.assertEqual(summary.p95_latency_ms, 48)
        self.assertEqual(summary.failures, {"incorrect": 1, "provider": 1})

    def test_analyze_writes_outputs_without_mutating_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "results.json"
            input_document = {"profile": "test", "runs": [{"model": "fake/model", "http_status": 200, "correct": True, "latency_ms": 12}]}
            input_path.write_text(json.dumps(input_document), encoding="utf-8")
            json_path, markdown_path = analyze(input_path, root / "out")
            self.assertIn("analysis_engine", json.loads(json_path.read_text(encoding="utf-8")))
            self.assertIn("P50", markdown_path.read_text(encoding="utf-8"))
            self.assertEqual(json.loads(input_path.read_text(encoding="utf-8")), input_document)

    def test_report_marks_clean_run(self):
        document = {"profile": "test"}
        summary = summarize([RunRecord(model="fake/model", http_status=200, correct=True)])[0]
        self.assertIn("No incorrect runs recorded.", build_report(document, [summary]))


if __name__ == "__main__":
    unittest.main()
