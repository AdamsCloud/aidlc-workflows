#!/usr/bin/env bun
// aidlc-zcode-adapter.ts — the ZCode hook shim (AUTHORED shell file; the
// aidlc-*.ts hook bodies beside it are PACKAGED core, byte-shared with every
// other harness).
//
// ZCode hook payloads are near-isomorphic to Claude Code's but camelCase
// (extracted from zcode.cjs 0.16.9's payload construction and output zod
// schemas; see ZCODE-PORT-NOTES.md in the framework repo):
//   1. field names: sessionId/toolName/toolInput/toolResponse/stopHookActive/
//      hookEventName vs Claude's session_id/tool_name/tool_input/
//      tool_response/stop_hook_active/hook_event_name.
//   2. tool aliases: Task↔Agent and Write/Edit←ApplyPatch are aliased by the
//      host; the core hooks parse Claude's canonical names.
//   3. no transcript_path: ZCode keeps conversations in its own store. The
//      core Stop hook already supports a transcript-less host (the Kiro and
//      opencode precedent, aidlc-continue-workflow.ts).
//
// The dispatcher imports this module and calls run(target, input, extraArgs)
// with the raw payload already read from stdin. Following the Codex adapter's
// #2066 precedent, the hot hooks run INSIDE this process (runCoreHere: import
// the packaged hook module beside this file, pin the project env, call its
// run(input) with stdout/stderr collected) — a child `aidlc engine hook` loads
// the whole engine a second time per hook, and ZCode runs hooks inline on
// every tool call, so child-per-hook latency lands directly on the person.
// Only record-human-turn (the authority boundary: its implementation must stay
// out of any importable process, so a forged host payload cannot mint a human
// turn) and an import failure fall back to a subprocess, through the
// dispatcher's internal entry so the authority token travels with it.
//
// Usage (registered in the project's .zcode/config.json hooks.events):
//   aidlc engine adapter zcode <target>
// where <target> ∈ session-start | record-human-turn | fold-usage |
//                  deliver-stage-rules | guard-tool-call | write-audit-log |
//                  run-sensors | sync-workflow-state | rebuild-stage-graph |
//                  continue-workflow

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

// Every registration routes through this shim; the dispatcher expands nothing
// here — guard-tool-call's four-guard group is expanded below, in-process.
const TARGETS = new Set([
  "session-start",
  "record-human-turn",
  "fold-usage",
  "deliver-stage-rules",
  "guard-tool-call",
  "write-audit-log",
  "run-sensors",
  "sync-workflow-state",
  "rebuild-stage-graph",
  "continue-workflow",
]);

// The dispatcher's PreToolUse group (aidlc-command.ts HOOK_GROUPS), mirrored
// here because this shim expands it in-process: same members, same order, same
// per-member tool matchers.
const READ_WRITE_OR_SHELL =
    "^(?:Read|NotebookRead|Edit|MultiEdit|Write|NotebookEdit|LS|Glob|Grep|Bash)$";
const WRITE_SHELL_OR_DISPATCH =
    "^(?:Edit|MultiEdit|Write|NotebookEdit|Bash|Task|Agent)$";
const GUARD_GROUP: ReadonlyArray<{ hook: string; matcher: string }> = [
  { hook: "state-transition-guard", matcher: READ_WRITE_OR_SHELL },
  { hook: "reviewer-scope", matcher: READ_WRITE_OR_SHELL },
  { hook: "review-freeze", matcher: READ_WRITE_OR_SHELL },
  { hook: "plan-approval-guard", matcher: WRITE_SHELL_OR_DISPATCH },
];

// ZCode (camelCase) → Claude Code (snake_case). Same-name fields (cwd, prompt,
// source) pass through untouched.
const RENAMES: Array<[string, string]> = [
  ["sessionId", "session_id"],
  ["hookEventName", "hook_event_name"],
  ["toolName", "tool_name"],
  ["toolInput", "tool_input"],
  ["toolResponse", "tool_response"],
  ["stopHookActive", "stop_hook_active"],
];

// The core hooks parse Claude's canonical tool names; ZCode aliases both
// spellings, so normalize to the one the guards match on.
const TOOL_ALIASES: Record<string, string> = {
  Agent: "Task",
  ApplyPatch: "Edit",
};

