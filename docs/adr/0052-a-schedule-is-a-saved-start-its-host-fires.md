# A schedule is a saved start, and its Machine's host fires it

**Status: accepted, to be built.**

A Workflow can start by itself: once a day, every Monday at nine, whenever a cron
expression says. A Schedule is a start an agent could have made, saved with when to make
it, and the host of the Machine it is on makes it. Whoever adds a Schedule chooses its
Machine, every listing names that Machine, and a Schedule can be moved to another one.
The CLI, chat and Desktop list, pause, resume, remove and move it. A Run it starts is like
any other Run, and its record says which Schedule started it.

## What was true before

Nothing started a Run unless a person or an agent asked at that moment. The host already
did work on its own clock, as side jobs: the merge watch, News, the cleanup sweep and
Home tokens (`src/side-jobs.ts`). None of them started a Run. An Actor's origin was
always a front door (`board`, `desktop`, `cli-tty`, `cli`, `chat`). Only the cleanup
sweep's own journal could say `host`. Nothing in a Run's record said who started it,
although its audit trail had it.

## Decision

**D1. A Schedule belongs to one Machine, and that Machine's host keeps it.** A Schedule
has:

- a name, unique on its Machine;
- a cron expression (five fields) and the time zone it is read in, by default the
  Machine's own, recorded by its IANA name;
- the start, as an agent's start gives one ([ADR-0033](0033-a-run-started-from-the-home-is-placed-not-asked.md)):
  the Workflow, every Input, an optional one as an explicit empty, the checkout, and,
  where the Workflow needs one, the approved verifications.

The checkout is an absolute path or `projects-root`. A workspace named by its id or label
is resolved to its checkout's path when the Schedule is added, because the workspace may
be gone by the time the Schedule fires. A Schedule takes no `here` and no attachments.

It is kept as a file under the state directory's `schedules/`, written only by the host
([ADR-0040](0040-the-host-is-the-only-writer.md)). Each change and each occurrence is
recorded beside it with who asked. Cleanup never removes a Schedule. A Schedule is not a
shared setting ([ADR-0043](0043-a-shared-setting-is-its-latest-edit.md)): its checkout is
a path on one Machine, so it means nothing on another.

**D2. A Schedule is checked when it is added, the way an agent's start is.** It must name
its checkout and every Input, the Workflow must be found from that checkout, the Inputs
must decode against its schema, and the cron expression must parse. A Schedule that fails
any of these is refused with the same `needs_input` or `invalid_input` a start gets.
Adding a name that already exists is refused: remove the old one first. There is no edit.

**D3. The host's engine fires it, as a chain of durable workflow executions.** The host
registers one workflow of its own, `Schedule`, on the engine every Run runs on
([ADR-0014](0014-native-workflows-run-on-effects-own-engine.md)). It is not a module and
not a Run, and the board never shows it. One execution is one occurrence of one Schedule.
Its key is the Schedule's name, its epoch and the occurrence. The epoch is the request id
of the add or resume that began the chain, so a Schedule resumed before an occurrence it
was paused at gets a new execution rather than the ended one. An execution:

1. Sleeps on a `DurableClock` until its occurrence. The wake-up is a persisted message in
   the host's database, so it outlives the host.
2. Reads the Schedule. If it has been paused, removed or resumed under another epoch
   since, the execution ends and starts nothing.
3. Starts the latest occurrence at or before now, as one Activity:
   - under the request id `schedule:<name>:<occurrence>`, so an Activity run again after
     a host stops halfway admits one Run, never two
     ([ADR-0017](0017-one-request-is-one-run.md));
   - as the Actor `schedule`, which names the Schedule and the occurrence. It is not a
     human;
   - placed as an agent's fresh start is placed: in the open Task already working its
     branch, or in a new Task in the host's herdr session.

   The execution hands that Run to the engine itself, as a parent hands over its child
   ([ADR-0022](0022-a-workflow-is-made-of-workflows.md)): the receipt is written first,
   then the Run is executed on the Schedule's own fiber. The Run keeps its own Task and
   has no parent. Only the engine knows the Schedule waits on it.

4. Waits for that Run's execution to end. The engine wakes it, as it wakes a parent.
5. Records the occurrence and what became of it, starts the execution for the next
   occurrence, and clears what the engine kept of its own.

Adding or resuming a Schedule writes it and starts its first execution, for the next
occurrence after now. Pausing or removing one only writes it: its waiting execution ends
itself when it wakes. Nothing interrupts a Schedule's execution, because an interrupt
would reach the Run it is waiting on. A host that starts asks the engine for each active
Schedule's pending execution again. Its key makes that a no-op unless the engine lost it.

Effect's `ClusterCron` was not used as it is. It is a Layer whose name and cron are fixed
when it is built, its job is not told which occurrence it is firing, and Sharding never
forgets an entity type. A Schedule removed and added again, or paused and resumed, would
therefore never fire again until the host restarts. A chain of executions is the same
shape `ClusterCron` has inside, one persisted message per occurrence, with the Schedule
as the payload instead of a Layer. A host side job that looked every minute was not used
either: it would keep a second clock beside the one the engine already keeps durably.

**D4. Missed occurrences collapse into one.** The host stays a process a client starts,
not a service ([ADR-0015](0015-one-local-host-owns-a-state-directory.md)). A Machine that
is off, or whose host nothing has started since it booted, fires nothing. Its pending
execution's clock is delivered late when the next host starts, and step 3 starts the
latest missed occurrence once, late. The record says when it was due. A paused Schedule
fires nothing, and resuming it does not catch up: the new epoch's first execution is for
its next occurrence.

