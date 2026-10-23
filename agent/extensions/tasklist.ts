import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { verificationOf, verifyCommandProblem, registerTasklistProbe, type ToolResult, type BranchEntry, type GateState } from "./done-gate.ts";

export type TasklistMode = "on" | "log" | "off";

export function envMode(name: string, fallback: TasklistMode): TasklistMode {
  const value = (process.env[name] ?? fallback).trim().toLowerCase();
  return value === "on" || value === "log" || value === "off" ? value : fallback;
}

export const LEDGER_DIR = ".omp-strata";
export const LEDGER_FILE = "tasks.json";

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

export interface LedgerGoal {
  id: string;
  objective_sha: string;
  requested_items: number;
}

export interface LedgerListCheck {
  requested: number;
  listed: number;
  missing: string[];
  checked_at: number;
}

export interface Ledger {
  version: number;
  goal: LedgerGoal;
  items: LedgerItem[];
  list_check: LedgerListCheck;
}

export interface TasklistState {
  ledger?: Ledger;
  callCount: number;
  lastInjectionText: string;
  lastActiveItem: string;
  listCheckDone: boolean;
  goalId?: string;
}

export function newTasklistState(): TasklistState {
  return { callCount: 0, lastInjectionText: "", lastActiveItem: "", listCheckDone: false };
}

function ledgerPath(cwd: string): string {
  return join(cwd, LEDGER_DIR, LEDGER_FILE);
}

function sha256(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}

function extractEnumeratedItems(text: string): string[] {
  const items: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const match = trimmed.match(/^(?:\d+[.)]\s*|\([a-z]\)\s*|-\s*|\*\s*)(.+)$/);
    if (match) {
      const content = match[1].trim();
      if (content) items.push(content);
    }
  }
  return items;
}

function contentWords(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\s+/).filter(w => w.length > 2));
}

function shareContentWord(a: string, b: string): boolean {
  const wa = contentWords(a);
  const wb = contentWords(b);
  for (const w of wa) if (wb.has(w)) return true;
  return false;
}

async function readLedger(cwd: string): Promise<Ledger | null> {
  try {
    const text = await readFile(ledgerPath(cwd), "utf8");
    return JSON.parse(text) as Ledger;
  } catch {
    return null;
  }
}

async function writeLedger(cwd: string, ledger: Ledger): Promise<void> {
  const path = ledgerPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(ledger, null, 2), "utf8");
}

function phaseFromDetails(details: unknown): { name: string; tasks: Array<{ content: string; status: string }> }[] | undefined {
  const phases = details && typeof details === "object" ? (details as { phases?: unknown }).phases : undefined;
  if (!Array.isArray(phases)) return undefined;
  return phases.filter(p => p && typeof p === "object" && typeof (p as { name?: unknown }).name === "string" && Array.isArray((p as { tasks?: unknown }).tasks))
    .map(p => ({ name: String((p as { name: unknown }).name), tasks: ((p as { tasks: unknown[] }).tasks).filter(t => t && typeof t === "object" && typeof (t as { content?: unknown }).content === "string" && typeof (t as { status?: unknown }).status === "string").map(t => ({ content: String((t as { content: unknown }).content), status: String((t as { status: unknown }).status) })) }));
}

