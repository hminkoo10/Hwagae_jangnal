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
[[ "$checkpoint" =~ ^/srv/hwagae/shared/[A-Za-z0-9_./=+-]+$ ]] || exit 2
verification_root=/srv/hwagae/shared/tft-verification
workdir="$verification_root/$revision"
[[ "$(realpath -m "$workdir")" == "$workdir" ]] || { echo 'Verification path must not traverse symlinks.' >&2; exit 2; }
[[ "$(realpath -m "$checkpoint")" == /srv/hwagae/shared/* ]] || { echo 'Checkpoint must remain under shared.' >&2; exit 2; }
mkdir -p "$workdir/reports" "$workdir/source"
reports="$workdir/reports"
command -v python3 >/dev/null
stage=environment
status=failed
finish() {
  result=$?
  trap - EXIT
  python3 - "$reports/status.json" "$revision" "$stage" "$status" "$result" <<'PY'
import datetime, json, pathlib, sys
path, revision, stage, status, code = sys.argv[1:]
pathlib.Path(path).write_text(json.dumps({
    "revision": revision, "status": status, "stage": stage, "exit_code": int(code),
    "finished_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "production_activated": False,
}, indent=2) + "\n")
PY
  exit "$result"
}
trap finish EXIT
exec 9>"$verification_root/verification.lock"
flock -n 9 || { stage=already_running; exit 2; }
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
if [[ ! -r "$checkpoint" ]]; then
  stage=checkpoint
  status=missing_checkpoint
  echo 'TFT checkpoint is missing or unreadable; environment report was preserved.' >&2
  exit 3
fi
[[ -f "$workdir/source.tar.gz" ]] || { stage=source_archive_missing; exit 2; }
tar -xzf "$workdir/source.tar.gz" --no-same-owner -C "$workdir/source"
cd "$workdir/source"
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
uv venv --no-project --python 3.11 "$workdir/model-env" 2>&1 | tee "$reports/model-install.log"
uv pip install --python "$workdir/model-env/bin/python" -r ml/requirements-inference.txt 2>&1 | tee -a "$reports/model-install.log"
uv pip freeze --python "$workdir/model-env/bin/python" > "$reports/model-packages.txt"
stage=model_smoke
"$workdir/model-env/bin/python" -m ml.smoke_test --report "$reports/model-smoke.json" 2>&1 | tee "$reports/model-smoke.log"
stage=model_tests
"$workdir/model-env/bin/python" -m unittest discover -s ml/tests -v 2>&1 | tee "$reports/model-tests.log"
stage=api_environment
uv sync --locked --python 3.14 2>&1 | tee "$reports/api-install.log"
uv pip freeze --python "$workdir/api-env/bin/python" > "$reports/api-packages.txt"
stage=api_bridge
"$workdir/api-env/bin/python" -m ml.verify_runtime --model-python "$workdir/model-env/bin/python" --report "$reports/api-bridge.json" 2>&1 | tee "$reports/api-bridge.log"
stage=api_tests
"$workdir/api-env/bin/python" -m pytest --tb=short 2>&1 | tee "$reports/api-tests.log"
stage=complete
status=passed
