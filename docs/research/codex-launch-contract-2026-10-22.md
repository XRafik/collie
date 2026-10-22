# Codex launch failures in Collie, 2026-10-22

Research scope: Collie at `3a6c4eab61d59991d933dc4c5ba052dc00c8d0f6`, the two preceding repair attempts, failed local and VM Runs, the installed Codex versions, and the first-party Codex App Server contract. This is research for a fix plan, not evidence that a repair has shipped.

## Findings

The startup root cause is a configuration mismatch between Codex's remote TUI and the App Server that executes its work. Collie configures its MCP server only on the TUI. Codex does not forward that setting to the execution server, but the TUI waits indefinitely for the configured Collie server to report startup. This keeps its working OSC title active and prevents herdr's start from completing. The same mismatch also removes Collie's tools from the model. Controlled A/B probes on **both machines** change only the App Server's MCP flags and reverse the startup failure. A second, directly reproduced recovery defect prevents Collie from stopping these unprompted servers. Both need coverage in the fix plan.

### 1. The observed failure happens inside herdr's start, before the readiness code that both repairs changed

The parent investigation read the actual Runs, their panes through `src/herdr.ts`, and their live process commands. The following local panes show Codex 0.162.1's empty composer, `Ask Codex to do anything`, while herdr reports the generic `codex` agent as working. They do not have the requested Run agent's name or an initial Delivery:

| Local Run              | Pane     | App Server port |
| ---------------------- | -------- | --------------- |
| `run-8d72c5d7` (stage) | `w26:p7` | `44567`         |
| `run-078d79cd`         | `w22:p9` | `39143`         |
| `run-424d5c51`         | `w25:p7` | `40269`         |

The VM exhibits the same symptom:

| VM Run                                            | Pane     | App Server port |
| ------------------------------------------------- | -------- | --------------- |
| `run-fdac38c9.implement-spilnu-frontend-monorepo` | `wJ2:p1` | `44179`         |
| `run-099be94c.implement-spilnu-frontend-monorepo` | `wJ3:p1` | `43221`         |
| `run-d03899b4`                                    | `wJ4:p1` | `33673`         |
| `run-1245512f`                                    | `wJ5:p1` | `42011`         |

Both VM implement parent Runs report startup failure. Both machines classify these empty Codex composers through `osc_title_working`, priority 1050, using the remote manifest dated `2026.10.11.1`. These are observations reported from the parent investigation's live host/pane reads, not an inference from the interactive shell's installed version. The parent retains the source Run logs and diagnostic captures.

