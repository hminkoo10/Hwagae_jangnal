#!/usr/bin/env bash
# Execute as the dedicated hwagae user after one-time server provisioning.
set -Eeuo pipefail
umask 027
export PATH="/opt/hwagae/node/bin:/opt/hwagae/bin:$PATH"

revision="${1:?Usage: deploy.sh COMMIT_SHA}"
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid commit SHA' >&2; exit 2; }
app_root=/srv/hwagae
release="$app_root/releases/$revision"
archive="$app_root/incoming/$revision.tar.gz"
[[ -d "$app_root/shared" && -r /etc/hwagae/hwagae.env && -f "$archive" ]] || {
  echo 'Server provisioning or release archive is missing.' >&2; exit 2;
}
command -v node >/dev/null
command -v npm >/dev/null
command -v uv >/dev/null
command -v curl >/dev/null
command -v flock >/dev/null
exec 9>"$app_root/deploy.lock"
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 2; }

previous=''
if [[ -L "$app_root/current" ]]; then
  previous="$(readlink -f "$app_root/current")"
  if [[ "$previous" != "$app_root/releases/"* || ! -d "$previous" ]]; then
    echo 'The current release is outside this application or missing.' >&2; exit 2
  fi
elif [[ -e "$app_root/current" ]]; then
  echo 'The current path must be a release symlink.' >&2; exit 2
fi
if [[ "$previous" == "$release" ]]; then
  echo 'This revision is already active; checking without rebuilding live files.'
  curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8000/health |
    "$release/.venv/bin/python" -c 'import json,sys; assert json.load(sys.stdin)["release"] == sys.argv[1]' "$revision"
  curl --fail --silent --show-error --max-time 10 --output /dev/null http://127.0.0.1:3000/
  exit 0
fi
activated=false
rollback() {
  result=$?
  trap - ERR
  if [[ "$activated" == true ]]; then
    if [[ -n "$previous" && -d "$previous" ]]; then
      ln -sfn "$previous" "$app_root/.rollback"
      mv -Tf "$app_root/.rollback" "$app_root/current"
      if sudo -n systemctl restart hwagae-api.service hwagae-web.service; then
        echo 'Restored previous code release and restarted services; database was preserved.' >&2
      else
        echo 'Restored previous code link, but service restart failed; inspect systemd logs.' >&2
      fi
    else
      sudo -n systemctl stop hwagae-api.service hwagae-web.service || true
      # A failed first release must not be mistaken for an active release on retry.
      if [[ -L "$app_root/current" && "$(readlink -f "$app_root/current")" == "$release" ]]; then
        unlink "$app_root/current"
      fi
    fi
  fi
  exit "$result"
}
trap rollback ERR

mkdir -p "$release"
tar -xzf "$archive" --no-same-owner -C "$release"
cd "$release"
printf '%s\n' "$revision" > REVISION
uv sync --locked --no-dev --python 3.14
# The API keeps Python 3.14; both TFT models run in separate Python 3.11 workers.
model_checkpoint="$app_root/shared/models/best-epoch=02-val_loss=3.9847.ckpt"
merchant_checkpoint="$release/ml/merchant_tft/model.ckpt"
[[ -r "$merchant_checkpoint" ]] || { echo 'The bundled merchant TFT checkpoint is missing.' >&2; exit 2; }
if [[ -f "$model_checkpoint" || -f "$merchant_checkpoint" ]]; then
  uv venv --no-project --allow-existing --python 3.11 .model-venv
  uv pip install --python .model-venv/bin/python --index-strategy unsafe-best-match \
    --default-index https://pypi.org/simple -r ml/requirements-inference.txt
fi
if [[ -f "$model_checkpoint" ]]; then
  [[ -r "$model_checkpoint" ]] || { echo 'The model checkpoint is not readable.' >&2; exit 2; }
  TFT_CHECKPOINT_PATH="$model_checkpoint" .model-venv/bin/python -m ml.smoke_test
  TFT_CHECKPOINT_PATH="$model_checkpoint" .model-venv/bin/python - <<'PY'
import sys
import unittest

suite = unittest.defaultTestLoader.discover("ml/tests")
result = unittest.TextTestRunner(verbosity=2).run(suite)
if result.skipped:
    print("Model deployment requires all tests to run; skipped tests are not accepted.", file=sys.stderr)
sys.exit(not result.wasSuccessful() or bool(result.skipped) or result.testsRun == 0)
PY
else
  .model-venv/bin/python -m unittest discover -s ml/tests -p test_merchant_tft.py -v
  echo 'No shared Walmart checkpoint; the bundled live-weather test TFT remains available.'
fi
npm ci --include=dev
export NEXT_PUBLIC_API_BASE_URL=/api
export NEXT_PUBLIC_DEMO_LOGIN_ENABLED=false
export NEXT_TELEMETRY_DISABLED=1
npm run build

# SQLite's backup API includes WAL data consistently while the old app runs.
if [[ -f "$app_root/shared/hwagae.sqlite3" ]]; then
  .venv/bin/python - "$app_root/shared/hwagae.sqlite3" "$app_root/shared/backup-$(date -u +%Y%m%dT%H%M%SZ).sqlite3" <<'PY'
import sqlite3
import sys
source = sqlite3.connect(sys.argv[1])
target = sqlite3.connect(sys.argv[2])
try:
    source.backup(target)
finally:
    source.close()
    target.close()
PY
fi

ln -sfn "$release" "$app_root/.next-current"
mv -Tf "$app_root/.next-current" "$app_root/current"
activated=true
sudo -n systemctl restart hwagae-api.service hwagae-web.service
curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 2 --max-time 5 http://127.0.0.1:8000/health |
  .venv/bin/python -c 'import json,sys; value=json.load(sys.stdin); assert value["status"] == "ok" and value["release"] == sys.argv[1]' "$revision"
curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 2 --max-time 5 --output /dev/null http://127.0.0.1:3000/
trap - ERR
printf 'Deployed %s\n' "$revision"
