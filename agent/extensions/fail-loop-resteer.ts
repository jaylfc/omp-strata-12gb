/**
 * Local Strata guard for omp 18.4.4 and 18.6.1.
 *
 * Blocks the next identical call after the same arguments have been used 3
 * times, whether those calls failed or succeeded. A refusal is a tool
 * result, so the model can emit that call again. When it does, the guard
 * steers the session with a message that asks for a new approach, so
 * autonomous work keeps going. The guard never aborts: in omp an abort pauses
 * the goal, so a loop would stop the whole autonomous run. Refuses eval code that calls completion(),
 * which would send that request to the coder. judge() is allowed: point
 * modelRoles.judge at the side model.
 *
 * SIDE_MODEL pins every subagent (the task tool and eval agent()) to a
 * second model so the spawn does not take the coder's only request slot.
 * Set it to "" to refuse subagents instead. The provider id and model id
 * must exist in models.yml. The repo copy names the placeholder
 * "mac/side-model"; apply.sh installs this file with mac/<SIDE_MODEL_ID>
 * from settings.env, or "" when SIDE_SUBAGENTS=off.
 *
 * wait, job, irc, yield, todo, and goal are allowed to repeat.
 *
 * A subagent's read <path>?q=<question> stays on that subagent's model.
 * The main session still uses modelRoles.vision on the coder. omp 18.4.4
 * queues a second Strata request, and the image-question call does not
 * walk retry.fallbackChains. The subagent model already accepts images,
 * so the read returns the pixels there: the Mac while it is answering,
 * the coder after that call has continued on the coder.
 */
const BLOCK_AFTER = 3;
/** Empty string refuses subagents. A selector pins them to that model. */
const SIDE_MODEL = "mac/side-model";
const EXEMPT = new Set(["wait", "job", "irc", "yield", "todo", "goal", "verify_item", "lesson_propose", "tasklist_probe"]);
/** omp 18.6.1 calls extension tools by writing JSON to xd://<tool>. Re-running an item's probe after a fix is not a loop. */
function exempt(name: string, args: unknown): boolean {
	if (EXEMPT.has(name)) return true;
	const path = args && typeof args === "object" ? (args as { path?: unknown }).path : undefined;
	return name === "write" && typeof path === "string" && /^xd:\/\/(?:verify_item|lesson_propose|tasklist_probe)\b/.test(path);
}
/**
 * Read-only tools may repeat while they succeed: after compaction or output
 * trimming the model needs the same file again. Repeated failures still block.
 */
const REPEAT_OK_ON_SUCCESS = new Set(["read", "grep", "glob", "find", "ls"]);
/** Even read-only repeats stop here: one session re-read the same six lines 164 times. */
const READ_REPEAT_LIMIT = 6;
/** A cycle of 2-4 calls repeated this many times in a row (A,B,A,B,A,B or A,B,C x3) is a loop. */
const FLIPFLOP_CYCLES = 3;
const MAX_CYCLE = 4;
/** An edit that returns a file to a state it already had this many times means the edits undo each other. */
const FILE_STATE_REPEATS = 2;
const INTENT_KEYS = new Set(["i", "__intent"]);

interface FailureReport {
	toolName: string;
	argumentsSummary: string;
	resultSummary: string;
}

interface ToolCallShape {
	toolName: string;
	input: unknown;
	toolCallId?: string;
}

interface ToolResultShape extends ToolCallShape {
	isError: boolean;
	content: Array<{ type?: string; text?: string }>;
}

/**
 * Arguments in a stable key order, without omp's intent note. omp adds the note as a top-level string field
 * (`i` or `__intent`); a tool's own argument with that name (a nested field, or a number) is kept, so two calls
 * that differ only there stay different.
 */
function canonicalize(value: unknown, topLevel = true): unknown {
	if (Array.isArray(value)) return value.map(item => canonicalize(item, false));
	if (!value || typeof value !== "object") return value;
	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(input).sort()) {
		if (topLevel && INTENT_KEYS.has(key) && typeof input[key] === "string") continue;
		output[key] = canonicalize(input[key], false);
	}
	return output;
}

function signature(toolName: string, args: unknown): string {
	return JSON.stringify([toolName, canonicalize(args)]);
}

function summarize(text: string, limit: number): string {
	let summary = text.replace(/\s+/g, " ").trim();
	if (summary.length > limit) summary = `${summary.slice(0, limit)}…`;
	return summary;
}

