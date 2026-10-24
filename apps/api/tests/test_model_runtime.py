"""Real pipe/process lifecycle tests with cheap workers; no ML packages needed."""

from concurrent.futures import ThreadPoolExecutor
import ast
import json
import os
from pathlib import Path
import sys
import time

import pytest

from app.model_runtime import MAX_MESSAGE_BYTES, ModelRuntime, ModelUnavailable


WORKER = """
import json, os, sys, time
time.sleep(float(os.environ.get("FAKE_WARM_DELAY", "0")))
print(json.dumps({"kind": "ready"}), flush=True)
time.sleep(float(os.environ.get("FAKE_READ_DELAY", "0")))
for line in sys.stdin:
    request = json.loads(line)
    context = request["context"]
    mode = context.get("mode", "ok")
    if mode == "crash":
        raise RuntimeError("secret/checkpoint/path must not reach the API")
    if mode == "malformed":
        print("not-json secret", flush=True)
        continue
    if mode == "oversized":
        print("x" * (2 * 1024 * 1024 + 1), flush=True)
        continue
    time.sleep(context.get("delay", 0))
    result = {"worker_pid": os.getpid()} if mode == "pid" else {"echo": context}
    print(json.dumps({"kind": "result", "id": request["id"], "result": result}), flush=True)
"""


def wait_status(runtime, expected, timeout=4):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        current = runtime.status()
        if current["status"] == expected:
            return current
        time.sleep(0.01)
    pytest.fail(f"expected {expected}, got {runtime.status()}")


