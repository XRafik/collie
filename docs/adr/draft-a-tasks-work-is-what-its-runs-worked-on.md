# A Task's work is what its Runs worked on

**Status: accepted, to be built.** Amends the rule in [`CONTEXT.md`](../../CONTEXT.md),
Task, that a fresh start joins the open Task whose checkout has its branch out. Builds on
[ADR-0013](0013-the-board-is-cards-of-tasks.md) (the board is cards of Tasks),
[ADR-0033](0033-a-run-started-from-the-home-is-placed-not-asked.md) (an agent's start
names everything), [ADR-0050](0050-a-merge-request-is-its-forges.md) and
[ADR-draft-a-merge-request-is-released-on-a-humans-go](draft-a-merge-request-is-released-on-a-humans-go.md)
D1 and D2. It keeps [AGENTS.md](../../AGENTS.md) Invariant 1 for a Run's offers.

On 2026-10-22, on vm-mk, Task task-56b9b34c ("Monorepo | Plan pending bonus alert on
reminders") had built `mk/cash-bonus-alert-from-reminders` on a worktree and opened
spilnu/frontend/monorepo!355. The human said "let's test this on stage" about its card.
Flock chat started `release` on !355 with the Task's own workspace named. The Release Run
got a Task and a workspace of its own, task-a2e62d73 ("Monorepo | Release merge request
355"), and the board drew two cards for one piece of work. The human's words: "It is not
a separate task."

There were two causes:

- **A Task's work was read from the wrong place.** A fresh start joins a Task when it is
  about "the branch the Task's checkout has out". That checkout is the one the Task's
  first Run was rooted at. A plan is rooted at the repository's main checkout or at the
  Projects root, and its implementation builds on a worktree of its own. git never has
  one branch out in two checkouts, so the branch is never out where the plan was rooted.
  No start about a plan Task's branch or merge request could find that Task. Only a Task
  whose first Run cut its own worktree could be found.
- **Chat could not take a Run's offer.** The card's Actions and `collie run action` start
  implement's `Release` offer as the implement Run's Follow-up Run: in its Task, and held
  to its Checks. Chat's `followup` only carries a Run on in its own Workflow, from words,
  and `collie_run` does not list a Run's offers. The chat parity table maps `run actions`
  to `collie_run` and `run action` to `collie_do`, and neither does either. So chat
  started `release` fresh.

## Decision

**D1. A Task's work is what its Runs worked on.** That is every branch one of its Runs
was placed on, other than the default branch, and every merge request one of them opened
or was given. It is read from the Runs' records when a start is placed. It is never read
from the checkout the Task was rooted at, and never from a label. Nothing new is recorded.
A merge request is compared as the forge names it, by project and number, not by how its
URL was written.

**D2. A fresh start about a Task's merge request is that Task's.** That is the merge
request its diff target names. It joins whatever state the Task is in, Finished included,
and whether or not herdr still has the Task's workspace. A merge request is one piece of
work for its whole life, and its number is never used again. A start that joins a Task
whose workspace is gone opens its agents in that workspace, reopened on the Run's
checkout, as a Follow-up Run does. A Finished Task it joins is Finished no longer, and its
cleanup hour starts again.

**D3. A fresh start about an open Task's branch is that Task's.** That is the branch it
is placed on, or the one its diff target names. An open Task is one whose workspace herdr
has, as before. A branch name can be used again for new work once the old work has landed
and been cleaned up. A merge request cannot be.

**D4. Where several Tasks have the work, the start joins the one that had it first.**
Tasks made before this decision may share a merge request. The first is the one that did
the work.

**D5. Joining is membership, not Lineage.** A Run that joins a Task has no parent. It is
not held to another Run's Checks or constraints. A stop of another Run does not reach it.
A Run is another Run's child only when it was started from it: as a chained child, as a
Follow-up Run, or by an offer taken from it.

**D6. Chat sees and takes a Run's offers.** `collie_run` lists the offers a Run makes now.
Each shows its id, title and Workflow, and why it cannot be made where it is listed
anyway. `collie_do` takes one offer of one Run by its id, with the offer's own arguments,
through the same invoke the card and `collie run action` use. The host decides the offer
again when it is taken, as it does for them. Chat is told to take a Run's offer when the
human asks for what that offer does, rather than start the offer's Workflow fresh.

**D7. The board draws what is recorded.** A Run that joins a Task is drawn on that Task's
card. It leads the card while it is the newest Run still going, so a running release puts
its Task in Working with the release's sentence. No card is merged when the board is read,
whether from a shared branch or a shared merge request: membership is recorded once, at
placement.

**D8. Nothing already recorded is moved.** A Run keeps the Task it was placed in. A Task
split off before this, such as task-a2e62d73, stays a card of its own until it is Finished
and cleaned up. A start admitted after the upgrade joins the Task that had the work first
(D4).

## Considered options

- **Merge cards when the board is read, by shared merge request.** The cards would join
  without any record changing, and old splits would join too. Rejected: membership would
  become a reading rather than a fact. The two Tasks would still have two workspaces, two
  cleanups and two sets of agents, and `collie run show` would contradict the board.
- **Make a fresh start about a Task's merge request the child of the Run that opened it.**
  It would inherit that Run's Checks, as a release taken from the offer does. Rejected: a
  start names its own Inputs and Checks (ADR-0033). Inheriting the constraints of a Run
  nobody named, and letting that Run's stop reach the start, is a silent guess. The offer
  is the explicit way, and chat now has it (D6).
- **Move existing Runs into the Task they belong to.** A running Run's agents are panes
  in the other Task's workspace. Moving them is a herdr operation with no way back, done
  for a Task that ends by itself.
- **Drop the open condition for branches too.** It would be one rule instead of two, but a
  branch name used again would pull new work into a Task that finished long ago.

## Consequences

The work that follows a merge request a Task made stays on that Task's card and in its
workspace. That covers its release, its stage, its deploy, its review and a fix of that
review. It holds however the work was started: from the end menu, from the card's offer,
from chat, from the CLI, from the board's start menu, by a Schedule or as an `ownTask`
child.

A start that joins a Task is still placed by its own Inputs: it gets its own checkout,
Checks and Intent.

The merge watch treats a joined Run as the Task's. One created before the merge request
merged is stopped by a merge somebody made by hand, as a Release Run started from the
offer is today. A Run that lands the merge request is spared as
ADR-draft-a-merge-request-is-released-on-a-humans-go D8 says.

Placing a fresh start reads the merge request and branch of every Run that has a Task.
Fresh starts are rare next to everything else the host reads, so this is not cached.

A Task is one host's. A start on another Machine about the same merge request is a Task
of that Machine's own. That is not decided here.
