import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as d from "../agent/extensions/done-gate.ts";
import * as t from "../agent/extensions/tasklist.ts";

function phases(tasks: Array<[string, string]>, name = "P") {
	return { phases: [{ name, tasks: tasks.map(([content, status]) => ({ content, status })) }] };
}

const user = (text: string): d.BranchEntry => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistantText = (text: string): d.BranchEntry => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
const call = (id: string, name: string, args: unknown): d.BranchEntry => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } });
const result = (id: string, name: string, details: unknown, at: number, content: unknown = []): d.BranchEntry => ({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: name, content, details, timestamp: at } });

const OBJECTIVE = "Do these:\n1. First item\n2. Second item\n3. Third item\n4. Fourth item\n5. Fifth item\n6. Final task";
const FIVE: Array<[string, string]> = [["First item", "pending"], ["Second item", "pending"], ["Third item", "pending"], ["Fourth item", "pending"], ["Fifth item", "pending"]];
const SIX: Array<[string, string]> = [...FIVE, ["Final task", "pending"]];

function ledgerOf(items: Array<{ content: string; status: string; probe?: string }>, requested = items.length): t.Ledger {
	return {
		version: 1,
		goal: { id: "g1", objective_sha: "abc", requested_items: requested },
		items: items.map(i => ({ phase: "P", opened_at: 1000, last_edit_at: 1000, verify: { runs: 0, last_exit: -1, last_at: 0 }, attempts: 0, ...i })),
		list_check: { requested, listed: items.length, missing: [], checked_at: 1000 },
	};
}

describe("tasklist ledger mirror", () => {
	test("seed: init, start, done and verify_item rebuild the ledger; objective from the first user message", () => {
		const branch: d.BranchEntry[] = [
			user(OBJECTIVE),
			call("c1", "todo", { op: "init" }),
			result("c1", "todo", phases([["item 1", "pending"], ["item 2", "in_progress"], ["item 3", "pending"]]), Date.parse("2026-10-23T10:00:01Z")),
			call("c3", "todo", { op: "done", task: "item 1" }),
			result("c3", "todo", phases([["item 1", "completed"], ["item 2", "in_progress"], ["item 3", "pending"]]), Date.parse("2026-10-23T10:02:00Z")),
			call("c4", "write", { path: "xd://verify_item" }),
			result("c4", "write", { verifyItem: { task: "item 2", command: "node p.mjs", exit: 0 } }, Date.parse("2026-10-23T10:03:00Z"), [{ type: "text", text: d.formatVerify("item 2", "node p.mjs", 0, 0.1, "PASS") }]),
		];
		const s = t.newTasklistState();
		t.seedFromBranch(s, branch);
		const ledger = s.ledger!;
		expect(ledger.version).toBe(1);
		expect(s.objective).toBe(OBJECTIVE);
		expect(ledger.goal.objective_sha).toMatch(/^[0-9a-f]{64}$/);
		expect(ledger.goal.requested_items).toBe(3);
		expect(ledger.items.map(i => [i.content, i.status, i.phase])).toEqual([["item 1", "completed", "P"], ["item 2", "in_progress", "P"], ["item 3", "pending", "P"]]);
		expect(ledger.items[1].verify).toMatchObject({ runs: 1, last_exit: 0 });
		expect(ledger.items[1].probe).toBe("node p.mjs");
		expect(ledger.list_check).toMatchObject({ requested: 3, listed: 3, missing: [] });
		expect(s.listCheckDone).toBe(true);
	});

	test("seed: each task keeps the phase that contains it", () => {
		const details = { phases: [{ name: "Build", tasks: [{ content: "a", status: "pending" }] }, { name: "Ship", tasks: [{ content: "b", status: "pending" }, { content: "c", status: "pending" }] }] };
		const s = t.newTasklistState();
		t.seedFromBranch(s, [call("c1", "todo", { op: "init" }), result("c1", "todo", details, 1000)]);
		expect(s.ledger!.items.map(i => [i.content, i.phase])).toEqual([["a", "Build"], ["b", "Ship"], ["c", "Ship"]]);
	});

	test("seed: the objective comes from the goal tool, else the first user message, never assistant text", () => {
		const a = t.newTasklistState();
		t.seedFromBranch(a, [assistantText("1. I will do a\n2. and b"), user("Fix the widget"), result("g", "goal", { goal: { id: "g9", objective: "Ship the widget (1) now" } }, 1000)]);
		expect(a.objective).toBe("Ship the widget (1) now");
		expect(a.goalId).toBe("g9");
		const b = t.newTasklistState();
		t.seedFromBranch(b, [assistantText("1. I will do a\n2. and b"), user("Fix the widget"), user("second message")]);
		expect(b.objective).toBe("Fix the widget");
		const c = t.newTasklistState();
		t.seedFromBranch(c, [assistantText("1. I will do a\n2. and b")]);
		expect(c.objective).toBeUndefined();
	});

	test("applyPhases drops tasks that left the todo list and keeps probes", () => {
		const s = t.newTasklistState();
		t.seedFromBranch(s, [call("c1", "todo", { op: "init" }), result("c1", "todo", phases([["a", "pending"], ["b", "pending"]]), 1000)]);
		s.ledger!.items[0].probe = "node a.mjs";
		t.applyPhases(s.ledger!, [{ name: "P", tasks: [{ content: "a", status: "in_progress" }] }], 2000);
		expect(s.ledger!.items.map(i => [i.content, i.status, i.probe])).toEqual([["a", "in_progress", "node a.mjs"]]);
	});
});

