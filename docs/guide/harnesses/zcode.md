# Running AI-DLC on ZCode

ZCode is the Z.ai desktop coding agent. This distribution ships AI-DLC onto ZCode's
native surfaces: the `/aidlc` slash command and skills under `.zcode/`, hook
registrations in the project's `.zcode/config.json`, and the neutral `AGENTS.md`
onboarding block at the project root.

## Install

```
aidlc config --harness zcode
```

in the project, then fully restart ZCode in that folder (ZCode loads a folder's
`.zcode/config.json` hooks only when a session starts) and run `/aidlc --doctor`.

Project hooks need one-time workspace trust: the first session after setup shows
ZCode's hook trust prompt — review the registered commands and choose trust.
After that the hooks run silently.

## How it works

- **Entry point**: `.zcode/commands/aidlc.md` (auto-mounts the `aidlc` skill)
  drives the same forwarding loop as every harness: `aidlc engine orchestrate
  next` → act on the directive → `report` → repeat.
- **Hooks**: every registration routes through
  `.zcode/hooks/aidlc-zcode-adapter.ts` (`aidlc engine adapter zcode <target>`).
  The adapter renames ZCode's camelCase payloads (`toolName` → `tool_name`, …)
  into the Claude shape the core hooks parse, then forwards stdout/stderr/exit
  code unchanged — ZCode's control channels align with Claude's (PreToolUse
  exit 2 = deny; Stop `{"decision":"block"}` requests continuation).
- **Questions**: ZCode has an `AskUserQuestion` tool, so structured questions
  render natively as on Claude Code (see `.zcode/skills/aidlc/question-rendering.md`).
- **Personas**: the 14 persona files under `.zcode/agents/` are reference
  material; ZCode has no native agent registry there, so the conductor prepends
  the persona to the delegation prompt when it dispatches a subagent.

## Differences from Claude Code (known gaps)

ZCode runs exactly seven hook events, so three core hooks stay unregistered —
the same degradation the Kiro and opencode distributions ship:

| Missing event | Unregistered core hook | Effect |
|---|---|---|
| SessionEnd | session-end | No `SESSION_ENDED` audit row; session bookkeeping derives from the engine's own record |
| PreCompact | validate-state | No pre-compaction state validation |
| SubagentStop | log-subagent | No subagent-completion audit rows |

Also absent on ZCode: no status line, no welcome banner, and no
`disable-model-invocation` frontmatter (the ~40 stage runner skills appear in
the project's skill list; their descriptions are prefixed `aidlc-`).

ZCode hook payloads carry no `transcript_path`; the core Stop hook already
supports a transcript-less host (Kiro/opencode precedent).

## Porting notes

See `ZCODE-PORT-NOTES.md` in the framework repo root for the payload/schema
analysis this port is built on (extracted from zcode.cjs 0.16.9). Key facts:

- Workspace hook config: `hooks.events.<Event>` + `hooks.enabled: true`; a
  `matcher` must be omitted (match-all) or a **non-empty** regex — an empty
  string fails the whole file's schema validation.
- Hook stdout is validated against a strict per-event JSON schema (extra keys
  fail); the adapter reshapes session-start output accordingly.
- Hooks config is read at session start only; mid-session edits never fire.