Collie waits for `host.herdr.agentStart` in [`src/agents.ts`](../../src/agents.ts#L1842). Only after that returns does it register the agent, record the launch, write its prompt, and call `awaitReady` at line 1962. The observed start timeout occurs before all those later steps. That ordering explains the live combination of an existing TUI and server, no Run-named agent, and no first Delivery. [`start` and `launch`](../../src/agents.ts#L1842), [`awaitReady`](../../src/compaction.ts#L634)

The pinned herdr 0.9.3 start loop confirms the mechanism. Its `agent_status` match keeps waiting on `working`; Codex's special acceptance of `interactive_ready` applies only to `unknown`, while the ordinary acceptance path requires `idle` or `done`. A pane classified as working therefore cannot pass this start boundary just because its composer is available. The fetched source exactly matches [herdr 0.9.3 `wait_for_started_agent`](https://github.com/herdrdev/herdr/blob/v0.9.3/src/cli/agent.rs#L609). The pin is recorded in [`herdr-pin.json`](../../herdr-pin.json).

Codex's own source confirms that `Ask Codex to do anything` is its empty composer placeholder; the displayed text is not evidence that it is executing the Run's task. The working title is explained below by unresolved MCP startup, even though no model turn has begun. [Codex 0.162.1 placeholder](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/chatwidget.rs#L2062)

**Proven:** herdr's startup wait is downstream of Codex's unresolved MCP startup. Relaxing the working recognizer is unnecessary to explain or reverse the observed failure; the controlled comparisons succeed with the same herdr rules after fixing only the server configuration.

The VM's `run-d03899b4-grill-r1` App Server log confirms the listener on port 33673. It also reports an ignored `experimental_use_rmcp_client` setting and a Linear OAuth `invalid_grant` after approximately four seconds. Those messages are not proof of the startup cause: the local server logs show listeners without corresponding MCP errors yet reproduce the same start failure. These logs were read through Collie's `readFile` interface at `state/compaction/<agent>/app-server.log`.

### 2. One missing server configuration causes both the perpetual spinner and absent tools

Collie starts the execution process as bare `codex app-server --listen ws://127.0.0.1:0`; the environment here contains the operator profile overlay. The separately launched remote TUI receives the generated `-c mcp_servers.collie.command=…`, `args`, and per-Run environment flags. [`codexEndpoint`](../../src/compactors.ts#L1070), [`installControls`](../../src/compaction.ts#L409), [Codex MCP arguments](../../src/harness.ts#L169), [agent launch argument assembly](../../src/agents.ts#L1842)

This does not configure the remote server. In Codex 0.162.1, `config_request_overrides_from_config` forwards only selected session flags to `thread/start`. Its whitelist excludes `mcp_servers`. Model and approval settings are forwarded separately; the defect should not be generalized to every TUI flag. The same whitelist exists in both 0.162.0 and 0.163.0. [0.162.1 forwarding whitelist](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/app_server_session.rs#L1935), [0.162.0 whitelist](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/tui/src/app_server_session.rs#L1935), [0.163.0 whitelist and thread parameters](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/tui/src/app_server_session.rs#L1940)

The parent confirmed this against all three actual local endpoints with read-only `config/read` requests: each effective server configuration contains `node_repl` and **does not contain `mcp_servers.collie`**, despite the Collie overrides in the associated remote TUI command. `mcpServerStatus/list` shows four `node_repl` tools and runtime application services, never Collie's server. VM endpoints `33673`, `42011`, and `44179` likewise have no Collie entry in configuration or MCP status. The VM instead configures `linear-server`, `context7`, `chrome-devtools`, `gh-grep`, and `helle`; the observed Linear account is not logged in and has zero tools, while other services are usable. No authentication values are reproduced here. [Official OpenAI App Server configuration and MCP inspection interfaces](https://learn.chatgpt.com/docs/app-server)

The resulting TUI behavior is specified by Codex 0.162.1's source:

1. The expected MCP server set is populated from the **TUI's** enabled `config.mcp_servers`, so it includes the Collie override. [Expected-server collection](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/app/app_server_events.rs#L36)
2. Startup finishes only when every expected name has reported a non-starting status. The execution server cannot report the Collie name it was never configured with. [MCP startup completion condition](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/chatwidget/mcp_startup.rs#L128)
3. The visible startup header disappears when all **reported** entries have settled, even if an expected name is missing. This produces the misleading empty composer. [Header rendering](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/chatwidget/mcp_startup.rs#L160)
4. The title remains active while `mcp_startup_status` is present. Herdr therefore continues matching `osc_title_working` and its start waits forever. [Title activity predicate](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/chatwidget/status_surfaces.rs#L1059), [herdr startup wait](https://github.com/herdrdev/herdr/blob/v0.9.3/src/cli/agent.rs#L609)

**Proven:** this configuration mismatch explains both symptoms through one causal chain. MCP authentication errors are distinguishable from the missing-name problem: a reported failed server is a terminal status, whereas Collie never appears at all.

### 3. Controlled A/B probes on both machines isolate the cause

The parent ran `/tmp/codex-mcp-startup-probe.ts` through Collie's `src/herdr.ts` boundary using the actual Codex **0.162.1** binary. It started a temporary App Server and remote TUI with the same TUI Collie flags and the same herdr configuration in both cases. Neither case began a model turn. The only treatment was adding the same per-Run Collie MCP `-c` flags to the **App Server**:

| Observation                   | A: bare execution server   | B: server also receives Collie MCP flags |
| ----------------------------- | -------------------------- | ---------------------------------------- |
| `agentStart`                  | timeout after **15.270 s** | success after **4.314 s**                |
| Agent identity                | unnamed generic `codex`    | `codex-mcp-probe-b`                      |
| Status                        | `working`                  | `idle`, `interactive_ready=true`         |
| OSC match                     | `osc_title_working`        | `osc_title_idle`, plain `.collie` title  |
| Effective server Collie entry | absent                     | present                                  |
| Composer                      | empty                      | ready                                    |

Local diagnostic logs are under `/tmp/collie-codex-mcp-probe-GBl2hC/`, including `codex-mcp-probe-a.log` and the corresponding B log.

The equivalent VM probe used the original working directory `/home/mk/work/gitte2/gitlab.cego.dk` and Codex **0.162.1**, again changing only the App Server MCP configuration:

| Observation     | A: bare execution server   | B: server also receives Collie MCP flags                        |
| --------------- | -------------------------- | --------------------------------------------------------------- |
| Endpoint / pane | `45833` / `wJ4:p2`         | `33819` / `wJ4:p3`                                              |
| `agentStart`    | failure after **15.277 s** | success after **5.215 s**                                       |
| Agent identity  | unnamed generic `codex`    | `codex-mcp-probe-b`                                             |
| State           | `working`, spinning title  | `interactive_ready=true`; herdr status `done`, explanation idle |
| Title           | active spinner             | plain title                                                     |

VM artifacts are `/tmp/collie-codex-mcp-probe-1mWoNC/codex-mcp-probe-{a,b}.{json,log}`. Both machines' temporary tabs and servers were cleaned after observation. These probes demonstrate that the configuration correction alone reverses startup on both machines; they do not yet prove a complete workflow or a deployed fix.

### 4. A separate recovery defect strands servers that have not received a first user message

The parent directly executed `withCodex` → `agentThreads` against original local endpoints **44567** and **39143**, with the matching agent working directory. Both returned `CodexError` from `thread/turns/list`: the thread is not materialized yet and this operation is unavailable before the first user message. This is an explicit upstream case, not a transport or authentication failure. [Codex 0.162.1 error mapping](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server/src/request_processors/thread_processor.rs#L5942)

Collie's `agentThreads` unconditionally calls `runningTurns`, which uses this persisted-history operation. `stopCodex` requires that read to succeed **before** it sends the server its first SIGTERM. Consequently, stopping or replacing an unprompted failed-start agent fails before draining its server; orphan processes and their control records remain. [`agentThreads` / `runningTurns`](../../src/codex.ts#L374), [`stopCodex` ordering](../../src/compactors.ts#L1152)

The regression must represent a loaded thread before its first message and prove that safe stop reaches quiet. Any special handling must be limited to this established protocol state, preserving ownership checks and failures for other unreadable turns. Converting every `thread/turns/list` error to an empty list would hide running work and violate Collie's stop contract. [Stop ownership and fail-closed requirements](../adr/0059-a-stopped-agent-is-stopped-where-its-turn-runs.md)

### 5. The two previous attempts tested the wrong boundary and an incorrect startup premise

`91fe01c4` changed `codexPort.ready` from finding a bound thread to accepting a successful `initialize`. Its added test removes all fake threads and asserts readiness. `3a6c4eab` then replaced initialization with a successful WebSocket connection and asserts that no protocol methods were called. Neither changes or tests the preceding `Herdr.agentStart`, its status recognition, agent naming, or first Delivery. [First repair](../../src/compactors.ts#L1275), [second repair](../../src/codex.ts#L163), [added test](../../test/compaction-codex.test.ts#L221); inspect exact changes with `git show 91fe01c4` and `git show 3a6c4eab`.

The current `ready` predicate proves the endpoint accepts a socket, while the symptom is a TUI that exists but is not admitted as the requested agent. The App Server's transport, initialization, thread creation, and turn execution are distinct states in the documented lifecycle. [Codex port readiness](../../src/compactors.ts#L1282), [official App Server lifecycle](https://learn.chatgpt.com/docs/app-server)

The first repair's premise that current Codex creates its thread only after the first prompt is false for the failing release. A fresh 0.162.1 TUI automatically invokes startup thread creation; that path submits `thread/start` before any user message. Read-only `thread/loaded/list` calls returned **one thread on each of the seven failed local/VM endpoints**. A missing first thread therefore does not explain this incident. [Fresh-session startup](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/app/startup.rs#L498), [startup thread request](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/app_server_session.rs#L1812)

The comment that initialization can block on optional remote MCP setup is not established by the upstream 0.162.1 initialization implementation. It must not be treated as a proven explanation of these failed Runs. [Codex 0.162.1 initialize implementation](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server/src/request_processors/initialize_processor.rs#L56)

### 6. Implementation follow-up: the real canary found that a failed Run's stop never reached its start's server

Added during implementation, after the research phase. The canary evidence is kept in the implementing Run's handoffs, tied to the commit each one tested.

On mk-laptop, control Run `run-94cd763f` timed out at `agent start` under the installed 0.85.0. After `collie host restart --dir` onto the candidate (d9727839, which already carried finding 4's fix), `collie run stop` answered `applied` with `closed: []` and `left: []`. It sent no SIGTERM, and Codex 0.163.0's App Server and its whole session stayed up. The cause was in Collie, not Codex. A Run's stop halted only the agents in its launch records, and a launch is recorded only once `agent start` succeeds. The start's control record already named the server, its endpoint and pid, and the Run's log, so nothing was missing except a stop that looked there. [`Agents.halt`](../../src/agents.ts), [control records](../../src/compaction.ts)

The stop now also reaches each control record that names the Run's log and a server, with no launch. It goes through the same proof of ownership, under the control lock. Four cases are covered against the stand-in:

- A start still holding the lock when the stop lands is left to its launch.
- A launch that then fails halts the Run's agents if a stop was requested, so that server is stopped too.
- A record that cannot be read or parsed, and a records directory that cannot be listed, leave the stop unproven rather than empty.
- Another Run's record is never touched.

Codex 0.163.0's not-materialized refusal has the same text as 0.162.1's.

### 7. Implementation follow-up: vm-mk's Codex refused the same thread with `-32601`

Added during implementation. On vm-mk, Codex 0.162.1's App Server for control Run `run-a2e08439` answered `thread/turns/list` with `-32601`, "list_turns is not supported yet", where mk-laptop's gave the not-materialized `-32600`. The candidate's stop failed on it with no signal sent, and so did a later launch's prune. `thread/read` reported the thread `idle`, with no turns, history mode `paginated` and an empty preview.

In 0.162.1, `thread/turns/list` takes the paginated path when `read_thread` returns history mode `paginated`, which it derives from the rollout's `session_meta` where there is one. That path refuses with `Unsupported { operation: "list_turns" }`, mapped to `-32601`, when the store has no state database, the thread has no metadata row, or the row's mode is `legacy`. So a thread read as paginated from its rollout while its row still said `legacy`, or had none, would answer as vm-mk's did. Only past that check does a thread with no rollout get the not-materialized `-32600`. The 0.163.0 handler is the same. [validation](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/thread-store/src/local/thread_history/read.rs#L188-L215) (no state database L194, no row L197-L206, `legacy` row L212-L214), [mode from the rollout](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/thread-store/src/local/read_thread.rs#L359-L362), [error mapping](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server/src/request_processors/thread_processor.rs#L5916)

The thread's one-line rollout, its `session_meta`, was written at 12:31:23.855 UTC, minutes after the thread started at 12:27:54. Its metadata row was last updated at 12:31:23.867, and now reads `paginated`, preview empty and `has_user_event` 0. By 12:36 the same server listed the thread's turns as empty, with no turn started in between. Which of the three causes held at the refusals is not known: the row's mode at the time was not captured, the row keeps only its latest state, and Codex's log has no entry for it. Nor is it known how long a thread answers this way: this one stopped before any user message. So the stop accepts that refusal only on the shape `thread/read` showed, idle with no turns, history mode `paginated` and an empty preview, and fails on any other `-32601`.

## Test gaps and required proof

The current launch tests use a fake herdr boundary. The Codex control tests use a fake WebSocket server; the installed-harness checks are opt-in and inspect help and generated schemas. Those checks can remain green while the TUI and execution server receive different MCP configurations and herdr never finishes startup. [`test/agents.test.ts`](../../test/agents.test.ts#L1), [`test/compaction-codex.test.ts`](../../test/compaction-codex.test.ts#L406), [`test/support/codex-server.ts`](../../test/support/codex-server.ts#L1), [opt-in switch](../../test/support/live.ts#L12)

The fix plan should require all of the following:

1. Add a regression at Collie's generated-launch boundary that fails when the remote TUI's enabled Collie server is absent from the App Server's invocation. Assert the per-Run command, arguments, environment and operator overlay at the actual server edge. Keep automated tests within the repository's unit-test/fake-edge rule; retain the controlled A/B as a separate runtime diagnostic.
2. Test the Collie launch boundary with the actual error shape: a TUI exists but `agentStart` has not registered the requested name. Assert that failure is reported at this phase, no Delivery is claimed, and a retry cannot silently create a duplicate writer. Do not replace this with another direct `codex.ready` test.
3. Route Codex's generated MCP configuration to the execution server as well as the TUI, so both agree about the expected servers. Verify that unrelated user configuration still loads and persistent user config is not rewritten. The remote TUI must keep the requested model and permission choice. Do not relax herdr's working-state protection or remove the TUI configuration to hide the symptom.
4. Perform a bounded live Collie launch on **each machine**, using its actual host environment and effective Codex binary. Prove registration under the requested agent name, one first Delivery, a turn that consumes the prompt, one successful Collie tool invocation, and a decoded Output. Record the server, thread, turn, pane, and Run identity. A schema check, empty composer, open socket, or successful `model/list` is insufficient.
5. Add a focused regression for stopping a loaded, unmaterialized thread before its first message; prove safe recovery/cleanup reaches quiet, while unrelated history errors still fail visibly. Then exercise reuse, steering, and stop after a normal successful launch. A stop must reach the execution server and its turns; closing the TUI alone does not establish that work stopped. [Collie stop decision](../adr/0059-a-stopped-agent-is-stopped-where-its-turn-runs.md), [stop implementation](../../src/compactors.ts#L1096)
6. Run focused checks through `collie verify`, and record build/version identity for local and VM acceptance. A source-tree pass must not be described as proof that both installed hosts run that build. The existing project instruction requires build plus smoke before changing the release/install path. [Project instructions](../../AGENTS.md)

## Protocol conformance debt, not the current root cause

`withCodex` sends `initialize` but omits the documented `initialized` notification. This should be tracked accurately rather than promoted into another unproven startup diagnosis. The inspected 0.162.1 implementation marks the session initialized while processing `initialize`, and its transport performs outbound initialization bookkeeping, so the omission alone does not establish these failures. The live `config/read` replies further demonstrate that current secondary connections can execute methods. [`withCodex`](../../src/codex.ts#L150), [documented handshake](https://learn.chatgpt.com/docs/app-server), [0.162.1 initialization state](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server/src/request_processors/initialize_processor.rs#L134), [transport bookkeeping](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server/src/lib.rs#L1238)

## Version and evidence limits

The interactive shell's `codex --version` returned `codex-cli 0.163.0`; the inspected failed TUI panes show **0.162.1**. The VM login shell also resolves **0.162.1**. Both hosts report Collie **0.85.0**. Those are different environments; testing only the investigator's PATH would miss the release actually producing the failure. Collie's baseline gate accepts Codex 0.162.0 and later. [`VERIFIED_VERSIONS`](../../src/compactors.ts#L104), parent live pane/process/version observations.

No implementation, host restart, persistent configuration edit, run-state edit, or deployed-repair claim was part of the original research phase. Finding 6 came later, from implementation. Controlled probes changed only temporary process arguments and were cleaned. Causal A/B evidence is complete on both machines. Full Collie workflow acceptance and verification of the eventual recovery fix remain implementation work.
