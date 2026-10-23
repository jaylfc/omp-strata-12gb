/**
 * Task list ledger, list check, re-injection and probe map.
 *
 * Mirrors the omp todo state into a local ledger (.omp-strata/tasks.json,
 * gitignored). The ledger is output only: on session_start, session_switch
 * and lazy init it is rebuilt from the session branch, like done-gate.ts, and
 * the file is never read back.
 *
 * List check: on the first successful `todo init` of a goal, the objective
 * (the active goal's, else the first user message, never assistant text) is
 * scanned for enumerated items. If the init lists fewer, or an item shares no
 * content word with any listed item, the refusal text goes to the model as
 * additionalContext on the NEXT tool call (a tool_result cannot block the init
 * that already ran). The check runs once per goal; a later init is only logged.
 *
 * Re-injection: every 6th tool call, and on the call after a todo result that
 * changed the active item, the open items are injected with the active item
 * and its probe marked. Repeats are re-emitted byte-identical: omp 18.6.1
 * dedupes additionalContext only within one tool batch (joinAdditionalContext),
 * so a later batch delivers it again, and identical bytes keep the prefix
 * stable.
 *
 * `tasklist_probe` (xd://tasklist_probe) sets an item's probe; verify_item
 * without a command reruns it (done-gate.ts resolveCommand).
 *
 * omp awaits tool_call and tool_result handlers (extensions/runner.ts,
 * #runHandlerWithTimeout), so async would be allowed, but these are sync like
 * the other extensions: seeding is in memory and the ledger write is a queued
 * promise whose errors are logged.
 *
 * OMP_STRATA_TASKLIST: log (default: write the ledger, log what would be
 * injected), on, off.
 */
import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type BranchEntry, envMode, registerTasklistProbe, textOf, type ToolResult, verificationOf, verifyCommandProblem } from "./done-gate.ts";

export const TASKLIST_MARKER = `<system-interrupt reason="tasklist">`;
export const LEDGER_DIR = ".omp-strata";
export const LEDGER_FILE = "tasks.json";
export const CADENCE = 6;

export interface LedgerItem {
	content: string;
	phase: string;
	status: string;
	probe?: string;
	opened_at: number;
	last_edit_at: number;
	verify: { runs: number; last_exit: number; last_at: number };
	attempts: number;
}

export interface Ledger {
	version: number;
	goal: { id: string; objective_sha: string; requested_items: number };
	items: LedgerItem[];
	/** requested: the enumerated count once the check ran (checked_at set), else the listed count. */
	list_check: { requested: number; listed: number; missing: string[]; checked_at: number };
}

export interface TasklistState {
	ledger?: Ledger;
	goalId?: string;
	objective?: string;
	callCount: number;
	/** The active item (first in_progress) as of the last todo result. */
	activeItem?: string;
	/** A todo result changed the active item since the last tool call. */
	activeChanged: boolean;
	listCheckDone: boolean;
	/** The list check refusal, waiting for the next tool call (on mode). */
	pendingRefusal?: string;
}

export function newTasklistState(): TasklistState {
	return { callCount: 0, activeChanged: false, listCheckDone: false };
}

