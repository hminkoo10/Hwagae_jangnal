"""Private JSONL worker for the separately installed Python 3.11 TFT runtime."""

from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import traceback


MAX_MESSAGE_BYTES = 2 * 1024 * 1024


def main() -> int:
    # Preserve the protocol pipe, then redirect even native-library stdout logs.
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), "wb")
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root))

    def emit(message):
        payload = (
            json.dumps(message, ensure_ascii=False, allow_nan=False).encode("utf-8")
            + b"\n"
        )
        if len(payload) > MAX_MESSAGE_BYTES:
            raise ValueError("worker response is too large")
        protocol.write(payload)
        protocol.flush()

    def reject_constant(value):
        raise ValueError("non-finite JSON number")

    try:
        from ml.predict import predict

        example = json.loads(
            (root / "ml/examples/input.json").read_text(encoding="utf-8")
        )
        predict(example)
        emit({"kind": "ready"})
        while True:
            line = sys.stdin.buffer.readline(MAX_MESSAGE_BYTES + 1)
            if not line:
                return 0
            if not line.endswith(b"\n") or len(line) > MAX_MESSAGE_BYTES:
                raise ValueError("invalid worker request size")
            request = json.loads(line.decode("utf-8"), parse_constant=reject_constant)
            if (
                not isinstance(request, dict)
                or request.get("kind") != "predict"
                or not isinstance(request.get("id"), str)
                or not isinstance(request.get("context"), dict)
            ):
                raise ValueError("invalid worker request")
            result = predict(request["context"])
            if not isinstance(result, dict):
                raise ValueError("invalid prediction")
            emit({"kind": "result", "id": request["id"], "result": result})
    except Exception:
        traceback.print_exc(file=sys.stderr)
        try:
            emit({"kind": "error"})
        except (OSError, ValueError):
            pass
        return 1
    finally:
        try:
            protocol.close()
        except OSError:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
