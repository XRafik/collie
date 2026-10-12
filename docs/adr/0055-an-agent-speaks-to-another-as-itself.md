# An agent speaks to another as itself, and work it starts reports back to it

**Status: accepted.** D1–D8 implemented 2026-10-12.

It builds on [ADR-0054](0054-a-machine-reaches-another-over-a-paired-link.md), which lets
a Machine reach its peer. It amends [ADR-0039](0039-every-operation-records-who-asked.md)
with an `agent` front door, and replaces `src/handoff.ts`'s advice to message a planner
with `herdr agent prompt`.

## What was true before

- **A Delivery reached its agent as bare text.** Nothing said who sent it, so the agent
  that received it could not answer.
- **An agent was never told its own Run.** It had no address to give.
- **Agents had no Collie tools.** Only chat was launched with Collie's MCP. An agent could
  run the `collie` CLI from its shell, and that was recorded as `cli`.
- **The one place agents were told to talk to each other went around Collie.** An
  implementer asked its planner with `herdr agent prompt`, which leaves no Delivery and no
  record, and cannot reach another Machine.
- **A Run had no way to start work elsewhere and hear what came of it.** It could not
  start a Run on another Machine, wait for the findings, and have that agent close
  afterwards.

## Decision

**D1. An agent is a front door of its own.**

- `agent` joins the Actor's front doors. It names the Run and the agent, and it is not a
  human.
- **How it is derived:**
  - For Collie's MCP in a Run's agent, the tool host stamps it from the launch
    environment Collie wrote.
  - For the `collie` CLI in an agent's pane, it comes from herdr's own record of which
    agent the pane is ([ADR-0039](0039-every-operation-records-who-asked.md) D4 already
    asks).
  - A model never names it. Like the rest of the Actor, it is honest rather than secure.
- **Recorded as `agent`.** A front door's `agent` stamp replaces the `cli` stamp an
  agent's CLI got before.

**D2. Every Run's agent has Collie's tools.**

- **The tools.** These are the same Toolkit Native chat has, served by `collie mcp`. They
  are wired into each harness's launch: Claude's `--mcp-config`, Codex's
  `mcp_servers`, Pi's generated extension, and OpenCode's `mcp` config.
- **The CLI stays.** It works in every harness's shell.
- **No new tools.** `collie_do`'s `deliver`, `start`, `stop`, `hold` and `answer` are
  what an agent needs, through the same admission check and executors as every other door
  (invariant 1).

**D3. A Run is found on the Machine that has it.** A tool or a command that names a Run
goes to the Machine whose host has it, as the CLI does under ADR-0054. A board or a list
may name a Machine, and `collie_herd` takes one.

**D4. A message from an agent says who sent it and how to answer.**

- **The line.** The receiving host puts one line before a Delivery whose Actor is
  `agent`:
  `From <agent> of <run> on <machine>. Answer with collie_do deliver to <run> (or collie run steer <run> --operation <agent> "…").`
- **Where it comes from.** It is written from the stamped Actor, never from the text.
- **The text is still sent word for word,** after that line.

**D5. Every agent knows its own address.** Its prompt names its Run, its agent name and
its Machine, beside how to message another Run's agent.

**D6. Work an agent starts reports back to it.**

- **The requester.** A Run started by an `agent` records that agent as its requester.
- **The report.** When the Run settles, its host delivers the Run's result to the
  requester, across Machines where it has to, with D4's line. The result is the Output's
  summary and where the full Output is.
- **Nothing to wait on.** The requester need not poll.
- **No queue.** If the requester's agent is gone, the report is recorded on the started
  Run and not delivered later ([ADR-0017](0017-one-request-is-one-run.md)).

**D7. A Run its Workflow declares as a report closes once it has reported.**

- **The declaration.** A Workflow may declare `closes: "reported"`. Its Run's agents and
  its Task's workspace are then closed once D6's report has been delivered, or recorded
  as undeliverable.
- **What keeps it open.** Another Run that needs the workspace, including a finished Run with a live agent, or a pane a human opened in the workspace
  ([ADR-0045](0045-collie-removes-what-it-made-once-nothing-needs-it.md)).
- **Asking again** is a new start.
- **`investigate`**, a shipped Workflow, is one: one agent, a goal, findings as its Output.

**D8. A start from another Machine names its checkout by its repository.** The receiving
host places the Run in its own checkout of that repository's remote under its Projects
root, on the branch the start names, fetched from the matched remote. A stale local branch or a dirty existing checkout is refused rather than overwritten. Where there is none, the refusal says what it looked
for ([ADR-0033](0033-a-run-started-from-the-home-is-placed-not-asked.md)).

## Considered

- **Tools of their own for agents** (`collie_message`, `collie_start`). These repeat
  `collie_do` under other names, so a second contract would drift from the first.
- **The CLI alone.** This is what an agent could already do, and an agent that has a tool
  in front of it uses it. MCP also gives the tool host the place to stamp D1 from.
- **Polling with `collie run watch`.** It works, and stays for a caller that wants to
  block. A report the requester doesn't have to ask for is D6.
- **Keeping the investigator alive for follow-ups.** mk asked for it to close once it has
  reported. A follow-up is cheap to start, and an agent left alive is a cost nobody is
  watching.

## Consequences

- An agent on the VM working on Desktop can start `investigate` on the laptop, in the
  laptop's own checkout of the same branch. It is told the findings when they come, and
  the laptop's agent and its workspace are gone afterwards.
- Two Runs' agents on either Machine can hold a conversation. Each message names its
  sender, and each answer is a Delivery the other receives.
- Each line of that conversation is recorded on the Run that received it, as the agent
  that sent it.
- A Schedule on one Machine may manage another's through `--machine` once
  ADR-0052 is built. A Schedule
  still belongs to the Machine that fires it.
