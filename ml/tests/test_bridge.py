"""Exercise the actual process protocol without torch or a checkpoint.

Run with the API's interpreter:
    python -m unittest discover -s ml/tests -p test_bridge.py -v
"""

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from ml import bridge


STUB_WORKER = r'''
import json
import os
import sys
import time

sequence = 0
for line in sys.stdin:
    message = json.loads(line)
    sequence += 1
    context = message.get("context") or {}
    mode = context.get("mode", "echo")
    if mode == "timeout":
        time.sleep(10)
    elif mode == "crash":
        os._exit(13)
    elif mode == "malformed":
        print("this is not JSON", flush=True)
        continue
    elif mode == "oversized":
        print("x" * 512, flush=True)
        continue
    if mode == "model_error":
        response = {"id": message["id"], "ok": False, "error": "insufficient model artifacts"}
    else:
        time.sleep(context.get("delay", 0))
        result = {"pid": os.getpid(), "sequence": sequence, "context": context}
        if mode == "nonfinite":
            result["prediction"] = float("nan")
        elif mode == "invalid_result":
            result = []
        response = {"id": "wrong-id" if mode == "mismatch" else message["id"],
                    "ok": True, "result": result}
    print(json.dumps(response), flush=True)
'''


class WorkerClientTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="hwagae-tft-bridge-test-")
        self.addCleanup(self.directory.cleanup)
        self.worker = Path(self.directory.name) / "stub_worker.py"
        self.worker.write_text(STUB_WORKER, encoding="utf-8")

    def client(self):
        env = os.environ.copy()
        env.update(PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8")
        client = bridge.WorkerClient(
            [sys.executable, "-u", str(self.worker)],
            cwd=self.directory.name, env=env, timeout=3,
        )
        self.addCleanup(client.close)
        return client

    def assert_stopped(self, client, process):
        self.assertIsNone(client.process)
        self.assertIsNotNone(process.poll(), "failed worker was not terminated")
        self.assertTrue(process.stdin.closed)
        self.assertTrue(process.stdout.closed)

    def test_bridge_import_does_not_import_model_dependencies(self):
        probe = (
            "import json,sys; import ml.bridge; "
            "print(json.dumps([name for name in "
            "['torch','numpy','pandas','pytorch_forecasting'] if name in sys.modules]))"
        )
        output = subprocess.check_output(
            [sys.executable, "-c", probe], cwd=bridge.ROOT,
            text=True, encoding="utf-8", timeout=10,
        )
        self.assertEqual(json.loads(output), [])

    def test_process_is_reused_and_explicit_close_terminates_it(self):
        client = self.client()
        first = client.request("predict", {"product_id": "first"})
        process = client.process
        second = client.request("predict", {"product_id": "second"})
        self.assertIs(client.process, process)
        self.assertEqual(first["pid"], second["pid"])
        self.assertEqual([first["sequence"], second["sequence"]], [1, 2])
        self.assertEqual(second["context"]["product_id"], "second")
        client.close()
        self.assert_stopped(client, process)
        client.close()  # Shutdown may be called by both lifespan and atexit.

    def test_four_concurrent_requests_keep_their_own_responses(self):
        client = self.client()
        ready = threading.Barrier(4)

        def request(index):
            ready.wait(timeout=5)
            context = {"request_number": index, "delay": (4 - index) * 0.01}
            return index, client.request("predict", context)

        with ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(request, range(4)))
        self.assertEqual(len({result["pid"] for _, result in results}), 1)
        self.assertEqual({result["sequence"] for _, result in results}, {1, 2, 3, 4})
        for index, result in results:
            self.assertEqual(result["context"]["request_number"], index)

    def test_timeout_terminates_worker_and_next_request_restarts(self):
        client = self.client()
        first = client.request("predict", {"request_number": 1})
        process = client.process
        client.timeout = 0.15
        with self.assertRaisesRegex(TimeoutError, "exceeded"):
            client.request("predict", {"mode": "timeout"})
        self.assert_stopped(client, process)
        client.timeout = 3
        second = client.request("predict", {"request_number": 2})
        self.assertNotEqual(first["pid"], second["pid"])
        self.assertEqual(second["sequence"], 1)
        self.assertEqual(second["context"]["request_number"], 2)

    def test_timeout_also_covers_worker_that_never_reads_stdin(self):
        self.worker.write_text("import time\ntime.sleep(10)\n", encoding="utf-8")
        client = self.client()
        client.timeout = 0.15
        errors = []

        def request():
            try:
                client.request("predict", {"large_input": "x" * 2_000_000})
            except Exception as exc:
                errors.append(exc)

        thread = threading.Thread(target=request, daemon=True)
        thread.start()
        thread.join(timeout=2)
        remained_blocked = thread.is_alive()
        # A regression must fail without hanging the test runner indefinitely.
        if remained_blocked and client.process is not None:
            client.process.terminate()
        thread.join(timeout=3)
        self.assertFalse(remained_blocked, "stdin transfer ignored the request deadline")
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], TimeoutError)
        self.assertIsNone(client.process)

    def test_malformed_mismatched_crashed_and_nonfinite_responses_fail_closed(self):
        for mode, exception, pattern in [
            ("malformed", ValueError, "Expecting value"),
            ("mismatch", RuntimeError, "does not match"),
            ("crash", RuntimeError, "exited before responding"),
            ("nonfinite", ValueError, "invalid JSON number"),
            ("invalid_result", RuntimeError, "invalid response"),
        ]:
            with self.subTest(mode=mode):
                client = self.client()
                first = client.request("predict", {})
                process = client.process
                with self.assertRaisesRegex(exception, pattern):
                    client.request("predict", {"mode": mode})
                self.assert_stopped(client, process)
                healthy = client.request("predict", {"recovered": True})
                self.assertNotEqual(healthy["pid"], first["pid"])
                self.assertEqual(healthy["sequence"], 1)
                self.assertTrue(healthy["context"]["recovered"])

    def test_model_error_is_raised_without_a_baseline_result(self):
        client = self.client()
        client.request("predict", {})
        process = client.process
        with self.assertRaisesRegex(RuntimeError, "TFT inference failed: insufficient model artifacts"):
            client.request("predict", {"mode": "model_error"})
        self.assert_stopped(client, process)

    def test_response_size_limit_terminates_worker(self):
        client = self.client()
        client.request("predict", {})
        process = client.process
        with patch.object(bridge, "MAX_RESPONSE", 256):
            with self.assertRaisesRegex(RuntimeError, "exceeds the size limit"):
                client.request("predict", {"mode": "oversized"})
        self.assert_stopped(client, process)

    def test_invalid_input_does_not_touch_existing_worker(self):
        client = self.client()
        client.request("predict", {})
        process = client.process
        with self.assertRaises(ValueError):
            client.request("predict", {"units_sold": float("nan")})
        self.assertIs(client.process, process)
        self.assertIsNone(process.poll())
        result = client.request("predict", {"valid": True})
        self.assertEqual(result["sequence"], 2)


if __name__ == "__main__":
    unittest.main()
