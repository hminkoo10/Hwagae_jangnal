"""Plot only the completed six-run summary, without reading raw experiments.

Run from the repository root in the separate document/plotting environment::

    python -m ml.plot_multiseed

Requires matplotlib (prepared document environment: 3.11.2). Do not install it
into the fixed CPU inference or GPU training environment. The four final CSVs
and manifest must already exist under --input-dir; no partial plot is produced.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path

from ml.evaluate import ROOT, digest
from ml.reproduce_multiseed import compare_table
from ml.run_multiseed import MEASURES, SEEDS, SUBSETS, VARIANTS, paired_tables


COUNTS = {"full_original_test": 7973, "strict_56_observed_history": 1701}


def read_table(path):
    with path.open(encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


def load_completed(directory):
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    if (manifest.get("status") != "three_pairs_completed_and_aligned"
            or manifest.get("seeds") != SEEDS or manifest.get("n_seed_pairs") != 3
            or manifest.get("full_rows") != 7973 or manifest.get("strict_rows") != 1701):
        raise ValueError("A completed, aligned three-pair manifest with 7973/1701 rows is required")
    artifacts = manifest.get("artifacts", [])
    expected_runs = {(seed, variant) for seed in SEEDS for variant in VARIANTS}
    if len(artifacts) != 6 or {(item["seed"], item["variant"]) for item in artifacts} != expected_runs:
        raise ValueError("Completion evidence for all six distinct model fits is required")
    for artifact in artifacts:
        completed = artifact["completion"]
        if (completed.get("status") != "trained_and_evaluated"
                or completed.get("matched_reference_rows") is not True
                or completed.get("test_used_for_training") is not False):
            raise ValueError("An incomplete or unaligned experiment cannot be plotted")

    rows = read_table(directory / "metrics.csv")
    baselines = read_table(directory / "api-baseline.csv")
    for table, identity_columns in ((rows, {"seed", "variant", "subset"}),
                                    (baselines, {"subset", "model"})):
        for row in table:
            if set(row) != identity_columns | {"n", "windows"} | set(MEASURES):
                raise ValueError("Unexpected metric table columns")
            for column in {"n", "windows", "seed"} & set(row):
                row[column] = int(row[column])
            if row["subset"] not in COUNTS or row["n"] != COUNTS[row["subset"]] or row["windows"] * 7 != row["n"]:
                raise ValueError("Metric row counts do not match the completed evaluation subsets")
            for column in MEASURES:
                row[column] = float(row[column])
                if not math.isfinite(row[column]) or row[column] < 0:
                    raise ValueError("Metrics must be finite and nonnegative")
            if row["interval_coverage"] > 1:
                raise ValueError("Interval coverage must be a fraction between zero and one")
    if len(baselines) != 2 or {(row["subset"], row["model"]) for row in baselines} != {
            (subset, "current_API_weekday_baseline") for subset in SUBSETS}:
        raise ValueError("Both matched API baseline rows are required")
    paired, summary = paired_tables(rows)  # requires every seed/variant/subset
    compare_table("paired-differences.csv", paired, read_table(directory / "paired-differences.csv"))
    compare_table("summary.csv", summary, read_table(directory / "summary.csv"))
    evidence = {name: digest(directory / name) for name in (
        "manifest.json", "metrics.csv", "api-baseline.csv", "paired-differences.csv", "summary.csv")}
    return rows, baselines, evidence


def plot(directory, output_dir):
    rows, baselines, evidence = load_completed(directory)
    # Import only after checking completion. No model packages are imported.
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.lines import Line2D

    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10,
                         "svg.hashsalt": "tft-paired-multiseed-v1"})
    points = {(row["subset"], row["seed"], row["variant"]): row["MAE"] for row in rows}
    baseline_values = {row["subset"]: row["MAE"] for row in baselines}
    all_values = list(points.values()) + list(baseline_values.values())
    padding = max((max(all_values) - min(all_values)) * .20, .05)
    limits = (max(0, min(all_values) - padding), max(all_values) + padding)
    colors = {"weather": "#2563eb", "no-weather": "#d97706"}
    markers = {"weather": "o", "no-weather": "D"}
    titles = {"full_original_test": "Full original test | 7,973 matched rows",
              "strict_56_observed_history": "Strict 56-day observed history | 1,701 matched rows"}
    figure, axes = plt.subplots(1, 2, figsize=(11.4, 5.4), sharey=True)
    figure.subplots_adjust(left=.08, right=.98, bottom=.22, top=.71, wspace=.15)
    for axis, subset in zip(axes, SUBSETS, strict=True):
        axis.axhline(baseline_values[subset], color="#475569", linestyle="--", linewidth=1.6, zorder=1)
        for index, seed in enumerate(SEEDS):
            values = [points[(subset, seed, variant)] for variant in VARIANTS]
            x = [index - .09, index + .09]
            axis.plot(x, values, color="#94a3b8", linewidth=1.5, zorder=2)
            for position, variant, value in zip(x, VARIANTS, values, strict=True):
                axis.scatter(position, value, color=colors[variant], marker=markers[variant], s=54,
                             edgecolors="white", linewidths=.7, zorder=3)
                offset, align = ((-6, 8), "right") if variant == "weather" else ((6, -15), "left")
                axis.annotate(f"{value:.3f}", (position, value), xytext=offset, textcoords="offset points",
                              ha=align, fontsize=9, color=colors[variant])
        axis.set_title(titles[subset] + f"\nAPI weekday baseline MAE: {baseline_values[subset]:.3f}",
                       loc="left", fontsize=10.5, fontweight="bold", pad=12)
        axis.set_xticks(range(3), [f"Seed {seed}" for seed in SEEDS])
        axis.set_xlim(-.55, 2.6)
        axis.set_ylim(*limits)
        axis.grid(axis="y", alpha=.2)
        axis.spines[["top", "right"]].set_visible(False)
    axes[0].set_ylabel("MAE (units sold per day) | lower is better")
    legend = [Line2D([], [], color=colors[variant], marker=markers[variant], linestyle="None", markersize=7,
                     label="Weather TFT" if variant == "weather" else "No-weather TFT") for variant in VARIANTS]
    legend.append(Line2D([], [], color="#475569", linestyle="--", label="API weekday baseline (84-day history)"))
    figure.suptitle("Weather vs no-weather: three paired training seeds", fontsize=16, fontweight="bold", y=.97)
    figure.legend(handles=legend, loc="upper center", bbox_to_anchor=(.5, .9), ncol=3, frameon=False, fontsize=10)
    axis_note = "Same zoomed y-axis in both panels; it does not start at zero." if limits[0] > 0 else "Same y-axis in both panels; zero is included."
    figure.text(.5, .11, axis_note + "\nPoints are individual runs; means and sample SD across 3 seeds: summary.csv.",
                ha="center", va="center", fontsize=10, color="#334155")
    figure.text(.5, .035, "Historical-weather persistence; input dimensions differ. Three seeds do not establish a causal weather effect.",
                ha="center", fontsize=9, color="#475569")
    provenance = json.dumps({"input_sha256": evidence, "script_sha256": digest(Path(__file__)),
                             "matplotlib": matplotlib.__version__, "y_limits": limits}, sort_keys=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    figure.savefig(output_dir / "multiseed.png", dpi=180,
                   metadata={"Software": "ml.plot_multiseed", "Description": provenance})
    figure.savefig(output_dir / "multiseed.svg",
                   metadata={"Date": None, "Creator": "ml.plot_multiseed", "Description": provenance})
    plt.close(figure)
    return {"status": "plotted_completed_three_pairs", "output": str(output_dir), "input_sha256": evidence}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input-dir", type=Path, default=ROOT / "ml/ablation/multiseed")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "ml/presentation/figures")
    args = parser.parse_args()
    try:
        result = plot(args.input_dir, args.output_dir)
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, f"Cannot plot incomplete or inconsistent results: {error}\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