@pytest.fixture
def runtime_factory(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    (root / "ops").mkdir(parents=True)
    (root / "ops/tft_worker.py").write_text(WORKER, encoding="utf-8")
    checkpoint = root / "fake.ckpt"
    checkpoint.touch()
    (root / "ml/merchant_tft").mkdir(parents=True)
    (root / "ml/merchant_tft/model.ckpt").touch()
    monkeypatch.setenv("TFT_PYTHON", sys.executable)
    monkeypatch.setenv("TFT_CHECKPOINT_PATH", str(checkpoint))
    monkeypatch.delenv("FAKE_WARM_DELAY", raising=False)
    monkeypatch.delenv("FAKE_READ_DELAY", raising=False)
    instances = []

    def create(**kwargs):
        runtime = ModelRuntime(repo_root=root, **kwargs)
        instances.append(runtime)
        return runtime

    yield create
    for runtime in instances:
        runtime.close()


def test_unconfigured_and_explicit_invalid_paths_are_distinct(tmp_path, monkeypatch):
    monkeypatch.delenv("TFT_PYTHON", raising=False)
    monkeypatch.delenv("TFT_CHECKPOINT_PATH", raising=False)
    runtime = ModelRuntime(repo_root=tmp_path)
    runtime.start()
    wait_status(runtime, "disabled")
    with pytest.raises(ModelUnavailable):
        runtime.predict({})
    runtime.close()

    monkeypatch.setenv("TFT_PYTHON", "relative/python")
    runtime = ModelRuntime(repo_root=tmp_path)
    runtime.start()
    state = wait_status(runtime, "unavailable")
    assert "relative" not in state["message"]
    runtime.close()

    monkeypatch.delenv("TFT_PYTHON")
    monkeypatch.setenv("TFT_CHECKPOINT_PATH", "relative/model.ckpt")
    runtime = ModelRuntime(repo_root=tmp_path)
    runtime.start()
    wait_status(runtime, "unavailable")
    runtime.close()


def test_warmup_is_nonblocking_and_predictions_reuse_process(
    runtime_factory, monkeypatch
):
    monkeypatch.setenv("FAKE_WARM_DELAY", "0.3")
    runtime = runtime_factory()
    started = time.monotonic()
    runtime.start()
    assert time.monotonic() - started < 0.15
    assert runtime.status()["status"] == "starting"
    with pytest.raises(ModelUnavailable):
        runtime.predict({})
    wait_status(runtime, "ready")
    process = runtime._process
    context = {"label": "한국어", "sales": [1, 2]}
    original = json.loads(json.dumps(context))
    assert runtime.predict(context) == {"echo": context}
    assert runtime.predict({"another": True}) == {"echo": {"another": True}}
    assert context == original
    assert runtime._process is process and process.poll() is None
    runtime._startup_expired()  # A timer racing with ready must be harmless.
    assert runtime.status()["status"] == "ready"
    runtime.close()
    assert process.poll() is not None
    with pytest.raises(ModelUnavailable):
        runtime.predict({})


def test_busy_request_fails_fast_without_corrupting_active_call(runtime_factory):
    runtime = runtime_factory()
    runtime.start()
    wait_status(runtime, "ready")
    with ThreadPoolExecutor(max_workers=1) as pool:
        active = pool.submit(runtime.predict, {"delay": 0.3})
        deadline = time.monotonic() + 2
        while runtime._pending is None and time.monotonic() < deadline:
            time.sleep(0.005)
        started = time.monotonic()
        with pytest.raises(ModelUnavailable, match="다른 TFT 예측"):
            runtime.predict({})
        assert time.monotonic() - started < 0.1
        assert active.result(timeout=2) == {"echo": {"delay": 0.3}}
    assert runtime.status()["status"] == "ready"


@pytest.mark.parametrize("mode", ["crash", "malformed", "oversized"])
def test_bad_worker_output_is_sanitized_and_disables_worker(runtime_factory, mode):
    runtime = runtime_factory()
    runtime.start()
    wait_status(runtime, "ready")
    with pytest.raises(ModelUnavailable) as caught:
        runtime.predict({"mode": mode})
    assert "secret" not in str(caught.value)
    wait_status(runtime, "unavailable")
    runtime.close()
    assert runtime._process.poll() is not None


@pytest.mark.parametrize("blocked_stdin", [False, True])
def test_prediction_timeout_kills_worker_and_cannot_return_late_result(
    runtime_factory, monkeypatch, blocked_stdin
):
    if blocked_stdin:
        monkeypatch.setenv("FAKE_READ_DELAY", "5")
    runtime = runtime_factory(prediction_timeout=0.1)
    runtime.start()
    wait_status(runtime, "ready")
    started = time.monotonic()
    with pytest.raises(ModelUnavailable, match="시간이 초과"):
        runtime.predict({"payload": "x" * 500_000} if blocked_stdin else {"delay": 5})
    assert time.monotonic() - started < 1
    wait_status(runtime, "unavailable")
    runtime.close()
    assert runtime._process.poll() is not None


def test_startup_timeout_and_shutdown_during_warmup(runtime_factory, monkeypatch):
    monkeypatch.setenv("FAKE_WARM_DELAY", "5")
    runtime = runtime_factory(startup_timeout=0.1)
    runtime.start()
    wait_status(runtime, "unavailable")
    runtime.close()
    if runtime._process is not None:
        assert runtime._process.poll() is not None
    closing = runtime_factory()
    closing.start()
    closing.close()
    assert closing.status()["status"] == "unavailable"
    assert not closing._thread.is_alive()


def test_shutdown_unblocks_inflight_request(runtime_factory):
    runtime = runtime_factory()
    runtime.start()
    wait_status(runtime, "ready")
    with ThreadPoolExecutor(max_workers=1) as pool:
        active = pool.submit(runtime.predict, {"delay": 5})
        deadline = time.monotonic() + 2
        while runtime._pending is None and time.monotonic() < deadline:
            time.sleep(0.005)
        runtime.close()
        with pytest.raises(ModelUnavailable):
            active.result(timeout=1)
    assert runtime._process.poll() is not None


def test_invalid_context_does_not_damage_ready_worker(runtime_factory):
    runtime = runtime_factory()
    runtime.start()
    wait_status(runtime, "ready")
    for context in ({"bad": float("nan")}, {"large": "x" * MAX_MESSAGE_BYTES}):
        with pytest.raises(ModelUnavailable, match="입력"):
            runtime.predict(context)
    assert runtime.predict({}) == {"echo": {}}


@pytest.mark.skipif(os.name != "nt", reason="Windows venv redirector process tree")
def test_windows_redirector_child_is_terminated(runtime_factory):
    import ctypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    runtime = runtime_factory()
    runtime.start()
    wait_status(runtime, "ready")
    worker_pid = runtime.predict({"mode": "pid"})["worker_pid"]
    handle = kernel.OpenProcess(0x00100000, False, worker_pid)
    assert handle
    try:
        runtime.close()
        assert kernel.WaitForSingleObject(handle, 1000) == 0
    finally:
        kernel.CloseHandle(handle)


@pytest.mark.parametrize("profile", ["walmart", "merchant"])
def test_real_worker_protocol_redirects_library_stdout_and_warms_fixture(
    tmp_path, monkeypatch, profile
):
    """Exercise the shipped worker with a tiny fake ml module, not a pickle."""
    root = tmp_path / "worker-repo"
    (root / "ops").mkdir(parents=True)
    (root / "ml/examples").mkdir(parents=True)
    (root / "ml/merchant_tft").mkdir(parents=True)
    worker = Path(__file__).resolve().parents[3] / "ops/tft_worker.py"
    ast.parse(worker.read_text(encoding="utf-8"), feature_version=(3, 11))
    (root / "ops/tft_worker.py").write_bytes(worker.read_bytes())
    (root / "ml/__init__.py").touch()
    (root / "ml/merchant_tft/__init__.py").touch()
    fixture = (
        "ml/merchant_tft/smoke.json"
        if profile == "merchant"
        else "ml/examples/input.json"
    )
    module = "ml/merchant_tft/predict.py" if profile == "merchant" else "ml/predict.py"
    (root / fixture).write_text('{"warm": true}', encoding="utf-8")
    (root / module).write_text(
        "import os\nwarmed = False\n"
        'print("python import log")\nos.write(1, b"native import log\\n")\n'
        "def predict(context):\n"
        "    global warmed\n"
        '    if context.get("invalid"):\n        raise ValueError("private input path")\n'
        '    if context.get("warm"):\n        warmed = True\n'
        '    if not warmed:\n        raise RuntimeError("not warmed")\n'
        '    print("prediction log")\n    return {"warmed": warmed, "context": context}\n',
        encoding="utf-8",
    )
    checkpoint = root / "fake.ckpt"
    checkpoint.touch()
    (root / "ml/merchant_tft/model.ckpt").touch()
    monkeypatch.setenv("TFT_PYTHON", sys.executable)
    monkeypatch.setenv("TFT_CHECKPOINT_PATH", str(checkpoint))
    runtime = ModelRuntime(repo_root=root, profile=profile)
    try:
        runtime.start()
        wait_status(runtime, "ready")
        assert runtime.predict({"hello": "한국"}) == {
            "warmed": True,
            "context": {"hello": "한국"},
        }
        process = runtime._process
        with pytest.raises(ModelUnavailable) as rejected:
            runtime.predict({"invalid": True})
        assert "private" not in str(rejected.value)
        assert runtime.status()["status"] == "ready"
        assert runtime.predict({"after_error": True})["context"] == {
            "after_error": True
        }
        assert runtime._process is process and process.poll() is None
    finally:
        runtime.close()


def test_profiles_have_separate_processes_checkpoints_and_failures(
    runtime_factory, monkeypatch
):
    walmart = runtime_factory()
    merchant = runtime_factory(profile="merchant")
    walmart.start()
    merchant.start()
    wait_status(walmart, "ready")
    wait_status(merchant, "ready")
    assert walmart._process.pid != merchant._process.pid
    assert merchant._process.args[-1] == "--merchant"
    assert walmart._process.args[-1].endswith("tft_worker.py")
    assert merchant._configuration()[1] == merchant._root / "ml/merchant_tft/model.ckpt"
    monkeypatch.setenv("TFT_CHECKPOINT_PATH", "invalid-walmart-path")
    assert merchant._configuration()[1].is_file()
    with pytest.raises(ModelUnavailable):
        merchant.predict({"mode": "crash"})
    assert walmart.predict({"still": "available"}) == {"echo": {"still": "available"}}
    assert walmart.status()["status"] == "ready"
    with pytest.raises(ValueError, match="unsupported"):
        runtime_factory(profile="client-supplied-module")
