# A cleanup listing waits while its Machine is connected

**Status: draft.** Decided by the grill step of run-cee1ccc4.

It amends how Desktop reads and sweeps a Machine for
[ADR-0045](0045-collie-removes-what-it-made-once-nothing-needs-it.md) D2. What a sweep
removes, and how each removal is proved, does not change.

## What was true before

- **Desktop gave a listing 15 seconds.** The Cleanup dialog asked every connected Machine's
  host what a sweep would remove. It asked them all at once and showed nothing until every
  one had answered or reached that bound. A Machine past it read "its host did not answer
  in time" and could not be chosen. The only way to ask again was to reopen the dialog,
  which read every Machine again.
- **vm-mk's host routinely took longer.** Between 2026-10-20 and 2026-10-22 its log said
  "the cleanup RPC took N ms to answer" 16 times. 12 of those took over 15 s, and the
  longest took 31 s. Run on vm-mk itself, `collie cleanup` took 15.2 s with nothing to
  remove. Over the same link, `collie usage --machine vm-mk` answered in 0.37 s. The
  connection was not the cause.
- **The listing did work the host had already done.** vm-mk holds 325 Runs and 200 Tasks.
  Its host rebuilt the board back to back, 2–3 s per build, at 95–170% CPU. A listing then
  built the board twice more on that same process: once for Task workspaces and once for
  retention. For every Finished Task, retention also asked herdr again for each session's
  workspaces and panes.
- **A renewed connection ended a sweep in Desktop.** A sweep was waited on for up to 10
  minutes. When its connection was renewed, the row read "Not cleaned" and waited for the
  human to press Try again, although the host takes a sweep once per request.
- **Nothing said where a slow listing spent its time.** The host logged the total and
  nothing more.

## Decision

**D1. A listing judges against the board the host keeps.**

- A listing reads the latest board the host has built. If there is none yet, it waits for
  the build in progress.
- It builds no board of its own.
- A sweep still builds its own when it judges. Its removals are what must not act on a
  stale view, and every removal is judged again when it is made.
- Retention reads herdr's workspaces and panes once per judgement, not once per Task.

**D2. Desktop asks each Machine on its own.**

- Each row fills as its Machine answers, so one slow Machine holds back no other.
- A row being read says how long it has waited.
- A row whose listing failed offers **Read again** for that Machine alone.

**D3. A listing is waited on while its Machine stays connected.**

- What tells a busy host from a gone one is the connection itself. The RPC pings every
  5 seconds, the SSH route has a server-alive check, and a connection that fails either
  drops the Machine's door. A fixed bound cannot make that call: a host's listing grows
  with the history it keeps.
- When the connection is renewed, the listing is asked again on the new one, since asking
  again only reads.
- The listing gives up after 2 minutes in all, with the reason.

**D4. A sweep follows its Machine's connection.**

- When the connection is renewed during a sweep, Desktop sends the sweep again under the
  same request on the new connection, within the same 10 minutes. The host answers it with
  the first sweep's report, because it takes a sweep once per request and finishes one it
  has begun.
- With no connection, the row says it is waiting for the Machine to reconnect.
- Each send is a line in `actions.log`.

**D5. A slow listing or sweep says where its time went.**

- Over the host's slow-call threshold, one host log line gives the total and each kind's
  judging time, slowest first.

## Considered

- **A longer fixed bound.** Every listing would still be shown at once, so all rows would
  wait for the slowest Machine. A host past the new number would fail the same way.
- **A listing the host keeps from its last sweep.** It would answer at once, but it could
  be ten minutes old, and it would still be stale right after a sweep. Judging against the
  board the host keeps is at most one build old.
- **Streaming each kind's judgement as it is made.** It would show progress inside a
  listing, but it needs a new RPC that older hosts lack. How long the row has waited, with
  the connection as the bound, tells the human enough.
- **Making the board cheaper to build.** That is what keeps vm-mk's host busy, and it slows
  every front door, not only Cleanup. It is its own work, measured on its own.

## Consequences

- No call between Desktop and a host changes, so a Desktop with this change also waits
  correctly on a host that does not have it.
- A listing can name an item that a removal made in the same second has already taken.
  The sweep judges every item again, so the listing can overstate what is left, but it can
  never cause a removal.
- Desktop chat's `collie_installation` includes the listing and gives up after 10 s. It
  gets faster from D1, and its bound is unchanged.