export function normalize(raw: string): string {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    obj = {};
  }
  const out: Record<string, unknown> = { ...obj };
  for (const [from, to] of RENAMES) {
    if (from in out) {
      out[to] = out[from];
      delete out[from];
    }
  }
  if (typeof out.tool_name === "string" && TOOL_ALIASES[out.tool_name]) {
    out.tool_name = TOOL_ALIASES[out.tool_name];
  }
  return JSON.stringify(out);
}

// The subprocess escape hatch (record-human-turn and import failures): the
// compiled engine re-enters through its own executable; the Bun channel runs
// the hook file directly. record-human-turn travels ONLY through the
// dispatcher's internal entry so the fresh authority token accompanies it —
// `engine hook record-human-turn` would spawn a second engine inside the first
// (two same-image process creations on the slow-spawn hosts).
function runCoreWithStderr(
    hookFile: string,
    input: string,
    projectDir: string,
): { stdout: string; stderr: string; code: number } {
  const hook = hookFile.replace(/^aidlc-|\.ts$/g, "");
  const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
  const authorityToken = hook === "record-human-turn" ? randomUUID() : "";
  const command = executable
      ? authorityToken
          ? [executable, "--internal-aidlc-record-human-turn", join(HOOKS_DIR, hookFile)]
          : [executable, "engine", "hook", hook]
      : authorityToken
          ? [
            process.execPath,
            join(HOOKS_DIR, "..", "tools", "aidlc.ts"),
            "--internal-aidlc-record-human-turn",
            join(HOOKS_DIR, hookFile),
          ]
          : [process.execPath, join(HOOKS_DIR, hookFile)];
  const projectEnv = {
    ...process.env,
    AIDLC_PROJECT_DIR: projectDir,
    CLAUDE_PROJECT_DIR: projectDir,
  };
  const r = Bun.spawnSync(command, {
    stdin: Buffer.from(input, "utf-8"),
    stdout: "pipe",
    stderr: "pipe",
    cwd: projectDir,
    env: authorityToken
        ? { ...projectEnv, AIDLC_INTERNAL_HUMAN_TURN_TOKEN: authorityToken }
        : projectEnv,
  });
  return {
    stdout: r.stdout?.toString() ?? "",
    stderr: r.stderr?.toString() ?? "",
    code: r.exitCode ?? 1,
  };
}