export function seedFromBranch(branch: readonly BranchEntry[], cwd = process.cwd()): Ledger {
  const ledger = { version: 1, goal: { id: "", objective_sha: "", requested_items: 0 }, items: [] as LedgerItem[], list_check: { requested: 0, listed: 0, missing: [] as string[], checked_at: Date.now() } };
  const calls = new Map<string, { name: string; args: unknown }>();
  let objectiveText = "";
  for (const entry of branch) {
    const message = entry?.message;
    if (!message) continue;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        const call = block as { type?: string; id?: string; name?: string; arguments?: unknown };
        if (call?.type === "toolCall" && typeof call.id === "string" && typeof call.name === "string") calls.set(call.id, { name: call.name, args: call.arguments });
        if (call?.type === "text" && typeof call.text === "string" && !objectiveText) {
          objectiveText = call.text;
        }
      }
    }
    if (message.role === "toolResult") {
      const call = message.toolCallId ? calls.get(message.toolCallId) : undefined;
      const name = call?.name ?? message.toolName ?? "";
      const at = typeof message.timestamp === "number" ? message.timestamp : typeof entry.timestamp === "number" ? entry.timestamp : Date.now();
      const details = message.details;
      if (name === "todo" && !message.isError) {
        const op = call?.args && typeof call.args === "object" ? (call.args as { op?: unknown }).op : undefined;
        const phasesData = phaseFromDetails(details);
        if (phasesData) {
          if (!ledger.goal.id) {
            const allTasks = phasesData.flatMap(p => p.tasks);
            ledger.goal.id = `g-${sha256(objectiveText + at)}`;
            ledger.goal.objective_sha = sha256(objectiveText);
            ledger.goal.requested_items = allTasks.length;
            ledger.items = allTasks.map((t, idx) => ({
              content: t.content,
              phase: phasesData[idx % phasesData.length].name,
              status: t.status,
              opened_at: at,
              last_edit_at: at,
              verify: { runs: 0, last_exit: -1, last_at: 0 },
              attempts: 0,
            }));
            ledger.list_check = { requested: 0, listed: allTasks.length, missing: [], checked_at: at };
          } else {
            const allTasks = phasesData.flatMap(p => p.tasks);
            for (const task of allTasks) {
              const existing = ledger.items.find(i => i.content === task.content);
              if (existing) {
                existing.status = task.status;
                existing.last_edit_at = at;
              } else {
                ledger.items.push({
                  content: task.content,
                  phase: phasesData.find(p => p.tasks.some(t => t.content === task.content))?.name ?? "P",
                  status: task.status,
                  opened_at: at,
                  last_edit_at: at,
                  verify: { runs: 0, last_exit: -1, last_at: 0 },
                  attempts: 0,
                });
              }
            }
            ledger.list_check.listed = allTasks.length;
          }
          if (op === "init" && !ledger.list_check.checked_at) {
            ledger.list_check.checked_at = at;
          }
        }
      }
      const verified = verificationOf({ toolName: name, input: call?.args ?? {}, isError: message.isError === true, content: message.content, details });
      if (verified) {
        const item = ledger.items.find(i => i.content.trim().toLowerCase() === verified.task.trim().toLowerCase());
        if (item) {
          item.verify.runs++;
          item.verify.last_exit = verified.exit;
          item.verify.last_at = at;
          if (!item.probe && verified.command) item.probe = verified.command;
        }
      }
    }
  }
  return ledger;
}

export function listCheck(state: TasklistState, objective: string, initItems: Array<[string, string]>): { block?: boolean; reason?: string; log?: { message: string; fields: Record<string, unknown> } } {
  const enumerated = extractEnumeratedItems(objective);
  if (enumerated.length === 0) {
    state.listCheckDone = true;
    return { log: { message: "tasklist: list check skipped: no enumeration found", fields: {} } };
  }
  if (state.listCheckDone) {
    return { log: { message: "tasklist: list check already done", fields: {} } };
  }
  const listedContents = initItems.map(([c]) => c);
  const missing: string[] = [];
  for (const req of enumerated) {
    if (!listedContents.some(lc => shareContentWord(req, lc))) {
      missing.push(req);
    }
  }
  if (missing.length > 0) {
    return {
      block: true,
      reason: `The todo init listed ${listedContents.length} items but the objective enumerates ${enumerated.length}. Missing:\n${missing.map(m => `- ${m}`).join("\n")}\nPlease run todo append for the missing items.`,
    };
  }
  state.listCheckDone = true;
  return { log: { message: "tasklist: list check passed", fields: { enumerated: enumerated.length, listed: listedContents.length } } };
}