describe("tasklist list check", () => {
	test("objective with 6 numbered items and init of 5 gives one refusal quoting the missing line", () => {
		const state = t.newTasklistState();
		const out = t.listCheck(state, OBJECTIVE, FIVE);
		expect(out.block).toBe(true);
		expect(out.reason).toContain("Final task");
		expect(out.reason).toContain("todo append");
		expect(out.enumerated).toBe(6);
		expect(out.missing).toEqual(["Final task"]);
	});

	test("the check runs once per goal: a later init is only logged, even after a refusal", () => {
		const state = t.newTasklistState();
		expect(t.listCheck(state, OBJECTIVE, FIVE).block).toBe(true);
		const second = t.listCheck(state, OBJECTIVE, SIX);
		expect(second.block).toBeFalsy();
		expect(second.log?.message).toBe("tasklist: list check already done");
		const third = t.listCheck(state, OBJECTIVE, FIVE);
		expect(third.block).toBeFalsy();
	});

	test("a full first init passes", () => {
		const state = t.newTasklistState();
		const out = t.listCheck(state, OBJECTIVE, SIX);
		expect(out.block).toBeFalsy();
		expect(out.log?.message).toBe("tasklist: list check passed");
		expect(out.enumerated).toBe(6);
	});

	test("objective without enumeration skips the check", () => {
		const state = t.newTasklistState();
		const out = t.listCheck(state, "Fix the widget and reconnect", [["Fix the widget", "pending"], ["Reconnect", "pending"]]);
		expect(out).toEqual({ log: { message: "tasklist: list check skipped: no enumeration found", fields: {} } });
	});
});

describe("tasklist cadence", () => {
	test("20 calls inject on calls 6, 9 (active item changed), 12 and 18, byte-identical, open items only, active marked", () => {
		const state = t.newTasklistState();
		state.ledger = ledgerOf([
			{ content: "item 1", status: "completed" },
			{ content: "item 2", status: "in_progress", probe: "node p.mjs" },
			{ content: "item 3", status: "pending" },
			{ content: "item 4", status: "pending" },
		]);
		const at: number[] = [];
		const texts: string[] = [];
		for (let i = 1; i <= 20; i++) {
			const out = t.maybeInject(state, i === 9);
			if (out) {
				at.push(i);
				texts.push(out.additionalContext);
			}
		}
		expect(at).toEqual([6, 9, 12, 18]);
		expect(new Set(texts).size).toBe(1);
		expect(texts[0]).toBe(["Open tasks (1 of 4 done). Now: item 2. Check: node p.mjs", "- [>] item 2", "- [ ] item 3", "- [ ] item 4"].join("\n"));
		expect(texts[0]).not.toContain("item 1");
	});

	test("no injection when nothing is open", () => {
		const state = t.newTasklistState();
		state.ledger = ledgerOf([{ content: "item 1", status: "completed" }]);
		for (let i = 1; i <= 12; i++) expect(t.maybeInject(state, i === 3)).toBeUndefined();
	});

	test("no injection without a ledger", () => {
		const state = t.newTasklistState();
		for (let i = 1; i <= 12; i++) expect(t.maybeInject(state, false)).toBeUndefined();
	});
});

