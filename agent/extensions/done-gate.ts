/**
 * Done gate: no "done" without evidence.
 *
 * On 2026-10-06 the coder marked nine goal items done and completed the goal.
 * An independent check found 3 PASS, 4 PARTIAL, 2 FAIL. Its evidence was a
 * syntax check after the last edit, a best-move simulator, and screenshots of
 * the wrong screen. Five of the items were marked done by one `todo done`
 * call that named other items: omp's `done` ignores `items` and `list`, and
 * with no `task` or `phase` it marks every open task done.
 *
 * This extension watches tool results and keeps a small record:
 * - when each todo item opened (first seen in a todo result);
 * - when the model last changed a file (edit, write, ast_edit);
 * - every probe that passed: a command that executes something (a test
 *   runner, curl, webcheck, a script named *test/probe/verify/check/smoke*,
 *   node -e importing project code, an eval that drives the browser), run in
 *   the foreground, with exit code 0 and no failure lines. A background job
 *   counts when its result arrives with exit code 0. `node --check`, `tsc`,
 *   lint, git, ls, cat and grep never count.
 *
 * `verify_item` is a tool the agent calls with an item's exact text and a
 * probe command. The extension runs the command itself (bash -lc, pipefail,
 * a timeout, the process group killed afterwards) and returns the exit code
 * and the tail of the output; the agent's own reading is not the verdict.
 * omp 18.6.1 exposes it as the device xd://verify_item (write JSON to it).
 *
 * A claim needs evidence after the item opened and after the last file
 * change. With OMP_STRATA_DONE_EVIDENCE=verify (default) that is the item's
 * latest verify_item run, exit 0; for `goal complete`, every task verified
 * since the last edit must have passed its latest run, and at least one run
 * must exist. With =probe, a heuristic probe (above) is enough. Claims are
 * `todo done` (each item it would complete) and `goal complete`. Without
 * evidence the call is refused with the exact verify_item call to make.
 * The same item refused twice goes through on the third try and logs
 * `done-gate: overridden`, so the gate can never hold a goal forever.
 *
 * `todo done` (or `drop`) with `items`/`list` and no `task`/`phase` is the
 * scope bug above. One named item is rewritten to `task`; a whole phase to
 * `phase`; anything else is refused with the one-task-per-call form.
 *
 * The watcher (watcher.ts) can arm the gate: after two consecutive
 * "overclaiming" verdicts at or above its threshold in steer mode, the next
 * `todo done` is checked as if OMP_STRATA_DONE_GATE_TODO were on (for 30
 * minutes, once). The hand-off goes through globalThis so it works whether
 * omp loads the two files as one module graph or two.
 *
 * Switches (on, log, off):
 *   OMP_STRATA_DONE_GATE_GOAL  goal complete, default on
 *   OMP_STRATA_DONE_GATE_TODO  todo done, default log
 *   OMP_STRATA_TODO_SCOPE      the items/list rewrite, default on
 *   OMP_STRATA_DONE_EVIDENCE   verify (default) or probe
 */
import { spawn } from "node:child_process";

export const MARKER = `<system-interrupt reason="done_gate">`;
/** Refusals of one item before the next attempt goes through. */
export const LET_THROUGH_AFTER = 2;

export type Mode = "on" | "log" | "off";

export function envMode(name: string, fallback: Mode): Mode {
	const value = (process.env[name] ?? fallback).trim().toLowerCase();
	return value === "on" || value === "log" || value === "off" ? value : fallback;
}

// ---------------------------------------------------------------------------
// What counts as a probe

