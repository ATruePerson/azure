.PHONY: build web-build web-check claude-python-check bench-python-check bench-report run tui test cover fmt vet lint clean

# Build the acc binary into the current directory.
build:
	go build -o acc .

web-build:
	npm run build:web

web-check:
	npm run check:web

claude-python-check:
	PYTHONDONTWRITEBYTECODE=1 python3 -m unittest claude/test_proxy.py

bench-python-check:
	PYTHONPATH=benchmarks/python python3 -m unittest discover -s benchmarks/python/tests

bench-report:
	PYTHONPATH=benchmarks/python python3 -m acc_eval analyze --input benchmarks/model-routing/results.json --output-dir benchmarks/model-routing

# Run the proxy against the default split config.
run:
	go run .

# Run with the interactive terminal dashboard.
tui:
	go run . -tui

# Run the test suite with the race detector.
test: claude-python-check
	go test -race ./...

# Test suite with coverage summary.
cover:
	go test -race -cover ./...

# Format all Go sources.
fmt:
	gofmt -w .

# Static analysis.
vet:
	go vet ./...

# Full pre-commit gate: format check, vet, build, test.
lint: vet
	@unformatted=$$(gofmt -l .); \
	if [ -n "$$unformatted" ]; then \
		echo "Needs gofmt:"; echo "$$unformatted"; exit 1; \
	fi
	go build ./...
	PYTHONDONTWRITEBYTECODE=1 python3 -m unittest claude/test_proxy.py
	go test -race ./...
	npm run check:web

clean:
	rm -f acc
