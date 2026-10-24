"""Reproduce all ten committed 7 x 5 CPU references; never writes goldens."""

from __future__ import annotations

import argparse
from copy import deepcopy
import json
import math
import os
from pathlib import Path
import platform
import time


ATOL = 1e-4
RTOL = 1e-5
EXAMPLES = Path(__file__).parent / "examples"


def compare(actual, expected, path="result"):
    if isinstance(expected, dict):
        if not isinstance(actual, dict) or actual.keys() != expected.keys():
            raise AssertionError(f"{path}: dictionary keys differ")
        for key in expected:
            compare(actual[key], expected[key], f"{path}.{key}")
    elif isinstance(expected, list):
        if not isinstance(actual, list) or len(actual) != len(expected):
            raise AssertionError(f"{path}: array lengths differ")
        for i, (got, want) in enumerate(zip(actual, expected, strict=True)):
            compare(got, want, f"{path}[{i}]")
    elif isinstance(expected, float):
        if not math.isfinite(actual) or not math.isclose(actual, expected, rel_tol=RTOL, abs_tol=ATOL):
            raise AssertionError(f"{path}: expected {expected}, got {actual}")
    elif actual != expected:
        raise AssertionError(f"{path}: expected {expected!r}, got {actual!r}")


def validate_points(result, dates, keys):
    for product in result["products"]:
        if product["status"] == "insufficient_history":
            assert not product["points"] and product["reason"]
            continue
        assert product["status"] == "ready"
        assert [point["date"] for point in product["points"]] == dates
        for point in product["points"]:
            assert set(point) == {"date", *keys}
            values = [point[key] for key in keys]
            assert all(math.isfinite(value) and value >= 0 for value in values)
            assert values == sorted(values)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, help="or set TFT_CHECKPOINT_PATH")
    parser.add_argument("--input", type=Path, help="override the default three-store / ten-product manifest")
    parser.add_argument("--expected", type=Path, help="five-quantile reference for --input")
    parser.add_argument("--report", type=Path, help="optional timing/report JSON destination")
    args = parser.parse_args()
    if args.checkpoint:
        os.environ["TFT_CHECKPOINT_PATH"] = str(args.checkpoint.resolve(strict=True))
    if args.expected and not args.input:
        parser.error("--expected requires --input")
    if args.input:
        sources = [(args.input, args.expected or EXAMPLES / "expected-quantiles.json", None)]
    else:
        manifest = json.loads((EXAMPLES / "demo-manifest.json").read_text(encoding="utf-8"))
        sources = [(EXAMPLES / entry["input"], EXAMPLES / entry["expected_quantiles"], EXAMPLES / entry["expected_api"])
                   for entry in manifest["samples"]]
    samples = [(json.loads(path.read_text(encoding="utf-8")),
                json.loads(reference.read_text(encoding="utf-8")),
                json.loads(api_reference.read_text(encoding="utf-8")) if api_reference else None)
               for path, reference, api_reference in sources]
    originals = deepcopy(samples)
    start = time.perf_counter()
    from ml.predict import predict, predict_quantiles
    import torch
    imported = time.perf_counter()
    actuals = [predict_quantiles(context) for context, _, _ in samples]
    cold_done = time.perf_counter()
    for (context, expected, _), actual in zip(samples, actuals, strict=True):
        compare(actual, expected, context["store_id"])
        validate_points(actual, context["dates"], ["p10", "p25", "p50", "p75", "p90"])
    responses = [predict(context) for context, _, _ in samples]
    warm_done = time.perf_counter()
    for (context, expected, expected_api), response in zip(samples, responses, strict=True):
        validate_points(response, context["dates"], ["p10", "p50", "p90"])
        projected = deepcopy(expected)
        for product in projected["products"]:
            product["points"] = [{key: point[key] for key in ("date", "p10", "p50", "p90")}
                                 for point in product["points"]]
        compare(response, projected, context["store_id"])
        if expected_api is not None:
            compare(response, expected_api, context["store_id"] + ".api")
    if samples != originals:
        raise AssertionError("predict mutated the request")
    insufficient = json.loads((EXAMPLES / "insufficient-history.json").read_text(encoding="utf-8"))
    insufficient_expected = json.loads((EXAMPLES / "expected-insufficient-history.json").read_text(encoding="utf-8"))
    insufficient_actual = predict(insufficient)
    compare(insufficient_actual, insufficient_expected)
    validate_points(insufficient_actual, insufficient["dates"], ["p10", "p50", "p90"])
    report = {
        "status": "passed", "python": platform.python_version(),
        "platform": platform.platform(), "torch": torch.__version__,
        "cuda_available": torch.cuda.is_available(), "cpu_threads": torch.get_num_threads(),
        "products": sum(len(context["products"]) for context, _, _ in samples),
        "sample_requests": len(samples), "days": 7, "quantiles": 5,
        "samples": [{"store_id": context["store_id"], "as_of": context["as_of"], "products": len(context["products"])}
                    for context, _, _ in samples],
        "insufficient_history_case": "passed",
        "atol": ATOL, "rtol": RTOL,
        "import_seconds": round(imported - start, 4),
        "cold_load_and_predict_seconds": round(cold_done - imported, 4),
        "warm_predict_seconds": round(warm_done - cold_done, 4),
    }
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
