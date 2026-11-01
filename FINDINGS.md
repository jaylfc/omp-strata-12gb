# Findings

These are measured results from running this profile on one machine: an RTX 3060 12 GB, an i5-10600, 78 GB of DDR4, and Strata serving `qwen3.8-flash-next-coder-iq1_m` with a 262144 context to omp 18.4.4. The test workload is a long autonomous `/goal` session on a browser game, plus a 40-run benchmark. Each section gives the date, the numbers, and the setting it led to. [README.md](README.md) lists every setting.

## Recommended coder settings

| Setting | Value | Section |
| --- | --- | --- |
| Thinking | `reasoning_effort: medium`, `reasoning_budget_tokens: 3072`, `maxTokens: 16384`, `defaultThinkingLevel: medium` | [Thinking level](#thinking-level-2026-10-05), [Reply cap](#reply-cap-2026-11-01) |
| Sampling | `temperature: 1.0`, `top_p: 0.95`, `top_k: 20` | [Sampling](#sampling-2026-10-05) |
| Compaction | `thresholdTokens: 98304`, `keepRecentTokens: 40000`, methods `shake`, `handoff`, `soft` | [Compaction](#compaction-2026-10-05) |
| Never | thinking off for agent work; greedy decoding | |

## Thinking level (2026-10-05)

**Setup:** 4 scripted tasks, 5 thinking arms and 2 reps, 40 runs in total, each with a 25-minute limit and scored by script.
- **Tasks:** a bug fix, a feature with hidden tests, a web UI change checked in a browser, and a task built to provoke loops.
- **Arms:** `reasoning_effort` and `reasoning_budget_tokens` change; everything else in the profile stays the same.
- Strata served nothing else during the runs.

| Arm | Pass | Total time | Median time | Median turns | Output tokens | Tool errors |
| --- | --- | --- | --- | --- | --- | --- |
| off | 6/8 | 71.5 min | 2.5 min | 16 | 50,335 | 195 |
| low, 1024 | 8/8 | 29.9 min | 3.9 min | 11 | 23,836 | 14 |
| low, 1536 | 8/8 | 29.1 min | 3.2 min | 10 | 25,230 | 16 |
| **medium, 3072** | **8/8** | **29.2 min** | 3.5 min | 12 | **22,700** | **13** |
| high, 6144 | 8/8 | 35.0 min | 3.2 min | 10 | 27,738 | 14 |

**Thinking off failed the feature task in both reps.**
- The model wrote `[500, "V"]` where it should be `"D"` and never noticed.
- It re-ran the same probe 100–200 times until the time limit.
- It was the fastest arm on trivial tasks but took 2.4 times the total time of any thinking arm, and made 14 times the tool errors.

**Among the thinking arms, the tasks did not separate pass rate or time.** Medium with a 3072 budget is the recommendation, for three reasons:
- it tied the fastest arm and had the fewest tool errors and output tokens;
- the Qwen3.8-Flash-Next model card warns that lower effort "can also lead to insufficient analysis, more failures, and repeated retries" in multi-turn agent work;
- Strata's `low` effort adds a "keep your thinking brief" instruction to the prompt.

**Caveat:** every arm ran with greedy decoding (next section). A sampled re-run with harder tasks is still to do.

## Sampling (2026-10-05)

**Strata decodes greedily when a request carries no `temperature`, and omp sends none unless configured.** Greedy decoding is deterministic: the same context tail gives the same output. In one long session:
- the coder's thinking collapsed to one line, "I need to dig deeper. Let me check the details.", 267 times in one hour, each followed by the same file read;
- 117 loop-guard refusals, 109 steering messages and a focused handoff did not stop it;
- only a manual handoff plus a concrete instruction broke it, for a while.

Upstream Strata issues #710 and #728 report the same pattern.

**Fix:** the model card's thinking-mode sampling, `temperature 1.0`, `top_p 0.95` and `top_k 20`, sent in the provider's `extraBody`. Over the following three hours:
- no repeated thinking and no loop-guard blocks;
- 96–98% prompt reuse;
- tool errors around 10–17%, mostly failed edit anchors.

**Cost:** median decode fell from 18.6–21.0 to 14.6–16.0 tokens/s. Strata's MTP drafts stay greedy, so fewer are accepted under sampling. `STRATA_SPEC_COUPLED=1`, which makes the drafts sample too, is the next thing to try.

To test sampling without restarting omp, Strata's `POST /settings` with `{"defaults": {"temperature": 1.0, "top_p": 0.95, "top_k": 20}}` changes the server-wide default live and keeps the prompt cache. Values in `extraBody` take precedence over it.

## Compaction (2026-10-05)

| Threshold / recent window | What happened |
| --- | --- |
| 32000 / 20000 | Handed off four times in half an hour. Each summary took 140–225 s on Strata. |
| 65536 / 20000 | Planning a change across about 20 files (~25K tokens) kept the context at the threshold. A mid-run `shake` fired every ~3 minutes and dropped files the model had just read. It read the same files 7–9 times each in an hour (270 reads, 0 edits). |
| **98304 / 40000** | The working set survives. Mid-run compaction now fires every 4–13 minutes, at 99–105K. |

**Cost:** a cold read after a restart or cache eviction takes about 100 s at this size. A cached turn reads only the new tokens, 1–3 s.

## Handoff (2026-10-06)

| Handoff (UTC) | Prompt | Reused | Cold read | Generated | Decode | Document |
| --- | --- | --- | --- | --- | --- | --- |
| 10-05 15:15 (no shake before it) | 99,925 | 98,582 | 3.5 s | 5,512 | 401 s | 13,727 chars |
| 10-05 16:35 | 92,190 | 8,845 | 82 s | 4,074 | 296 s | 16,089 |
| 10-05 18:46 | 88,217 | 8,845 | 80 s | 3,980 | 282 s | 15,662 |
| 10-06 02:33 | 79,475 | 8,845 | 73 s | 4,763 | 360 s | 18,423 |
| 10-06 03:49 | 89,732 | 9,060 | 80 s | 5,396 | 383 s | 20,687 |
| 10-06 05:26 | 88,280 | 55,140 | 36 s | 4,925 | 314 s | 18,124 |
| 10-06 06:29 (no document; soft followed) | 92,232 | 9,060 | 81 s | 3,072 | 247 s | none |
| 10-06 07:53 | 81,193 | 9,060 | 72 s | 4,704 | 339 s | 16,784 |
| 10-06 09:02 | 81,173 | 9,060 | 72 s | 6,599 | 475 s | 21,501 |
| 10-06 13:28 | 93,190 | 45,999 | 50 s | 4,682 | 383 s | 16,812 |

Each row is matched by the coder turns just before and after it in the session (their `input + cacheRead` equals the engine's prompt count). Every cold handoff followed a shake that elided tool results and still left the context above 80% of the threshold. Shake rewrote the session before the handoff was built, so the prefix ended at the first elided result. At 13:28 the model thought for about 70 tokens; the document is the decode cost, about 3.65 characters per token. The 10:34 handoff wrote 102 tokens and is left out. `handoff-speed.ts` is the response; see README, Handoff speed.

## Engine (2026-10-04)

**Benchmark:** the same ~56K-token prompt per engine: a cold read, then an exact continuation. Same pack and arguments, RTX 3060.

| Engine | Cold read | Decode | Exact continuation |
| --- | --- | --- | --- |
| Strata 0.1.38 | 950 tok/s | 14–17.5 tok/s | not measured |
| Strata 0.1.39 | 1,037 tok/s | 16–16.9 tok/s | **0 reused**, full 54 s re-read |
| [architectds/Strata](https://github.com/architectds/Strata) `best` (0.1.39 plus fork work) | ~1,000 tok/s | 17.8–19.6 tok/s | 56,512 reused, 1.1 s |

- **Under real omp load on the fork:** 99.5% prompt reuse per turn (200–350 new tokens read) and 19–23 tokens/s decode with greedy decoding.
- **Why upstream 0.1.39 reused nothing is not yet known.** Strata issue #458 describes one cause: an effort setting rendered at the top of the system prompt changes the prefix. Our test used a fixed effort, so that may not be the explanation.

**Vision off frees expert cache.** With vision off on the coder (`scripts/strata-vision.sh off`), the expert cache holds 2,453 slots, against 1,726 with the vision encoder on the card. Each freed GiB of VRAM is worth about 520 cached experts. Images then go to another model in `models.yml`.

## Loop guard (2026-10-05)

- **Count repeats by call id.** The profile's two extensions disagreed about what a call looked like. `rtk.ts` rewrites bash commands, so `grep …` becomes `rtk grep …`, and the loop guard saw one version when the call was made and the other when its result came back. The guard counted repeats by the result's version and decided by the call's version, so loops of rewritten commands were never blocked: about 200 identical calls went through in one benchmark run. The guard now matches each result to its call by id and logs the first mismatch per session (PR #21).
- **Steering messages do not break a greedy loop.** The model ignored more than 100 of them in a row. Sampling fixed the loops; refusals only bound the damage.

## Visual checks (2026-10-05)

A subagent given screenshot paths may not realise it can see them. One answered "I cannot see or review images" and returned a verdict anyway. Two layout bugs then counted as verified:
- the D-pad covered the game screen;
- the D-pad's arrows were hidden behind its own bars.

The extension now appends `read <path>?q=<question>` instructions to any subagent task that names an image path (PR #24). Overlaps and hidden elements can also be measured from element rectangles, without a vision model; that is planned as a webcheck option.

## How a long session loses time

Of about six hours spent on one feature, about five went to process failures rather than coding:

| Hours | Cause | Fix |
| --- | --- | --- |
| ~1 | Compaction thrash | Compaction above |
| ~2 | The greedy thinking loop | Sampling above |
| ~2 | Building six throwaway end-to-end scripts to walk a bot to one screen, while finished, checked work sat uncommitted for three hours | A steer to commit, and to check the data directly in code |

Planned additions to the extension:
- a nudge to commit after a long stretch with a dirty tree;
- a steer after five identical thinking blocks in a row.

## Open questions

- Sampled re-run of the thinking benchmark with harder tasks, comparing low/1536 and medium/3072.
- `STRATA_SPEC_COUPLED=1`, to win back decode speed under sampling.
- Strata PR #751 (disk KV cache across restarts) and PR #886 (empty assistant turns in history), once merged.
- Why upstream 0.1.39 reused no prompt prefix in our test.

## Read before edit

omp 18.4.4 already refuses hashline edits on lines no read or search displayed (`edit.enforceSeenLines`, on by default), and it ties each edit to the file hash of the last read, so stale reads are refused too. The new `read-before-edit.ts` covers replace-mode edits and `write`. Replaying 5,252 recorded tool calls (1,405 bench and 3,847 Cinderline) through it:

- **Edits:** 0 of 645 would have been refused. In the replace-mode bench arm the model read every file before editing it (25 edits, none failed).
- **Edit failures:** the 156 that did happen were all hashline, and omp already catches the unseen-line ones (3 of the 34 bench failures).
- **Writes:** these cannot be judged after the fact, because the replay sees today's files. 56 writes were flagged; the 8 inspected all created new files, which the live guard allows.

The guard therefore ships log-only, and the regular audits count its `would refuse` lines. It is switched on only if those show real cases and a bench A/B confirms it helps.


## Claims of done (2026-10-06)

The coder marked nine goal items done and completed goal `159b375baa3760c4`. An independent check of each item on a private copy found **3 PASS, 4 PARTIAL, 2 FAIL**, plus three new P0 crashes (lab `experiments/001-cinderline-polish/verify-2026-10-06.md`). Its evidence was weak:
- `node --check` after the last edit;
- `winsim.mjs`, a simulator that picks the best move every turn (88.5% wins; with the default move, real first fights were lost 12 of 16);
- screenshots of the field and title screens for a fix that was in battle;
- dialogue tested once on a fresh log.

Five items were marked done by calls that named other items. omp's `todo done` ignores `items` and `list`. With no `task` or `phase` it marks every open task done: at 07:26, `{"op":"done","items":[4 names]}` completed all 9 tasks.

Replaying that session's claims through `done-gate.ts` with the heuristic rule (`OMP_STRATA_DONE_EVIDENCE=probe`):

| Time (UTC) | Claim | Decision |
| --- | --- | --- |
| 07:26 | `done` naming 4 items (completed 9) | refused: items/list ignored |
| 08:34 | `done` naming 1 item (completed 5) | rewritten to `task`; webcheck had run after the last edit |
| 13:15:01 | `done` with `list` (2 of 3 items) | refused: items/list ignored |
| 13:15:53 | `done` with a whole phase of 4 re-created items | rewritten to `phase`, refused: no probe since they opened |
| 14:39 | `goal complete` | **allowed**: `winsim.mjs` ran after the last edit |

The heuristic stops the bulk claims, but it lets the 14:39 completion through on the simulator. A pattern match on command text cannot tell a real probe from a flattering one. So the default rule is `verify`. `verify_item` runs the item's probe in the extension and records its exit code. `done` needs that item's latest run to have passed after the last edit. The first `goal complete` gets a per-criterion checklist (`goal-verify.ts`), and the goal completes only when the latest run of every criterion exited 0. Self-verification by the agent catches about 61% of wrong solutions and repairs about half of those (arXiv 2609.38812); a dedicated verification tool changes behaviour where a prompt to verify does not (arXiv 2610.01618).

Deferred: a verifier in a fresh context. omp 18.6.1 gives an extension no context that is fresh and runs tools: `runEphemeralTurn` is one reply on the session's own model, with no tool execution. `task` subagents here are pinned to the side model, with the coder as fallback. The probes already run outside the coder; the round that lists and judges the criteria does not.

## Reply cap (2026-11-01)

Across 53 omp session logs, 33 coder replies stopped on length, 24 of them at exactly 7168 tokens. The cut turns were about 3k thinking tokens (the 3072 budget is applied) followed by a file body of about 4k tokens in a `write` call. omp 18.6.1 executed none of the cut tool calls, and none of the 188 writes compared on disk was a truncated prefix, so the cost was a lost turn, not a broken file. The cap is now 16384, which also matches the shared `max_tokens` default on the live Strata server. Recount length stops after the next long session.
