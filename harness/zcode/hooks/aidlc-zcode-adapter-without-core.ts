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
// with the raw payload already read from stdin. run() renames the payload
// into the ClaudeCodeHookInput shape the core hooks parse, then runs the
// named core hook through the engine dispatcher (`engine hook <target>`,
// which also expands the guard-tool-call composite) as a subprocess,
// forwarding stdout, stderr and the exit code unchanged. No output
// post-processing is needed: ZCode's hook control channels align with
// Claude's — PreToolUse exit 2 + stderr is a deny, Stop
// `{"decision":"block","reason":...}` requests continuation, and SessionStart
// `{"additionalContext":...}` injects context — all of which the core hooks
// already emit in that shape.
//
// Usage (registered in the project's .zcode/config.json hooks.events):
//   aidlc engine adapter zcode <target>
// where <target> ∈ session-start | record-human-turn | fold-usage |
//                  deliver-stage-rules | guard-tool-call | write-audit-log |
//                  run-sensors | sync-workflow-state | rebuild-stage-graph |
//                  continue-workflow

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

// Every registration routes through the dispatcher: it resolves the core hook
// beside this shim and expands `guard-tool-call` into its four guards
// (state-transition, reviewer-scope, review-freeze, plan-approval).
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

// Core hook file per plain target (single-process spawns); guard-tool-call
// (four-guard group) and record-human-turn (its record needs the dispatcher's
// anti-spoof setup — the kiro adapter likewise never runs it bare) stay on the
// dispatcher route.
const PLAIN_HOOK_LEAF: Record<string, string> = {
  "session-start": "aidlc-session-start.ts",
  "fold-usage": "aidlc-fold-usage.ts",
  "deliver-stage-rules": "aidlc-deliver-stage-rules.ts",
  "write-audit-log": "aidlc-write-audit-log.ts",
  "run-sensors": "aidlc-run-sensors.ts",
  "sync-workflow-state": "aidlc-sync-workflow-state.ts",
  "rebuild-stage-graph": "aidlc-rebuild-stage-graph.ts",
  "continue-workflow": "aidlc-continue-workflow.ts",
};

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

function engineHookCommand(target: string): { command: string[]; cwd: string } {
  // The core hook runs from the same payload, so hand it this adapter's
  // project rather than let it derive one from its own path.
  const cwd = process.env.AIDLC_PROJECT_DIR ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const compiledExe = process.env.AIDLC_COMPILED_EXECUTABLE;
  // Plain targets run the core hook FILE directly (one process, the kiro
  // bun-channel pattern): re-entering the dispatcher would add a full engine
  // bootstrap per hook, and ZCode runs hooks inline, so that latency lands on
  // every tool call. Only guard-tool-call needs the dispatcher: it expands the
  // four-guard group in one process.
  const plain = PLAIN_HOOK_LEAF[target];
  const command = compiledExe
    ? [compiledExe, "engine", "hook", target]
    : plain
      ? [process.execPath, join(HOOKS_DIR, plain)]
      : [process.execPath, join(HOOKS_DIR, "..", "tools", "aidlc.ts"), "engine", "hook", target];
  return { command, cwd };
}

// ZCode validates hook stdout against a strict schema (any extra key fails)
// and the per-event members discriminate on a REQUIRED hookEventName. The
// core session-start hook emits Claude's shape ({additionalContext,
// hookSpecificOutput:{...}}); reshape it to ZCode's. Every other target's
// output already fits (guards: exit 2 + stderr; Stop: {"decision":"block"});
// Stop also accepts hookSpecificOutput, so it passes through untouched.
function reshapeStdout(target: string, stdout: string): string {
  if (target !== "session-start" || stdout.trim() === "") return stdout;
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
    return JSON.stringify(out) + "\n";
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
  const payload = normalize(input);
  const { command, cwd } = engineHookCommand(target);
  // Bun's NATIVE spawnSync, never node:child_process: under Bun on Windows the
  // compat-layer spawnSync takes ~10s to create a process from the engine's own
  // image (measured: same-image spawn 10.0-11.7s vs Bun.spawnSync 83ms), which
  // would land on every ZCode tool call. The kiro adapter ships the same
  // Bun.spawnSync pattern.
  const result = Bun.spawnSync({
    cmd: command,
    cwd,
    env: { ...process.env, AIDLC_PROJECT_DIR: cwd, CLAUDE_PROJECT_DIR: cwd },
    input: payload,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutText = result.stdout ? result.stdout.toString() : "";
  const stderrText = result.stderr ? result.stderr.toString() : "";
  if (stdoutText.length > 0) {
    process.stdout.write(reshapeStdout(target, stdoutText));
  }
  if (stderrText.length > 0) {
    process.stderr.write(stderrText);
  }
  // Exit-code passthrough is the control channel: 2 from a PreToolUse guard
  // denies the tool call on ZCode exactly as on Claude Code.
  return result.exitCode ?? 1;
}

// Direct-invocation path for debugging (`bun aidlc-zcode-adapter.ts <target>`
// with a payload on stdin); the dispatcher import path above never runs this.
if (import.meta.main) {
  let data = "";
  const timer = setTimeout(() => {
    process.exit(run(process.argv[2] ?? "", data, process.argv.slice(3)).then((code) => code));
  }, 60_000);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    data += chunk;
  });
  process.stdin.on("end", () => {
    clearTimeout(timer);
    run(process.argv[2] ?? "", data, process.argv.slice(3)).then((code) => process.exit(code));
  });
}
