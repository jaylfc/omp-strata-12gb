import { describe, expect, test, beforeEach } from "bun:test";
import * as t from "../agent/extensions/tasklist.ts";
import * as d from "../agent/extensions/done-gate.ts";

function phases(tasks: Array<[string, string]>, name = "P") {
  return { op: "init", phases: [{ name, tasks: tasks.map(([content, status]) => ({ content, status })) }] };
}

function seeded(tasks: Array<[string, string]>, name = "P") {
  const s = d.newState();
  d.record(s, { toolName: "todo", input: { op: "init" }, details: phases(tasks, name) }, 1000);
  return s;
}

const edit = (s: d.GateState, at: number, path = "src/a.js") => d.record(s, { toolName: "edit", input: { path, old_string: "x", new_string: "y" }, content: [{ type: "text", text: "ok" }] }, at);

const bash = (s: d.GateState, at: number, command: string, opts: { isError?: boolean; text?: string; exitCode?: number } = {}) =>
  d.record(s, { toolName: "bash", input: { command }, isError: opts.isError ?? false, content: [{ type: "text", text: opts.text ?? "ok" }], details: opts.exitCode === undefined ? {} : { exitCode: opts.exitCode } }, at);

const verifyItem = (s: d.GateState, at: number, task: string, exit: number, command = "node p.mjs") =>
  d.record(s, { toolName: "write", input: { path: "xd://verify_item" }, content: [{ type: "text", text: d.formatVerify(task, command, exit, 0.1, "") }] }, at);

function mkToolResult(name: string, input: unknown, content: unknown, details: unknown = {}, isError = false) {
  return { toolName: name, input, content, details, isError };
}

describe("tasklist ledger mirror", () => {
  test("reseed: branch with init, start, done and verify_item rebuilds ledger", () => {
    const branch: d.BranchEntry[] = [
      { type: "message", timestamp: "2026-10-23T10:00:00Z", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "todo", arguments: { op: "init" } }] } },
      { type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "todo", content: [], details: phases([["item 1", "pending"], ["item 2", "in_progress"], ["item 3", "pending"]]), timestamp: Date.parse("2026-10-23T10:00:01Z") } },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "todo", arguments: { op: "start", task: "item 1" } }] } },
      { type: "message", message: { role: "toolResult", toolCallId: "c2", toolName: "todo", content: [], details: phases([["item 1", "in_progress"], ["item 2", "in_progress"], ["item 3", "pending"]]), timestamp: Date.parse("2026-10-23T10:01:00Z") } },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c3", name: "todo", arguments: { op: "done", task: "item 1" } }] } },
      { type: "message", message: { role: "toolResult", toolCallId: "c3", toolName: "todo", content: [], details: phases([["item 1", "completed"], ["item 2", "in_progress"], ["item 3", "pending"]]), timestamp: Date.parse("2026-10-23T10:02:00Z") } },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c4", name: "write", arguments: { path: "xd://verify_item" } }] } },
      { type: "message", message: { role: "toolResult", toolCallId: "c4", toolName: "write", isError: false, content: [{ type: "text", text: d.formatVerify("item 2", "node p.mjs", 0, 0.1, "PASS") }], details: { verifyItem: { task: "item 2", command: "node p.mjs", exit: 0 } }, timestamp: Date.parse("2026-10-23T10:03:00Z") } },
    ];

    const ledger = t.seedFromBranch(branch as t.BranchEntry[]);
    expect(ledger.version).toBe(1);
    expect(ledger.goal.objective_sha).toBeDefined();
    expect(ledger.goal.requested_items).toBe(3);
    expect(ledger.items.length).toBe(3);
    expect(ledger.items[0]).toMatchObject({ content: "item 1", status: "completed", phase: "P" });
    expect(ledger.items[1]).toMatchObject({ content: "item 2", status: "in_progress", phase: "P" });
    expect(ledger.items[2]).toMatchObject({ content: "item 3", status: "pending", phase: "P" });
    expect(ledger.items[1].verify.runs).toBe(1);
    expect(ledger.items[1].verify.last_exit).toBe(0);
    expect(ledger.list_check).toEqual({ requested: 0, listed: 3, missing: [], checked_at: expect.any(Number) });
  });
});

