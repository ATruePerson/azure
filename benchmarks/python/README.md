# ACC Python evaluation tools

`acc_eval` is the Python side of ACC's benchmark workflow. It analyzes the
`results.json` emitted by the Go model-routing runner and produces percentile
latency, category accuracy, failure-class, tool-schema, and repair metrics.

It uses only the Python standard library:

```bash
PYTHONPATH=benchmarks/python python3 -m acc_eval analyze \
  --input benchmarks/model-routing/results.json \
  --output-dir benchmarks/model-routing
```

The outputs are `python-results.json` and `python-report.md`. The Go runner
continues to own request execution because it shares ACC's production protocol
types and is the lowest-risk place to test the live gateway boundary.
