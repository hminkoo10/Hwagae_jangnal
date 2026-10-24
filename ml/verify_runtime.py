"""Verify the Python 3.14 API -> Python 3.11 CPU model process boundary."""

from __future__ import annotations

import argparse
from copy import deepcopy
import json
import os
from pathlib import Path
import platform
import sys
import time

from ml.smoke_test import ATOL, RTOL, compare, validate_points


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-python", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    if sys.version_info[:2] != (3, 14):
        raise RuntimeError("Run API boundary verification with Python 3.14.")
    os.environ["TFT_PYTHON"] = str(args.model_python.resolve(strict=True))
    examples = Path(__file__).parent / "examples"
    context = json.loads((examples / "input.json").read_text(encoding="utf-8"))
    original = deepcopy(context)
    expected = json.loads((examples / "expected-quantiles.json").read_text(encoding="utf-8"))
    for product in expected["products"]:
        product["points"] = [{key: point[key] for key in ("date", "p10", "p50", "p90")}
                             for point in product["points"]]
    from ml import bridge

    start = time.perf_counter()
    worker = bridge.warmup()
    warm = time.perf_counter()
    if not str(worker["python"]).startswith("3.11.") or worker["device"] != "cpu":
        raise AssertionError("Model worker must report Python 3.11 and CPU execution.")
    if Path(worker["executable"]).resolve() != args.model_python.resolve():
        raise AssertionError("Model worker did not use the requested Python executable.")
    manifest = json.loads((Path(__file__).parent / "metadata" / "manifest.json").read_text(encoding="utf-8"))
    if worker["checkpoint_sha256"] != manifest["checkpoint_sha256"]:
        raise AssertionError("Model worker checkpoint hash differs from the handoff.")
    actual = bridge.predict(context)
    completed = time.perf_counter()
    compare(actual, expected)
    validate_points(actual, context["dates"], ["p10", "p50", "p90"])
    if context != original:
        raise AssertionError("API bridge mutated the input request.")
    insufficient = json.loads((examples / "insufficient-history.json").read_text(encoding="utf-8"))
    insufficient_expected = json.loads((examples / "expected-insufficient-history.json").read_text(encoding="utf-8"))
    compare(bridge.predict(insufficient), insufficient_expected)
    report = {
        "status": "passed", "api_python": platform.python_version(),
        "api_executable": sys.executable, "api_platform": platform.platform(),
        "api_machine": platform.machine(), "worker": worker,
        "products": len(context["products"]), "days": 7, "api_quantiles": 3,
        "atol": ATOL, "rtol": RTOL, "insufficient_history": "passed",
        "worker_warmup_seconds": round(warm - start, 4),
        "bridge_predict_seconds": round(completed - warm, 4),
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
