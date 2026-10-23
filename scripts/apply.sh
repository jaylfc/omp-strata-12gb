#!/usr/bin/env bash
# Copy the Strata profile into ~/.omp/profiles/omp-strata/agent.
# Stock omp keeps ~/.omp/agent. agent/strata.config.yml is merged with
# `omp config set`, so a theme already in the profile config.yml stays.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
agent="${HOME}/.omp/profiles/omp-strata/agent"
mkdir -p "$agent/extensions" "$agent/skills/mac-mini"

# Local choices from ~/.config/omp-strata/settings.env. scripts/strata-vision.sh
# writes the vision keys. Updates keep them.
STRATA_VISION=on
VISION_MODEL=""
SIDE_FALLBACK=on
COMPACTION_MODEL=""
SMOL_MODEL=""
# The optional second OpenAI-compatible machine, provider `mac` in models.yml.
# The repo ships placeholders; settings.env names the real server and model.
SIDE_BASE_URL=http://127.0.0.1:1234/v1
SIDE_MODEL_ID=side-model
SIDE_MODEL_NAME="Side model"
SIDE_CONTEXT=32768
# SIDE_SUBAGENTS=off refuses subagents instead of pinning them to the side model.
SIDE_SUBAGENTS=on
settings="${XDG_CONFIG_HOME:-$HOME/.config}/omp-strata/settings.env"
if [[ -f "$settings" ]]; then
  # shellcheck disable=SC1090
  source "$settings"
fi
if [[ -z "$SIDE_BASE_URL" || -z "$SIDE_MODEL_ID" || -z "$SIDE_MODEL_NAME" || ! "$SIDE_CONTEXT" =~ ^[0-9]+$ ]]; then
  echo "settings.env: SIDE_BASE_URL, SIDE_MODEL_ID, and SIDE_MODEL_NAME must be set, and SIDE_CONTEXT must be a number" >&2
  exit 1
