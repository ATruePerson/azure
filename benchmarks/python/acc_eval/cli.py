from __future__ import annotations

import argparse
from pathlib import Path

from .report import analyze


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="acc-eval", description="Analyze ACC model-routing results")
    subcommands = parser.add_subparsers(dest="command", required=True)
    analyze_parser = subcommands.add_parser("analyze", help="generate Python JSON and Markdown analysis")
    analyze_parser.add_argument("--input", type=Path, required=True, help="Go runner results.json")
    analyze_parser.add_argument("--output-dir", type=Path, required=True, help="directory for analysis outputs")
    args = parser.parse_args(argv)

    if args.command == "analyze":
        json_path, markdown_path = analyze(args.input, args.output_dir)
        print(f"JSON analysis: {json_path}")
        print(f"Markdown report: {markdown_path}")
        return 0
    return 2