**D5. A Schedule runs one Run at a time.** The chain waits for its Run (D3 step 4) before
it starts the next execution. That covers a Run that is running, asking a question, parked
or stalled, because none of their executions has ended. When the Run's execution ends, the
next execution is for the latest occurrence that fell while the Run was going, at once, or
else for the next occurrence the cron expression gives. The start in step 3 retries each
minute while herdr does not answer, because a scheduled Run always gets a Task workspace
and never falls back to one it inherited. Any other refusal is recorded against that
occurrence, and the chain goes on to the next occurrence.

**D6. Every door sees and manages it.**

- **CLI:** `collie schedule add`, `list`, `pause`, `resume`, `remove` and `move`. `add`
  takes the flags `collie run start` takes, plus `--cron` and `--tz`. Every command
  takes `--machine` (D8).
- **Chat:** action kinds carried out by the same executors, and the list in a Collie tool,
  so the Flock chat manages any Machine's Schedules (invariant 1).
- **Desktop:** a Schedules section for each Machine on the Machines page, with pause,
  resume, remove and move. Adding one from Desktop goes through the Flock chat.

The list says, for each Schedule:

- its Machine and its name;
- its Workflow and checkout;
- its cron expression and time zone;
- its next occurrence, and whether it is paused;
- its last occurrence, with what became of it: the Run and its status, "waiting for" a
  Run still going, or the refusal.

**D7. On the board, a scheduled Run is a Run.** It gets its own Task card, or joins the
open Task on its branch, like any fresh start. Its record says who started it: "Started by
schedule `<name>` for <occurrence>". That line is read from the Run's start audit line,
which every Run's record now shows, not only a scheduled one. It is an optional field on a
Run's details, so `PROTOCOL` stays the same
([ADR-0038](0038-the-host-builds-and-serves-the-board.md)). An occurrence that started
nothing is shown on its Schedule, never on the board.

**D8. A Schedule's Machine is chosen when it is added, named everywhere, and only that
Machine fires it.**

- **Choosing.** Whoever adds a Schedule chooses its Machine from those the Flock reaches:
  - **The Flock chat** names one, as it names one for a start. Where the human's Machine
    rule covers the work, the rule decides. With several Machines reachable and nothing
    naming one, the add is refused, as such a start is.
  - **The CLI** names one with `--machine <name>`, where the name is a herdr machine's
    label or id, or this computer's hostname. It reaches that Machine as Desktop does,
    over SSH, by running that Machine's own `collie` with the same command. Without
    `--machine` it acts on the Machine it runs on, and says which. The CLI never reads
    the Machine rule: only the Flock chat's model interprets those words.
  - **Native chat** acts on its own Machine, or runs the CLI with `--machine`.
  - **Desktop** adds through its Flock chat.
- **Naming.** Every listing names each Schedule's Machine, by the name Desktop gives it:
  the CLI's `list`, `collie_installation`, the Flock chat (`<machine>:<name>`) and the
  Machines page.
- **Moving.** Moving a Schedule to another Machine takes three steps:
  1. Add it there, paused, with the same start. Its checkout is replaced where the
     mover names another path, because a path on one Machine may not exist on the other.
  2. Remove it here.
  3. Resume it there.

  Both Machines must be reachable, or the move is refused. A Schedule left on a Machine
  that could not be told would fire again when that Machine came back. A move that stops
  after the first step leaves the new copy paused and says so. The moved Schedule starts
  fresh, with no catch-up. The Runs it already started stay on the old Machine. The CLI
  and Desktop carry out the same three steps through one shared sequence, and the Flock
  chat through a tool of Desktop's own.

- **Firing.** A Schedule is held by the Machine it runs on, and only that Machine's host
  fires it. No other Machine, and not Desktop, fires a Schedule for it. There is no
  failover, because a Schedule's checkout, logins and Runs are that Machine's. A Machine
  that Desktop or the CLI cannot reach still fires its Schedules while its host runs.
  - A Machine that is off, or asleep, or has no host running, fires nothing. Its missed
    occurrences collapse when its host is next up (D4).
  - A Machine whose herdr does not answer waits (D5).
  - Adding, pausing, resuming, removing and moving need the Machine reachable from
    whoever asks. Otherwise they are refused as `machine_unreachable`.

## Consequences

- A Workflow that should run daily needs no cron of the operating system and no agent
  left waiting.
- A Run can be started with nobody watching. Anything it asks still waits on its card.
  Its Schedule waits too, until that Run settles, so an unanswered question becomes a
  visible stop rather than a pile of Runs.
- `FrontDoor` gains `schedule`. Cleanup's list of kinds it keeps gains `schedules`.
- The host's engine runs a workflow that is not a module: `Schedule`, registered with the
  host's stack. Its steps are kept stable across releases, because a waiting execution
  replays against the code of the host that wakes it
  ([ADR-0014](0014-native-workflows-run-on-effects-own-engine.md)).
- The CLI gains a reach to the Flock's Machines, for Schedules only. It finds them with
  `herdr machine list` through `src/herdr.ts`, and runs each Machine's own `collie` over
  SSH, so it needs no Flock client of its own.
- Not decided here:
  - starting the host when a Machine boots;
  - a "run now", which starts the same Workflow by hand;
  - editing a Schedule in place;
  - `--machine` for commands other than `schedule`.
