#!/usr/bin/env bash
# Choose where images are read: on the Strata coder (default) or on another model.
#
#   strata-vision.sh on  [--restart] [--server-only|--profile-only]
#   strata-vision.sh off --model PROVIDER/MODEL [--restart] [--server-only|--profile-only]
#
# on   Strata loads its vision encoder (scripts/enable-strata-vision.sh) and the
#      coder reads images itself. This uses about 1.2 GB of VRAM on a 12 GB card.
# off  Strata starts without the encoder, so that VRAM goes to the expert cache.
#      The coder is declared text-only, and omp sends images and read ?q= to
#      PROVIDER/MODEL (a model in models.yml that accepts images).
#
# The choice is saved in ~/.config/omp-strata/settings.env, which apply.sh reads,
# so updates keep it. The server half runs where the Strata checkout is
# (STRATA_DIR or ~/Strata); the profile half runs where omp is installed.
# --restart restarts a running Strata server so the change takes effect.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
mode="${1:-}"
shift || true
model=""
restart=0
server=1
profile=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) model="${2:?--model needs PROVIDER/MODEL}"; shift 2 ;;
    --restart) restart=1; shift ;;
    --server-only) profile=0; shift ;;
    --profile-only) server=0; shift ;;
    *) echo "strata-vision: unknown argument $1" >&2; exit 2 ;;
  esac
done
if [[ "$mode" != on && "$mode" != off ]]; then
  sed -n '2,8p' "$0" >&2
  exit 2
fi
if [[ "$mode" == off && "$profile" == 1 && -z "$model" ]]; then
  echo "strata-vision off needs --model PROVIDER/MODEL for images (for example mac/side-model)" >&2
  exit 2
fi

settings_dir="${XDG_CONFIG_HOME:-$HOME/.config}/omp-strata"
mkdir -p "$settings_dir"
# Update only this script's keys so other settings (SIDE_FALLBACK) stay.
touch "$settings_dir/settings.env"
# grep exits 1 when nothing is left (fine) and 2 on a real error (stop before touching settings.env).
rc=0
grep -vE '^(STRATA_VISION|VISION_MODEL)=' "$settings_dir/settings.env" >"$settings_dir/settings.env.tmp" || rc=$?
if (( rc > 1 )); then
  echo "strata-vision: could not read $settings_dir/settings.env; left it unchanged" >&2
  rm -f "$settings_dir/settings.env.tmp"
  exit 1
fi
mode=$(stat -c %a "$settings_dir/settings.env" 2>/dev/null || stat -f %Lp "$settings_dir/settings.env" 2>/dev/null || echo 600)
chmod "$mode" "$settings_dir/settings.env.tmp"
{
  echo "STRATA_VISION=$mode"
  [[ -n "$model" ]] && echo "VISION_MODEL=$model"
} >>"$settings_dir/settings.env.tmp"
mv "$settings_dir/settings.env.tmp" "$settings_dir/settings.env"
echo "saved $settings_dir/settings.env"

strata="${STRATA_DIR:-$HOME/Strata}"
cfg="$strata/strata-coder-iq1_m.json"
if [[ "$server" == 1 && -f "$cfg" ]]; then
  if [[ "$mode" == on ]]; then
    bash "$root/scripts/enable-strata-vision.sh" $([[ "$restart" == 1 ]] && echo --restart)
  else
    python3 - "$cfg" <<'PY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
cfg = json.loads(path.read_text())
args = cfg.get("args", [])
out = []
skip = False
for i, arg in enumerate(args):
    if skip:
        skip = False
        continue
    if arg == "--vision":
        continue
    if arg == "--vram-reserve-mib":
        skip = True
        continue
    out.append(arg)
cfg["args"] = out
cfg.pop("vision", None)
backup = path.with_suffix(".json.vision-on")
if not backup.exists():
    backup.write_text(path.read_text())
tmp = path.with_suffix(".json.tmp")
tmp.write_text(json.dumps(cfg, indent=1) + "\n")
tmp.replace(path)
print(f"images off in {path} (encoder and VRAM reserve removed; previous config in {backup.name})")
PY
    if [[ "$restart" == 1 ]]; then
      bash "$root/scripts/restart-strata.sh" "$cfg"
    else
      echo "A running server still has the encoder loaded. Rerun with --restart after it is idle."
    fi
  fi
elif [[ "$server" == 1 ]]; then
  echo "no Strata config at $cfg; skipped the server half"
fi

if [[ "$profile" == 1 ]]; then
  if [[ -x /opt/host-omp/omp ]] || command -v omp >/dev/null 2>&1; then
    bash "$root/scripts/apply.sh"
  else
    echo "omp is not installed here; skipped the profile half"
  fi
fi
