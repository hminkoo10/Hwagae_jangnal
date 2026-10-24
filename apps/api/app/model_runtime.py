"""Bounded stdio bridge to an optional, separately installed TFT Python runtime."""

from __future__ import annotations

from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import queue
import subprocess
import threading
import uuid


MAX_MESSAGE_BYTES = 2 * 1024 * 1024
_MESSAGES = {
    "disabled": "TFT 실행 환경이 설정되지 않았어요.",
    "starting": "TFT 모델을 준비하고 있어요. 잠시 후 다시 확인해주세요.",
    "ready": "TFT 모델을 사용할 수 있어요.",
    "unavailable": "TFT 모델을 실행할 수 없어요. 서버 상태를 확인해주세요.",
}


class ModelUnavailable(Exception):
    """Only sanitized, user-facing messages cross the API boundary."""


@dataclass
class _Request:
    identifier: str
    payload: bytes
    done: threading.Event = field(default_factory=threading.Event)
    result: dict | None = None
    error: str | None = None


class ModelRuntime:
    def __init__(
        self,
        *,
        repo_root: Path | None = None,
        startup_timeout: float = 120.0,
        prediction_timeout: float = 20.0,
    ):
        self._root = (repo_root or Path(__file__).resolve().parents[3]).resolve()
        self._startup_timeout = max(0.01, min(float(startup_timeout), 300.0))
        self._prediction_timeout = max(0.01, min(float(prediction_timeout), 20.0))
        self._state = "disabled"
        self._message = _MESSAGES["disabled"]
        self._lock = threading.Lock()
        self._call_lock = threading.Lock()
        self._stop_lock = threading.Lock()
        self._stop_thread: threading.Thread | None = None
        self._jobs: queue.Queue[_Request | None] = queue.Queue(maxsize=1)
        self._pending: _Request | None = None
        self._process: subprocess.Popen | None = None
        self._thread: threading.Thread | None = None
        self._closed = False
        self._started = False

    def start(self) -> None:
        """Return immediately; imports and the first real prediction run off-thread."""
        with self._lock:
            if self._started or self._closed:
                return
            self._started = True
            self._state = "starting"
            self._message = _MESSAGES["starting"]
            self._thread = threading.Thread(
                target=self._serve, name="hwagae-tft-runtime", daemon=True
            )
            self._thread.start()

    def status(self) -> dict:
        with self._lock:
            exited = (
                self._state == "ready"
                and self._process is not None
                and self._process.poll() is not None
            )
        if exited:
            self._fail(_MESSAGES["unavailable"])
        with self._lock:
            return {"status": self._state, "message": self._message}

    def predict(self, context: dict) -> dict:
        if not self._call_lock.acquire(blocking=False):
            raise ModelUnavailable(
                "다른 TFT 예측을 처리하고 있어요. 잠시 후 다시 시도해주세요."
            )
        try:
            current = self.status()
            if current["status"] != "ready":
                raise ModelUnavailable(current["message"])
            identifier = uuid.uuid4().hex
            try:
                payload = (
                    json.dumps(
                        {"kind": "predict", "id": identifier, "context": context},
                        ensure_ascii=False,
                        allow_nan=False,
                    ).encode("utf-8")
                    + b"\n"
                )
                if not isinstance(context, dict) or len(payload) > MAX_MESSAGE_BYTES:
                    raise ValueError("invalid input")
            except TypeError, ValueError, OverflowError:
                raise ModelUnavailable("TFT 예측 입력을 처리할 수 없어요.") from None
            request = _Request(identifier, payload)
            with self._lock:
                if self._closed or self._state != "ready":
                    raise ModelUnavailable(self._message)
                self._pending = request
                self._jobs.put_nowait(request)
            if not request.done.wait(self._prediction_timeout):
                message = (
                    "TFT 예측 시간이 초과됐어요. 서버에서 모델을 다시 준비해야 해요."
                )
                self._fail(message)
                raise ModelUnavailable(message)
            if request.error or request.result is None:
                raise ModelUnavailable(request.error or _MESSAGES["unavailable"])
            return request.result
        finally:
            self._call_lock.release()

    def close(self) -> None:
        with self._lock:
            self._closed = True
            disabled = self._state == "disabled"
        self._fail("TFT 모델 실행이 종료됐어요.", preserve_disabled=disabled)
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=8)

    def _configuration(self) -> tuple[Path, Path] | None:
        python_default = (
            self._root
            / ".model-venv"
            / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        )
        checkpoint_default = Path(
            "/srv/hwagae/shared/models/best-epoch=02-val_loss=3.9847.ckpt"
        )
        selected = []
        missing_default = False
        for name, fallback in (
            ("TFT_PYTHON", python_default),
            ("TFT_CHECKPOINT_PATH", checkpoint_default),
        ):
            configured = os.environ.get(name, "").strip()
            path = Path(configured) if configured else fallback
            if configured and (not path.is_absolute() or not path.is_file()):
                raise ValueError("invalid configured runtime path")
            if not path.is_file():
                missing_default = True
            # Keep a venv executable's path: resolving its symlink can bypass it.
            selected.append(path.absolute())
        if missing_default:
            return None
        return selected[0], selected[1]

    def _serve(self) -> None:
        process = None
        timer = threading.Timer(self._startup_timeout, self._startup_expired)
        timer.daemon = True
        timer.start()
        try:
            configuration = self._configuration()
            if configuration is None:
                with self._lock:
                    if not self._closed and self._state == "starting":
                        self._state = "disabled"
                        self._message = _MESSAGES["disabled"]
                return
            python, checkpoint = configuration
            environment = os.environ.copy()
            environment.update(
                PYTHONUTF8="1",
                PYTHONIOENCODING="utf-8",
                PYTHONUNBUFFERED="1",
                TFT_CHECKPOINT_PATH=str(checkpoint),
            )
            process = subprocess.Popen(
                [str(python), "-u", str(self._root / "ops" / "tft_worker.py")],
                cwd=self._root,
                env=environment,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=None,
                shell=False,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            with self._lock:
                if self._closed or self._state != "starting":
                    return
                self._process = process
            if self._read(process) != {"kind": "ready"}:
                raise ValueError("worker did not become ready")
            with self._lock:
                if self._closed or self._state != "starting":
                    return
                self._state = "ready"
                self._message = _MESSAGES["ready"]
            timer.cancel()
            while True:
                request = self._jobs.get()
                if request is None:
                    return
                with self._lock:
                    if self._closed or self._state != "ready":
                        return
                assert process.stdin is not None
                process.stdin.write(request.payload)
                process.stdin.flush()
                response = self._read(process)
                if (
                    response.get("kind") != "result"
                    or response.get("id") != request.identifier
                    or not isinstance(response.get("result"), dict)
                ):
                    raise ValueError("invalid worker response")
                with self._lock:
                    if self._closed or self._state != "ready":
                        return
                    request.result = response["result"]
                    self._pending = None
                    request.done.set()
        except Exception:
            self._fail(_MESSAGES["unavailable"])
        finally:
            timer.cancel()
            if process is not None:
                self._kill(process)
                if self._stop_thread is not None:
                    self._stop_thread.join(timeout=6)
                try:
                    process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    pass
                for stream in (process.stdin, process.stdout):
                    if stream is not None:
                        try:
                            stream.close()
                        except OSError:
                            pass

    @staticmethod
    def _read(process: subprocess.Popen) -> dict:
        assert process.stdout is not None
        line = process.stdout.readline(MAX_MESSAGE_BYTES + 1)
        if not line.endswith(b"\n") or len(line) > MAX_MESSAGE_BYTES:
            raise ValueError("invalid worker message size")

        def reject_constant(value):
            raise ValueError("non-finite JSON number")

        result = json.loads(line.decode("utf-8"), parse_constant=reject_constant)
        if not isinstance(result, dict):
            raise ValueError("invalid worker message")
        return result

    def _startup_expired(self) -> None:
        self._fail(
            "TFT 모델 준비 시간이 초과됐어요. 서버 상태를 확인해주세요.",
            only_if_starting=True,
        )

    def _fail(
        self,
        message: str,
        *,
        preserve_disabled: bool = False,
        only_if_starting: bool = False,
    ) -> None:
        with self._lock:
            if only_if_starting and self._state != "starting":
                return
            if not preserve_disabled and self._state != "unavailable":
                self._state = "unavailable"
                self._message = message
            if self._pending is not None:
                self._pending.error = self._message
                self._pending.done.set()
                self._pending = None
            process = self._process
            try:
                self._jobs.put_nowait(None)
            except queue.Full:
                pass
        if process is not None:
            self._kill(process)

    def _kill(self, process: subprocess.Popen) -> None:
        if process.poll() is None:
            if os.name == "nt":
                # Windows venv python.exe is a redirector with a child interpreter.
                # Kill only this owned process tree, off-thread to keep deadlines.
                def kill_tree():
                    try:
                        subprocess.run(
                            [
                                str(
                                    Path(os.environ.get("SystemRoot", r"C:\Windows"))
                                    / "System32/taskkill.exe"
                                ),
                                "/PID",
                                str(process.pid),
                                "/T",
                                "/F",
                            ],
                            stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL,
                            creationflags=subprocess.CREATE_NO_WINDOW,
                            timeout=5,
                            check=False,
                        )
                    except OSError, subprocess.TimeoutExpired:
                        pass
                    finally:
                        if process.poll() is None:
                            try:
                                process.kill()
                            except OSError:
                                pass

                with self._stop_lock:
                    if self._stop_thread is None:
                        self._stop_thread = threading.Thread(
                            target=kill_tree, name="hwagae-tft-stop", daemon=True
                        )
                        self._stop_thread.start()
                return
            try:
                process.kill()
            except OSError:
                pass
