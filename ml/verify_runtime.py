"""Measure reproducible multi-store inference in a Python 3.11 CPU process."""

from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import platform
import sys
import statistics
import time

from ml.smoke_test import ATOL, RTOL, compare, validate_points


def peak_rss():
    """Process high-water resident memory, including imports and model loading."""
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        class MemoryCounters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                        *[(name, ctypes.c_size_t) for name in (
                            "PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage",
                            "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage",
                            "PagefileUsage", "PeakPagefileUsage")]]

        counters = MemoryCounters()
        counters.cb = ctypes.sizeof(counters)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        api = ctypes.WinDLL("psapi", use_last_error=True)
        api.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(MemoryCounters), wintypes.DWORD]
        api.GetProcessMemoryInfo.restype = wintypes.BOOL
        if not api.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
            raise ctypes.WinError(ctypes.get_last_error())
        return counters.PeakWorkingSetSize, "Windows GetProcessMemoryInfo.PeakWorkingSetSize"
    import resource
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(peak if sys.platform == "darwin" else peak * 1024), "getrusage(RUSAGE_SELF).ru_maxrss"


def benchmark(input_path, expected_path, repeats):
    if sys.version_info[:2] != (3, 11):
        raise RuntimeError("Run direct model benchmarks with the Python 3.11 model environment.")
    workload = json.loads(input_path.read_text(encoding="utf-8"))
    contexts = workload["contexts"]
    expected = json.loads(expected_path.read_text(encoding="utf-8"))["results"]
    if not contexts or len(contexts) != len(expected):
        raise ValueError("Benchmark needs aligned, nonempty contexts and expected results.")
    original = deepcopy(contexts)
    start = time.perf_counter()
    from ml.predict import _runtime, predict
    import torch
    imported = time.perf_counter()
    results = [predict(context) for context in contexts]
    cold_done = time.perf_counter()
    cold_peak, memory_source = peak_rss()
    runtime = _runtime()
    if str(runtime.model.device) != "cpu":
        raise AssertionError("Benchmark model must execute on CPU.")
    metadata = Path(os.environ.get("TFT_METADATA_DIR", Path(__file__).parent / "metadata"))
    manifest = json.loads((metadata / "manifest.json").read_text(encoding="utf-8"))
    compare(results, expected)
    for context, result in zip(contexts, results, strict=True):
        if [product["product_id"] for product in result["products"]] != [product["id"] for product in context["products"]]:
            raise AssertionError("Benchmark product set/order differs from its request.")
        if any(product["status"] != "ready" for product in result["products"]):
            raise AssertionError("Benchmark must contain only supported products with complete history.")
        validate_points(result, context["dates"], ["p10", "p50", "p90"])
    elapsed = []
    for _ in range(repeats):
        before = time.perf_counter()
        results = [predict(context) for context in contexts]
        elapsed.append(time.perf_counter() - before)
        compare(results, expected)
    final_peak, _ = peak_rss()
    if contexts != original:
        raise AssertionError("Benchmark mutated a request.")
    return {
        "status": "passed", "kind": "sequential_multi_store_workload",
        "python": platform.python_version(), "platform": platform.platform(),
        "machine": platform.machine(), "torch": torch.__version__,
        "device": str(runtime.model.device), "model_version": runtime.version,
        "checkpoint_sha256": manifest["checkpoint_sha256"],
        "cpu_threads": torch.get_num_threads(), "cuda_available": torch.cuda.is_available(),
        "contexts": len(contexts), "products": sum(len(context["products"]) for context in contexts),
        "distinct_series": len({(context["model_input"]["store_nbr"], product["model_item_nbr"])
                                for context in contexts for product in context["products"]}),
        "distinct_skus": len({product["model_item_nbr"] for context in contexts for product in context["products"]}),
        "input_sha256": hashlib.sha256(input_path.read_bytes()).hexdigest(),
        "expected_sha256": hashlib.sha256(expected_path.read_bytes()).hexdigest(),
        "atol": ATOL, "rtol": RTOL, "warm_repeats": repeats,
        "import_seconds": round(imported - start, 6),
        "cold_predict_seconds": round(cold_done - imported, 6),
        "cold_total_seconds": round(cold_done - start, 6),
        "warm_seconds": [round(value, 6) for value in elapsed],
        "warm_median_seconds": round(statistics.median(elapsed), 6),
        "cold_peak_rss_bytes": cold_peak, "peak_rss_bytes": final_peak,
        "memory_source": memory_source,
        "timing_scope": "fresh process import plus one sequential pass; warm passes reuse one loaded model",
        "memory_scope": "whole model process high-water RSS, including imports; not incremental or per-product memory",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--benchmark-input", type=Path, required=True)
    parser.add_argument("--benchmark-expected", type=Path, required=True)
    parser.add_argument("--warm-repeats", type=int, default=3)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    if args.warm_repeats < 1:
        parser.error("--warm-repeats must be positive.")
    report = benchmark(args.benchmark_input, args.benchmark_expected, args.warm_repeats)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
