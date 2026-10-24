"""Standard-library bridge from the API interpreter to a persistent CPU worker.

The API does not import torch or the training dependencies. The worker's stdout
is a JSON-lines protocol; model diagnostics go to stderr. Requests are serialized
and a failed/timed-out worker is terminated, ready for the next call to restart.
"""

from __future__ import annotations

import atexit
import json
import math
import os
from pathlib import Path
import queue
import subprocess
import threading
import time
import uuid


ROOT = Path(__file__).resolve().parents[1]
MAX_RESPONSE = 8 * 1024 * 1024


def _invalid_number(value):
    raise ValueError(f"invalid JSON number {value}")


class WorkerClient:
    def __init__(self, command, *, cwd, env, timeout):
        self.command = command
        self.cwd = cwd
        self.env = env
        self.timeout = timeout
        self.lock = threading.RLock()
        self.process = None
        self.responses = None

    def _start(self):
        if self.process is not None and self.process.poll() is None:
            return
        self._stop()
        self.responses = queue.Queue()
        self.process = subprocess.Popen(
            self.command, cwd=self.cwd, env=self.env, shell=False,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=None,
            text=True, encoding="utf-8", bufsize=1,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        process, responses = self.process, self.responses

        def read_responses():
            try:
                while True:
                    line = process.stdout.readline(MAX_RESPONSE + 1)
                    if not line:
                        responses.put((False, "TFT worker exited before responding"))
                        return
                    if len(line) > MAX_RESPONSE:
                        responses.put((False, "TFT worker response exceeds the size limit"))
                        return
                    responses.put((True, line))
            except (OSError, ValueError):
                responses.put((False, "TFT worker response stream closed"))

        threading.Thread(target=read_responses, name="tft-worker-output", daemon=True).start()

    def _stop(self):
        process, self.process = self.process, None
        if process is None:
            return
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
        for stream in (process.stdin, process.stdout):
            if stream is not None:
                stream.close()

    def close(self):
        with self.lock:
            self._stop()

    def request(self, operation, context=None):
        request_id = uuid.uuid4().hex
        message = {"id": request_id, "operation": operation}
        if context is not None:
            message["context"] = context
        # Reject NaN and unserializable input before touching worker state.
        line = json.dumps(message, ensure_ascii=False, allow_nan=False) + "\n"
        with self.lock:
            self._start()
            deadline = time.monotonic() + self.timeout
            process = self.process
            written = queue.Queue()

            def write_request():
                try:
                    process.stdin.write(line)
                    process.stdin.flush()
                    written.put(None)
                except (OSError, ValueError) as exc:
                    written.put(exc)

            # A worker can stop consuming stdin before the OS pipe fills.
            # Include input transfer in the same deadline as the response.
            threading.Thread(target=write_request, name="tft-worker-input", daemon=True).start()
            try:
                write_error = written.get(timeout=max(0, deadline - time.monotonic()))
                if write_error is not None:
                    raise write_error
                received, payload = self.responses.get(timeout=max(0, deadline - time.monotonic()))
                if not received:
                    raise RuntimeError(payload)
                response = json.loads(payload, parse_constant=_invalid_number)
                if not isinstance(response, dict) or response.get("id") != request_id:
                    raise RuntimeError("TFT worker response does not match the request")
                if response.get("ok") is False:
                    raise RuntimeError("TFT inference failed: " + str(response.get("error", "unknown error")))
                if response.get("ok") is not True or not isinstance(response.get("result"), dict):
                    raise RuntimeError("TFT worker returned an invalid response")
                return response["result"]
            except queue.Empty as exc:
                self._stop()
                raise TimeoutError(f"TFT inference exceeded {self.timeout:g} seconds") from exc
            except (OSError, ValueError, RuntimeError):
                self._stop()
                raise


_LOCK = threading.RLock()
_CLIENT = None
_CONFIG = None


def _client():
    global _CLIENT, _CONFIG
    python = os.getenv("TFT_PYTHON", "")
    checkpoint = os.getenv("TFT_CHECKPOINT_PATH", "")
    if not python or not checkpoint:
        raise ValueError("TFT_PYTHON and TFT_CHECKPOINT_PATH are required for the model worker")
    interpreter = str(Path(python).resolve(strict=True))
    model_path = str(Path(checkpoint).resolve(strict=True))
    timeout = float(os.getenv("TFT_REQUEST_TIMEOUT_SECONDS", "60"))
    if not math.isfinite(timeout) or timeout <= 0 or timeout > 600:
        raise ValueError("TFT_REQUEST_TIMEOUT_SECONDS must be greater than 0 and at most 600")
    config = (interpreter, model_path, os.getenv("TFT_METADATA_DIR", ""),
              os.getenv("TFT_NUM_THREADS", "1"), timeout)
    with _LOCK:
        if _CLIENT is None or config != _CONFIG:
            if _CLIENT is not None:
                _CLIENT.close()
            env = os.environ.copy()
            env.update(TFT_CHECKPOINT_PATH=model_path, PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8")
            _CLIENT = WorkerClient([interpreter, "-u", "-m", "ml.worker"],
                                   cwd=str(ROOT), env=env, timeout=timeout)
            _CONFIG = config
        return _CLIENT


def warmup() -> dict:
    """Load the checkpoint before the API accepts the first browser request."""
    metadata = _client().request("warmup")
    if metadata.get("device") != "cpu":
        close()
        raise RuntimeError("TFT worker must run on CPU")
    return metadata


def predict(context: dict) -> dict:
    return _client().request("predict", context)


def close():
    global _CLIENT, _CONFIG
    with _LOCK:
        if _CLIENT is not None:
            _CLIENT.close()
        _CLIENT = _CONFIG = None


atexit.register(close)
