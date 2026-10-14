# A user's definitions are the Flock's

**Status: accepted, built for paired hosts; Desktop's part (D5) is to be built.** Extends [ADR-0043](0043-a-shared-setting-is-its-latest-edit.md)
from settings to the user Layer, and [ADR-0057](0057-a-machine-reaches-another-over-a-paired-link.md)
D9 to what paired hosts sync.

Every Machine in a Flock holds the same user Layer. Each file in it is decided by
whichever edit of it was made last, wherever it was made, and a removal is an edit.

## What was true before

The user Layer (`~/.collie/user/workflows/` and `~/.collie/user/personas/`) was each
Machine's own. A Workflow forked on the laptop did not exist on a VM. A Run started there
ran the shipped definition instead, and nothing said so. Settings were already shared
(ADR-0043), so the human expected the same of their definitions. Desktop could only show
definitions one Machine at a time, because they differed.

## Decision

**D1. What is shared.** A **shared definition** is a regular file directly in the user
Layer's `workflows/` or `personas/`. That covers modules, their Markdown and their helpers.
It is known by its path in the user directory, such as `workflows/plan.workflow.ts`. Not
shared:

- the toolchain Collie provisions in a Layer to typecheck it (`package.json`,
  `tsconfig.json`, the SDK declarations, `bun.lock` and `node_modules/`), which each
  Machine provisions for itself;
- subdirectories;
- the project Layer, which is the project's checkout and travels with its repository;
- the shipped Layer, which is the release and is levelled with the version.

**D2. An edit's time.** A file's edit is its text at its modification time. A removal is
an edit too. The host records the shared definitions it last saw, beside the settings'
stamps. A recorded file that has gone is recorded as removed at the time the host noticed.
A hand edit is an edit, so no Collie command is needed to share one.

**D3. The latest edit wins, per file.** This is the same latest-edit rule shared settings
use, in one place for both. A host writes a given edit only where it is later than its
own. It gives the written file the edit's own time, so the file is not seen as a new local
edit. An edit made on the Machine while a sync was running survives and comes back in the
reply.

**D4. Nothing is lost silently.** Before a sync replaces or removes a shared definition
whose text differs, the host keeps the text it had in the user directory's `replaced/`,
outside both Layers, and logs which file and why. The edit that lost is still on disk.

**D5. The same paths as settings.** Two additive front-door operations do this: one reads
a Machine's shared definitions and one writes the Flock's. `PROTOCOL` stays. Each
operation is recorded under the Actor that asked
([ADR-0039](0039-every-operation-records-who-asked.md)). They are used where settings are
synced:

- **Hosts.** Each host syncs its paired peers when a link comes up, and after its shared
  definitions change. The host watches the two directories as it watches its settings.
- **Desktop.** Desktop keeps the Flock's shared definitions as it keeps the Flock's
  settings. It syncs each Machine as that Machine connects and on Sync now.

A Machine whose last sync of them failed is behind on its definitions, and Sync now is its
fix. A Machine on an older Collie fails the read. Like settings, it is synced once it is
upgraded.

## Consequences

- One Machine's definitions stand for the Flock's. Desktop's Workflows page is one view,
  not a view per Machine.
- Removing a fork on one Machine removes it everywhere, at the next sync.
- Clocks decide, as they do for settings. Two edits of one file closer together than the
  Machines' clocks disagree may keep the earlier one, and `replaced/` holds the other.
- A file edited on a Machine out of reach spreads when that Machine is next reached. If a
  later edit was made elsewhere in the meantime, the out-of-reach Machine's text ends up in
  its `replaced/`.
- `replaced/` grows only when two Machines edit one file between syncs. Nothing prunes it.

## Considered

- **Syncing the user Layer over SSH or git.** Rejected for the reason ADR-0043 D4 gives:
  the host is the one writer, and a second transport is a second set of failures to show.
- **Only Collie's own writes (`workflow create`, `fork`).** Rejected. An author edits a
  module in an editor, and an edit that only sometimes spreads is worse than none.
