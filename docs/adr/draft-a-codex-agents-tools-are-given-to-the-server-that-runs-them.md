# A Codex agent's tools are given to the App Server that runs them

**Status: accepted, to be built.** Applies [ADR-0007](0007-compact-a-reused-agent-at-a-work-boundary.md)'s
Codex topology, one `codex app-server` per agent with the TUI as its `--remote` client, to
the agent's MCP servers. Keeps [ADR-0059](0059-a-stopped-agent-is-stopped-where-its-turn-runs.md)
D2: a thread with no user message has no in-progress turn, so it is listed with none.

## What happened

From 09:06Z to 10:48Z on 2026-10-22 no Codex agent started, on either Machine. The local
Runs were `run-0c869985`, `run-217f280c`, `run-3d91ccca`, `run-8d72c5d7`, `run-078d79cd` and
`run-424d5c51`. On vm-mk they were `run-d03899b4` and `run-1245512f`. Each failed with
`herdr agent start` reporting `timed out waiting for agent startup`. Each pane showed
Codex 0.162.1's empty composer. herdr classified it `working` by `osc_title_working`,
because the terminal title kept a spinner. Collie 0.84.0 (#179) and 0.85.0 (#180) changed
`codexPort.ready`, which runs only after `agent start` returns, so neither could help.

The cause is in where Collie put its tools. Collie gave `-c mcp_servers.collie.*` to the
TUI only. The App Server was started bare.

- The remote TUI forwards only a whitelist of session flags to `thread/start`, and
  `mcp_servers` is not on it (`codex-rs/tui/src/app_server_session.rs`,
  `config_request_overrides_from_config`, in 0.162.0, 0.162.1 and 0.163.0). So the server
  never starts `collie`. `config/read` on every stuck server, three local and three on
  vm-mk, has no `mcp_servers.collie`.
- The TUI expects a startup status from every MCP server in its own config
  (`app/app_server_events.rs`, `refresh_mcp_startup_expected_servers_from_config`). It
  keeps `mcp_startup_status` set until each expected name has reported
  (`chatwidget/mcp_startup.rs`). Its title shows a spinner while that is set, even with no
  turn running (`chatwidget/status_surfaces.rs`, `terminal_title_has_active_progress`).
  The spinner never stops, and herdr waits for an idle agent that never comes.

The A/B test used the same Codex 0.162.1 TUI command and herdr's `codex` manifest
2026.10.11.1, on both Machines, and sent no prompt.

- **Bare server:** `agent start` timed out at about 15.3 s. The TUI kept its spinner and
  was never named.
- **Same `mcp_servers.collie` entry also given to the server:** the agent was named, idle
  and `interactive_ready` in 4.3 s locally and 5.2 s on vm-mk. The title was plain.

Each stuck agent could not be stopped either. Its server had a bound thread that no user
message had materialized. `thread/turns/list` refuses such a thread with "not materialized
yet". The stop read that refusal as a failure before it sent its SIGTERM. The TUI and the
server stayed up, and every later start under that name parked as not quiet.

## Decision

**D1. The App Server gets the agent's MCP servers.** The entries Collie generates for an
agent are part of starting that agent's App Server: its tools, with their per-Run
environment. The agent's tools run in the server.

**D2. The TUI's copy is the same as the server's.** The TUI keeps exactly the entries the
server got. Codex waits for every server it expects, so an entry on one side only is a
Codex agent that never starts. The A/B test proved this configuration, with the entries
on both sides. The model, the permission flags and the operator's profile stay where they
are.

**D3. Not herdr's classifier.** The spinner is Codex reporting startup that is really
still pending. Changing herdr's rule, or weakening Collie's readiness, would start an agent
without its tools. #179 and #180 changed the readiness check that runs after `agent start`
returns. They neither caused this nor cured it. The reasons they give are contradicted:
the TUI binds its thread before the first prompt, and nothing shows `initialize` waiting on
MCP setup.

**D4. An idle thread that has no user message has no in-progress turn.** The stuck
servers answer `thread/read` with status `idle`, no turns and a rollout path that is set.
They answer `thread/turns/list` with JSON-RPC `-32600`, "thread … is not materialized yet;
thread/turns/list is unavailable before first user message". The stop treats that thread
as having no in-progress turn only when both answers are true. It then drains the server as
ADR-0059 D2 says. A rollout path is not evidence either way. vm-mk's Codex gave such a
thread a second answer: `thread/read` reported history mode `paginated`, and
`thread/turns/list` refused with `-32601`, "list_turns is not supported yet". The same
thread later listed no turns, still with no user message, so this answer is not known to
last until the first one. That thread counts too, but only when `thread/read` reports it
`idle`, with no turns, history mode `paginated` and an empty preview. Any other refusal still fails the stop, and so does either refusal on a thread that
fails its conditions. ADR-0059 D4's proof of ownership is unchanged.

**D5. A Run's stop reaches a start herdr never admitted.** Such a start has a control record
naming its server and the Run's log, but no launch, because the launch is recorded only once
`agent start` succeeds. A Run's stop stops each such server too, through the same `stopAgent`
and ADR-0059 D4's proof of ownership, under the agent's control lock. A start still holding
that lock is not stopped then: its launch halts the Run's agents once it has ended, whether
it started or failed. A record the stop cannot read, or a records directory it cannot list,
is named as not stopped rather than taken as none. It never touches another Run's records.
Its pane stays open, because Collie never learned which pane it was. The real canary found
this: on the candidate, the stop of a failed control Run answered `applied` and stopped
nothing.

## Consequences

- A Codex fix is not done until a real Codex agent on each Machine has done all of this:
  started under its name, taken its first prompt, called a Collie tool, taken a second
  turn, had its Output collected and been stopped to quiet. A test against the stand-in
  server proves the arguments, not that Codex accepts them. The proof uses a candidate
  build in an installation of its own, so it needs no merge and leaves the live host
  alone.
- The stuck agents left by 2026-10-22 can be stopped by the fixed build. Nothing in this
  decision removes them by hand.