export function maybeInject(state: TasklistState, activeChanged: boolean, activeItem: string): { additionalContext?: string } | undefined {
  if (!state.ledger) return undefined;
  const openItems = state.ledger.items.filter(i => i.status !== "completed" && i.status !== "abandoned");
  if (openItems.length === 0) return undefined;

  const shouldInject = (state.callCount > 0 && state.callCount % 6 === 0) || activeChanged;
  if (!shouldInject) {
    state.callCount++;
    return undefined;
  }

  const active = state.ledger.items.find(i => i.content === activeItem);
  const probe = active?.probe ?? "(no probe set)";
  const lines = [
    `Open tasks (${state.ledger.items.filter(i => i.status === "completed").length} of ${state.ledger.goal.requested_items} done). Now: ${activeItem}. Check: ${probe}`,
    ...openItems.map(i => `- [ ] ${i.content}`),
  ];
  const text = lines.join("\n");
  if (text === state.lastInjectionText) {
    state.callCount++;
    return undefined;
  }
  state.lastInjectionText = text;
  state.callCount++;
  state.lastActiveItem = activeItem;
  return { additionalContext: text };
}

export function resolveProbe(state: TasklistState, task: string, given: unknown): string | undefined {
  if (typeof given === "string" && given.trim()) return given.trim();
  if (!state.ledger) return undefined;
  const item = state.ledger.items.find(i => i.content.trim().toLowerCase() === task.trim().toLowerCase());
  return item?.probe;
}