export function newLedger(): Ledger {
	return { version: 1, goal: { id: "", objective_sha: "", requested_items: 0 }, items: [], list_check: { requested: 0, listed: 0, missing: [], checked_at: 0 } };
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

// ---------------------------------------------------------------------------
// The ledger file (output only)

export function ledgerPath(cwd: string): string {
	return join(cwd, LEDGER_DIR, LEDGER_FILE);
}

async function writeText(cwd: string, text: string): Promise<void> {
	const path = ledgerPath(cwd);
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	await writeFile(tmp, text, "utf8");
	await rename(tmp, path);
}

/** Atomic: write tasks.json.tmp in the same directory, then rename over tasks.json. */
export async function writeLedger(cwd: string, ledger: Ledger): Promise<void> {
	await writeText(cwd, JSON.stringify(ledger, null, 2));
}

let writes: Promise<void> = Promise.resolve();

/** Queue a write of the ledger as it is now; writes run in order and never throw. */
function queueWrite(cwd: string, ledger: Ledger, onError: (error: unknown) => void): void {
	const text = JSON.stringify(ledger, null, 2);
	writes = writes.then(() => writeText(cwd, text)).catch(onError);
}

/** Resolves when every queued ledger write has finished. */
export function ledgerIdle(): Promise<void> {
	return writes;
}

// ---------------------------------------------------------------------------
// Todo details and the ledger

interface Phase {
	name: string;
	tasks: Array<{ content: string; status: string }>;
}

function phasesOf(details: unknown): Phase[] | undefined {
	const phases = details && typeof details === "object" ? (details as { phases?: unknown }).phases : undefined;
	if (!Array.isArray(phases)) return undefined;
	const out: Phase[] = [];
	for (const p of phases) {
		const phase = p as { name?: unknown; tasks?: unknown };
		if (!phase || typeof phase.name !== "string" || !Array.isArray(phase.tasks)) continue;
		const tasks: Phase["tasks"] = [];
		for (const t of phase.tasks) {
			const task = t as { content?: unknown; status?: unknown };
			if (task && typeof task.content === "string" && typeof task.status === "string") tasks.push({ content: task.content, status: task.status });
		}
		out.push({ name: phase.name, tasks });
	}
	return out;
}

export function isOpen(item: { status: string }): boolean {
	return item.status !== "completed" && item.status !== "abandoned";
}

/** The item being worked on: the first in_progress one. */
export function activeItemOf(ledger: Ledger | undefined): string | undefined {
	return ledger?.items.find(i => i.status === "in_progress")?.content;
}

function syncCounts(ledger: Ledger): void {
	ledger.goal.requested_items = ledger.list_check.requested;
}

/** The todo list is the whole truth: tasks that left it leave the ledger; probes and verification history stay. */
export function applyPhases(ledger: Ledger, phases: readonly Phase[], at: number): void {
	const before = new Map(ledger.items.map(i => [i.content, i]));
	ledger.items = phases.flatMap(phase =>
		phase.tasks.map(task => {
			const old = before.get(task.content);
			if (old) return { ...old, phase: phase.name, last_edit_at: old.status === task.status ? old.last_edit_at : at, status: task.status };
			return { content: task.content, phase: phase.name, status: task.status, opened_at: at, last_edit_at: at, verify: { runs: 0, last_exit: -1, last_at: 0 }, attempts: 0 };
		}),
	);
	ledger.list_check.listed = ledger.items.length;
	if (!ledger.list_check.checked_at) ledger.list_check.requested = ledger.items.length;
	syncCounts(ledger);
}

function recordVerify(ledger: Ledger, verified: { task: string; command: string; exit: number }, at: number): void {
	const item = ledger.items.find(i => i.content.trim().toLowerCase() === verified.task.trim().toLowerCase());
	if (!item) return;
	item.verify.runs++;
	item.verify.last_exit = verified.exit;
	item.verify.last_at = at;
	if (verified.exit !== 0) item.attempts++;
	if (!item.probe && verified.command) item.probe = verified.command;
}

// ---------------------------------------------------------------------------
// The objective: the goal's, else the first user message (as goal-verify.ts, never assistant text)

/** Same shape as goal-verify.ts goalFrom: a goal tool result's details, or a mode_change entry's data. */
function goalFrom(value: unknown): { id?: string; objective?: string } | undefined {
	if (!value || typeof value !== "object") return undefined;
	const goal = (value as { goal?: { id?: unknown; objective?: unknown } }).goal;
	if (!goal || typeof goal !== "object") return undefined;
	return { id: typeof goal.id === "string" ? goal.id : undefined, objective: typeof goal.objective === "string" ? goal.objective : undefined };
}

export function firstUserText(branch: readonly BranchEntry[]): string | undefined {
	for (const entry of branch) {
		const message = entry?.message;
		if (message?.role !== "user") continue;
		const text = textOf(message.content).trim();
		if (text) return text;
	}
	return undefined;
}

function refreshGoal(state: TasklistState): void {
	if (!state.ledger) return;
	state.ledger.goal.id = state.goalId ?? (state.objective ? `g-${sha256(state.objective).slice(0, 12)}` : "");
	state.ledger.goal.objective_sha = state.objective ? sha256(state.objective) : "";
}

/** A new goal id restarts the list check; an objective always replaces the earlier one. */
export function setGoal(state: TasklistState, id: string | undefined, objective: string | undefined): void {
	if (id && id !== state.goalId) {
		state.goalId = id;
		state.listCheckDone = false;
		state.pendingRefusal = undefined;
		if (state.ledger) {
			state.ledger.list_check.checked_at = 0;
			state.ledger.list_check.missing = [];
			state.ledger.list_check.requested = state.ledger.list_check.listed;
			syncCounts(state.ledger);
		}
	}
	if (objective) state.objective = objective;
	refreshGoal(state);
}

/** The newest goal in the branch (a /goal typed by the operator is a mode_change entry), else the first user message. */
function refreshObjective(state: TasklistState, branch: readonly BranchEntry[] | undefined): void {
	if (!branch) return;
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i] as BranchEntry & { data?: unknown };
		if (e?.type !== "mode_change") continue;
		const goal = goalFrom(e.data);
		if (goal?.id) {
			if (goal.id !== state.goalId || !state.objective) setGoal(state, goal.id, goal.objective);
			return;
		}
	}
	if (!state.objective) {
		const text = firstUserText(branch);
		if (text) setGoal(state, undefined, text);
	}
}

