"""Private stdin/stdout worker, launched with the model's own Python interpreter."""

from __future__ import annotations

from contextlib import redirect_stdout
import hashlib
import json
import os
from pathlib import Path
import platform
import sys


def execute(message):
    from ml.predict import _runtime, predict
    if message.get("operation") == "warmup":
        runtime = _runtime()
        import torch
        return {
            "python": platform.python_version(), "executable": sys.executable,
            "platform": platform.platform(), "machine": platform.machine(),
            "torch": torch.__version__, "device": str(next(runtime.model.parameters()).device),
            "model_version": runtime.version,
            "checkpoint_sha256": hashlib.sha256(Path(os.environ["TFT_CHECKPOINT_PATH"]).read_bytes()).hexdigest(),
        }
    if message.get("operation") == "predict":
        return predict(message["context"])
    raise ValueError("unknown worker operation")


def main():
    protocol = sys.stdout
    for line in sys.stdin:
        request_id = None
        try:
            message = json.loads(line)
            request_id = message.get("id")
            if not isinstance(request_id, str) or not request_id:
                raise ValueError("worker request id is required")
            with redirect_stdout(sys.stderr):
                result = execute(message)
            response = {"id": request_id, "ok": True, "result": result}
            encoded = json.dumps(response, ensure_ascii=False, allow_nan=False)
        except Exception as exc:
            # Include only the actionable error, never the input or a traceback.
            response = {"id": request_id, "ok": False, "error": f"{type(exc).__name__}: {exc}"}
            encoded = json.dumps(response, ensure_ascii=False, allow_nan=False)
        protocol.write(encoded + "\n")
        protocol.flush()


if __name__ == "__main__":
    main()