fi
side_model="mac/$SIDE_MODEL_ID"
# A role that names the side provider must name its one model, or omp would
# route that role to a model models.yml does not have.
for role in VISION_MODEL SMOL_MODEL COMPACTION_MODEL; do
  if [[ "${!role}" == mac/* && "${!role}" != "$side_model" ]]; then
    echo "settings.env: $role=${!role} but the side model is $side_model; set SIDE_MODEL_ID" >&2
    exit 1
  fi
done
subagent_model="$side_model"
[[ "$SIDE_SUBAGENTS" == off ]] && subagent_model=""

# The repo copy pins subagents to the placeholder; install it with the real selector.
python3 - "$root/agent/extensions/fail-loop-resteer.ts" "$agent/extensions/fail-loop-resteer.ts" "$subagent_model" <<'PY'
import json, pathlib, sys
src, dst, model = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
text = src.read_text()
old = 'const SIDE_MODEL = "mac/side-model";'
if text.count(old) != 1:
    raise SystemExit(f"{src}: SIDE_MODEL line not found; update apply.sh")
dst.write_text(text.replace(old, f"const SIDE_MODEL = {json.dumps(model)};"))
dst.chmod(0o644)
print(f"installed {dst} (SIDE_MODEL {json.dumps(model)})")
PY

install -m 644 "$root/agent/extensions/read-before-edit.ts" "$agent/extensions/read-before-edit.ts"
echo "installed $agent/extensions/read-before-edit.ts"

install -m 644 "$root/agent/extensions/operator-pause.ts" "$agent/extensions/operator-pause.ts"
echo "installed $agent/extensions/operator-pause.ts"

install -m 644 "$root/agent/extensions/handoff-speed.ts" "$agent/extensions/handoff-speed.ts"
echo "installed $agent/extensions/handoff-speed.ts"

# Claims and evidence: done-gate (with verify_item), goal-verify, lessons, tasklist; the watcher (log mode unless settings.env says otherwise).
for ext in done-gate.ts goal-verify.ts lessons.ts tasklist.ts watcher.ts; do
  install -m 644 "$root/agent/extensions/$ext" "$agent/extensions/$ext"
  echo "installed $agent/extensions/$ext"
done
# The curated lessons. lessons-proposed.jsonl beside it holds the agent's suggestions and is never touched here.
install -m 644 "$root/agent/lessons.jsonl" "$agent/lessons.jsonl"
echo "installed $agent/lessons.jsonl"

install -m 644 "$root/agent/skills/mac-mini/SKILL.md" "$agent/skills/mac-mini/SKILL.md"
echo "installed $agent/skills/mac-mini/SKILL.md"

install -m 644 "$root/agent/RULES.md" "$agent/RULES.md"
echo "installed $agent/RULES.md"

# The side provider's URL, model id, name, and context come from settings.env.
python3 - "$root/agent/models.yml" "$agent/models.yml" "$SIDE_BASE_URL" "$SIDE_MODEL_ID" "$SIDE_MODEL_NAME" "$SIDE_CONTEXT" <<'PY'
import json, pathlib, sys
import yaml
src, dst = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
url, model_id, name, context = sys.argv[3:]


def scalar(value):
    # Plain when YAML reads it back as the same string, JSON-quoted otherwise.
    try:
        if yaml.safe_load(value) == value:
            return value
    except yaml.YAMLError:
        pass
    return json.dumps(value)


text = src.read_text()
swaps = [
    ("  mac:\n    baseUrl: http://127.0.0.1:1234/v1\n", f"  mac:\n    baseUrl: {scalar(url)}\n"),
    ("      - id: side-model\n        name: Side model\n", f"      - id: {scalar(model_id)}\n        name: {scalar(name)}\n"),
    ("        contextWindow: 32768\n", f"        contextWindow: {int(context)}\n"),
]
for old, new in swaps:
    if text.count(old) != 1:
        raise SystemExit(f"{src}: side provider line {old.strip()!r} not found; update apply.sh")
    text = text.replace(old, new)
side = yaml.safe_load(text)["providers"]["mac"]
if side["baseUrl"] != url or side["models"][0]["id"] != model_id:
    raise SystemExit(f"{src}: side provider did not round-trip; update apply.sh")
dst.write_text(text)
dst.chmod(0o644)
print(f"installed {dst} (side model {model_id} at {url})")
PY

# imagelxc reaches host Strata through the proxy on 18080. Other machines use 8080.
if [[ -x /opt/host-omp/omp ]]; then
  python3 - "$agent/models.yml" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
old = "http://127.0.0.1:8080/v1"
new = "http://127.0.0.1:18080/v1"
if old in text:
    path.write_text(text.replace(old, new, 1))
    print("strata baseUrl 18080 (imagelxc proxy)")
PY
fi

config_yml="$root/agent/strata.config.yml"
overrides=()
if [[ "$STRATA_VISION" == off ]]; then
  if [[ -z "$VISION_MODEL" ]]; then
    echo "STRATA_VISION=off needs VISION_MODEL in $settings; run scripts/strata-vision.sh off --model PROVIDER/MODEL" >&2
    exit 1
  fi
  # The coder is text-only, so omp describes images with modelRoles.vision.
  python3 - "$agent/models.yml" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
old = "        input: [text, image]\n        imageInputDecoder: stb\n        contextWindow: 262144"
if old not in text:
    raise SystemExit(f"{path}: coder input line not found; update apply.sh")
path.write_text(text.replace(old, "        input: [text]\n        imageInputDecoder: stb\n        contextWindow: 262144", 1))
print("coder input [text] (STRATA_VISION=off)")
PY
  overrides+=("vision=$VISION_MODEL")
fi
# SIDE_FALLBACK=off: a failed side-model call errors instead of continuing on
# the coder. Each fallback is a cold read on the coder and evicts its prompt cache.
[[ "$SIDE_FALLBACK" == off ]] && overrides+=("nofallback")
# SMOL_MODEL: omp's small background calls (skill routing hints and similar,
# ~400 prompt tokens) go to modelRoles.smol. On the coder each one evicts the
# coder's conversation; with --kv-persist that is a 1-2 GB save and a restore.
[[ -n "$SMOL_MODEL" ]] && overrides+=("smol=$SMOL_MODEL")
# strata.config.yml names the placeholder mac/side-model (judge, task, and its
# fallback chain); point those at SIDE_MODEL_ID.
[[ "$side_model" != mac/side-model ]] && overrides+=("side=$side_model")
# COMPACTION_MODEL: omp 18.4.4 runs handoff on the session model and blocks the
# coder for minutes. soft uses compactionModel and can run in the background,
# so soft goes first and the summary is written by that model.
if [[ -n "$COMPACTION_MODEL" ]]; then
  python3 - "$agent/models.yml" "$COMPACTION_MODEL" <<'PY'
import pathlib, sys
path, model = pathlib.Path(sys.argv[1]), sys.argv[2]
text = path.read_text()
import json, re
m = re.search(r"        contextWindow: 262144\n        maxTokens: \d+\n", text)
if not m:
    raise SystemExit(f"{path}: coder entry not found; update apply.sh")
path.write_text(text[:m.end()] + f"        compactionModel: {json.dumps(model)}\n" + text[m.end():])
print(f"coder compactionModel {model}")
PY
  overrides+=("softfirst")
fi
if (( ${#overrides[@]} )); then
  config_yml="$(mktemp --suffix=.yml)"
  trap 'rm -f "$config_yml"' EXIT
  python3 - "$root/agent/strata.config.yml" "$config_yml" "${overrides[@]}" <<'PY'
import sys, yaml
src, dst, *overrides = sys.argv[1:]
cfg = yaml.safe_load(open(src))


def rename(node, old, new):
    if isinstance(node, dict):
        return {rename(k, old, new): rename(v, old, new) for k, v in node.items()}
    if isinstance(node, list):
        return [rename(v, old, new) for v in node]
    return new if node == old else node


# The side rename runs first, so SMOL_MODEL or VISION_MODEL may name the side model too.
for item in overrides:
    if item.startswith("side="):
        cfg = rename(cfg, "mac/side-model", item.split("=", 1)[1])
        print(f"judge, task, and fallback chain on {item.split('=', 1)[1]} (SIDE_MODEL_ID set)")
for item in overrides:
    if item.startswith("vision="):
        cfg.setdefault("modelRoles", {})["vision"] = item.split("=", 1)[1]
        print(f"modelRoles.vision {item.split('=', 1)[1]} (STRATA_VISION=off)")
    elif item.startswith("smol="):
        cfg.setdefault("modelRoles", {})["smol"] = item.split("=", 1)[1]
        print(f"modelRoles.smol {item.split('=', 1)[1]} (SMOL_MODEL set)")
    elif item == "softfirst":
        cfg.setdefault("compaction", {})["methodOrder"] = ["soft", "shake", "handoff"]
        print("compaction.methodOrder soft, shake, handoff (COMPACTION_MODEL set)")
    elif item == "nofallback":
        cfg.setdefault("retry", {})["fallbackChains"] = {}
        cfg["retry"]["modelFallback"] = False
        print("retry.modelFallback false, fallbackChains cleared (SIDE_FALLBACK=off)")
yaml.safe_dump(cfg, open(dst, "w"), sort_keys=False)
PY
fi

if [[ -x /opt/host-omp/omp ]]; then
  omp_bin=/opt/host-omp/omp
elif command -v omp >/dev/null 2>&1; then
  omp_bin=omp
else
  echo "omp is not on PATH; merge agent/strata.config.yml after omp is installed"
  exit 1
fi

keys="$(mktemp)"
pairs="$(mktemp)"
trap 'rm -f "$keys" "$pairs"' EXIT
"$omp_bin" --profile=omp-strata config list --json >"$keys"
python3 "$root/scripts/config-pairs.py" "$config_yml" "$keys" >"$pairs"
while IFS= read -r -d '' key && IFS= read -r -d '' value; do
  "$omp_bin" --profile=omp-strata config set "$key" "$value"
  echo "set $key"
done <"$pairs"

echo "extensions load on the next omp-strata start"