function resultText(content: ToolResultShape["content"] | undefined): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter(block => block?.type === "text" && typeof block.text === "string")
		.map(block => block.text ?? "")
		.join("\n");
}

function reportFor(toolName: string, args: unknown, text: string): FailureReport {
	return {
		toolName,
		argumentsSummary: summarize(JSON.stringify(canonicalize(args)), 400),
		resultSummary: summarize(text, 200),
	};
}

interface SessionEntry {
	message?: {
		role?: string;
		content?: unknown;
		isError?: boolean;
		toolCallId?: string;
		toolName?: string;
	};
}

/** The trailing run of one identical call, whatever its results were. */
export interface Run {
	signature: string;
	count: number;
	allFailed: boolean;
	allSucceeded: boolean;
	/** Oldest failure in the run, for the fail message. */
	firstFailure?: FailureReport;
	/** Newest result in the run. */
	last: FailureReport;
}

const OWN_MARKERS = [
	`<system-interrupt reason="tool_call_loop_blocked">`,
	`<system-interrupt reason="completion_uses_coder">`,
	`<system-interrupt reason="describe_mjs_blocked">`,
	`<system-interrupt reason="probe_repeat_blocked">`,
	`<system-interrupt reason="eval_preflight">`,
];

/**
 * A result that is one of this extension's own refusals is not a real run of
 * the call. omp may wrap the refusal text, so the marker can sit anywhere.
 */
function isOwnBlock(text: string): boolean {
	return OWN_MARKERS.some(marker => text.includes(marker));
}

/** Extend run with one newer result, or start a new run when the call differs. */
function extendRun(run: Run | undefined, next: string, isError: boolean, report: FailureReport): Run {
	if (run && run.signature === next) {
		return {
			signature: next,
			count: run.count + 1,
			allFailed: run.allFailed && isError,
			allSucceeded: run.allSucceeded && !isError,
			firstFailure: run.firstFailure ?? (isError ? report : undefined),
			last: report,
		};
	}
	return {
		signature: next,
		count: 1,
		allFailed: isError,
		allSucceeded: !isError,
		firstFailure: isError ? report : undefined,
		last: report,
	};
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return resultText(content as ToolResultShape["content"]);
}

/** Rebuild the trailing run of one identical call already stored in the session. */
export function seedFromBranch(branch: readonly SessionEntry[]): Run | undefined {
	const calls = new Map<string, { name: string; args: unknown }>();
	for (const entry of branch) {
		const message = entry?.message;
		if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (!block || typeof block !== "object") continue;
			const call = block as { type?: string; id?: string; name?: string; arguments?: unknown };
			if (call.type !== "toolCall" || typeof call.id !== "string" || typeof call.name !== "string") continue;
			calls.set(call.id, { name: call.name, args: call.arguments });
		}
	}

	// Find where the trailing run starts, then replay it oldest first.
	const results: Array<{ name: string; args: unknown; isError: boolean; text: string }> = [];
	let runSignature: string | undefined;
	for (let index = branch.length - 1; index >= 0; index--) {
		const message = branch[index]?.message;
		if (!message || message.role !== "toolResult") continue;
		const call = message.toolCallId ? calls.get(message.toolCallId) : undefined;
		const name = call?.name ?? message.toolName ?? "";
		const args = call?.args ?? {};
		if (!name || exempt(name, args)) continue;
		const text = textOf(message.content);
		if (isOwnBlock(text)) continue;
		const next = signature(name, args);
		if (runSignature === undefined) runSignature = next;
		else if (next !== runSignature) break;
		results.push({ name, args, isError: message.isError === true, text });
	}

	let run: Run | undefined;
	for (const result of results.reverse()) {
		const next = signature(result.name, result.args);
		run = extendRun(run, next, result.isError, reportFor(result.name, result.args, result.text));
	}
	return run;
}

function failReason(report: FailureReport, count: number): string {
	const result = report.resultSummary || "(no text result)";
	return [
		`<system-interrupt reason="tool_call_loop_blocked">`,
		`This exact \`${report.toolName}\` call failed ${count} times with the same arguments and was not run again.`,
		`Arguments: \`${report.argumentsSummary}\``,
		"",
		`First failure in this streak (truncated): \`${result}\``,
		"",
		"Read that failure and determine why this call failed before you choose the next action. Repeating these arguments will not produce a new result.",
		"",
		`Do not call \`${report.toolName}\` with these arguments again. Continue the current goal with different arguments, a different command, or a different tool.`,
		`</system-interrupt>`,
	].join("\n");
}

