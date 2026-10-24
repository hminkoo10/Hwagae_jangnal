#!/usr/bin/env bash
# Execute as the dedicated hwagae user after one-time server provisioning.
set -Eeuo pipefail
umask 027

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
      sudo -n systemctl restart hwagae-api.service hwagae-web.service || true
      echo 'Restored previous code release; database was preserved.' >&2
    else
      sudo -n systemctl stop hwagae-api.service hwagae-web.service || true
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