// ---------------------------------------------------------------------------
// Seeding from the session

function timeOf(entry: BranchEntry | undefined): number {
	const raw = entry?.message?.timestamp ?? entry?.timestamp;
	if (typeof raw === "number") return raw;
	if (typeof raw === "string") {
		const ms = Date.parse(raw);
		if (!Number.isNaN(ms)) return ms;
	}
	return 0;
}

/** Rebuild the ledger and the objective from the session branch. */
export function seedFromBranch(state: TasklistState, branch: readonly BranchEntry[]): void {
	state.ledger = newLedger();
	state.listCheckDone = false;
	state.pendingRefusal = undefined;
	state.objective = undefined;
	state.goalId = undefined;
	const calls = new Map<string, { name: string; args: unknown }>();
	for (const entry of branch) {
		const e = entry as BranchEntry & { data?: unknown };
		if (e?.type === "mode_change") {
			const goal = goalFrom(e.data);
			if (goal) setGoal(state, goal.id, goal.objective);
			continue;
		}
		const message = entry?.message;
		if (!message) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				const b = block as { type?: string; id?: string; name?: string; arguments?: unknown };
				if (b?.type === "toolCall" && typeof b.id === "string" && typeof b.name === "string") calls.set(b.id, { name: b.name, args: b.arguments });
			}
		}
		if (message.role === "toolResult") {
			const call = message.toolCallId ? calls.get(message.toolCallId) : undefined;
			const name = call?.name ?? message.toolName ?? "";
			const at = timeOf(entry);
			if (name === "goal") {
				const goal = goalFrom(message.details);
				if (goal) setGoal(state, goal.id, goal.objective);
			}
			if (name === "todo" && message.isError !== true) {
				const phases = phasesOf(message.details);
				if (phases) {
					applyPhases(state.ledger, phases, at);
					if ((call?.args as { op?: unknown } | undefined)?.op === "init") state.listCheckDone = true;
				}
			}
			const verified = verificationOf({ toolName: name, input: call?.args ?? {}, isError: message.isError === true, content: message.content, details: message.details });
			if (verified) recordVerify(state.ledger, verified, at);
		}
	}
	if (!state.objective) {
		const text = firstUserText(branch);
		if (text) state.objective = text;
	}
	refreshGoal(state);
	state.activeItem = activeItemOf(state.ledger);
}

// ---------------------------------------------------------------------------
// List check

function extractEnumeratedItems(text: string): string[] {
	const items: string[] = [];
	for (const line of text.split("\n")) {
		const match = line.trim().match(/^(?:\d+[.)]\s*|\([a-z]\)\s*|-\s*|\*\s*)(.+)$/);
		const content = match?.[1].trim();
		if (content) items.push(content);
	}
	return items;
}

function contentWords(text: string): Set<string> {
	return new Set(text.toLowerCase().split(/\s+/).filter(w => w.length > 2));
}