describe("tasklist probe default", () => {
	test("verify_item without command reruns the ledger probe", () => {
		const state = t.newTasklistState();
		state.ledger = ledgerOf([{ content: "test item", status: "in_progress", probe: "node test.mjs" }]);
		expect(t.resolveProbe(state, "test item", undefined)).toBe("node test.mjs");
		expect(t.resolveProbe(state, "test item", " node x.mjs ")).toBe("node x.mjs");
	});

	test("a print-only tasklist_probe is refused", () => {
		const problem = t.verifyProbeCommand("echo hello");
		expect(problem).toBeDefined();
		expect(problem).toContain("prints, lists, reads, or syntax-checks");
	});

	test("a valid tasklist_probe is accepted", () => {
		expect(t.verifyProbeCommand("node test.mjs")).toBeUndefined();
	});

	test("done-gate resolveCommand uses the ledger probe before the last command", () => {
		const prior = process.env.OMP_STRATA_TASKLIST;
		process.env.OMP_STRATA_TASKLIST = "log";
		try {
			const h = harness();
			const branch = [user("Fix it"), call("c1", "todo", { op: "init" }), result("c1", "todo", phases([["item a", "in_progress"]]), 1000)];
			h.start(branch);
			h.done("write", { path: "xd://verify_item" }, { verifyItem: { task: "item a", command: "node probe-a.mjs", exit: 0 } }, [{ type: "text", text: d.formatVerify("item a", "node probe-a.mjs", 0, 0.1, "PASS") }]);
			expect(d.resolveCommand(d.newState(), "item a", undefined)).toBe("node probe-a.mjs");
			expect(d.resolveCommand(d.newState(), "item a", "node given.mjs")).toBe("node given.mjs");
		} finally {
			restoreEnv(prior);
		}
	});
});

// ---------------------------------------------------------------------------
// The registered handlers

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function restoreEnv(prior: string | undefined) {
	if (prior === undefined) delete process.env.OMP_STRATA_TASKLIST;
	else process.env.OMP_STRATA_TASKLIST = prior;
}

type Handler = (event: any, ctx: any) => any;

function harness() {
	const handlers = new Map<string, Handler[]>();
	const logs: Array<{ message: string; fields?: Record<string, unknown> }> = [];
	const cwd = mkdtempSync(join(tmpdir(), "tasklist-"));
	dirs.push(cwd);
	let branch: d.BranchEntry[] = [];
	const ctx = { cwd, sessionManager: { getBranch: () => branch } };
	const pi = {
		on: (name: string, handler: Handler) => void handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		logger: { warn: (message: string, fields?: Record<string, unknown>) => void logs.push({ message, fields }) },
	};
	t.default(pi as any);
	const fire = (name: string, event: unknown) => {
		let out: any;
		for (const h of handlers.get(name) ?? []) out = h(event, ctx) ?? out;
		return out;
	};
	return {
		cwd,
		logs,
		registered: () => [...handlers.keys()],
		start(b: d.BranchEntry[]) {
			branch = b;
			fire("session_start", {});
		},
		setBranch(b: d.BranchEntry[]) {
			branch = b;
		},
		call: (toolName: string, input: unknown = {}) => fire("tool_call", { toolName, input }),
		done: (toolName: string, input: unknown, details: unknown, content: unknown = []) => fire("tool_result", { toolName, input, details, content, isError: false }),
		ledgerPath: join(cwd, ".omp-strata", "tasks.json"),
	};
}

function withMode<T>(mode: string, fn: () => T): T {
	const prior = process.env.OMP_STRATA_TASKLIST;
	process.env.OMP_STRATA_TASKLIST = mode;
	try {
		return fn();
	} finally {
		restoreEnv(prior);
	}
}