function successReason(report: FailureReport, count: number): string {
	const result = report.resultSummary || "(no text result)";
	return [
		`<system-interrupt reason="tool_call_loop_blocked">`,
		`This exact \`${report.toolName}\` call already succeeded ${count} times with the same arguments and was not run again.`,
		`Arguments: \`${report.argumentsSummary}\``,
		"",
		`Result (truncated): \`${result}\``,
		"",
		"Read that result and continue the current goal with a different action. Repeating these arguments will not produce a new result.",
		"",
		`Do not call \`${report.toolName}\` with these arguments again.`,
		`</system-interrupt>`,
	].join("\n");
}

function repeatReason(report: FailureReport, count: number): string {
	const result = report.resultSummary || "(no text result)";
	return [
		`<system-interrupt reason="tool_call_loop_blocked">`,
		`This exact \`${report.toolName}\` call already ran ${count} times with the same arguments and was not run again.`,
		`Arguments: \`${report.argumentsSummary}\``,
		"",
		`Last result (truncated): \`${result}\``,
		"",
		"Read that result and continue the current goal with a different action. Repeating these arguments will not produce a new result.",
		"",
		`Do not call \`${report.toolName}\` with these arguments again.`,
		`</system-interrupt>`,
	].join("\n");
}

function codeOf(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const code = (input as { code?: unknown }).code;
	return typeof code === "string" ? code : "";
}

/**
 * Browser-facade mistakes small models make in eval, each with the form omp
 * 18.4.4 accepts. Each rule matched only failing cells in a replay of 327
 * real eval cells from 2026-10-04. Matching cells are refused before they run, so the model
 * gets the fix in one step instead of a stack trace it may retry.
 */