function shareContentWord(a: string, b: string): boolean {
	const wb = contentWords(b);
	for (const w of contentWords(a)) if (wb.has(w)) return true;
	return false;
}

export interface ListCheckResult {
	block?: boolean;
	reason?: string;
	enumerated?: number;
	missing?: string[];
	log?: { message: string; fields: Record<string, unknown> };
}

/** Once per goal: the first call decides (and sets listCheckDone), a later one is only logged. */
export function listCheck(state: TasklistState, objective: string, initItems: Array<[string, string]>): ListCheckResult {
	if (state.listCheckDone) return { log: { message: "tasklist: list check already done", fields: {} } };
	const enumerated = extractEnumeratedItems(objective);
	state.listCheckDone = true;
	if (enumerated.length === 0) return { log: { message: "tasklist: list check skipped: no enumeration found", fields: {} } };
	const listed = initItems.map(([content]) => content);
	const missing = enumerated.filter(req => !listed.some(item => shareContentWord(req, item)));
	if (missing.length === 0 && listed.length >= enumerated.length) {
		return { enumerated: enumerated.length, missing, log: { message: "tasklist: list check passed", fields: { enumerated: enumerated.length, listed: listed.length } } };
	}
	const reason = [
		TASKLIST_MARKER,
		`The todo init listed ${listed.length} items but the objective enumerates ${enumerated.length}.${missing.length > 0 ? " Missing:" : ""}`,
		...missing.map(m => `- ${m}`),
		"Run todo append for what is missing so every enumerated item has a task.",
		"</system-interrupt>",
	].join("\n");
	return { block: true, reason, enumerated: enumerated.length, missing, log: { message: "tasklist: list check refused", fields: { enumerated: enumerated.length, listed: listed.length, missing } } };
}

// ---------------------------------------------------------------------------
// Re-injection

export function injectionText(ledger: Ledger): string {
	const open = ledger.items.filter(isOpen);
	const active = activeItemOf(ledger);
	const probe = ledger.items.find(i => i.content === active)?.probe ?? "(no probe set)";
	const done = ledger.items.filter(i => i.status === "completed").length;
	return [`Open tasks (${done} of ${ledger.goal.requested_items} done). Now: ${active ?? "(none in progress)"}. Check: ${probe}`, ...open.map(i => `- [${i.content === active ? ">" : " "}] ${i.content}`)].join("\n");
}

/** Called once per tool call, and the only place calls are counted. Due on every CADENCE-th call and when a todo result changed the active item. */
export function maybeInject(state: TasklistState, activeChanged: boolean): { additionalContext: string } | undefined {
	state.callCount++;
	const ledger = state.ledger;
	if (!ledger || !ledger.items.some(isOpen)) return undefined;
	if (state.callCount % CADENCE !== 0 && !activeChanged) return undefined;
	return { additionalContext: injectionText(ledger) };
}

/** The probe for a task: given, else the ledger's. */
export function resolveProbe(state: TasklistState, task: string, given: unknown): string | undefined {
	if (typeof given === "string" && given.trim()) return given.trim();
	return state.ledger?.items.find(i => i.content.trim().toLowerCase() === task.trim().toLowerCase())?.probe;
}

export function verifyProbeCommand(command: string): string | undefined {
	return verifyCommandProblem(command);
}

// ---------------------------------------------------------------------------
// The extension

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

type TypeBox = { Type: { Object: (props: Record<string, unknown>) => unknown; String: (opts?: Record<string, unknown>) => unknown } };