// Run one step with its stdout and stderr collected instead of written. A step
// that throws fails alone: code 1 with the error text, as its own crashed
// process would have ended, and never a refusal.
async function collectOutput(
    step: () => number | Promise<number>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  const text = (chunk: unknown): string =>
      typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf-8");
  process.stdout.write = ((chunk: unknown) => {
    out.push(text(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    err.push(text(chunk));
    return true;
  }) as typeof process.stderr.write;
  let code: number;
  try {
    code = await step();
  } catch (error) {
    err.push(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    code = 1;
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
  return { stdout: out.join(""), stderr: err.join(""), code };
}

// The core hooks that can land on every tool call run INSIDE this process (the
// Codex #2066 pattern): import the packaged module beside this file, pin the
// project the way the child saw it, call its run(input) with the pipes
// collected. A hook that cannot be imported or exports no run() runs as a
// child as before.
async function runCoreHere(
    hookFile: string,
    input: string,
    projectDir: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  let mod: { run?: unknown };
  try {
    mod = (await import(pathToFileURL(join(HOOKS_DIR, hookFile)).href)) as { run?: unknown };
  } catch {
    return runCoreWithStderr(hookFile, input, projectDir);
  }
  if (typeof mod.run !== "function") return runCoreWithStderr(hookFile, input, projectDir);
  const hookRun = mod.run as (input: string) => number | Promise<number>;
  process.env.AIDLC_PROJECT_DIR = projectDir;
  process.env.CLAUDE_PROJECT_DIR = projectDir;
  return await collectOutput(() => hookRun(input));
}

// The dispatcher's runGroupMembers semantics, in-process: each member judges
// the payload unless its matcher excludes the tool; exit 2 collects a refusal,
// any other non-zero keeps the first failure code; the reasons go to stderr so
// ZCode's deny channel carries them.
async function runGuardGroup(
    input: string,
    projectDir: string,
): Promise<number> {
  let toolName: string | null = null;
  try {
    const parsed = JSON.parse(input) as { tool_name?: unknown };
    if (typeof parsed.tool_name === "string") toolName = parsed.tool_name;
  } catch {
    // A payload this process cannot read goes to every member, which judges it.
  }
  let code = 0;
  const refusals: string[] = [];
  const failures: string[] = [];
  for (const member of GUARD_GROUP) {
    if (toolName !== null && !new RegExp(member.matcher).test(toolName)) continue;
    const hookFile = `aidlc-${member.hook}.ts`;
    if (!existsSync(join(HOOKS_DIR, hookFile))) {
      if (code === 0) code = 1;
      failures.push(`aidlc engine hook ${member.hook}: not available in this install\n`);
      continue;
    }
    const said = await runCoreHere(hookFile, input, projectDir);
    if (said.code === 2) {
      code = 2;
      if (said.stderr && !refusals.includes(said.stderr)) refusals.push(said.stderr);
    } else if (said.code !== 0) {
      if (code === 0) code = said.code;
      if (said.stderr && !failures.includes(said.stderr)) failures.push(said.stderr);
    }
  }
  const said = code === 2 ? refusals : failures;
  if (said.length > 0) process.stderr.write(said.join(""));
  return code;
}

// ZCode validates hook stdout against a strict schema (any extra key fails)
// and the per-event members discriminate on a REQUIRED hookEventName. The
// core session-start hook emits Claude's shape ({additionalContext,
// hookSpecificOutput:{...}}); reshape it to ZCode's. Every other target's
// output already fits (guards: exit 2 + stderr; Stop: {"decision":"block"}).
function reshapeSessionStart(stdout: string): string {
  if (stdout.trim() === "") return stdout;
  try {
    const obj = JSON.parse(stdout) as Record<string, unknown>;
    const context =
        typeof obj.additionalContext === "string"
            ? obj.additionalContext
            : typeof (obj.hookSpecificOutput as Record<string, unknown> | undefined)?.additionalContext === "string"
                ? ((obj.hookSpecificOutput as Record<string, unknown>).additionalContext as string)
                : undefined;
    const out: Record<string, string> = { hookEventName: "SessionStart" };
    if (context !== undefined) out.additionalContext = context;
    return `${JSON.stringify(out)}\n`;
  } catch {
    return stdout;
  }
}

export async function run(target: string, input: string, extraArgs: string[] = []): Promise<number> {
  if (!TARGETS.has(target)) {
    process.stderr.write(`aidlc-zcode-adapter: unknown target '${target}'\n`);
    return 64;
  }
  if (extraArgs.length > 0) {
    process.stderr.write(`aidlc-zcode-adapter: ignoring extra args ${JSON.stringify(extraArgs)}\n`);
  }
  const projectDirRaw = process.env.AIDLC_PROJECT_DIR ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const payload = normalize(input);

  switch (target) {
    case "record-human-turn": {
      // Authority boundary: subprocess through the internal entry, never an
      // in-process import (see the header note).
      const said = runCoreWithStderr("aidlc-record-human-turn.ts", payload, projectDirRaw);
      if (said.stdout.length > 0) process.stdout.write(said.stdout);
      if (said.stderr.length > 0) process.stderr.write(said.stderr);
      return said.code;
    }
    case "guard-tool-call":
      return await runGuardGroup(payload, projectDirRaw);
    case "session-start": {
      const said = await runCoreHere("aidlc-session-start.ts", payload, projectDirRaw);
      if (said.stdout.length > 0) {
        process.stdout.write(reshapeSessionStart(said.stdout));
      }
      if (said.stderr.length > 0) process.stderr.write(said.stderr);
      return said.code;
    }
    default: {
      const said = await runCoreHere(`aidlc-${target}.ts`, payload, projectDirRaw);
      if (said.stdout.length > 0) process.stdout.write(said.stdout);
      if (said.stderr.length > 0) process.stderr.write(said.stderr);
      return said.code;
    }
  }
}

// Direct-invocation path for debugging (`bun aidlc-zcode-adapter.ts <target>`
// with a payload on stdin); the dispatcher import path above never runs this.
if (import.meta.main) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    data += chunk;
  });
  process.stdin.on("end", () => {
    void run(process.argv[2] ?? "", data, process.argv.slice(3)).then((code) => process.exit(code));
  });
}
