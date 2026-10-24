#!/usr/bin/env bash
# Isolated verification only. Never source production env, switch current,
# access the production database, or manage services.
set -Eeuo pipefail
umask 077
export PATH="/opt/hwagae/bin:$PATH"
revision="${1:?Usage: verify-tft.sh COMMIT_SHA --checkpoint ABSOLUTE_PATH}"
shift
[[ "$revision" =~ ^[a-f0-9]{40}$ && "${1:-}" == --checkpoint && $# == 2 ]] || exit 2
checkpoint="$2"
verification_id="${TFT_VERIFICATION_ID:-manual-$(date -u +%Y%m%dT%H%M%S)-$$}"
[[ "$verification_id" =~ ^[A-Za-z0-9_-]+$ ]] || exit 2
[[ "$checkpoint" =~ ^/srv/hwagae/shared/[A-Za-z0-9_./=+-]+$ ]] || exit 2
verification_root=/srv/hwagae/shared/tft-verification
workdir="$verification_root/$revision"
[[ "$(realpath -m "$workdir")" == "$workdir" ]] || { echo 'Verification path must not traverse symlinks.' >&2; exit 2; }
[[ "$(realpath -m "$checkpoint")" == /srv/hwagae/shared/* ]] || { echo 'Checkpoint must remain under shared.' >&2; exit 2; }
mkdir -p "$workdir/source"
exec 9>"$verification_root/verification.lock"
flock -n 9 || { echo 'Another TFT verification is running.' >&2; exit 2; }
reports="$workdir/reports"
if [[ -e "$reports" ]]; then
  mv -T "$reports" "$workdir/reports-$(date -u +%Y%m%dT%H%M%S)-$$"
fi
mkdir -p "$reports"
command -v python3 >/dev/null
stage=environment
status=failed
finish() {
  result=$?
  trap - EXIT
  python3 - "$reports/status.json" "$revision" "$stage" "$status" "$result" "$verification_id" <<'PY'
import datetime, json, pathlib, sys
path, revision, stage, status, code, verification_id = sys.argv[1:]
pathlib.Path(path).write_text(json.dumps({
    "revision": revision, "status": status, "stage": stage, "exit_code": int(code),
    "verification_id": verification_id,
    "finished_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "production_activated": False,
}, indent=2) + "\n")
PY
  exit "$result"
}
trap finish EXIT
python3 - "$reports/environment.json" "$checkpoint" <<'PY'
import json, os, pathlib, platform, shutil, sys
release = {}
for line in pathlib.Path("/etc/os-release").read_text().splitlines():
    if "=" in line:
        key, value = line.split("=", 1)
        release[key] = value.strip('"')
memory = next((line.split()[1] for line in pathlib.Path("/proc/meminfo").read_text().splitlines() if line.startswith("MemTotal:")), None)
out = {"system": platform.system(), "machine": platform.machine(), "kernel": platform.release(),
       "os": {key: release.get(key) for key in ("ID", "VERSION_ID", "PRETTY_NAME")},
       "logical_cpus": os.cpu_count(), "memory_kib": int(memory) if memory else None,
       "disk_free_bytes": shutil.disk_usage(pathlib.Path(sys.argv[1]).parent).free,
       "checkpoint_exists": pathlib.Path(sys.argv[2]).is_file(),
       "system_python": platform.python_version()}
pathlib.Path(sys.argv[1]).write_text(json.dumps(out, indent=2) + "\n")
if out["system"] != "Linux" or out["machine"] not in ("aarch64", "arm64") or release.get("ID") != "ubuntu":
    raise SystemExit("This verification requires native Ubuntu ARM64.")
PY
[[ -f "$workdir/source.tar.gz" ]] || { stage=source_archive_missing; exit 2; }
tar -xzf "$workdir/source.tar.gz" --no-same-owner -C "$workdir/source"
cd "$workdir/source"
stage=checkpoint_discovery
checkpoint="$(python3 - "$checkpoint" "$reports/checkpoint.json" ml/metadata/manifest.json <<'PY'
import hashlib, json, os, pathlib, re, sys
requested, report_path, manifest_path = map(pathlib.Path, sys.argv[1:])
expected = json.loads(manifest_path.read_text())["checkpoint_sha256"]
if not re.fullmatch(r"[a-f0-9]{64}", expected):
    raise SystemExit("Invalid expected checkpoint SHA-256.")
models = pathlib.Path("/srv/hwagae/shared/models")
checks, selected = [], None

def matches(path):
    entry = {"path": str(path)}
    try:
        if not path.is_file():
            entry["status"] = "missing_or_not_file"
            return False
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        entry["sha256"] = digest.hexdigest()
        entry["status"] = "matched" if entry["sha256"] == expected else "hash_mismatch"
        return entry["status"] == "matched"
    except OSError as error:
        entry["status"] = "unreadable"
        entry["error_type"] = type(error).__name__
        return False
    finally:
        checks.append(entry)

if matches(requested):
    selected = requested
elif models.is_dir() and models.resolve() == models:
    # Search only real files within this directory; do not follow directory or
    # file symlinks into other server locations. Files are hashed, never loaded.
    for directory, folders, files in os.walk(models, followlinks=False):
        folders[:] = sorted(name for name in folders if not (pathlib.Path(directory) / name).is_symlink())
        for name in sorted(files):
            candidate = pathlib.Path(directory) / name
            if candidate.suffix != ".ckpt" or candidate.is_symlink() or candidate == requested:
                continue
            if not candidate.resolve().is_relative_to(models):
                continue
            if matches(candidate):
                selected = candidate
                break
        if selected:
            break
out = {"status": "matched_existing_checkpoint" if selected else "missing_checkpoint",
       "requested_path": str(requested), "discovery_root": str(models),
       "expected_sha256": expected, "selected_path": str(selected) if selected else None,
       "selected_sha256": expected if selected else None, "checks": checks,
       "model_files_written": False}
report_path.write_text(json.dumps(out, indent=2) + "\n")
print(selected or "")
PY
)"
# Every install/cache/output is confined to this verification directory.
export UV_PYTHON_INSTALL_DIR="$workdir/python"
export UV_CACHE_DIR="$workdir/uv-cache"
export UV_PROJECT_ENVIRONMENT="$workdir/api-env"
export TMPDIR="$workdir/tmp"
mkdir -p "$TMPDIR"
export TFT_CHECKPOINT_PATH="$checkpoint"
export TFT_PYTHON="$workdir/model-env/bin/python"
export TFT_NUM_THREADS=1
export CUDA_VISIBLE_DEVICES=''
export PYTHONPATH="$PWD:$PWD/apps/api"
export APP_ENV=development
export SEED_DEMO=false
export DB_PATH="$workdir/verification.sqlite3"
export TFT_DEMO_ENABLED=true
export TFT_REAL_INTEGRATION=1
export FORECAST_PROVIDER=ml.bridge:predict
stage=model_environment
command -v uv >/dev/null
uv --version > "$reports/uv-version.txt"
uv venv --no-project --allow-existing --python 3.11 "$workdir/model-env" 2>&1 | tee "$reports/model-install.log"
uv pip install --index-strategy unsafe-best-match --python "$workdir/model-env/bin/python" -r ml/requirements-inference.txt 2>&1 | tee -a "$reports/model-install.log"
uv pip freeze --python "$workdir/model-env/bin/python" > "$reports/model-packages.txt"
stage=model_import
"$workdir/model-env/bin/python" - "$reports/model-environment.json" <<'PY' 2>&1 | tee "$reports/model-import.log"
import json, pathlib, platform, sys
import pytorch_forecasting
import torch
out = {"python": platform.python_version(), "platform": platform.platform(),
       "machine": platform.machine(), "torch": torch.__version__,
       "pytorch_forecasting": pytorch_forecasting.__version__,
       "device": str(torch.zeros(1, device="cpu").device),
       "cuda_available": torch.cuda.is_available(), "checkpoint_loaded": False}
pathlib.Path(sys.argv[1]).write_text(json.dumps(out, indent=2) + "\n")
if sys.version_info[:2] != (3, 11) or out["device"] != "cpu":
    raise SystemExit("Model import check requires Python 3.11 and CPU execution.")
print(json.dumps(out, indent=2))
PY
if [[ -z "$checkpoint" ]]; then
  stage=checkpoint
  status=missing_checkpoint
  echo 'No existing checkpoint matched the expected SHA-256. Environment/install/import reports were preserved; inference was not run.' >&2
  exit 3
fi
stage=model_smoke
"$workdir/model-env/bin/python" -m ml.smoke_test --report "$reports/model-smoke.json" 2>&1 | tee "$reports/model-smoke.log"
stage=model_tests
"$workdir/model-env/bin/python" -m unittest discover -s ml/tests -v 2>&1 | tee "$reports/model-tests.log"
for count in 10 50; do
  stage="benchmark_${count}"
  "$workdir/model-env/bin/python" -m ml.verify_runtime \
    --benchmark-input "ml/examples/benchmark-$count.json" \
    --benchmark-expected "ml/examples/benchmark-$count-expected.json" \
    --report "$reports/benchmark-$count.json" 2>&1 | tee "$reports/benchmark-$count.log"
done
stage=api_environment
uv sync --locked --python 3.14 2>&1 | tee "$reports/api-install.log"
uv pip freeze --python "$workdir/api-env/bin/python" > "$reports/api-packages.txt"
stage=api_bridge
"$workdir/api-env/bin/python" -m ml.verify_runtime --model-python "$workdir/model-env/bin/python" --report "$reports/api-bridge.json" 2>&1 | tee "$reports/api-bridge.log"
stage=api_tests
"$workdir/api-env/bin/python" -m pytest --tb=short 2>&1 | tee "$reports/api-tests.log"
stage=complete
status=passed