export default function (pi: {
	on(event: "tool_call", handler: (event: { toolName: string; input: unknown }, ctx?: Ctx) => { additionalContext?: string } | undefined): void;
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
	const mode = envMode("OMP_STRATA_TASKLIST", "log");
	if (mode === "off") return;
	let state = newTasklistState();
	const log = (message: string, fields?: Record<string, unknown>): void => pi.logger?.warn?.(message, fields);
	const save = (ctx: Ctx | undefined): void => {
		if (state.ledger) queueWrite(cwdOf(ctx), state.ledger, error => log("tasklist: ledger write failed", { error: String(error) }));
	};
	const reseed = (_event: unknown, ctx: Ctx | undefined): void => {
		state = newTasklistState();
		const branch = branchOf(ctx);
		try {
			if (branch) seedFromBranch(state, branch);
		} catch {
			state = newTasklistState();
		}
		state.ledger ??= newLedger();
	};
	registerTasklistProbe(task => resolveProbe(state, task, undefined));
	log("strata tasklist loaded", { mode });
	pi.on("session_start", reseed);
	pi.on("session_switch", reseed);

	pi.on("tool_result", (event, ctx) => {
		if (!state.ledger) reseed(undefined, ctx);
		const ledger = state.ledger!;
		const at = Date.now();
		let changed = false;
		if (event.toolName === "goal") {
			const goal = goalFrom(event.details);
			if (goal) setGoal(state, goal.id, goal.objective);
		}
		const phases = event.toolName === "todo" && !event.isError ? phasesOf(event.details) : undefined;
		if (phases) {
			applyPhases(ledger, phases, at);
			changed = true;
			const op = event.input && typeof event.input === "object" ? (event.input as { op?: unknown }).op : undefined;
			if (op === "init" && !state.listCheckDone) {
				refreshObjective(state, branchOf(ctx));
				if (state.objective) {
					const check = listCheck(state, state.objective, ledger.items.map(i => [i.content, i.status]));
					if (check.enumerated) {
						ledger.list_check = { requested: check.enumerated, listed: ledger.items.length, missing: check.missing ?? [], checked_at: at };
						syncCounts(ledger);
					}
					if (check.log) log(check.log.message, check.log.fields);
					if (check.block && check.reason) {
						if (mode === "on") state.pendingRefusal = check.reason;
						else log("tasklist: would inject", { kind: "list check", text: check.reason });
					}
				} else {
					log("tasklist: list check skipped: no objective yet", {});
				}
			}
			const active = activeItemOf(ledger);
			if (active !== state.activeItem && active !== undefined) state.activeChanged = true;
			state.activeItem = active;
		}
		const verified = verificationOf(event);
		if (verified) {
			recordVerify(ledger, verified, at);
			changed = true;
		}
		if (changed) save(ctx);
	});

	pi.on("tool_call", (_event, ctx) => {
		if (!state.ledger) reseed(undefined, ctx);
		const parts: string[] = [];
		if (state.pendingRefusal) {
			parts.push(state.pendingRefusal);
			state.pendingRefusal = undefined;
		}
		const injection = maybeInject(state, state.activeChanged);
		state.activeChanged = false;
		if (injection) {
			if (mode === "on") parts.push(injection.additionalContext);
			else log("tasklist: would inject", { kind: "open tasks", call: state.callCount, text: injection.additionalContext });
		}
		return parts.length > 0 ? { additionalContext: parts.join("\n\n") } : undefined;
	});

	const T = pi.typebox?.Type;
	if (!pi.registerTool || !T) return;
	pi.registerTool({
		name: "tasklist_probe",
		label: "Tasklist probe",
		description: "Set or update the probe command for a todo item. verify_item without a command reruns it, and the open-task reminders show it.",
		parameters: T.Object({
			task: T.String({ description: "exact todo item text" }),
			command: T.String({ description: "shell command that exercises the item and exits non-zero on failure" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const task = typeof params.task === "string" ? params.task.trim() : "";
			const command = typeof params.command === "string" ? params.command.trim() : "";
			if (!task) return { content: [{ type: "text", text: "tasklist_probe needs task: the exact todo item text." }], isError: true };
			if (!command) return { content: [{ type: "text", text: "tasklist_probe needs command: a shell command that exercises the item and exits non-zero on failure." }], isError: true };
			const problem = verifyProbeCommand(command);
			if (problem) return { content: [{ type: "text", text: `tasklist_probe refused: ${problem}.` }], isError: true };
			if (!state.ledger) reseed(undefined, ctx);
			const item = state.ledger!.items.find(i => i.content.trim().toLowerCase() === task.toLowerCase());
			if (!item) return { content: [{ type: "text", text: `tasklist_probe: no such task ${JSON.stringify(task)}.` }], isError: true };
			item.probe = command;
			save(ctx);
			return { content: [{ type: "text", text: `tasklist_probe set for ${JSON.stringify(task)}: ${command}` }] };
		},
	});
}
