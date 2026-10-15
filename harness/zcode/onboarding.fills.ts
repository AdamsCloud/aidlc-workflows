// harness/zcode/onboarding.fills.ts — ZCode's onboarding-doc fills.
// The packager fills core/templates/onboarding-harness.md into
// dist/zcode/.zcode/onboarding.md, with .zcode token projection. The root
// AGENTS.md stays neutral, identical to the other sharing harnesses.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/aidlc",
  slots: {
    title_block: `# AI-DLC on ZCode

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development, running on **ZCode**. The workspace shell ships in \`.zcode/\` (no setup command); describe what you want to build and it sets up the workflow for you. Run \`/aidlc\` followed by a scope or project description to begin. Run \`/aidlc --doctor\` to validate your setup, \`/aidlc --version\` to print the framework version, \`/aidlc --stage <slug>\` to jump to a specific stage, \`/aidlc --phase <name>\` to jump to a phase, \`/aidlc --depth <level>\` to override depth, \`/aidlc --test-strategy <level>\` to override test volume, \`/aidlc --review <class>\` to cap stage reviews (adversarial, advisory, none). Run \`/aidlc compose "<task>"\` to get a plan tailored to that task (works up front, from a scan report via \`--report <path>\`, and mid-workflow to re-shape the pending stages - every proposal stops at an approve/edit/reject gate).`,

    prereq_bullets: `- **ZCode desktop**: fully restart ZCode in this folder after setup (quit the app and open it again). ZCode loads a folder's \`.zcode/config.json\` hooks only when a session starts; a session opened before setup runs none of them, and \`/aidlc --doctor\` reports that.
- **aidlc on PATH**: the framework commands run through the \`aidlc\` binary (or \`bun .zcode/tools/aidlc.ts\` in the copy channel); keep it resolvable from the shell ZCode starts with.
- **Model provider**: nothing here selects a provider or model; ZCode keeps your existing model configuration. Run \`{{INVOKE}} config providers\` to record and validate a project provider choice.
- **MCP servers**: none ship for ZCode today. A project's own \`.zcode/config.json\` \`mcp.servers\` entries are left untouched by setup and remain available to every agent.`,

    prereq_bullets_tail: `- **Activation**: type the whole \`/aidlc ...\` request before pressing Enter; it loads the shipped \`.zcode/skills/aidlc/SKILL.md\` conductor (the \`.zcode/commands/aidlc.md\` entry auto-mounts it) and drives the workflow. The \`.zcode/config.json\` hook registrations take effect when the session starts.`,

    hook_permissions_note: `ZCode runs configuration-file hooks only with \`hooks.enabled: true\`, which the shipped \`.zcode/config.json\` already sets; no per-hook approval prompt appears. The registrations merge into any existing \`.zcode/config.json\` without touching your own keys.`,

    agents_note: `The 14 persona \`.md\` files ship under \`.zcode/agents/\` as reference material: ZCode has no native agent registry there, so the conductor reads the persona it needs and delegates through its subagent tool with that persona as the prompt (the four delegated stages — 2.1 pipeline, 2.2 subagent, 2.4 mob, 3.5 subagent — reviewer passes, and composer requests all travel this way).`,

    structure_extra: "",

    sections_before_resumption: `## What's different on this harness

This is the same AI-DLC core that ships to every harness: the same ordered steps, the same approval gates, and the same written record of what was decided, rendered onto ZCode. On ZCode:

- Approval gates and questions render through the **AskUserQuestion** tool, as on Claude Code (see \`question-rendering.md\`); the questions FILE with \`[Answer]:\` tags remains the source of truth.
- There is **no statusline** and **no welcome banner**; use \`/aidlc --status\` and the progress lines at gates.
- \`SESSION_ENDED\`, \`SESSION_COMPACTED\` and subagent-completion audit rows are NOT emitted: ZCode runs exactly seven hook events and has no SessionEnd, PreCompact or SubagentStop counterpart (the Kiro/opencode precedent). Session bookkeeping, pre-compaction state validation and subagent audit therefore degrade to what the engine derives from its own record.
- Every hook registration routes through \`.zcode/hooks/aidlc-zcode-adapter.ts\` (\`{{INVOKE}} engine adapter zcode <target>\`), which renames ZCode's camelCase payloads to the Claude shape the core hooks parse.
- A workflow's \`aidlc/\` workspace tree is harness-neutral: a project can move between Claude Code and ZCode installs (keep both \`.claude/\` and \`.zcode/\` in sync via the framework's packaging if you do this).
`,

    sections_after_resumption: "",
  },
};

export default fills;