export function verifyProbeCommand(command: string): string | undefined {
  return verifyCommandProblem(command);
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

export default function (pi: {
  on(event: "tool_call", handler: (event: { toolName: string; input: unknown }, ctx?: Ctx) => { block?: boolean; reason?: string; input?: unknown; additionalContext?: string } | undefined): void;
  on(event: "tool_result", handler: (event: ToolResult, ctx?: Ctx) => void): void;
  on(event: "session_start" | "session_switch", handler: (event: unknown, ctx: Ctx) => void): void;
  registerTool?: (tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown, ctx?: Ctx) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean; details?: unknown }>;
  }) => void;
  typebox?: { Type: { Object: (props: Record<string, unknown>) => unknown; String: (opts?: Record<string, unknown>) => unknown; Number: (opts?: Record<string, unknown>) => unknown; Optional: (schema: unknown) => unknown } };
  logger?: Logger;
}): void {
  const mode = envMode("OMP_STRATA_TASKLIST", "log");
  if (mode === "off") return;

  let state = newTasklistState();
  registerTasklistProbe((task: string) => {
    if (!state.ledger) return undefined;
    const item = state.ledger.items.find(i => i.content.trim().toLowerCase() === task.trim().toLowerCase());
    return item?.probe;
  });
  const reseed = async (_event: unknown, ctx: Ctx): Promise<void> => {
    state = newTasklistState();
    const branch = branchOf(ctx);
    const cwd = cwdOf(ctx);
    if (branch) {
      try {
        state.ledger = await readLedger(cwd);
        if (!state.ledger) {
          state.ledger = seedFromBranch(branch, cwd);
        }
      } catch {
        state.ledger = seedFromBranch(branch, cwd);
      }
    }
  };

  pi.logger?.warn?.("strata tasklist loaded", { mode });
  pi.on("session_start", reseed);
  pi.on("session_switch", reseed);

  pi.on("tool_result", async (event, ctx) => {
    const cwd = cwdOf(ctx);
    if (!state.ledger) {
      const branch = branchOf(ctx);
      if (branch) {
        try {
          state.ledger = await readLedger(cwd);
          if (!state.ledger) state.ledger = seedFromBranch(branch, cwd);
        } catch {
          state.ledger = seedFromBranch(branch, cwd);
        }
      } else {
        state.ledger = { version: 1, goal: { id: "", objective_sha: "", requested_items: 0 }, items: [], list_check: { requested: 0, listed: 0, missing: [], checked_at: Date.now() } };
      }
    }

    if (event.toolName === "todo" && !event.isError) {
      const op = event.input && typeof event.input === "object" ? (event.input as { op?: unknown }).op : undefined;
      const phasesData = phaseFromDetails(event.details);
      if (phasesData) {
        const allTasks = phasesData.flatMap(p => p.tasks);
        if (op === "init" && !state.listCheckDone) {
          let objectiveText = "";
          const branch = branchOf(ctx);
          if (branch) {
            for (const entry of branch) {
              const message = entry?.message;
              if (message?.role === "assistant" && Array.isArray(message.content)) {
                for (const block of message.content) {
                  if (block.type === "text" && typeof block.text === "string") {
                    objectiveText = block.text;
                    break;
                  }
                }
                if (objectiveText) break;
              }
            }
          }
          if (objectiveText) {
            const check = listCheck(state, objectiveText, allTasks.map(t => [t.content, t.status]));
            if (check.block) {
              pi.logger?.warn?.("tasklist: list check blocked", { missing: check.reason });
            } else if (check.log) {
              pi.logger?.warn?.(check.log.message, check.log.fields);
            }
          }
        }
        for (const task of allTasks) {
          const existing = state.ledger!.items.find(i => i.content === task.content);
          if (existing) {
            existing.status = task.status;
            existing.last_edit_at = Date.now();
          } else {
            state.ledger!.items.push({
              content: task.content,
              phase: phasesData.find(p => p.tasks.some(t => t.content === task.content))?.name ?? "P",
              status: task.status,
              opened_at: Date.now(),
              last_edit_at: Date.now(),
              verify: { runs: 0, last_exit: -1, last_at: 0 },
              attempts: 0,
            });
          }
        }
        state.ledger!.goal.requested_items = allTasks.length;
        state.ledger!.list_check.listed = allTasks.length;
      }
    }

    const verified = verificationOf(event);
    if (verified) {
      const item = state.ledger!.items.find(i => i.content.trim().toLowerCase() === verified.task.trim().toLowerCase());
      if (item) {
        item.verify.runs++;
        item.verify.last_exit = verified.exit;
        item.verify.last_at = Date.now();
        if (!item.probe && verified.command) item.probe = verified.command;
      }
    }

    await writeLedger(cwd, state.ledger!);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (mode === "log") return undefined;
    if (!state.ledger) {
      await reseed({}, ctx);
    }
    state.callCount++;

    if (event.toolName === "todo" && !event.isError) {
      const op = event.input && typeof event.input === "object" ? (event.input as { op?: unknown }).op : undefined;
      if (op === "start" || op === "done") {
        const task = event.input && typeof event.input === "object" ? (event.input as { task?: unknown }).task : undefined;
        if (typeof task === "string") {
          const injection = maybeInject(state, true, task);
          if (injection) return injection;
        }
      }
    }

    const injection = maybeInject(state, false, state.lastActiveItem);
    if (injection) return injection;

    return undefined;
  });

  const T = pi.typebox?.Type;
  if (pi.registerTool && T) {
    pi.registerTool({
      name: "tasklist_probe",
      label: "Tasklist probe",
      description: "Set or update the probe command for a todo item. The probe is used for automatic verification and re-injection.",
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
        if (!state.ledger) {
          await reseed({}, ctx);
        }
        const item = state.ledger!.items.find(i => i.content.trim().toLowerCase() === task.trim().toLowerCase());
        if (!item) return { content: [{ type: "text", text: `tasklist_probe: no such task ${JSON.stringify(task)}.` }], isError: true };
        item.probe = command;
        await writeLedger(cwdOf(ctx), state.ledger!);
        return { content: [{ type: "text", text: `tasklist_probe set for ${JSON.stringify(task)}: ${command}` }] };
      },
    });
  }
}