const TEST_RUNNER_RE = /(?:^|[\s;&|("'`])(?:node\s+--test|bun\s+test|deno\s+test|(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|e2e|verify|check)\b|npx\s+(?:jest|vitest|mocha|playwright)|pytest|python3?\s+-m\s+(?:pytest|unittest)|jest|vitest|mocha|playwright\s+test|cargo\s+test|go\s+test|make\s+(?:test|check|verify)|ctest|rspec|phpunit)\b/;
const NET_PROBE_RE = /(?:^|[\s;&|("'`])(?:curl|wget|xh|websocat|wscat|webcheck|grpcurl|nc\s+-z)\b/;
const RUNNER_RE = /(?:^|[\s;&|("'`])(?:node|bun|deno|tsx|ts-node|python3?|ruby|bash|sh|zsh|php|perl)\s+((?:-[\w-]+(?:[= ]\S+)?\s+)*)(\S+)/g;
const PROBE_NAME_RE = /(?:test|spec|probe|verify|check|smoke|e2e|repro|assert|harness|sim|playtest|bench)/i;
const WEAK_FLAG_RE = /^(?:--check|-n|--syntax-check|py_compile|compileall)$/;
const INLINE_RE = /(?:^|[\s;&|("'`])(?:node|bun|deno)\s+(?:--input-type=\S+\s+)?(?:-e|--eval|-p|--print)\s|(?:^|[\s;&|("'`])python3?\s+-c\s/;
const INLINE_EXEC_RE = /\b(?:import|require|from)\b|\bfetch\(|WebSocket|assert/;
const EVAL_PROBE_RE = /browser\.|\btab\w*\.(?:run|click|press|tap|goto|evaluate|screenshot)|\bfetch\(|WebSocket|\bassert|\brequests\.|urllib|webcheck/;

/** True when a bash command executes something that can show a claim works. */
export function isProbeCommand(command: string): boolean {
	if (typeof command !== "string" || !command.trim()) return false;
	const cmd = command.replace(/\\\n/g, " ");
	if (TEST_RUNNER_RE.test(cmd) || NET_PROBE_RE.test(cmd)) return true;
	if (INLINE_RE.test(cmd) && INLINE_EXEC_RE.test(cmd)) return true;
	for (const match of cmd.matchAll(RUNNER_RE)) {
		const flags = (match[1] ?? "").trim();
		const target = (match[2] ?? "").replace(/^["'`]+|["'`;)]+$/g, "");
		if (flags.split(/\s+/).some(flag => WEAK_FLAG_RE.test(flag))) continue;
		if (target.startsWith("-")) continue;
		const base = target.split("/").pop() ?? target;
		if (/\.(?:m?[jt]sx?|cjs|py|rb|sh|php|pl)$/.test(base) && PROBE_NAME_RE.test(base)) return true;
	}
	return false;
}

/** True when an eval cell drives a browser, a request or an assertion. */
export function isProbeEval(code: unknown): boolean {
	return typeof code === "string" && EVAL_PROBE_RE.test(code);
}

const FAIL_LINE_RE = /^\s*(?:FAIL(?:ED)?\b|not ok\b|✗|✘)|\b[1-9]\d*\s+(?:failed|failing|failures?)\b|\b(?:failed|failures?)[:=]\s*[1-9]|AssertionError|Uncaught\b|Traceback \(most recent call last\)|\bUnhandled(?:PromiseRejection)?\b/im;

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(block => block && typeof block === "object" && (block as { type?: string }).type === "text")
		.map(block => String((block as { text?: unknown }).text ?? ""))
		.join("\n");
}

export function hasFailLines(text: string): boolean {
	return FAIL_LINE_RE.test(text);
}

export interface ToolResult {
	toolName: string;
	input: unknown;
	isError?: boolean;
	content?: unknown;
	details?: unknown;
	toolCallId?: string;
}

function field(input: unknown, key: string): unknown {
	return input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
}

/** "probe-pass", "probe-fail", "background" (a job id), or undefined when the result is not a probe. */
export function classifyResult(result: ToolResult): { kind: "pass" | "fail" | "background"; command: string; job?: string } | undefined {
	const body = textOf(result.content);
	if (body.includes("<system-interrupt")) return undefined;
	let command = "";
	if (result.toolName === "bash") {
		command = String(field(result.input, "command") ?? "");
		if (!isProbeCommand(command)) return undefined;
		const job = /Backgrounded as job ([^\s;]+)/i.exec(body);
		if (job) return { kind: "background", command, job: job[1] };
	} else if (result.toolName === "eval") {
		const code = field(result.input, "code") ?? field(result.input, "input");
		if (!isProbeEval(code)) return undefined;
		command = String(code).slice(0, 120);
	} else {
		return undefined;
	}
	const exit = field(result.details, "exitCode");
	const failed = result.isError === true || (typeof exit === "number" && exit !== 0) || hasFailLines(body);
	return { kind: failed ? "fail" : "pass", command };
}

// ---------------------------------------------------------------------------
// verify_item

export const VERIFY_TIMEOUT_S = 120;
export const VERIFY_MAX_TIMEOUT_S = 600;
const TAIL_LINES = 40;
const TAIL_CHARS = 3000;
const VERIFY_LINE_RE = /^verify_item (PASS|FAIL) exit=(-?\d+|timeout) task=("(?:[^"\\]|\\.)*")\ncmd: (.*)$/m;
const NOOP_WORD_RE = /^(?:echo|printf|true|false|:|exit|git|ls|cat|grep|rg|ag|head|tail|wc|sleep|tsc|eslint|prettier|stat|test|\[)$/;
const PREFIX_WORD_RE = /^(?:cd|timeout|env|nice|time|command|exec|sudo|nohup)$/;

export interface Verification {
	task: string;
	command: string;
	exit: number;
	at: number;
}

/** Why a verify_item command cannot show anything works, or undefined when it is acceptable. */
export function verifyCommandProblem(command: string): string | undefined {
	if (typeof command !== "string" || !command.trim()) return "the command is empty";
	const segments = command.split(/&&|\|\||;|\n|\|/).map(seg => seg.trim()).filter(Boolean);
	const runs = segments.filter(seg => {
		const words = seg.split(/\s+/);
		let i = 0;
		// Skip wrappers and their arguments: cd DIR, timeout 60, env A=1, VAR=1.
		while (i < words.length) {
			const w = words[i];
			if (w === "cd") i += 2;
			else if (PREFIX_WORD_RE.test(w) || /^\w+=/.test(w) || /^-/.test(w) || /^\d+[smh]?$/.test(w)) i += 1;
			else break;
		}
		const first = words[i];
		if (first === undefined || NOOP_WORD_RE.test(first)) return false;
		const rest = words.slice(i + 1);
		if (rest.some(w => /^(?:--check|--syntax-check|py_compile|compileall)$/.test(w))) return false;
		if (/^(?:ba|z|da)?sh$/.test(first) && rest.includes("-n")) return false;
		return true;
	});
	if (runs.length === 0) return "it only prints, lists, reads, or syntax-checks; give a command that executes the changed code (a test, a probe script, a request)";
	return undefined;
}

/** The first command in backticks in an item's text that verify_item would accept. */
export function commandFromText(text: string): string | undefined {
	for (const match of text.matchAll(/`([^`]+)`/g)) if (!verifyCommandProblem(match[1])) return match[1];
	return undefined;
}

export function tailOf(output: string): string {
	const lines = output.replace(/\s+$/, "").split("\n");
	let tail = lines.slice(-TAIL_LINES).join("\n");
	if (tail.length > TAIL_CHARS) tail = tail.slice(-TAIL_CHARS);
	return lines.length > TAIL_LINES || output.length > TAIL_CHARS ? `…\n${tail}` : tail;
}

/** The result text. Its first two lines are parsed back by parseVerifyText (live, after a restart, and by goal-verify). */
export function formatVerify(task: string, command: string, exit: number | "timeout", seconds: number, output: string): string {
	const pass = exit === 0;
	return [
		`verify_item ${pass ? "PASS" : "FAIL"} exit=${exit} task=${JSON.stringify(task)}`,
		`cmd: ${command.replace(/\n/g, " ")}`,
		`time: ${seconds.toFixed(1)}s`,
		"--- output (tail) ---",
		tailOf(output) || "(no output)",
	].join("\n");
}

export function parseVerifyText(text: string): { task: string; command: string; exit: number } | undefined {
	const match = VERIFY_LINE_RE.exec(text);
	if (!match) return undefined;
	let task: string;
	try {
		task = JSON.parse(match[3]);
	} catch {
		return undefined;
	}
	return { task, command: match[4], exit: match[2] === "timeout" ? -1 : Number(match[2]) };
}

/** A verify_item result (called directly, or through omp's xd://verify_item device), or undefined. Printed look-alikes do not count. */
export function verificationOf(result: ToolResult): { task: string; command: string; exit: number } | undefined {
	const path = field(result.input, "path");
	const isTool = result.toolName === "verify_item" || (result.toolName === "write" && typeof path === "string" && path.startsWith("xd://verify_item"));
	if (!isTool) return undefined;
	const text = textOf(result.content);
	if (text.includes("<system-interrupt")) return undefined;
	const detail = field(result.details, "verifyItem");
	if (detail && typeof field(detail, "task") === "string" && typeof field(detail, "exit") === "number") {
		return { task: String(field(detail, "task")), command: String(field(detail, "command") ?? ""), exit: Number(field(detail, "exit")) };
	}
	return parseVerifyText(text);
}

/** Run a probe the way verify_item does. Resolves with the exit code ("timeout" when killed) and combined output. */
export function runProbe(command: string, cwd: string, timeoutS: number, signal?: AbortSignal): Promise<{ exit: number | "timeout"; output: string; seconds: number }> {
	return new Promise(resolve => {
		const started = Date.now();
		let output = "";
		let timedOut = false;
		let settled = false;
		const child = spawn("bash", ["-lc", `set -o pipefail\n${command}`], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const keep = (chunk: Buffer) => {
			output += chunk.toString("utf8");
			if (output.length > 200_000) output = output.slice(-100_000);
		};
		child.stdout?.on("data", keep);
		child.stderr?.on("data", keep);
		const killGroup = () => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup();
		}, timeoutS * 1000);
		const onAbort = () => {
			timedOut = true;
			killGroup();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			// Anything the probe left running in its group (a server it started) goes with it.
			setTimeout(killGroup, 200);
			resolve({ exit: timedOut ? "timeout" : (code ?? 1), output, seconds: (Date.now() - started) / 1000 });
		};
		child.on("error", error => {
			output += `\n${error.message}`;
			finish(127);
		});
		// "exit", not "close": a background child holding stdout open must not hang the tool.
		child.on("exit", code => setTimeout(() => finish(code), 100));
	});
}

// ---------------------------------------------------------------------------
// Files the model changed

const HEADER_RE = /^\[([^\]#\n]+)#[0-9A-Fa-f]{3,8}\]/gm;
const EDIT_TOOLS = new Set(["edit", "write", "ast_edit"]);

export function changedPaths(result: ToolResult): string[] {
	if (!EDIT_TOOLS.has(result.toolName) || result.isError) return [];
	const out = new Set<string>();
	for (const key of ["path", "file_path", "file"]) {
		const value = field(result.input, key);
		if (typeof value === "string" && value.trim()) out.add(value.trim());
	}
	for (const source of [String(field(result.input, "input") ?? ""), textOf(result.content)]) {
		for (const match of source.matchAll(HEADER_RE)) out.add(match[1].trim());
	}
	// xd://tool, proc://job, local://, artifact:// are omp devices and buffers, not project files.
	return [...out].filter(p => !/^[a-z][\w+.-]*:\/\//i.test(p));
}

// ---------------------------------------------------------------------------
// Todo state

export interface Task {
	content: string;
	status: string;
}
export interface Phase {
	name: string;
	tasks: Task[];
}

function phasesOf(details: unknown): Phase[] | undefined {
	const phases = field(details, "phases");
	if (!Array.isArray(phases)) return undefined;
	return phases.filter(p => p && typeof p.name === "string" && Array.isArray(p.tasks)) as Phase[];
}

/** The tasks a `todo done`/`drop` call would change, exactly as omp resolves it. */
export function targetsOf(phases: Phase[], input: unknown): Task[] {
	const task = field(input, "task");
	const phase = field(input, "phase");
	if (typeof task === "string" && task) {
		for (const p of phases) {
			const found = p.tasks.find(t => t.content === task);
			if (found) return [found];
		}
		return [];
	}
	if (typeof phase === "string" && phase) return [...(phases.find(p => p.name === phase)?.tasks ?? [])];
	return phases.flatMap(p => p.tasks);
}

/** Names the model gave in `items` or `list` (ignored by omp's done). */
export function namedItems(input: unknown): string[] {
	const names: string[] = [];
	const items = field(input, "items");
	if (Array.isArray(items)) for (const item of items) if (typeof item === "string") names.push(item);
	let list = field(input, "list");
	if (typeof list === "string") {
		try {
			list = JSON.parse(list);
		} catch {
			list = undefined;
		}
	}
	if (Array.isArray(list)) {
		for (const entry of list) {
			const inner = field(entry, "items");
			if (Array.isArray(inner)) for (const item of inner) if (typeof item === "string") names.push(item);
		}
	}
	return names;
}

/**
 * The scope fix for `todo done`/`drop` without task or phase but with items/list.
 * Returns a rewritten input, a refusal, or undefined when the call is fine.
 */
export function scopeFix(phases: Phase[], input: unknown): { input: Record<string, unknown> } | { refuse: string } | undefined {
	const op = field(input, "op");
	if (op !== "done" && op !== "drop") return undefined;
	if (field(input, "task") || field(input, "phase")) return undefined;
	const names = namedItems(input);
	if (names.length === 0) return undefined;
	const open = phases.flatMap(p => p.tasks).filter(t => t.status !== "completed" && t.status !== "abandoned");
	const base: Record<string, unknown> = {};
	const i = field(input, "i");
	if (typeof i === "string") base.i = i;
	const all = phases.flatMap(p => p.tasks);
	if (names.length === 1 && all.some(t => t.content === names[0])) return { input: { ...base, op, task: names[0] } };
	const wanted = new Set(names);
	const phase = phases.find(p => p.tasks.length > 0 && p.tasks.length === wanted.size && p.tasks.every(t => wanted.has(t.content)));
	if (phase) return { input: { ...base, op, phase: phase.name } };
	return {
		refuse: [
			MARKER,
			`The todo ${op} was not run. omp's ${op} ignores "items" and "list"; with no "task" or "phase" it marks all ${open.length} open tasks ${op === "done" ? "done" : "dropped"}, not only the ${names.length} you named.`,
			`Send one call per task: {"op": "${op}", "task": "<exact task text>"}, and only for tasks whose probe passed.`,
			`</system-interrupt>`,
		].join("\n"),
	};
}

// ---------------------------------------------------------------------------
// Watcher hand-off

const BUS_KEY = "__ompStrataWatcher";
interface Bus {
	overclaim?: { item?: string; until: number; reason: string };
}

function bus(): Bus {
	const g = globalThis as Record<string, unknown>;
	if (!g[BUS_KEY] || typeof g[BUS_KEY] !== "object") g[BUS_KEY] = {};
	return g[BUS_KEY] as Bus;
}

/** Arm the gate: the next `todo done` (within `minutes`) is checked as if the todo gate were on. */
export function armDoneGate(item: string | undefined, reason: string, minutes = 30, now = Date.now()): void {
	bus().overclaim = { item, until: now + minutes * 60000, reason };
}

/** The armed watcher verdict, or undefined when none is armed or it expired. */
export function doneGateArmed(now = Date.now()): { item?: string; reason: string } | undefined {
	const o = bus().overclaim;
	if (!o) return undefined;
	if (o.until < now) {
		bus().overclaim = undefined;
		return undefined;
	}
	return { item: o.item, reason: o.reason };
}

export function disarmDoneGate(): void {
	bus().overclaim = undefined;
}

/** The todo mode for this call: "on" while the watcher has armed the gate, else the configured mode. */
export function effectiveTodoMode(configured: Mode, toolName: string, input: unknown, now = Date.now()): { mode: Mode; armed?: { item?: string; reason: string } } {
	if (configured === "off" || toolName !== "todo" || field(input, "op") !== "done") return { mode: configured };
	const armed = doneGateArmed(now);
	if (!armed) return { mode: configured };
	return { mode: "on", armed };
}

// ---------------------------------------------------------------------------
// The gate

interface Probe {
	at: number;
	command: string;
}

export interface GateState {
	clock: number;
	opened: Map<string, number>;
	lastEdit?: { at: number; paths: string[] };
	probes: Probe[];
	jobs: Map<string, string>;
	phases: Phase[];
	refusals: Map<string, number>;
	verifications: Verification[];
	commands: Map<string, string>;
}

export function newState(): GateState {
	return { clock: 0, opened: new Map(), probes: [], jobs: new Map(), phases: [], refusals: new Map(), verifications: [], commands: new Map() };
}

export interface BranchEntry {
	type?: string;
	customType?: string;
	content?: unknown;
	timestamp?: string | number;
	message?: { role?: string; content?: unknown; isError?: boolean; toolCallId?: string; toolName?: string; details?: unknown; timestamp?: number };
}

function timeOf(entry: BranchEntry | undefined): number | undefined {
	const raw = entry?.message?.timestamp ?? entry?.timestamp;
	if (typeof raw === "number") return raw;
	if (typeof raw === "string") {
		const ms = Date.parse(raw);
		return Number.isNaN(ms) ? undefined : ms;
	}
	return undefined;
}

/** Record one tool result. `at` is its time in ms (Date.now() live, the entry time on replay). */
export function record(state: GateState, result: ToolResult, at: number): void {
	state.clock = Math.max(state.clock + 1, at);
	const now = state.clock;
	const paths = changedPaths(result);
	if (paths.length) state.lastEdit = { at: now, paths };
	const verified = verificationOf(result);
	if (verified) {
		state.verifications.push({ ...verified, at: now });
		state.commands.set(verified.task, verified.command);
		if (verified.exit === 0) state.probes.push({ at: now, command: verified.command });
		return;
	}
	const probe = classifyResult(result);
	if (probe?.kind === "pass") state.probes.push({ at: now, command: probe.command });
	if (probe?.kind === "background" && probe.job) state.jobs.set(probe.job, probe.command);
	if (result.toolName === "todo" && !result.isError) {
		const phases = phasesOf(result.details);
		if (phases && field(result.details, "op") !== "view") {
			state.phases = phases;
			for (const task of phases.flatMap(p => p.tasks)) if (!state.opened.has(task.content)) state.opened.set(task.content, now);
		}
	}
}

/** Background jobs that finished with exit code 0, from async-result messages in the branch. */
export function asyncPasses(state: Pick<GateState, "jobs">, branch: readonly BranchEntry[] | undefined): Probe[] {
	if (!Array.isArray(branch)) return [];
	const out: Probe[] = [];
	for (const entry of branch) {
		if (entry?.type !== "custom_message" || entry.customType !== "async-result") continue;
		const at = timeOf(entry);
		if (at === undefined) continue;
		const text = textOf(entry.content);
		// One section per job: "── Job bg_4 (cmd) ──" when several finished, "Background job bg_2 has completed" for one.
		const sections = text.split(/\n(?=── Job )/);
		for (const section of sections) {
			const id = /(?:── Job |Background job )(\S+)/.exec(section)?.[1];
			const inline = /── Job \S+ \((.*)\) ──/.exec(section)?.[1];
			const command = (id && state.jobs.get(id)) ?? inline ?? "";
			if (!command || !isProbeCommand(command)) continue;
			const exit = /Command exited with code (\d+)/.exec(section);
			if (exit && exit[1] !== "0") continue;
			if (hasFailLines(section.replace(/^.*── Job.*$/m, ""))) continue;
			out.push({ at, command });
		}
	}
	return out;
}

/** The newest passing probe after `since`, or undefined. */
export function evidenceAfter(state: GateState, since: number, branch?: readonly BranchEntry[]): Probe | undefined {
	const all = [...state.probes, ...asyncPasses(state, branch)].filter(p => p.at > since);
	all.sort((a, b) => b.at - a.at);
	return all[0];
}

export type Evidence = "verify" | "probe";

export function evidenceMode(): Evidence {
	return (process.env.OMP_STRATA_DONE_EVIDENCE ?? "verify").trim().toLowerCase() === "probe" ? "probe" : "verify";
}

function sameTask(a: string, b: string): boolean {
	return a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The latest verify_item run of each task after `since`. */
export function latestVerifications(state: GateState, since: number): Verification[] {
	const latest = new Map<string, Verification>();
	for (const v of state.verifications) if (v.at > since) latest.set(v.task.trim().toLowerCase(), v);
	return [...latest.values()];
}

export interface Claim {
	key: string;
	label: string;
	since: number;
	evidence?: Probe;
	/** A heuristic probe after `since`, logged in verify mode to compare the two rules. */
	heuristic?: Probe;
	/** The latest verify_item run that failed, when that is why there is no evidence. */
	failed?: Verification;
}

function todoClaim(state: GateState, task: Task, lastEdit: number, evidence: Evidence, branch?: readonly BranchEntry[]): Claim {
	const since = Math.max(state.opened.get(task.content) ?? 0, lastEdit);
	const heuristic = evidenceAfter(state, since, branch);
	const claim: Claim = { key: `todo:${task.content}`, label: task.content, since, heuristic };
	if (evidence === "probe") {
		claim.evidence = heuristic;
		return claim;
	}
	const runs = state.verifications.filter(v => v.at > since && sameTask(v.task, task.content));
	const last = runs[runs.length - 1];
	if (last?.exit === 0) claim.evidence = { at: last.at, command: last.command };
	else if (last) claim.failed = last;
	return claim;
}

function goalClaim(state: GateState, lastEdit: number, evidence: Evidence, branch?: readonly BranchEntry[]): Claim {
	const heuristic = evidenceAfter(state, lastEdit, branch);
	const claim: Claim = { key: "goal", label: "the goal", since: lastEdit, heuristic };
	if (evidence === "probe") {
		claim.evidence = heuristic;
		return claim;
	}
	const latest = latestVerifications(state, lastEdit);
	const failed = latest.find(v => v.exit !== 0);
	if (failed) claim.failed = failed;
	else if (latest.length > 0) {
		const newest = latest.reduce((a, b) => (a.at > b.at ? a : b));
		claim.evidence = { at: newest.at, command: newest.command };
	}
	return claim;
}

/** Each claim a call makes, with the evidence found for it. Undefined when the call claims nothing. */
export function claimsOf(state: GateState, toolName: string, input: unknown, branch?: readonly BranchEntry[], evidence: Evidence = "probe"): { kind: "todo" | "goal"; claims: Claim[]; bulk: boolean } | undefined {
	const lastEdit = state.lastEdit?.at ?? 0;
	if (toolName === "goal" && field(input, "op") === "complete") {
		return { kind: "goal", bulk: false, claims: [goalClaim(state, lastEdit, evidence, branch)] };
	}
	if (toolName === "todo" && field(input, "op") === "done") {
		const targets = targetsOf(state.phases, input).filter(t => t.status !== "completed" && t.status !== "abandoned");
		if (targets.length === 0) return undefined;
		const bulk = !field(input, "task");
		return { kind: "todo", bulk, claims: targets.map(t => todoClaim(state, t, lastEdit, evidence, branch)) };
	}
	return undefined;
}

function short(text: string, max = 90): string {
	const one = text.replace(/\s+/g, " ").trim();
	return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function verifyCall(task: string, command?: string): string {
	return `write to xd://verify_item with content ${JSON.stringify({ task, command: command ?? "<command that exercises the acceptance criteria>" })}`;
}

export function refusal(kind: "todo" | "goal", missing: Claim[], state: GateState, bulk: boolean, total: number, evidence: Evidence = "probe"): string {
	const what = kind === "goal"
		? "The goal was not completed."
		: `Not marked done: ${missing.map(c => `"${short(c.label, 70)}"`).join(", ")}.`;
	const edit = state.lastEdit;
	const afterEdit = !!edit && missing.some(c => c.since === edit.at);
	const where = afterEdit ? `after your last file change (${edit!.paths.slice(0, 3).join(", ")})` : "since this item was opened";
	const lines = [MARKER, what];
	const failed = missing.find(c => c.failed)?.failed;
	if (evidence === "verify") {
		if (failed) lines.push(`Its latest verify_item failed (exit ${failed.exit}, task ${JSON.stringify(short(failed.task, 60))}). Fix it and run verify_item again.`);
		else lines.push(kind === "goal" ? `No verify_item run ${where}.` : `No passing verify_item for this item ${where}.`);
		const first = missing[0];
		lines.push(
			kind === "goal"
				? `For each acceptance criterion: ${verifyCall("<criterion>")}. It runs the command and returns the exit code and the output tail. Then complete the goal.`
				: `Run its probe: ${verifyCall(first.label, state.commands.get(first.label) ?? commandFromText(first.label))}. Use the exact todo text as task. It runs the command and returns the exit code and output tail. Then mark it done.`,
			"node --check, tsc, lint, git, ls, cat and grep are refused as probes.",
		);
	} else {
		lines.push(
			`No probe passed ${where}.`,
			"Evidence that counts: a test, probe, curl, webcheck or script run in the foreground that exits 0 with no failure lines, after the last edit. node --check, tsc, lint, git, ls, cat and grep do not count.",
			kind === "goal"
				? "Run a probe for each acceptance criterion of the goal, read the output, then complete it."
				: "Run a probe that exercises this item's acceptance criteria, read its output, then mark it done.",
		);
	}
	if (kind === "todo" && bulk) lines.push(`This call names no single task, so it would mark ${total} task${total === 1 ? "" : "s"} done. Mark one task per call: {"op": "done", "task": "<exact text>"}.`);
	lines.push(`</system-interrupt>`);
	return lines.join("\n");
}

export interface Decision {
	block?: boolean;
	reason?: string;
	input?: Record<string, unknown>;
	log?: { message: string; fields: Record<string, unknown> };
}

/** Decide on one tool call. Updates refusal counts. */
export function decide(state: GateState, call: { toolName: string; input: unknown }, modes: { goal: Mode; todo: Mode; scope: Mode; evidence?: Evidence }, branch?: readonly BranchEntry[]): Decision | undefined {
	const evidence = modes.evidence ?? "probe";
	let input = call.input;
	let rewritten: Record<string, unknown> | undefined;
	if (call.toolName === "todo" && modes.scope !== "off") {
		const fix = scopeFix(state.phases, input);
		if (fix && "refuse" in fix) {
			const fields = { names: namedItems(input).length, mode: modes.scope };
			if (modes.scope === "on") return { block: true, reason: fix.refuse, log: { message: "done-gate: refused a todo call whose items/list omp ignores", fields } };
			return { log: { message: "done-gate: would refuse a todo call whose items/list omp ignores", fields } };
		}
		if (fix && "input" in fix) {
			if (modes.scope === "on") {
				rewritten = fix.input;
				input = fix.input;
			}
		}
	}
	const found = claimsOf(state, call.toolName, input, branch, evidence);
	const result: Decision = rewritten ? { input: rewritten, log: { message: "done-gate: rewrote todo items/list to one target", fields: { input: rewritten } } } : {};
	if (!found) return rewritten ? result : undefined;
	const mode = found.kind === "goal" ? modes.goal : modes.todo;
	if (mode === "off") return rewritten ? result : undefined;
	const missing = found.claims.filter(c => !c.evidence);
	const base = {
		kind: found.kind,
		items: found.claims.length,
		missing: missing.length,
		bulk: found.bulk,
		rewritten: !!rewritten,
		mode,
		rule: evidence,
		evidence: found.claims.map(c => c.evidence?.command && short(c.evidence.command, 60)).filter(Boolean).slice(0, 3),
		heuristicWouldPass: found.claims.every(c => !!c.heuristic),
	};
	if (missing.length === 0) return { ...result, log: { message: "done-gate: evidenced", fields: base } };
	const attempts = Math.max(...missing.map(c => (state.refusals.get(c.key) ?? 0) + 1));
	if (mode === "log") return { ...result, log: { message: "done-gate: would refuse", fields: { ...base, labels: missing.map(c => short(c.label, 60)) } } };
	if (attempts > LET_THROUGH_AFTER) {
		for (const c of missing) state.refusals.delete(c.key);
		return { ...result, log: { message: "done-gate: overridden", fields: { ...base, attempt: attempts, labels: missing.map(c => short(c.label, 60)) } } };
	}
	for (const c of missing) state.refusals.set(c.key, (state.refusals.get(c.key) ?? 0) + 1);
	const total = found.claims.length;
	return { block: true, reason: refusal(found.kind, missing, state, found.bulk, total, evidence), log: { message: "done-gate: refused", fields: { ...base, attempt: attempts, labels: missing.map(c => short(c.label, 60)) } } };
}

/** Rebuild the record from the session after a restart or `--continue`. */
export function seedFromBranch(state: GateState, branch: readonly BranchEntry[]): void {
	const calls = new Map<string, { name: string; args: unknown }>();
	for (const entry of branch) {
		const message = entry?.message;
		if (!message) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				const call = block as { type?: string; id?: string; name?: string; arguments?: unknown };
				if (call?.type === "toolCall" && typeof call.id === "string" && typeof call.name === "string") calls.set(call.id, { name: call.name, args: call.arguments });
			}
		}
		if (message.role === "toolResult") {
			const call = message.toolCallId ? calls.get(message.toolCallId) : undefined;
			record(state, { toolName: call?.name ?? message.toolName ?? "", input: call?.args ?? {}, isError: message.isError === true, content: message.content, details: message.details }, timeOf(entry) ?? state.clock + 1);
		}
	}
}

type Logger = { warn?: (message: string, fields?: Record<string, unknown>) => void };
interface Ctx {
	cwd?: string;
	sessionManager?: { getBranch?: () => readonly BranchEntry[]; getCwd?: () => string };
}

function branchOf(ctx: Ctx | undefined): readonly BranchEntry[] | undefined {
	try {
		const branch = ctx?.sessionManager?.getBranch?.();
		return Array.isArray(branch) ? branch : undefined;
	} catch {
		return undefined;
	}
}

function cwdOf(ctx: Ctx | undefined): string {
	try {
		return ctx?.cwd ?? ctx?.sessionManager?.getCwd?.() ?? process.cwd();
	} catch {
		return process.cwd();
	}
}

type TypeBox = { Type: { Object: (props: Record<string, unknown>) => unknown; String: (opts?: Record<string, unknown>) => unknown; Number: (opts?: Record<string, unknown>) => unknown; Optional: (schema: unknown) => unknown } };

const TASKLIST_KEY = "__ompStrataTasklist";
function tasklistProbeGetter(): ((task: string) => string | undefined) | undefined {
	const g = globalThis as Record<string, unknown>;
	const getter = g[TASKLIST_KEY];
	return typeof getter === "function" ? getter : undefined;
}

export function registerTasklistProbe(getter: (task: string) => string | undefined): void {
	const g = globalThis as Record<string, unknown>;
	g[TASKLIST_KEY] = getter;
}

/** The verify_item command for a task: given, else the tasklist probe, else the last one used for it, else one in backticks in the task text. */
export function resolveCommand(state: GateState, task: string, given: unknown): string | undefined {
	if (typeof given === "string" && given.trim()) return given.trim();
	const tl = tasklistProbeGetter();
	if (tl) {
		const probe = tl(task);
		if (probe) return probe;
	}
	for (const [key, command] of state.commands) if (sameTask(key, task)) return command;
	return commandFromText(task);
}

export default function (pi: {
	on(event: "tool_call", handler: (event: { toolName: string; input: unknown }, ctx?: Ctx) => { block?: boolean; reason?: string; input?: unknown } | undefined): void;
	on(event: "tool_result", handler: (event: ToolResult, ctx?: Ctx) => void): void;
	on(event: "session_start" | "session_switch", handler: (event: unknown, ctx: Ctx) => void): void;
	registerTool?: (tool: {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown, ctx?: Ctx) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean; details?: unknown }>;
	}) => void;
	typebox?: TypeBox;
	logger?: Logger;
}): void {
	const modes = { goal: envMode("OMP_STRATA_DONE_GATE_GOAL", "on"), todo: envMode("OMP_STRATA_DONE_GATE_TODO", "log"), scope: envMode("OMP_STRATA_TODO_SCOPE", "on"), evidence: evidenceMode() };
	if (modes.goal === "off" && modes.todo === "off" && modes.scope === "off") return;
	let state = newState();
	const reseed = (_event: unknown, ctx: Ctx): void => {
		state = newState();
		const branch = branchOf(ctx);
		if (branch) {
			try {
				seedFromBranch(state, branch);
			} catch {
				state = newState();
			}
		}
	};
	pi.logger?.warn?.("strata done-gate loaded", modes);
	pi.on("session_start", reseed);
	pi.on("session_switch", reseed);
	pi.on("tool_result", event => {
		record(state, event, Date.now());
	});
	pi.on("tool_call", (event, ctx) => {
		const todo = effectiveTodoMode(modes.todo, event.toolName, event.input);
		const decision = decide(state, event, todo.armed ? { ...modes, todo: todo.mode } : modes, branchOf(ctx));
		if (todo.armed) {
			// One checked claim per watcher verdict.
			disarmDoneGate();
			pi.logger?.warn?.("done-gate: watcher armed this check", { reason: todo.armed.reason, item: todo.armed.item?.slice(0, 60), refused: !!decision?.block });
		}
		if (!decision) return undefined;
		if (decision.log) pi.logger?.warn?.(decision.log.message, decision.log.fields);
		if (decision.block) return { block: true, reason: decision.reason };
		if (decision.input) return { input: decision.input };
		return undefined;
	});

	const T = pi.typebox?.Type;
	if (!pi.registerTool || !T) return;
	pi.registerTool({
		name: "verify_item",
		label: "Verify item",
		description: "Run the probe for one todo item or acceptance criterion and get its exit code and output tail. A todo item counts as done only after its latest verify_item passed after your last edit.",
		parameters: T.Object({
			task: T.String({ description: "exact todo item text, or the acceptance criterion" }),
			command: T.Optional(T.String({ description: "shell command that exercises it and exits non-zero on failure; omit to rerun the last one for this task" })),
			timeout_seconds: T.Optional(T.Number({ description: `default ${VERIFY_TIMEOUT_S}, max ${VERIFY_MAX_TIMEOUT_S}` })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const task = typeof params.task === "string" ? params.task.trim() : "";
			if (!task) return { content: [{ type: "text", text: "verify_item needs task: the exact todo item text or the criterion." }], isError: true };
			const command = resolveCommand(state, task, params.command);
			if (!command) return { content: [{ type: "text", text: `verify_item needs a command for ${JSON.stringify(task)}: one that exercises it and exits non-zero on failure.` }], isError: true };
			const problem = verifyCommandProblem(command);
			if (problem) return { content: [{ type: "text", text: `verify_item did not run ${JSON.stringify(command)}: ${problem}.` }], isError: true };
			const requested = typeof params.timeout_seconds === "number" && params.timeout_seconds > 0 ? params.timeout_seconds : VERIFY_TIMEOUT_S;
			const timeoutS = Math.min(requested, VERIFY_MAX_TIMEOUT_S);
			const run = await runProbe(command, cwdOf(ctx), timeoutS, signal);
			const text = formatVerify(task, command, run.exit, run.seconds, run.output);
			pi.logger?.warn?.("done-gate: verify_item", { task: short(task, 60), command: short(command, 80), exit: run.exit, seconds: Math.round(run.seconds * 10) / 10 });
			return { content: [{ type: "text", text }], isError: run.exit !== 0, details: { verifyItem: { task, command, exit: run.exit === "timeout" ? -1 : run.exit } } };
		},
	});
}
