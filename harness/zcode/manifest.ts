// harness/zcode/manifest.ts — the ZCode distribution row.
//
// One core, N harnesses. This manifest tells scripts/package.ts how to project
// the harness-neutral core/ tree into dist/zcode/.zcode/:
//   - the harness directory token substitution ({{HARNESS_DIR}} → .zcode)
//   - the per-dir map (core/<src> → <harnessDir>/<dst>); ZCode renames nothing
//   - which authored files live in harness/zcode/ and where they land
//
// ZCode (the Z.ai desktop coding agent) is Claude-Code-derived: skills and
// commands under .zcode/ use the same .md shapes, its AskUserQuestion tool
// renders structured questions, and its hook control channels match Claude's
// (PreToolUse exit 2 = deny; Stop {"decision":"block"} requests continuation).
// Two hard differences drive the adapter and the hook registrations:
//   1. hook payloads are camelCase near-isomorphs of Claude's (sessionId,
//      tool_name → toolName, …), so every registration routes through
//      hooks/aidlc-zcode-adapter.ts (`aidlc engine adapter zcode <target>`).
//   2. ZCode runs exactly seven hook events; SessionEnd, PreCompact and
//      SubagentStop have no counterpart, so session-end, validate-state and
//      log-subagent stay unregistered (the Kiro/opencode precedent for a
//      host without those seams).
// The hooks themselves live in the project's .zcode/config.json under
// hooks.events.<Event> with hooks.enabled: true — merged into a team's own
// config by the json-entries root integration, never overwriting it.

import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import onboardingFills from "./onboarding.fills.ts";

const manifest: HarnessManifest = {
  name: "zcode",
  productName: "ZCode",
  // A ZCode session open during setup runs none of this folder's hooks until
  // it starts again: ZCode loads a folder's .zcode/config.json hooks at
  // session start only (measured live; a mid-session config edit never fires).
  configNextStep:
    "open ZCode in this project (if it is already open in this folder, exit it fully and start it again) " +
    "and run `/aidlc --doctor`",
  firstRunSteps: [
    "1. Open this folder in ZCode. If ZCode was open during setup, quit it",
    "   fully and open it again: it loads this folder's .zcode hooks only at",
    "   session start.",
    '2. /aidlc "what you want built"  describe your first intent',
  ],
  hookActivation: {
    recovery:
      "Fully restart ZCode in this folder (quit the app and open it again), then run <entry>. " +
      "ZCode loads a folder's .zcode/config.json hooks only when a session starts; a session opened " +
      "before AI-DLC was set up runs none of them.",
    notRunYet:
      "This is expected before your first ZCode chat in this folder. If you already started one, it " +
      "predates the setup: fully restart ZCode in this folder, then run doctor again.",
    agentStep:
      "ZCode is not running AI-DLC's hooks in this folder. You cannot change that from inside the chat. " +
      'Show the person this line: "Fully restart ZCode (quit the app, open it again) in this folder, then ' +
      'type <entry>." Then end your turn.',
  },
  harnessDir: ".zcode",
  orchestratorSkillPath: ".zcode/skills/aidlc/SKILL.md",
  tierFlavor: "claude",
  rootIntegrations: [
    {
      path: ".gitignore",
      policy: "managed-block",
      marker: "gitignore",
      shared: "union",
    },
    {
      // Neutral onboarding block, byte-identical to the other AGENTS.md
      // harnesses (kiro/codex/opencode); the ZCode-native part ships in
      // .zcode/onboarding.md beside the orchestrator skill.
      path: "AGENTS.md",
      policy: "managed-block",
      marker: "agents",
      shared: "identical",
    },
    // NOTE: the hook registrations in .zcode/config.json ship as a harnessFile
    // (the Claude settings.json model: the file inside the harness dir is
    // framework-owned), NOT as a json-entries root integration — the release
    // packager rejects a root-integration path that overlaps the managed
    // .zcode/ tree. A project that already has its own .zcode/config.json
    // must merge the hooks.events block by hand once.
  ],

  // core/<src> → <harnessDir>/<dst>. ZCode keeps every core dir name as-is.
  coreDirs: [
    { src: "tools", dst: "tools" },
    { src: "aidlc-common", dst: "aidlc-common" },
    { src: "knowledge", dst: "knowledge" },
    { src: "sensors", dst: "sensors" },
    { src: "scopes", dst: "scopes" },
    { src: "agents", dst: "agents" },
    { src: "hooks", dst: "hooks" },
    { src: "skills/aidlc-session-cost", dst: "skills/aidlc-session-cost" },
    { src: "skills/aidlc-replay", dst: "skills/aidlc-replay" },
    { src: "skills/aidlc-outcomes-pack", dst: "skills/aidlc-outcomes-pack" },
    { src: "skills/aidlc-knowledge", dst: "skills/aidlc-knowledge" },
  ],

  // Authored harness surfaces copied verbatim (with token substitution on
  // .md/.json text) from harness/zcode/<src> → <harnessDir>/<dst>.
  harnessFiles: [
    { src: "skills/aidlc/SKILL.md", dst: "skills/aidlc/SKILL.md" },
    { src: "skills/aidlc/question-rendering.md", dst: "skills/aidlc/question-rendering.md" },
    { src: "skills/aidlc/composer.md", dst: "skills/aidlc/composer.md" },
    // Plain-reference method stub: ZCode's AGENTS.md has no @-import
    // mechanism, so the stub lists the engine-maintained active-memory files
    // for the conductor to read instead of pulling them ambiently.
    { src: "rules-aidlc.md", dst: "rules/aidlc.md" },
    // The /aidlc slash command: ZCode discovers commands from
    // .zcode/commands/*.md; `skills: aidlc` auto-mounts the conductor.
    { src: "commands/aidlc.md", dst: "commands/aidlc.md" },
    // The ZCode hook shim every registration routes through.
    { src: "hooks/aidlc-zcode-adapter.ts", dst: "hooks/aidlc-zcode-adapter.ts" },
    // Ships as .zcode/config.json (hooks.events.* + hooks.enabled); its
    // root-blocks part feeds the json-entries integration above.
    { src: "zcode-config.json", dst: "config.json" },
    // Project-root .gitignore (beside .zcode/, not inside it). Authored as
    // dot-gitignore so it does not act as a live ignore inside harness/zcode/.
    { src: "dot-gitignore", dst: ".gitignore", projectRoot: true },
  ],

  // Neutral root AGENTS.md (shared identical) + ZCode-native onboarding in
  // .zcode/onboarding.md.
  onboarding: { dst: "AGENTS.md", projectRoot: true, harnessDst: "onboarding.md", fills: onboardingFills },

  // ZCode renames no core dir.
  rulesRename: null,

  // Harmless on ZCode today (unknown frontmatter keys are ignored); kept for
  // parity with the Claude row so the tree stays identical if ZCode grows a
  // native equivalent of Claude's disable-model-invocation.
  runnerFrontmatterAdditions: ["disable-model-invocation: true"],

  // No emit() plugin: every ZCode surface is an authored file or a core
  // projection (the claude route).
  emit: null,
};

export default manifest;
