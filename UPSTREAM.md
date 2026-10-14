# Upstream pin

tested_omp: 18.6.1
upstream_latest_seen: v18.10.4
upstream_latest_seen_at: 2026-10-14

The profile was run on upstream omp 18.4.4 until 2026-10-06 and on 18.6.1 since. The daily check records the newest can1357/oh-my-pi release tag. It may rewrite the two `upstream_latest_seen` and `upstream_latest_seen_at` lines. `tested_omp` changes when that version has actually been run with this profile.

v18.6.0 (2026-10-03) parses DeepSeek DSML tool calls from local servers, including llama.cpp and other OpenAI-compatible hosts. The Strata model in use here is Qwen3.8-Flash-Next. The installed binary stays on 18.4.4 until that newer build is tried on purpose.

omp runs unmodified. Loop handling lives only in this profile's extension: it blocks the next identical call after 3 uses, including successes and mixed results, refuses `completion()` on the coder, and pins subagents to the side model. An earlier upstream PR for a generic failure block (can1357/oh-my-pi#14312) was withdrawn on 2026-10-05; its review findings were applied to the extension instead.

**Moving to 18.6.1 (2026-10-06).** A lab A/B ran omp 18.4.4 against 18.6.1, with the same profile and model and 2 reps of the bench tasks:

| | 18.4.4 | 18.6.1 |
|---|---|---|
| Pass | 8/8 | 8/8 |
| Mean minutes per run | 6.6 | 5.1 |
| Tool errors | 15 | 12 |
| Prefix reuse | 95.1% | 97.1% |

- **Extensions:** both load, and their hooks fire identically.
- **Subagents:** when the side model can't be reached, a subagent still spawns and falls back to the coder.
- **Running a version:** `~/.config/omp-strata/omp-path` names the binary to run, so a machine can move to 18.6.1 or roll back without a new host mount.