describe("tasklist handlers", () => {
	test("off registers nothing", () => {
		withMode("off", () => {
			const h = harness();
			expect(h.registered()).toEqual([]);
		});
	});

	test("on: a short first init is refused once, as additionalContext on the next tool call", async () => {
		const h = withMode("on", () => harness());
		h.start([user(OBJECTIVE)]);
		expect(h.call("todo", { op: "init" })).toBeUndefined();
		h.done("todo", { op: "init" }, phases(FIVE));
		const next = h.call("read", { path: "a" });
		expect(next.additionalContext).toContain("Final task");
		expect(next.additionalContext).toContain("todo append");
		expect(h.call("read", { path: "b" })).toBeUndefined();
		h.done("todo", { op: "init" }, phases(SIX));
		expect(h.call("read", { path: "c" })).toBeUndefined();
		await t.ledgerIdle();
		const written = JSON.parse(readFileSync(h.ledgerPath, "utf8"));
		expect(written.items.length).toBe(6);
		expect(written.list_check).toMatchObject({ requested: 6, listed: 6 });
		expect(written.goal.requested_items).toBe(6);
	});

	test("on: the list check never fires twice for one goal, even across a reseed from the branch", () => {
		const h = withMode("on", () => harness());
		const branch = [user(OBJECTIVE), call("c1", "todo", { op: "init" }), result("c1", "todo", phases(FIVE), 1000)];
		h.start(branch);
		expect(h.call("read")).toBeUndefined();
		h.done("todo", { op: "init" }, phases(FIVE));
		expect(h.call("read")).toBeUndefined();
	});

	test("log: the ledger is written and the injection is only logged", async () => {
		const h = withMode("log", () => harness());
		h.start([user("Fix the widget"), call("c1", "todo", { op: "init" }), result("c1", "todo", phases([["item a", "in_progress"], ["item b", "pending"]]), 1000)]);
		const outs: unknown[] = [];
		for (let i = 1; i <= 6; i++) outs.push(h.call("read", { path: String(i) }));
		expect(outs.every(o => o === undefined)).toBe(true);
		const would = h.logs.filter(l => l.message === "tasklist: would inject");
		expect(would.length).toBe(1);
		expect(String(would[0].fields?.text)).toContain("Now: item a");
		h.done("todo", { op: "start", task: "item b" }, phases([["item a", "pending"], ["item b", "in_progress"]]));
		expect(h.call("read")).toBeUndefined();
		expect(h.logs.filter(l => l.message === "tasklist: would inject").length).toBe(2);
		await t.ledgerIdle();
		expect(JSON.parse(readFileSync(h.ledgerPath, "utf8")).items.map((i: t.LedgerItem) => i.status)).toEqual(["pending", "in_progress"]);
	});

	test("on: every 6th call and the call after an active item change inject the same text", () => {
		const h = withMode("on", () => harness());
		h.start([user("Fix the widget"), call("c1", "todo", { op: "init" }), result("c1", "todo", phases([["item a", "in_progress"], ["item b", "pending"]]), 1000)]);
		const injected: number[] = [];
		const texts: string[] = [];
		for (let i = 1; i <= 13; i++) {
			if (i === 8) h.done("todo", { op: "start", task: "item b" }, phases([["item a", "in_progress"], ["item b", "in_progress"]]));
			if (i === 9) h.done("todo", { op: "done", task: "item a" }, phases([["item a", "completed"], ["item b", "in_progress"]]));
			const out = h.call("read", { path: String(i) });
			if (out?.additionalContext) {
				injected.push(i);
				texts.push(out.additionalContext);
			}
		}
		expect(injected).toEqual([6, 9, 12]);
		expect(texts[1]).toContain("Now: item b");
	});

	test("reseed rebuilds from the branch and never trusts tasks.json", async () => {
		const h = withMode("log", () => harness());
		mkdirSync(join(h.cwd, ".omp-strata"));
		writeFileSync(h.ledgerPath, JSON.stringify(ledgerOf([{ content: "stale item", status: "pending" }])));
		h.start([user("Fix the widget"), call("c1", "todo", { op: "init" }), result("c1", "todo", phases([["fresh item", "pending"]]), 1000)]);
		h.call("read");
		h.done("todo", { op: "start", task: "fresh item" }, phases([["fresh item", "in_progress"]]));
		await t.ledgerIdle();
		expect(JSON.parse(readFileSync(h.ledgerPath, "utf8")).items.map((i: t.LedgerItem) => i.content)).toEqual(["fresh item"]);
	});
});

describe("tasklist ledger file", () => {
	test("writeLedger goes through tasks.json.tmp and leaves only tasks.json", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "tasklist-"));
		dirs.push(cwd);
		const ledger = ledgerOf([{ content: "a", status: "pending" }]);
		await t.writeLedger(cwd, ledger);
		expect(readdirSync(join(cwd, ".omp-strata"))).toEqual(["tasks.json"]);
		expect(JSON.parse(readFileSync(join(cwd, ".omp-strata", "tasks.json"), "utf8"))).toEqual(ledger);
		expect(existsSync(join(cwd, ".omp-strata", "tasks.json.tmp"))).toBe(false);
	});
});
