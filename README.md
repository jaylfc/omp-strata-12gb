# omp-strata-12gb

Profile for [oh-my-pi](https://github.com/can1357/oh-my-pi) pointed at one local [Strata](https://github.com/Niko1221/Strata) server. Install the upstream `omp` binary, then apply this profile on top. The running agent keeps using that upstream binary. This repo is the guide for that one-machine setup, not a second client fork. omp itself runs unmodified; every change lives in this profile.

The focus is a single card on one machine. Our setup also includes a Mac mini M4 with 24 GB, and we are experimenting with offloading judge calls, subagent chat, and subagent image reviews to it. Coding, handoff, smol, and the main session's screenshot questions stay on the Strata card. An install with no second machine does that work on the card.

Tested on omp 18.6.1 (and earlier 18.4.4) with `qwen3.8-flash-next-coder-iq1_m`, a 262144 context, and one request in flight. Upstream is ahead of that pin. See [UPSTREAM.md](UPSTREAM.md).

Measured results behind these settings (thinking level, sampling, compaction, engine, loop guard) are in [FINDINGS.md](FINDINGS.md). The short version: medium thinking with a 3072-token budget, Qwen's thinking sampling instead of Strata's greedy default, and compaction at 98304 tokens with a 40000-token recent window.

## Updates come from this repo

The running profile is this repository. `scripts/apply.sh` installs it into `~/.omp/profiles/omp-strata`, then merges `agent/strata.config.yml`. Extensions load at process start. When a new commit changes `agent/` or `bin/`, `self-update.sh` runs `~/.config/omp-strata/restart-hook` if that file is executable, so a long-running session can restart itself with `--continue`; without a hook it logs that a restart is needed. Commits that touch only docs, such as the daily `UPSTREAM.md` pin, do not run the hook.

`omp` stays the upstream command and keeps using `~/.omp/agent`. `omp-strata` is `omp --profile=omp-strata` with this profile. `omp-strata update` pulls this repo. `omp update` stays the upstream updater.

`startup.checkUpdate` is false on the profile, so `omp-strata` does not offer upgrades from `can1357/oh-my-pi`. The host timer `omp-strata-update.timer` runs `scripts/host-self-update.sh` hourly inside imagelxc. The omp program itself stays the tested upstream binary. [UPSTREAM.md](UPSTREAM.md) only records that upstream tag. It does not install it.

RTK's generated `extensions/rtk.ts` is not in this repo. `rtk init` writes it, and a later RTK release replaces it.

## Why these changes exist

Strata here serves one request at a time and keeps one prompt-cache prefix. The log line is `prompt N tokens = R reused + M read in M ms`. A different request in the middle (a subagent on the same server, a title, a judge call, a compaction handoff) makes the next coder turn cold. Decode is about 17–25 tokens/s. A cold prefill of 100k–160k tokens has taken minutes. Repeated identical tool calls cost the same.

The coder stays the main model. Coding, the main session's screenshots, handoff, and smol all run on it, which is the path for a single card. Judge, subagent chat, and a subagent's image review are the Mac mini experiment below: they try that machine when it is configured, and they continue on the coder when it does not answer.

## Every setting

| Piece | Value | Why |
| --- | --- | --- |
| Provider id | `strata` | omp 18.2.7 and newer reserves the provider id `local` for tiny on-device models. |
| `baseUrl` | `http://127.0.0.1:8080/v1` | Strata's own port. Inside imagelxc, `apply.sh` rewrites the installed copy to `http://127.0.0.1:18080/v1`, the proxy onto host `127.0.0.1:8080`. Strata itself still listens on the host port only. |
| `api` / `auth` | `openai-completions`, `auth: none` | Matches the local server. `auth: none` still counts as a configured credential, so omp will actually call it. |
| `compat.qwenTemplateReasoningEffort` plus `extraBody.reasoning_effort: medium` and `reasoning_budget_tokens: 3072` | capped coder thinking | With thinking off, the coder reacted only to its latest observation and ran loops such as a three-step edit cycle 39 times (experiment 001). In a 40-run bench on 2026-10-05 every thinking arm passed 8/8; medium with a 3072 budget tied low/1536 on time (29.2 vs 29.1 min) with the fewest tool errors (13) and output tokens. Qwen's card warns that low effort leads to repeated retries in agent work, and Strata's low effort adds a "keep your thinking brief" nudge. Strata's hard budget closes the thinking at 3072 tokens and the answer gets the rest of `maxTokens`. `extraBody` is applied after the template, so it wins on an existing session. |
| Coder `input` | `[text, image]` | The coder pack keeps vision. `imageInputDecoder: stb` makes omp send PNG or JPEG. `scripts/enable-strata-vision.sh` turns the encoder on and reserves 700 MiB, which is what fits the encoder beside the expert cache on a 12 GB card. A vision call uses the coder's only slot. `scripts/strata-vision.sh off` makes it `[text]` and sends images to another model (see Vision on or off). |
| Coder `contextWindow` | `262144` | The server is started with `--max-context 262144`. |
| Coder `maxTokens` | `7168` | Up to 3072 thinking tokens plus room for a file-sized answer. Measured answers without thinking stayed well under 4096. |
| `providers.maxInFlightRequests.strata` | `1` | A second in-flight call on this server is the thing that drops the prefix. |
| `title.refreshOnReplan` | `false` | A title call is another request. Also launch with `--no-title`. |
| `provider.appendOnlyContext` | `on` | New turns append to the cached prefix instead of rewriting it. A healthy turn then reads a few dozen new tokens. |
| Compaction method | `shake`, then `handoff`, then `soft` | Shake drops recoverable tool output and makes no model call. Handoff is the model summary. Soft is the local fallback. In omp 18.6.1 shake rewrites the history before it checks the result: when the remainder is still above 80% of the threshold it moves on to handoff, and the handoff is built from the rewritten history. `handoff-speed.ts` puts the unrewritten messages back (see Handoff speed). A shake that succeeds still makes the next turn read about 65–70K tokens cold, and it defers a handoff by 20–90 minutes. |
| Coder sampling | `temperature 1.0`, `top_p 0.95`, `top_k 20` in the strata provider's `extraBody` | Strata decodes greedily when a request carries no temperature, and omp sends none by default. Greedy decoding repeats itself exactly: on 2026-10-05 the coder wrote the same one-line thought 267 times in an hour, each followed by the same file read, and steering did not break it. These are the Qwen3.8 card's thinking-mode values. With them the loops stopped; decode fell from about 19 to about 15.5 tok/s, because the speculative drafts are still greedy. |
| `compaction.thresholdTokens` | `98304` | Below this, no compaction runs. On 2026-10-04 a 32000 threshold handed off four times in half an hour; each summary took 140–225s on Strata. On 2026-10-05 a 65536 threshold with a 20000 recent window made a mid-run shake fire every ~3 minutes while the model planned from about 20 files (~25K tokens): each shake dropped files it had just read, and it read the same files 7–9 times in an hour without editing. A cached read stays at 1–3s; a cold 98,304-token read takes about 100s. |
| `compaction.keepRecentTokens` | `40000` | The recent tail stays verbatim and shake leaves its tool output alone, so the files the model is working from survive. The summary replaces what is older. |
| `compaction.midTurnEnabled` | `true` | Compaction can run in the middle of a turn, so a long tool loop does not wait for the turn to end. |
| `compaction.asyncEnabled` | `true` | A speculative summary can arm before the threshold. A mid-turn handoff that is not already armed still runs inline on the coder. With `methodOrder` led by shake it has not armed since 2026-10-04 (no `Speculative compaction armed` in the omp logs), so on one slot it neither helps nor costs. |
| Artifact spill | `tools.artifactSpillThreshold`, `artifactHeadBytes`, `artifactTailBytes` all `10` | These are kilobytes. Large tool output leaves the prompt. The head and tail that remain are short. |
| `defaultThinkingLevel` | `medium` | Matches the provider's `reasoning_effort: medium`; the budget above is the hard limit. |
| `RULES.md` | caveman lite, ponytail lite, git, webcheck, and completion() | Re-sent every turn, so it stays short. Code, commands, paths, numbers, and error strings stay verbatim. |
| Repeated calls | extension, after 3 identical arguments | The next identical call is refused whether the earlier calls failed, succeeded, or mixed. A pure failure streak tells the model to determine why, and includes the oldest failure text. Emitting that same call again steers the session (`pi.sendUserMessage`, `deliverAs: "steer"`): the first steer asks for the cause and a different approach, the second tells the model to drop the step and move to the next item of the goal. Later repeats keep getting the second steer. The guard never aborts, because in omp an abort pauses the goal and stops the autonomous run. `read`, `grep`, `glob`, `find`, and `ls` may repeat up to 6 times in a row while they succeed, since after compaction or output trimming the model needs the same file again (without a cap one session read the same six lines 164 times); repeated failures of those tools are still refused. A cycle of 2–4 calls repeated three times in a row (A, B, A, B, A, B or A, B, C three times) is refused on its next step, with the cycle listed. A second check watches file state: omp stamps each edit result with the file's hash, and when edits bring a file back to the same earlier version twice, the next edit to that file is refused until the model commits or makes 15 other calls. In experiment 001 a three-step cycle (add a hint line, delete the duplicate, restore it) ran 39 edits; the file hash went #9EDB, #0A73, #4FD0 and back each time. Replayed through the guard, it stops at edit 8 with results visible and at edit 10 when shake had hidden them. A text turn does not reset the counter, and `--continue` rebuilds it from the session. The extension's own refusals do not count as runs. `wait`, `job`, `irc`, `yield`, `todo`, `goal`, `verify_item`, and `lesson_propose` (also as `xd://` writes) may repeat. The signature ignores `i` and `__intent`. |
| Handoff speed | `handoff-speed.ts`, on (`OMP_STRATA_HANDOFF_SPEED=on`, `prefix`, or `off`) | On the handoff request only: restores the messages as the last coder turn sent them, so Strata reuses its cached prefix; asks for a document under 8,000 characters; caps the handoff's thinking at 1024 tokens. Details in Handoff speed. |
| Read before edit | `read-before-edit.ts`, log-only (`OMP_STRATA_READ_GUARD=log`) | Covers what omp's `edit.enforceSeenLines` does not: a replace-mode edit (`old_string`) to a file the model has not seen this session, and a `write` over an existing file it has not seen or that changed on disk since. A file counts as seen when a result displayed it (`[path#TAG]`), a read or the model's own edit or write succeeded, or a bash viewing command (`cat`, `head`, `tail`, `sed -n`, `grep`, `rg`, ...) named it. Hashline edits pass through. `on` refuses with the exact `read` to run and lets the same call through on its third try; `log` only logs `read-before-edit would refuse`; `off` disables it. It stays at `log` until a bench A/B shows it helps. |
| Operator pause | `operator-pause.ts`, `scripts/omp-pause.sh` | In goal mode one omp turn is a whole agent run, and `/goal pause` only applies when it ends; Esc aborts the step that is generating. `scripts/omp-pause.sh pause` creates `~/.config/omp-strata/pause-requested`, types `/goal pause`, and waits for omp to be idle. While the file exists the extension refuses each tool call before it runs and asks the model for a three-sentence status, so the run ends at the next step with nothing lost. `scripts/omp-pause.sh resume` resumes. It never presses Esc. |
| Done gate | `done-gate.ts`: goal on, todo log, scope on, evidence `verify` | `todo done` and `goal complete` need evidence after the item opened and after the last file change. By default that evidence is the item's latest `verify_item` run, with exit 0. Without it the call is refused with the exact `verify_item` call to make. The same item goes through on its third try and logs `done-gate: overridden`. A `done` that names items in `items`/`list` without `task` or `phase` is rewritten to one task or one phase, or refused, because omp would mark every open task done. See Claims and evidence. |
| `verify_item` | tool in `done-gate.ts`, `xd://verify_item` | Runs one item's probe (`bash -lc`, `pipefail`, 120 s default and 600 s maximum, process group killed afterwards) and returns the exit code and the last 40 lines. It refuses commands that only print, list, read, or syntax-check. |
| Verify before goal complete | `goal-verify.ts`, on | The first `goal complete` of each goal is refused with the objective and a checklist: one `verify_item` per acceptance criterion. The goal completes only when the latest run of every criterion exited 0 and no newer reply has a FAIL line. It refuses 3 times at most per goal. |
| Lessons | `lessons.ts`, `agent/lessons.jsonl`, on | Short rules shown once per session, at most 3 at a time, after a read, edit, write, bash command, or todo/goal call that matches their tags. `lesson_propose` saves a suggestion to `lessons-proposed.jsonl` only after a probe failed in the session. |
| Constraint pinning | `handoff-speed.ts`, on (`OMP_STRATA_PIN`) | After each compaction, one hidden note: the goal objective verbatim, the item in progress, and RULES.md when the system prompt lacks it. |
| Watcher | `watcher.ts`, log-only (`OMP_STRATA_WATCHER=log`) | Every 8 tool results (or 10 minutes into an active run) builds a digest of the current item, the last 12 calls, edits, commits, probes, repeats, guard events and done claims, and asks a second model on another machine for a typed verdict: progressing, looping, drifting, stuck on the environment, overclaiming, or waiting. It never calls the coder's server, never blocks a tool, and in `log` mode never touches the session; every check goes to `~/.config/omp-strata/watcher.jsonl` with the rule baseline beside it. See Watcher. |
| Game probes | 3 per script since the last edit or write | `where.mjs`, `touchprobe.mjs`, `menutest.mjs`, and the other `cinderline/tools/*.mjs` probes share a count even when the shell pipeline changes. `describe.mjs` is refused. A screenshot question in the main session is `read <path>?q=<question>` on the coder. In a subagent, that read stays on the subagent's model. `judge()` tries the Mac, then the coder. |
| `completion()` | refused | That eval helper calls the coder and replaces the prefix. |
| Browser eval pre-flight | refused before running | `browser.open("url")` with a string, and `tab.run(() => …)` that touches `document`, `window`, or `fetch` (it runs in Bun, not the page). The refusal shows the accepted form and points at `webcheck`. In a replay of 327 real eval cells from 2026-10-04 these two rules matched 50 of the 133 failures and none of the successes. |
| `webcheck` | `tools/webcheck`, linked into `~/.local/bin` | One bash command loads a page in headless Chromium with a device (`--device iphone14promax`, `--landscape`, `--standalone` for an installed PWA), runs `--wait`, `--tap X,Y`, `--click`, `--key`, `--eval`, and `--shot` in order, and prints JSON: status, console errors, page errors, eval values, and the element under each tap. A small model gets a real browser without writing async code. Needs Node.js and a Chromium binary (`WEBCHECK_CHROME` overrides the path). |
| `judge()` | allowed | It uses `modelRoles.judge`. With no judge role configured, the call errors; the 3-repeat block then stops a retry loop. |
| Subagents | pinned or refused | See the side-model section. |
| RTK 0.51.0 | installed by `rtk init`, not vendored | Strips shell noise from context. omp needs `rtk` on `PATH` (0.23.0 or newer). |
| Prompt cache | left on | `--prompt-cache 0`, `--adapt-swaps 0`, and `--pcie-frac 0` disable it. This profile does not do that. |

Personal theme, symbol preset, and setup version are not part of the profile. `apply.sh` merges keys and leaves those alone.

## Handoff speed

Measured on 2026-10-05 and 2026-10-06 (the Strata engine log and the session's `compaction` entries): an automatic handoff took 6–9 minutes. Ten of eleven handoff requests read 33K–83K tokens cold first (36–82 s), and a complete one then decoded 4.0K–6.6K tokens at 12–14 tok/s (280–475 s). Thinking was small: the 13:28Z handoff thought for about 70 tokens and wrote 4.6K tokens of document. The documents were 13.7K–21.5K characters, of which about 2.8K is the file list omp appends.

The cold read came from shake. Every cold handoff followed a shake that elided old tool results and fell short of the threshold; the one handoff with no shake before it (2026-10-05 15:15Z) reused 98,582 of 99,925 tokens and read the rest in 3.5 s. The handoff request is built from the session's messages after shake rewrote them, so the server's prefix ended at the first elided result, usually right after the system prompt (8,845 or 9,060 reused).

`agent/extensions/handoff-speed.ts` acts on `before_provider_request`, only when the last message is omp's handoff instruction:

- It remembers each coder turn as sent (requests with tools). On the handoff it puts back those messages in place of the rewritten ones and keeps the handoff's newer messages after them. It does this only when every remembered message matches the handoff's message at the same position by role and tool call ids; otherwise the request goes out unchanged. The handoff then summarizes the full history, and the prefill is the last reply, its tool results, and the instruction: a few seconds.
- It appends a length limit to the instruction: under 8,000 characters, Goal, In Progress, Pending, Next Steps, decisions, and error text in full, Done one line per item with files and commit hash. The newest `keepRecentTokens` (40,000) stay verbatim after the document, so it does not need to restate them.
- It sets `reasoning_budget_tokens` to 1024 for the handoff. On 2026-10-06 06:29Z a handoff spent its whole 3072-token budget thinking, returned no document, and the soft fallback took another 7.6 minutes. `reasoning_effort` is not touched: Strata renders it into the system prompt, so changing it would make the whole request cold.

Expected per handoff, from those numbers: about 65 s less prefill and about 130 s less decode (a 14K-character document becoming 8K), so roughly 3 of the 6–9 minutes. The turn after a handoff still reads its new history cold (about 35–40 s). Every handoff logs `strata handoff-speed: handoff request` in the omp log with `prefixRestored`, `rewrittenMessages`, and the limits. `OMP_STRATA_HANDOFF_SPEED=prefix` keeps only the prefix restore; `off` disables the extension.

Shake stays first. Over 12.5 hours on 2026-10-06 it succeeded five times (each one a cold read of about 68 s on the next turn) and preceded eight handoffs. Without it the same work would need about two more handoffs, which costs about as much as the cold reads it causes. A lower threshold would give more handoffs of similar length.

## Claims and evidence

On 2026-10-06 the coder declared nine goal items done; an independent check found 3 PASS, 4 PARTIAL, and 2 FAIL (FINDINGS.md, Claims of done). Three extensions turn "done" into a claim that needs evidence.

**`done-gate.ts`** keeps a record from tool results: when each todo item opened (its first appearance in a todo result), when a file last changed (`edit`, `write`, `ast_edit`; `xd://` and `proc://` writes do not count), and every `verify_item` run.
- With `OMP_STRATA_DONE_EVIDENCE=verify` (the default), `todo done` needs that item's latest `verify_item` run (the `task` is matched to the exact todo text, ignoring case and spacing) to have exited 0 after the item opened and after the last file change. `goal complete` needs at least one run since the last change, and the latest run of every task since then must have exited 0.
- With `=probe`, a heuristic probe is enough: a bash command that executes something (a test runner, `curl`, `webcheck`, a script named like `*test*`, `*probe*`, `*verify*`, `*check*`, `*smoke*`, `*sim*`, or inline `node -e`/`python -c` that imports code), run in the foreground, exit 0, and no failure lines. A background job counts once its result arrives with exit code 0. `node --check`, `tsc`, lint, git, ls, cat, and grep never count.
- Every decision logs `heuristicWouldPass`, so a live run shows where the two rules disagree.
- A refusal names the items and the `verify_item` call to make. The same item refused twice goes through on the next try and logs `done-gate: overridden`.
- `done` or `drop` that names items in `items` or `list` without `task` or `phase` is rewritten to `task` (one item) or `phase` (a whole phase). Otherwise it is refused, since omp ignores those fields and would mark every open task.

**`verify_item`** takes `task` (the exact todo text or a criterion), `command`, and optional `timeout_seconds`. omp 18.6.1 lists extension tools as devices, so the model writes the arguments as JSON to `xd://verify_item`. When `command` is left out, it reruns the task's last command, or a command in backticks in the task text. The extension runs the command itself and returns `verify_item PASS|FAIL exit=N task="…"`, the command, the time, and the output tail. The verdict is the exit code, not the model's reading of the output. Commands that only print, list, read, or syntax-check are refused. `fail-loop-resteer.ts` lets `verify_item` repeat, because rerunning a probe after a fix is not a loop.

**`goal-verify.ts`** refuses the first `goal complete` of each goal with the objective and a checklist: list each acceptance criterion and run each through `verify_item`. The next attempt goes through only when, since the checklist, the latest run of every criterion exited 0 and no reply newer than the last run has a FAIL line. A heuristic probe counts only when no `verify_item` ran. After 3 refusals the call goes through and logs `goal-verify: overridden`. `/goal complete` typed by the operator is not checked. The probes run outside the coder's context; the round that lists the criteria runs in it, because omp 18.6.1 gives extensions no fresh context that can run tools.

**`lessons.ts`** reads `agent/lessons.jsonl`, one JSON object per line: `id`, `tags`, `lesson` (under 320 characters), `source`, `added`. Tags are `path:<glob>` (a file read, edited, or written, or a path in a bash command), `cmd:<regex>` (a bash command or eval cell), `text:<regex>` (a read file's text or an edit's new text), and `topic:<regex>` (a todo or goal call). After a matching result, up to 3 lessons not yet shown in the session are added as `[lesson ID] …`; a restart re-reads the session and skips them. The seed lessons come from the 2026-10-06 verification and the lab journal. `lesson_propose` (`xd://lesson_propose`) appends `{tags, lesson, evidence, probe}` to `agent/lessons-proposed.jsonl`, but only after a probe failed in the session: a `verify_item` or probe command with a non-zero exit. A gate's refusal does not count. A person (or Claude) moves good proposals into the repo's `agent/lessons.jsonl`. The extension never writes `lessons.jsonl`, and `apply.sh` never touches the proposals.

**`tasklist.ts`** mirrors the omp todo state into a local ledger (`.omp-strata/tasks.json`, gitignored). The ledger is output only: on session start, session switch and first use it is rebuilt from the session branch, like `done-gate.ts`, and the file is never read back. After every `todo` result and `verify_item` run it rewrites the ledger atomically (temp file, then rename) with items, status, probes and verification history. On the first successful `todo init` of a goal it checks the objective (the goal's, else the first user message, never assistant text) for enumerated items (numbered lines, bullets, `N.` and `(a)` forms); if the init lists fewer, or an enumerated item shares no content word with any listed item, the refusal text reaches the coder as additional context on the next tool call and asks for `todo append`. The check runs once per goal; a later init is only logged. Every 6th tool call, and on the call after a `todo` result that changed the active item, it injects the open items with the active item and its probe marked: `Open tasks (2 of 6 done). Now: <active>. Check: <probe>` followed by the open items as checkboxes. Repeats are re-emitted byte-identical: omp dedupes additional context only within one tool batch, and identical bytes keep the prefix stable. A new device `xd://tasklist_probe` sets or updates an item's probe; print/list/syntax-only commands are refused via `done-gate`'s `verifyCommandProblem`. When `verify_item` is called without `command`, the ledger probe for that item is used before falling back to the last command or backticks in the task text. `fail-loop-resteer.ts` treats `tasklist_probe` as repeatable. Switch: `OMP_STRATA_TASKLIST` = `log` (default), `on`, `off`. In `log` mode the ledger is written and what would be injected is logged (`tasklist: would inject`), but nothing is sent.

**Constraint pinning** (`handoff-speed.ts`, `session_compact`): after each compaction, one hidden message with the goal objective verbatim (up to 1,500 characters), the todo item in progress and the open count, and RULES.md verbatim if the system prompt does not already contain it. omp re-sends RULES.md in the system prompt, so in practice the note is the goal and the item, about 300 characters. It goes in as a steer mid-run, or before the next turn when idle.

| Switch | Values (default first) | Effect |
| --- | --- | --- |
| `OMP_STRATA_DONE_GATE_GOAL` | `on`, `log`, `off` | Evidence gate on `goal complete`. |
| `OMP_STRATA_DONE_GATE_TODO` | `log`, `on`, `off` | Evidence gate on `todo done`. `log` writes `done-gate: would refuse` and changes nothing. |
| `OMP_STRATA_TODO_SCOPE` | `on`, `log`, `off` | The `items`/`list` rewrite or refusal. |
| `OMP_STRATA_DONE_EVIDENCE` | `verify`, `probe` | What counts as evidence (above). |
| `OMP_STRATA_GOAL_VERIFY` | `on`, `log`, `off` | The checklist round on `goal complete`. |
| `OMP_STRATA_LESSONS` | `on`, `off` | Lesson notes and `lesson_propose`. `OMP_STRATA_LESSONS_FILE` and `OMP_STRATA_LESSONS_PROPOSED` override the paths. |
| `OMP_STRATA_TASKLIST` | `log`, `on`, `off` | Ledger mirror, list check, re-injection, probe map. `log` writes the ledger and logs what would be injected. |
| `OMP_STRATA_PIN` | `on`, `off` | The note after compaction. `OMP_STRATA_RULES_FILE` overrides the RULES.md path. |

Set them in the environment that starts `omp-strata`. Every decision is logged in the omp log as `done-gate: …`, `goal-verify: …`, `lessons: …`, or `strata pin: …`. To see what the coder was told, look for `<system-interrupt reason="done_gate">` and `reason="goal_verify"` in the session.

The watcher (below) can arm the done gate: in steer mode one overclaiming verdict makes the next `todo done` go through the gate as if it were `on`.

Deferred: a verifier in a fresh context (a `task` subagent, or the side model); lesson weights, a byte budget, and a probing curator; and a 3-rep bench A/B before `OMP_STRATA_DONE_GATE_TODO=on`.

## Watcher

`agent/extensions/watcher.ts` judges the coder's progress from outside, on a second machine, so it never takes the coder's single Strata slot or its prefix cache. The design, the labelled replay set and the model bake-off are in the lab, experiment 026.

- **When.** Every `OMP_STRATA_WATCHER_EVERY` tool results (8), or after `OMP_STRATA_WATCHER_MINUTES` (10) while a run is active. One check at a time, in the background, with a 90 s timeout; a tool result never waits for it.
- **What it sees.** A digest computed from the session branch: the goal, the current todo item and its time, edits and files, commits, probes passed and failed, scripts written on the item, repeats without a file change between them, loop-guard events and other refusals, environment errors, waits, every `todo done` or `goal complete` with or without a passing probe after the last edit, and the last 12 calls with their outcome. Passwords, tokens and keys are redacted before it leaves the machine.
- **Who answers.** `OMP_STRATA_WATCHER_API`:
  - `chat` (default): an OpenAI-compatible model answering JSON `{state, confidence, steer}`. With no `WATCHER_URL`/`WATCHER_MODEL` it uses `SIDE_BASE_URL`/`SIDE_MODEL_ID` from settings.env, i.e. the Mac side model.
  - `system1`: a decision model on llama.cpp `/v1/systemone` (for example Kev-4B). One described choice over the six states, option order shuffled per call; the steer is a template chosen by the state.
  - `rules`: no model, the computed-facts baseline. It is also the fallback when the endpoint fails.
  - `cascade` (the default when `WATCHER_S1_URL` names a System One endpoint, for example Kev-4B on `/v1/systemone`): the rules and the System One model flag first. Overclaiming is flagged on one verdict from either. Any other problem needs the rules to flag it and two System One verdicts in a row (threshold `WATCHER_S1_THRESHOLD`, 0.3). The chat model is then asked only about the non-overclaiming flags: it confirms (any problem state) or vetoes (progressing or waiting), and its line is the steer. Overclaiming flags stand, since the done gate backstops them. On the lab 026 held-out windows this caught 11 of 16 with 3 false alarms in 15, against 13/16 and 5/15 for the flag alone and 9/16 and 1/15 for the chat model alone. Over the whole replayed session it halved the alarms outside documented episodes (0.48 to 0.26 per active hour). The chat model ran on 29% of checks (median 15.5 s each).
- **Modes.** `OMP_STRATA_WATCHER`:
  - `log` (default): logs only. Each row in `watcher.jsonl` has the digest, facts, verdict, latency, the rule baseline's verdict, and what steer mode would have done.
  - `steer`: sends one steer line (`Watcher (<state>, NN%): …`) only after two consecutive checks agree on the same non-progress state at or above the threshold, at most once per `OMP_STRATA_WATCHER_STEER_GAP_MIN` minutes (15). A looping verdict is left to the fail-loop guard when the guard fired in the window. One overclaiming verdict at or above the threshold arms the done gate: the next `todo done` is checked as if `OMP_STRATA_DONE_GATE_TODO=on`, once, within 30 minutes.
  - `off`.

| Switch (environment) | settings.env key | Default |
| --- | --- | --- |
| `OMP_STRATA_WATCHER` | `WATCHER_MODE` | `log` |
| `OMP_STRATA_WATCHER_API` | `WATCHER_API` | `chat` |
| `OMP_STRATA_WATCHER_URL` | `WATCHER_URL` | `SIDE_BASE_URL` |
| `OMP_STRATA_WATCHER_MODEL` | `WATCHER_MODEL` | `SIDE_MODEL_ID` |
| `OMP_STRATA_WATCHER_THRESHOLD` | `WATCHER_THRESHOLD` | chat 0.9, system1 0.4, rules 0.7 (fitted on the 026 train split) |
| `OMP_STRATA_WATCHER_EVERY` / `_MINUTES` / `_TIMEOUT_S` / `_STEER_GAP_MIN` | `WATCHER_EVERY` / … | 8 / 10 / 90 / 15 |
| `OMP_STRATA_WATCHER_LOG` | `WATCHER_LOG` | `~/.config/omp-strata/watcher.jsonl` |
| `OMP_STRATA_WATCHER_S1_URL` | `WATCHER_S1_URL` | unset (set it to enable `cascade`) |
| `OMP_STRATA_WATCHER_S1_THRESHOLD` | `WATCHER_S1_THRESHOLD` | 0.3 |

Every check also logs `watcher: verdict` in the omp log.

Measured on 417 replayed windows of the 2026-10-03 to 10-06 Cinderline session, scored on 31 frozen held-out windows (lab experiment 026):
- The computed-facts rules caught 10 of 16 problem windows, with 3 false alarms in 15 ok windows.
- Kev-4B Q4_K_M on `/v1/systemone` caught 9 of 16 with 2 false alarms, at 4.5 s per check and +3.6–4.3 GB on the Mac.
- Gemma 4 12B on the side model caught 7 of 16 with no false alarms, at about 15 s per check under live traffic.

Start in `log` mode on the side model. Steer mode waits for a week of labelled log rows.

## Vision on the coder

`modelRoles.vision` is `strata/qwen3.8-flash-next-coder-iq1_m`. `read <path>?q=<question>` uses that role. The coder pack is the GSQ-RCO Coder quant, which keeps the vision pathway. Strata reads pictures with a separate `strata-vision` process and the coder repo's `mmproj-Qwen3.8-Flash-Next-BF16.gguf` (about 0.9 GB). That is not a switch to the full unpruned model.

`scripts/enable-strata-vision.sh` downloads that projector, compiles `strata-vision` when the local engine was built without it, and writes two things into `strata-coder-iq1_m.json`: a `vision` section (`gpu: true`, `max_tokens: 1024`) and `--vision --vram-reserve-mib 700` on the engine. The encoder starts before the engine and holds about 1.2 GB. The 700 MiB reserve is what Strata leaves so a 12 GB card still fits the expert cache. Text decode is a few percent slower. A running server does not pick this up until it is restarted (`--restart` does that when the server is idle).

A vision call is a request on the only coder slot, so the following turn misses the prompt prefix. Handoff stays on the coder. Leave `compactionModel` unset.

That path is the main session. omp 18.4.4 answers `read <path>?q=<question>` with `modelRoles.vision` through a direct call. A busy Strata provider waits in `providers.maxInFlightRequests`. A subagent's copy of the extension rewrites that read so the image comes back to the subagent's own model. While the subagent is on the Mac, the review runs there and the coder keeps its slot. After a failed Mac request has continued the subagent on the coder, the same read returns the image on the coder. A one-machine install still answers the main session's screenshot questions on the card.

`install.sh` runs the vision script when `STRATA_DIR` or `~/Strata` contains a Strata checkout. The omp profile still installs if that checkout is absent.

### Vision on or off

Vision on the coder is the default, because a one-machine install has no other model to read pictures. With a second model that accepts images, you can turn the coder's encoder off. The 12 GB card then gives the encoder's VRAM (about 1.2 GB with the 700 MiB reserve) to the expert cache, and screenshots stop taking the coder's only slot.

```bash
# Images on the coder (default)
bash scripts/strata-vision.sh on --restart
# Images on another model from models.yml; the coder is text-only
bash scripts/strata-vision.sh off --model mac/side-model --restart
```

The choice is saved in `~/.config/omp-strata/settings.env` (`STRATA_VISION`, `VISION_MODEL`), so `apply.sh`, `install.sh`, and updates keep it. With `off`, `apply.sh` sets the coder's `input` to `[text]` and `modelRoles.vision` to `VISION_MODEL`. omp then describes tool screenshots with that model, and `read <path>?q=` goes there. The Strata half edits `strata-coder-iq1_m.json` (it keeps the previous file as `.json.vision-on`), and `--restart` restarts the running server through `scripts/restart-strata.sh`. When Strata and omp run on different machines, run the script on each with `--server-only` or `--profile-only`.

`SIDE_FALLBACK=off` in the same file stops judge and subagent calls from continuing on the coder when the side model fails. Each such fallback is a cold read of an 8–12K-token subagent prompt on the coder, and it evicts the main session's cached prompt, so the next main turn re-reads 55–61K tokens (about a minute on a 3060). With the coder's vision off, a fallback review also cannot see the screenshot. Leave it on for a one-machine install.

`COMPACTION_MODEL=<provider/model>` in the same file moves compaction to that model: `apply.sh` sets the coder entry's `compactionModel` and puts `soft` first. Measured on 2026-10-04 with a 12B side model on a base M4, a mid-turn `soft` compaction of a 74K-token session blocked the coder for 14 minutes (a cold read of about 54K tokens on the Mac plus a 14K-character summary at about 14 tok/s). The coder's own `handoff` took about 6 minutes on the same session size. In omp 18.4.4 a mid-turn compaction does not run in the background, so leave this unset unless the side model reads and writes faster than the coder. If you do set it, the model's loaded context must hold the span older than `keepRecentTokens` (about 45K at a 65536 threshold) plus its summary.

## The Mac mini experiment

Our development setup includes a Mac mini M4 with 24 GB alongside the 12 GB Strata card. Offloading judge calls, subagent chat, and subagent image reviews to that Mac is an experiment. The repo's focus stays the single card. Coding, the main session's screenshots, handoff, and smol run on `strata/qwen3.8-flash-next-coder-iq1_m`, and an install with only that server still codes, reads screenshots, and compacts. Handoff stays on the coder. Leave `compactionModel` unset.

`modelRoles.smol` is the coder. omp uses that role to compress a skill description into one routing hint of at most 12 words and 160 characters, and small background calls use it when no separate tiny model is set. The call does not walk `retry.fallbackChains` and stops after 30s. On 2026-10-04 a 108-token mac-mini prompt took 1.6–2.2s warm on the coder and 3.6–3.7s on the Mac. Both answers were 14 or 15 words, so omp kept the plain preview. The role stays on the coder, which is the machine a single-card install has. After the skill text changed, one cold coder call (108 prompt tokens, 19 generated, about 3.7s) returned `Use Mac mini for judge() and subagents; main-session screenshots use read ?q=`. That line is 12 words and 77 characters, so omp cached it. The same description does not call the coder again. A compression still uses the coder's only slot. Titles stay off (`--no-title`, and `title.refreshOnReplan: false`). `SMOL_MODEL=<provider/model>` in `~/.config/omp-strata/settings.env` moves that role to another model when one is available. Each smol call on the coder evicts its conversation; with `--kv-persist` that means a 1–2 GB save and a restore, measured at 31 saves (48 GB) in four hours of goal work.

`agent/models.yml` has the side provider for that experiment: provider `mac`, an optional second OpenAI-compatible machine (we use LM Studio on a Mac mini). The repo ships placeholders, `http://127.0.0.1:1234/v1` and model id `side-model`. `apply.sh` fills the installed copy from these keys in `~/.config/omp-strata/settings.env`:

| Key | Default | What it sets |
| --- | --- | --- |
| `SIDE_BASE_URL` | `http://127.0.0.1:1234/v1` | The side provider's `baseUrl`. |
| `SIDE_MODEL_ID` | `side-model` | The model id. `modelRoles.judge`, `modelRoles.task`, the fallback chain, and the extension's `SIDE_MODEL` become `mac/<id>`. |
| `SIDE_MODEL_NAME` | `Side model` | The display name. Quote it when it has spaces. |
| `SIDE_CONTEXT` | `32768` | `contextWindow`. Match the context the server actually loaded. |
| `SIDE_SUBAGENTS` | `on` | `off` installs the extension with `SIDE_MODEL = ""`, which refuses subagents. |

`apply.sh` stops before installing anything when `VISION_MODEL`, `SMOL_MODEL`, or `COMPACTION_MODEL` names a `mac/` model other than `mac/<SIDE_MODEL_ID>`. A single-card install can leave the provider unused. Judge and subagent calls continue on the coder when the side machine does not answer.

| Role | Where it runs |
| --- | --- |
| `modelRoles.vision` | The Strata coder, for the main session. A subagent's `read <path>?q=<question>` stays on the subagent's model. |
| `modelRoles.judge` | The Mac first, then the coder. `judge()` and `judgeBatch()`. |
| `modelRoles.task` | The Mac first, then the coder. The bundled task agent (`@task`). |
| `modelRoles.smol` | The Strata coder. Skill compression and other small calls. |
| Coder `compactionModel` | unset. Handoff uses the session model. |

`SIDE_MODEL` in `agent/extensions/fail-loop-resteer.ts` is the placeholder `mac/side-model`. `apply.sh` installs the extension with `mac/<SIDE_MODEL_ID>` in its place, so every subagent, including eval `agent()`, is pinned to the side model. `SIDE_SUBAGENTS=off` installs it as `""`, which refuses subagents when that provider is gone. Edit `settings.env` rather than the installed file: `apply.sh` overwrites it.

`retry.fallbackChains` lists the coder under that Mac model and under `judge` and `task`. Smol is already the coder, so it has no chain. The Mac is still the first try for judge and subagents. When the request fails, omp continues it on the coder. That uses the coder's only slot, so the next coder turn reads the prompt cold. `retry.fallbackRevertPolicy` stays `cooldown-expiry`, so a later call tries the Mac again after the suppression window.

On 2026-10-04 our side model changed from a dense 27B (MLX, 2-bit) to a 12B vision model (Q4_0 GGUF, loaded at 32768 context with 2 parallel slots; compaction stays on the coder, so the Mac keeps memory free for on-demand image generation). On a base M4, the dense 27B read a 6.5K-token prompt at about 31 tok/s and decoded at about 2 tok/s while other requests were queued, so each screenshot review took many minutes. LM Studio's just-in-time model loading is off, so a request can never load the model again with default settings.

Two LM Studio facts decide that entry (first measured with the dense 27B, and they hold for any model served there):

- omp sends images as WebP data URLs. LM Studio answers `400 'url' field must be a base64 encoded image` for those. The Mac model sets `imageInputDecoder: stb`, and so does the coder. A direct HTTP call must send `data:image/png;base64,...`.
- The model thinks unless the request sets `reasoning_effort` to `none`. Thinking can spend the whole `max_tokens` budget and return empty content. Set `compat.extraBody.reasoning_effort: none`.

`providers.maxInFlightRequests` for the Mac is `1`, so a judge call and a subagent queue there instead of loading the model twice. The coder's slot stays separate, so one Mac call can overlap one coder turn. A main-session vision call is a coder turn. A subagent image review runs on the subagent's model, so it overlaps the coder while the Mac is answering.

The `mac-mini` skill tells the agent which call goes where. `RULES.md` stays the short always-on reminder. `apply.sh` replaces `RULES.md` from this repo on every install.

## What this profile does not change

- The installed omp binary. Loop handling (blocking at three, covering successes and mixed repeats, blocking `completion()`, pinning or refusing subagents) lives in this profile's extension.
- Strata's listen address. It stays on `127.0.0.1:8080`.
- The coder output cap, unless a measured generation is cut off at 4096.
- The goal session. Extensions load at process start. Pickup is `/goal pause`, exit, `omp-strata --continue --auto-approve --no-title`, then `/goal resume` on the same goal.

## Install

Install upstream `omp` first. This profile was tested on 18.6.1 (and earlier 18.4.4). Then:

```bash
git clone https://github.com/jaylfc/omp-strata-12gb.git omp-strata
cd omp-strata
bash scripts/install.sh
```

After that:

| Command | What it runs |
| --- | --- |
| `omp` | Upstream omp, state in `~/.omp/agent`. |
| `omp-strata` | `omp --profile=omp-strata`, state in `~/.omp/profiles/omp-strata`. |
| `omp update` | Upstream's own updater. |
| `omp-strata update` | `git pull` of this repo, then `scripts/install.sh`. |

`install.sh` links `bin/omp-strata` into `~/.local/bin`, adds the `omp-strata` shell function to `~/.bashrc`, runs `apply.sh`, and enables Strata vision when a checkout is at `STRATA_DIR` or `~/Strata`. `apply.sh` installs the extension, the `mac-mini` skill, `RULES.md`, and `models.yml`, and merges `agent/strata.config.yml` with `omp --profile=omp-strata config set`. Theme keys already in the profile `config.yml` stay. `strata.config.yml` is the only list of keys; `scripts/config-pairs.py` maps it onto `omp config list --json` and needs PyYAML (`python3-yaml`).

`agent/models.yml` points Strata at `http://127.0.0.1:8080/v1`. On imagelxc, where `/opt/host-omp/omp` exists, `apply.sh` rewrites the installed copy to `http://127.0.0.1:18080/v1`. The same install restores `/usr/local/bin/omp` to the upstream binary and links `/usr/local/bin/omp-strata`. The first imagelxc install moves the old default `~/.omp/agent` into the profile, because that directory was this profile before the split.

Install RTK 0.51.0 and let it write its extension.

```bash
# https://github.com/rtk-ai/rtk/releases/tag/v0.51.0
rtk init --agent omp --global --auto-patch
```

With a side machine, set `SIDE_BASE_URL`, `SIDE_MODEL_ID`, and `SIDE_CONTEXT` (the loaded context) in `~/.config/omp-strata/settings.env`, then run `bash scripts/apply.sh` again before starting.

Start in the project directory:

```bash
omp-strata --continue --auto-approve --no-title
```

`--continue` uses the session saved for the current directory, so start it in the same directory as the original session.

## Daily upstream check

`.github/workflows/upstream-pin.yml` runs every day at 08:17 UTC, and on demand. It compares [UPSTREAM.md](UPSTREAM.md) with the newest can1357/oh-my-pi release. When the release tag has moved, it commits those two lines. It leaves `tested_omp` as recorded, and it does not replace an installed omp binary.

```bash
bash scripts/check-upstream.sh
bash scripts/check-upstream.sh --write
```

## Layout

```
agent/models.yml                         strata provider, side provider placeholders
agent/strata.config.yml                  keys to merge
agent/RULES.md                           always-on rules
agent/skills/mac-mini/SKILL.md           when to use the side model
agent/extensions/fail-loop-resteer.ts    loop re-steer, completion block, eval pre-flight, subagent pin, image review
agent/extensions/handoff-speed.ts        warm handoff prefix, handoff length and thinking limits, pin after compaction
agent/extensions/done-gate.ts            evidence gate on todo done and goal complete, verify_item tool, items/list fix
agent/extensions/goal-verify.ts          verification checklist before goal complete, decided by exit codes
agent/extensions/lessons.ts              lessons shown when their tags match, lesson_propose tool
agent/extensions/watcher.ts              off-node progress watcher: digest, typed verdict, log or steer, done-gate arming
agent/extensions/tasklist.ts             ledger mirror, list check, re-injection, probe map
agent/lessons.jsonl                      curated lessons (one JSON object per line)
tests/                                   bun tests for the extensions (`bun test tests/`)
tools/webcheck/                          one-command browser check that prints JSON
bin/omp-strata                          `omp --profile=omp-strata`; `update` pulls this repo
scripts/install.sh                       link the command, alias it, apply the profile, enable Strata vision
scripts/apply.sh                         install into ~/.omp/profiles/omp-strata/agent
scripts/enable-strata-vision.sh          mmproj, strata-vision, 700 MiB reserve on a coder config
scripts/strata-vision.sh                 vision on the coder, or off with images on another model
scripts/restart-strata.sh                restart the running Strata server with the same command
scripts/config-pairs.py                  strata.config.yml -> `omp config set` pairs
scripts/migrate-profile.sh               imagelxc one-time move of the old default agent
scripts/self-update.sh                   pull this repo and install it
scripts/host-self-update.sh              hourly host entry, runs the update in imagelxc
scripts/systemd/                         user timer for the hourly pull
scripts/check-upstream.sh                compare the pin with upstream
UPSTREAM.md                              tested omp, latest release
FINDINGS.md                              measured results behind the settings
```
