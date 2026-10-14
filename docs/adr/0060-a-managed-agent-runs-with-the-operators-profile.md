# A managed agent runs with the operator's profile

**Status: accepted.** Implemented 2026-10-13.

## What was true before

- **A managed agent got everything a human session gets.** Collie starts a harness in a
  pane, so it loaded every plugin and persona, every claude.ai connector and the global
  `~/.claude/CLAUDE.md` — context and behaviour meant for a person, paid for on every turn.
- **There was nowhere to say otherwise.** The only way to change what an agent loaded was
  to change the operator's own config, which changes their own sessions too.
- **A credential an agent needed had no safe route.** Typing it into a goal or a steer puts
  it in a record and a prompt.

## Decision

**D1. One shared setting, `agent_profile`, holds an overlay per role.** A role's own entry
applies, else `*`'s; the two are never merged. It is a shared setting like any other
([ADR-0043](0043-a-shared-setting-is-its-latest-edit.md)): one JSON text, synced as written,
so the Flock settings protocol and its schema do not change. Empty is the default, and a
launch with no overlay is identical to one before this.

**D2. `env` applies to every harness, before it starts.** Collie types each variable into
the agent's pane before `herdr agent start`, as it already does for its MCP environment;
herdr's start has no environment of its own to pass. A Codex App Server or OpenCode server
Collie starts for the agent runs the same lines first, since Codex's tools run in its
server rather than the pane.

**D3. A secret is a file on each Machine, and only its path travels.** A value is either a
literal or `{"file": "<path>"}`. A literal that matches a credential pattern is refused,
because the setting goes to every Machine. A file's value is read by the pane's shell with
`read -r`, never by Collie and never with command substitution, so it appears in no prompt,
record, log, launch argument, typed line or synced setting. `~` is the Machine's own home.
A file that is missing or not `0600` parks that agent's launch, naming the path and the
problem.

**D4. Claude settings are merged into the file Collie passes, from a fixed list.**
`enabledPlugins`, `skillOverrides`, `claudeMdExcludes`, `disableClaudeAiConnectors` and
`hooks`. Hooks are appended per event after Collie's, which are always present; Collie's
delivery receipts and compaction rest on them. `disableAllHooks` and every other key are
refused, so an overlay cannot remove what Collie depends on. Without Collie's compaction
controls the overlay is a settings file of its own.

**D5. Collie ships no policy.** Which plugins, connectors or guards a managed agent gets is
the operator's; `docs/using.md` shows one operator's choices as examples, never defaults.
Codex, Pi and OpenCode take `env` only.

## Consequences

- An operator's own sessions and config files are never written.
- A profile that cannot be applied stops a launch with the reason rather than starting an
  agent without it.
- Whether Claude honours the merged settings is an operator check: one live agent's
  `/status`, `/context` and `/hooks`.