const EVAL_PREFLIGHT: Array<{ test: (code: string) => boolean; fix: string }> = [
	{
		test: code => /browser\.open\(\s*["'`]/.test(code),
		fix: 'browser.open takes one options object: `const tab = await browser.open({ name: "main", url: "<url>", viewport: { width: 430, height: 932 } });`',
	},
	{
		test: code => /\.run\(\s*(async\s*)?\(\s*\)\s*=>/.test(code) && /\b(document|window|fetch)\b/.test(code),
		fix: "tab.run executes in Bun, not in the page; its function receives `{ tab, page }`. Run page code with `await tab.evaluate(() => ({ w: innerWidth, h: innerHeight }))`.",
	},
];

function evalPreflight(input: unknown): string | undefined {
	const code = codeOf(input);
	if (!code.includes("browser.") && !/\btab\./.test(code)) return undefined;
	const fixes = EVAL_PREFLIGHT.filter(rule => rule.test(code)).map(rule => `- ${rule.fix}`);
	if (fixes.length === 0) return undefined;
	return [
		`<system-interrupt reason="eval_preflight">`,
		"This eval cell was not run. It uses the browser API in a way omp rejects:",
		...fixes,
		"",
		"Simplest path for a page check: one bash call to `webcheck <url> --device iphone14promax --eval EXPR --shot /tmp/x.png`. It prints JSON with console errors, page errors, and eval values.",
		`</system-interrupt>`,
	].join("\n");
}

function callsCompletion(input: unknown): boolean {
	return /\bcompletion\s*\(/.test(codeOf(input));
}

const PROBE_RE = /(?:where|touchprobe|menutest|doorwalk|firstsnap|battletest|smoke|xcheck)\.mjs/;

function commandText(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const record = input as { command?: unknown; code?: unknown };
	if (typeof record.command === "string") return record.command;
	if (typeof record.code === "string") return record.code;
	return "";
}

function probeKey(input: unknown): string | undefined {
	const text = commandText(input);
	if (/describe\.mjs/.test(text)) return "describe.mjs";
	const match = text.match(PROBE_RE);
	return match ? match[0] : undefined;
}

function describeReason(): string {
	return [
		`<system-interrupt reason="describe_mjs_blocked">`,
		"describe.mjs was not run. It calls the side model from this turn and can spend the whole reply on thinking.",
		"",
		"For a saved screenshot, read <path>?q=<question> (Strata vision, on this server). For a pass/fail check, call judge() once in eval (the Mac).",
		"",
		"Continue the current goal with that call.",
		`</system-interrupt>`,
	].join("\n");
}

function probeReason(script: string, count: number): string {
	return [
		`<system-interrupt reason="probe_repeat_blocked">`,
		`${script} already ran ${count} times since the last edit. Another probe will not teach you more.`,
		"",
		"Use the numbers you have. After a screenshot, read <path>?q=<question> on this server, or call judge() once on the Mac.",
		"",
		"Continue the current goal with a different action. Edit the code before probing again.",
		`</system-interrupt>`,
	].join("\n");
}

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|svgz?)(?::img)?$/i;

export interface ImageReviewModel {
	input?: readonly string[];
	provider?: string;
	id?: string;
}

/**
 * A subagent image question that should return pixels to the active model.
 * Undefined leaves the call on modelRoles.vision.
 */
export function subagentImageReview(
	toolName: string,
	input: unknown,
	agentKind: string | undefined,
	model: ImageReviewModel | undefined,
): { path: string; question: string } | undefined {
	if (agentKind !== "sub" || toolName !== "read") return undefined;
	if (!model?.input?.includes("image")) return undefined;
	if (!input || typeof input !== "object") return undefined;
	const raw = (input as { path?: unknown }).path;
	if (typeof raw !== "string" || raw.includes("://")) return undefined;
	const queryAt = raw.indexOf("?");
	if (queryAt === -1) return undefined;
	const question = new URLSearchParams(raw.slice(queryAt + 1)).get("q")?.trim();
	if (!question) return undefined;
	const path = raw.slice(0, queryAt);
	if (!IMAGE_FILE.test(path)) return undefined;
	return { path, question };
}

const IMAGE_PATH_SOURCE = /(?:^|[\s"'`(])((?:\/|\.{1,2}\/)[^\s"'`)]+\.(?:png|jpe?g|webp))\b/gi;
const IMAGE_HINT_MARK = "read <path>?q=<question>";

/**
 * A subagent given screenshot paths does not know it can see them: on 2026-10-05 the side model
 * answered "I cannot see or review images" and no visual check happened. Tell each task how.
 */
/** A copy of a task call without model choices (top level and per task), or undefined when it has none. */
export function stripTaskModel(input: unknown): Record<string, unknown> | undefined {
	if (!input || typeof input !== "object") return undefined;
	const record = input as Record<string, unknown> & { tasks?: unknown };
	let changed = "model" in record;
	const { model: _drop, ...rest } = record;
	const out: Record<string, unknown> = rest;
	if (Array.isArray(record.tasks)) {
		out.tasks = record.tasks.map(item => {
			if (item && typeof item === "object" && "model" in (item as Record<string, unknown>)) {
				changed = true;
				const { model: _m, ...task } = item as Record<string, unknown>;
				return task;
			}
			return item;
		});
	}
	return changed ? out : undefined;
}

export function addImageReadHint(input: unknown): Record<string, unknown> | undefined {
	const record = input as { tasks?: Array<{ task?: unknown }> } | undefined;
	if (!record || !Array.isArray(record.tasks)) return undefined;
	let changed = false;
	const tasks = record.tasks.map(item => {
		const text = typeof item?.task === "string" ? item.task : "";
		if (!text || text.includes(IMAGE_HINT_MARK)) return item;
		const paths = [...new Set([...text.matchAll(new RegExp(IMAGE_PATH_SOURCE))].map(match => match[1]))];
		if (paths.length === 0) return item;
		changed = true;
		return {
			...item,
			task: `${text}\n\nYou can see these images. For each one, call the read tool with the path followed by ?q= and your question, for example read ${paths[0]}?q=<question>, and base every verdict on what that returns. Do not answer before reading each image: ${paths.join(", ")}. (${IMAGE_HINT_MARK})`,
		};
	});
	return changed ? { ...(input as Record<string, unknown>), tasks } : undefined;
}

function imageReviewContext(question: string): string {
	const text = question.length > 500 ? `${question.slice(0, 500)}…` : question;
	return `The image question on this read was: ${text}`;
}

function completionReason(): string {
	return [
		`<system-interrupt reason="completion_uses_coder">`,
		"completion() was not run. It sends another request to the coder and replaces the prompt cache.",
		"",
		"Use judge() when a judge model is configured. For a saved image, read <path>?q=<question>. Read game state as numbers or text from the page, or run cinderline/tools/where.mjs, touchprobe.mjs, or menutest.mjs once and use that result.",
		"",
		"Continue the current goal with a different action.",
		`</system-interrupt>`,
	].join("\n");
}

/** Length of a cycle (2..MAX_CYCLE) that the history ends with, repeated FLIPFLOP_CYCLES times, else 0. */
function trailingCycle(history: readonly string[]): number {
	for (let len = 2; len <= MAX_CYCLE; len++) {
		const need = len * FLIPFLOP_CYCLES;
		if (history.length < need) continue;
		const tail = history.slice(-need);
		const unit = tail.slice(0, len);
		if (new Set(unit).size < 2) continue;
		if (tail.every((sig, i) => sig === unit[i % len])) return len;
	}
	return 0;
}

/** "[path#TAG]" header omp prints on read and edit results. */
function fileState(text: string): { path: string; tag: string } | undefined {
	const m = /^\[([^\]#\s]+)#([0-9A-Fa-f]{3,8})\]/m.exec(text);
	return m ? { path: m[1], tag: m[2] } : undefined;
}

/** True when an edit or write input targets exactly this path (its `path` field or a "[path#TAG]" header). */
function editsPath(input: unknown, path: string): boolean {
	const record = (input ?? {}) as { path?: unknown; input?: unknown };
	if (record.path === path) return true;
	return typeof record.input === "string" && record.input.includes(`[${path}#`);
}

function fileStateReason(path: string, tag: string, times: number): string {
	return [
		`<system-interrupt reason="tool_call_loop_blocked">`,
		`Your edits have returned ${path} to the same earlier version (#${tag}) ${times} times, so they are undoing each other.`,
		"Do not edit this file again until you decide which version the goal needs. Keep that version, check it once, commit, and move to the next item.",
		`</system-interrupt>`,
	].join("\n");
}

function flipflopReason(cycle: readonly string[]): string {
	return [
		`<system-interrupt reason="tool_call_loop_blocked">`,
		`The last ${cycle.length * FLIPFLOP_CYCLES} calls repeated the same ${cycle.length}-step cycle ${FLIPFLOP_CYCLES} times and undid each other:`,
		...cycle.map(sig => `- ${summarize(sig, 160)}`),
		"",
		"Pick the version the goal needs, keep it, and do not switch back. Verify it once, commit, and move to the next item.",
		`</system-interrupt>`,
	].join("\n");
}

function steerText(steers: number): string {
	if (steers === 1) {
		return [
			"Loop guard: you sent a tool call that was already refused. That approach is finished.",
			"In one sentence, state why it kept failing or repeating. Then take a different approach: a different tool, a different command, or a smaller step.",
			"Continue the current goal.",
		].join("\n");
	}
	return [
		"Loop guard: the same refused call came back again. Drop this step.",
		"Write a one-line note of what is still unverified, move on to the next item of the current goal, and come back to this one later with a new method.",
	].join("\n");
}

function taskReason(): string {
	if (SIDE_MODEL) {
		return [
			`<system-interrupt reason="subagent_pinned">`,
			`Subagents run on \`${SIDE_MODEL}\` so the coder keeps its prompt cache.`,
			"",
			"Continue the current goal. Use the task tool for side work and do not pin that work to the coder.",
			`</system-interrupt>`,
		].join("\n");
	}
	return [
		`<system-interrupt reason="local_model_single_request">`,
		"The task tool was not run. This session uses one local model that serves one request at a time, and a subagent replaces the prompt the goal is in the middle of.",
		"",
		"Do the work inline in this session. Continue the current goal with the tools you already have.",
		`</system-interrupt>`,
	].join("\n");
}

interface SessionContext {
	sessionManager?: { getBranch?: () => readonly SessionEntry[] };
}

export default function (pi: {
	on(
		event: "tool_call",
		handler: (
			event: ToolCallShape,
			ctx?: { abort?: () => void; agent?: { kind?: string }; model?: ImageReviewModel },
		) => { block?: boolean; reason?: string; input?: Record<string, unknown>; additionalContext?: string } | undefined,
	): void;
	on(event: "tool_result", handler: (event: ToolResultShape) => void): void;
	on(event: "session_start" | "session_switch", handler: (event: unknown, ctx: SessionContext) => void): void;
	on(
		event: "before_subagent_spawn",
		handler: (event: { agent?: string; patterns?: string[] }) => { block?: boolean; reason?: string; model?: string; note?: string } | undefined,
	): void;
	sendUserMessage?: (content: string, options?: { deliverAs?: "steer" | "followUp" | "aside"; attribution?: "user" | "agent" }) => void;
	logger?: { warn?: (message: string, fields?: Record<string, unknown>) => void };
}): void {
	let run: Run | undefined;
	const history: string[] = [];
	/** path -> tag -> times an edit produced that tag */
	const editStates = new Map<string, Map<string, number>>();
	let frozenFile: { path: string; tag: string; times: number; since: number } | undefined;
	let resultsSeen = 0;
	let probeSeen: string | undefined;
	let probeCount = 0;
	let blockedSig: string | undefined;
	let steers = 0;
	/**
	 * Signature each call had when tool_call saw it, by call id. omp hands tool_result a transformed
	 * copy of the arguments, so recomputing the signature there can split one run of identical calls.
	 */
	const callSignatures = new Map<string, string>();
	let mismatchLogged = false;

	const refuse = (
		ctx: { abort?: () => void } | undefined,
		sig: string,
		reason: string,
	): { block: true; reason: string } => {
		if (blockedSig === sig) {
			pi.logger?.warn?.("steering after a blocked call was repeated", { signature: sig, steers: steers + 1 });
			try {
				pi.sendUserMessage?.(steerText(steers + 1), { deliverAs: "steer", attribution: "agent" });
				steers++;
			} catch {
				// The refusal below still stops this call.
			}
			return { block: true, reason };
		}
		steers = 0;
		blockedSig = sig;
		return { block: true, reason };
	};

	const reseed = (_event: unknown, ctx: SessionContext): void => {
		run = undefined;
		probeSeen = undefined;
		probeCount = 0;
		blockedSig = undefined;
		steers = 0;
		callSignatures.clear();
		mismatchLogged = false;
		try {
			const branch = ctx?.sessionManager?.getBranch?.();
			if (Array.isArray(branch)) run = seedFromBranch(branch);
		} catch {
			// A session that cannot be read still counts new calls from zero.
		}
	};
	pi.logger?.warn?.("strata resteer loaded", {
		blockAfter: BLOCK_AFTER,
		completionBlocked: true,
		sideModel: SIDE_MODEL || "blocked",
	});
	pi.on("before_subagent_spawn", () => {
		if (!SIDE_MODEL) {
			pi.logger?.warn?.("blocking subagent with no side model");
			return { block: true, reason: taskReason() };
		}
		return {
			model: SIDE_MODEL,
			note: `Subagent pinned to ${SIDE_MODEL}. If that model does not answer, the call continues on the coder. A read <path>?q=<question> image review stays on this subagent's model.`,
		};
	});
	pi.on("session_start", reseed);
	pi.on("session_switch", reseed);

	pi.on("tool_result", event => {
		if (event.toolName === "edit" || event.toolName === "write") {
			probeSeen = undefined;
			probeCount = 0;
		}
		const probed = probeKey(event.input);
		if (probed && probed !== "describe.mjs") {
			if (probed === probeSeen) probeCount++;
			else {
				probeSeen = probed;
				probeCount = 1;
			}
		}
		if (exempt(event.toolName, event.input)) return;
		const text = resultText(event.content);
		if (isOwnBlock(text)) return;
		const recomputed = signature(event.toolName, event.input);
		const seen = event.toolCallId ? callSignatures.get(event.toolCallId) : undefined;
		if (event.toolCallId) callSignatures.delete(event.toolCallId);
		if (seen && seen !== recomputed && !mismatchLogged) {
			mismatchLogged = true;
			pi.logger?.warn?.("tool_result input differs from tool_call input", { atCall: seen, atResult: recomputed });
		}
		const next = seen ?? recomputed;
		run = extendRun(run, next, event.isError, reportFor(event.toolName, event.input, text));
		history.push(next);
		if (history.length > MAX_CYCLE * FLIPFLOP_CYCLES) history.shift();
		resultsSeen++;
		// A commit, or 15 other calls, means the model has settled on a version and moved on.
		const command = typeof (event.input as { command?: unknown })?.command === "string"
			? (event.input as { command: string }).command : "";
		const committed = event.toolName === "bash" && !event.isError && /(^|[;&|]\s*|\s)git\s+commit\b/.test(command);
		if (frozenFile && (committed || resultsSeen - frozenFile.since > 15)) frozenFile = undefined;
		if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
			const state = fileState(text);
			if (state) {
				const seen = editStates.get(state.path) ?? new Map<string, number>();
				const times = (seen.get(state.tag) ?? 0) + 1;
				seen.set(state.tag, times);
				editStates.set(state.path, seen);
				// The first time a file lands on a tag is normal; landing there again means a revert.
				if (times > FILE_STATE_REPEATS) frozenFile = { path: state.path, tag: state.tag, times: times - 1, since: resultsSeen };
			}
		}
	});

	pi.on("tool_call", (event, ctx) => {
		const review = subagentImageReview(event.toolName, event.input, ctx?.agent?.kind, ctx?.model);
		if (review) {
			const model = ctx?.model;
			pi.logger?.warn?.("subagent image review stays on the active model", {
				model: model?.provider && model.id ? `${model.provider}/${model.id}` : "",
			});
			return {
				input: { path: review.path },
				additionalContext: imageReviewContext(review.question),
			};
		}
		if (event.toolName === "task" && !SIDE_MODEL) {
			pi.logger?.warn?.("blocking subagent task on local model", { toolName: event.toolName });
			return refuse(ctx, signature(event.toolName, event.input), taskReason());
		}
		if (event.toolName === "task") {
			// omp 18.5+ lets the model pick a subagent's model in the call (omp #14564); the spawn hook's pin decides instead.
			const unpinned = stripTaskModel(event.input);
			if (unpinned) pi.logger?.warn?.("removed a model choice from a subagent task", { toolName: event.toolName });
			const base = unpinned ?? event.input;
			const withHint = addImageReadHint(base);
			if (withHint) pi.logger?.warn?.("added image-read hint to subagent tasks", { toolName: event.toolName });
			if (withHint || unpinned) return { input: withHint ?? unpinned };
		}
		if (exempt(event.toolName, event.input)) return;
		if (event.toolName === "eval") {
			const preflight = evalPreflight(event.input);
			if (preflight) {
				pi.logger?.warn?.("refusing eval cell that misuses the browser API", { toolName: event.toolName });
				return refuse(ctx, signature(event.toolName, event.input), preflight);
			}
		}
		if (event.toolName === "eval" && callsCompletion(event.input)) {
			pi.logger?.warn?.("blocking completion() on the coder", { toolName: event.toolName });
			return refuse(ctx, signature(event.toolName, event.input), completionReason());
		}
		const probed = probeKey(event.input);
		if (probed === "describe.mjs") {
			pi.logger?.warn?.("blocking describe.mjs", { toolName: event.toolName });
			return refuse(ctx, signature(event.toolName, event.input), describeReason());
		}
		if (probed && probed === probeSeen && probeCount >= BLOCK_AFTER) {
			pi.logger?.warn?.("blocking repeated probe", { toolName: event.toolName, script: probed, count: probeCount });
			return refuse(ctx, signature(event.toolName, event.input), probeReason(probed, probeCount));
		}
		const next = signature(event.toolName, event.input);
		if (event.toolCallId) {
			callSignatures.set(event.toolCallId, next);
			// Blocked calls never reach tool_result; keep the map from growing without bound.
			if (callSignatures.size > 64) callSignatures.delete(callSignatures.keys().next().value as string);
		}
		const len = trailingCycle(history);
		if (len && next === history[history.length - len]) {
			const cycle = history.slice(-len);
			pi.logger?.warn?.("blocking repeated cycle", { toolName: event.toolName, length: len });
			return refuse(ctx, next, flipflopReason(cycle));
		}
		if (frozenFile && (event.toolName === "edit" || event.toolName === "write") &&
			editsPath(event.input, frozenFile.path)) {
			pi.logger?.warn?.("blocking edit to a file that keeps reverting", { path: frozenFile.path });
			return refuse(ctx, next, fileStateReason(frozenFile.path, frozenFile.tag, frozenFile.times));
		}
		if (run && run.count >= BLOCK_AFTER && next === run.signature) {
			pi.logger?.warn?.("blocking repeated tool call", { toolName: event.toolName, count: run.count });
			if (run.allFailed && run.firstFailure) return refuse(ctx, next, failReason(run.firstFailure, run.count));
			if (run.allSucceeded && REPEAT_OK_ON_SUCCESS.has(event.toolName) && run.count < READ_REPEAT_LIMIT) return;
			if (run.allSucceeded) return refuse(ctx, next, successReason(run.last, run.count));
			return refuse(ctx, next, repeatReason(run.last, run.count));
		}
	});
}