describe("tasklist list check", () => {
  test("objective with 6 numbered items and init of 5 gives one refusal quoting missing line", () => {
    const objective = "Do these:\n1. First item\n2. Second item\n3. Third item\n4. Fourth item\n5. Fifth item\n6. Final task";
    const state = t.newTasklistState();
    const result = t.listCheck(state, objective, [["First item", "pending"], ["Second item", "pending"], ["Third item", "pending"], ["Fourth item", "pending"], ["Fifth item", "pending"]]);
    expect(result.block).toBe(true);
    expect(result.reason).toContain("Final task");
    expect(result.reason).toContain("todo append");
  });

  test("second init with all items goes through and is logged", () => {
    const objective = "Do these:\n1. First item\n2. Second item\n3. Third item\n4. Fourth item\n5. Fifth item\n6. Final task";
    const state = t.newTasklistState();
    t.listCheck(state, objective, [["First item", "pending"], ["Second item", "pending"], ["Third item", "pending"], ["Fourth item", "pending"], ["Fifth item", "pending"]]);
    const result = t.listCheck(state, objective, [["First item", "pending"], ["Second item", "pending"], ["Third item", "pending"], ["Fourth item", "pending"], ["Fifth item", "pending"], ["Final task", "pending"]]);
    expect(result.block).toBeFalsy();
    expect(result.log?.message).toBe("tasklist: list check passed");
  });

  test("objective without enumeration skips the check", () => {
    const objective = "Fix the widget and reconnect";
    const state = t.newTasklistState();
    const result = t.listCheck(state, objective, [["Fix the widget", "pending"], ["Reconnect", "pending"]]);
    expect(result).toEqual({ log: { message: "tasklist: list check skipped: no enumeration found", fields: {} } });
  });
});

describe("tasklist cadence", () => {
  test("20 calls produce injections at expected positions, open items only, active marked, identical text", () => {
    const state = t.newTasklistState();
    const items = [
      { content: "item 1", phase: "P", status: "completed" },
      { content: "item 2", phase: "P", status: "in_progress" },
      { content: "item 3", phase: "P", status: "pending" },
      { content: "item 4", phase: "P", status: "pending" },
      { content: "item 5", phase: "P", status: "pending" },
      { content: "item 6", phase: "P", status: "pending" },
    ];
    const ledger = { version: 1, goal: { id: "g1", objective_sha: "abc", requested_items: 6 }, items, list_check: { requested: 6, listed: 6, missing: [], checked_at: Date.now() } };
    state.ledger = ledger;
    state.callCount = 0;
    state.lastActiveItem = "";

    const injections: string[] = [];
    for (let i = 1; i <= 20; i++) {
      const activeChanged = i === 7; // simulate active item change after todo result at call 7
      const result = t.maybeInject(state, activeChanged, "item 2");
      if (result?.additionalContext) injections.push(result.additionalContext);
    }

    expect(injections.length).toBeGreaterThan(0);
    for (const inj of injections) {
      expect(inj).toContain("Open tasks (");
      expect(inj).toContain("Now: item 2");
      expect(inj).toContain("Check:");
      expect(inj).toContain("- [ ] item 3");
      expect(inj).toContain("- [ ] item 4");
      expect(inj).toContain("- [ ] item 5");
      expect(inj).toContain("- [ ] item 6");
      expect(inj).not.toContain("item 1");
    }
    expect(new Set(injections).size).toBe(1);
  });

  test("no injection when nothing is open", () => {
    const state = t.newTasklistState();
    const items = [{ content: "item 1", phase: "P", status: "completed" }];
    const ledger = { version: 1, goal: { id: "g1", objective_sha: "abc", requested_items: 1 }, items, list_check: { requested: 1, listed: 1, missing: [], checked_at: Date.now() } };
    state.ledger = ledger;
    const result = t.maybeInject(state, false, "item 1");
    expect(result?.additionalContext).toBeUndefined();
  });
});

describe("tasklist probe default", () => {
  test("verify_item without command reruns the ledger probe", () => {
    const state = t.newTasklistState();
    const items = [{ content: "test item", phase: "P", status: "in_progress", probe: "node test.mjs", opened_at: 1000, last_edit_at: 1000, verify: { runs: 0, last_exit: -1, last_at: 0 }, attempts: 0 }];
    const ledger = { version: 1, goal: { id: "g1", objective_sha: "abc", requested_items: 1 }, items, list_check: { requested: 1, listed: 1, missing: [], checked_at: Date.now() } };
    state.ledger = ledger;

    const cmd = t.resolveProbe(state, "test item", undefined);
    expect(cmd).toBe("node test.mjs");
  });

  test("a print-only tasklist_probe is refused", () => {
    const problem = t.verifyProbeCommand("echo hello");
    expect(problem).toBeDefined();
    expect(problem).toContain("prints, lists, reads, or syntax-checks");
  });

  test("a valid tasklist_probe is accepted", () => {
    const problem = t.verifyProbeCommand("node test.mjs");
    expect(problem).toBeUndefined();
  });
});