# Ad-hoc work is a `general` Run, in place, and chat chooses a workflow by what it says it is for

**Status: accepted, to be built.**

Collie shipped five workflows, and each of them is a process: `plan` interviews and writes
tickets, `implement` builds on a branch of its own through a review rally to a merge
request, `review` reviews, `renovate` lands a month's dependency updates and `architecture`
surveys a project. A lot of what a human asks for is none of those. "Upgrade the VM's
install to 0.45.1", "find out why the nightly job failed", "rotate this token", "bump
that one version and commit it". There was nowhere to put such a task, so chat put it
into `implement`, which takes "a plain description of the work" as a work source, or into
`plan`. Either way the task paid for a worktree, a branch, a spec, a review rally and a
merge request it did not need, or it stopped at an end menu nobody wanted.
`vm-mk:run-0b937065` is one of those tasks.

Chat could not have chosen better from what it was shown. `collie_workspaces` listed each
workflow as `id (inputs)` and nothing else, and neither chat's instructions said what any
workflow is for.

## Decision

**D1. `general` is a shipped workflow.** One agent does one task. Its one Input is `goal`,
hinted `goal`, so the human's words fill it. A start from the Home is rooted at the
Projects root like `plan` (ADR-0033) without any code knowing its id. It has no menu, no
review and no fan-out. The Run ends when the agent writes its Output: a `summary`, which
is the Run's result and the sentence on its card, and a `blocked` reason where something
stopped it, which fails the Run with that reason. The agent can still ask the human in its
pane, as `plan`'s planner does, and it takes steering after the Run ends (ADR-0041).

**D2. It works in place.** `general` declares no `checkout`. The Run works in the checkout it
was started for, or at the Projects root. Most ad-hoc tasks change no repository at all. A
worktree and a branch would cost every one of them a checkout cut at admission. The branch
would also make the card something somebody has to file (`standing.ts`) until a human
dispositions it. A Run that left nothing to file is Finished on its own, which is right for
a chore. Work that should land as a merge request is `implement`'s, because a branch, a
review and a merge request are exactly what `implement` is for.

**D3. Its evidence is what every Run's is.** `general` runs no gate and declares no
`verifies` and no outcome, so it is `unspecified`. The checks granted to the Run are run at
its finish and recorded against the tree, as for every Run. Where the agent changed code
in a repository and nothing names the checks, it names them with `collie run intent
verification` (ADR-0055). The `summary` is a claim and is shown as one.

**D4. Chat chooses a workflow by what it says it is for.** `collie_workspaces` lists each
workflow with its `description`, and every shipped workflow's description says what it is
for. Both chats' instructions say to choose by description. They also say that a request
which is not planning, building to a merge request, reviewing, renovating or surveying
architecture is `general`, and is never forced into `implement` or `plan`. A prompt that
names a shipped workflow is content, as `collie-chat.md` already names `implement`.
Nothing in `src/` decides by the id (ADR-0029).

## Considered options

- **A branch of its own, like `implement`.** This isolates the human's checkout. But it
  cuts a worktree for a task that touches no repository, and it leaves a branch card to
  disposition for every chore. It also makes `general` a smaller `implement`, and then the
  choice between the two is a coin toss.
- **Teach `implement` a "just do it" mode.** That is one workflow with two meanings, and
  its outcome, gate and merge request would each need an exception for the second one.
- **Have chat pick `general` in code when no other workflow fits.** That would be Collie
  dispatching on a workflow's id, which ADR-0029 forbids. The choice belongs to the model,
  given the descriptions.

## Consequences

Two `general` Runs started in one checkout work on one tree, as two `review` Runs already
can. A `general` Run that edits code edits the checkout it was started for. Collie does
not stash or branch for it. Each shipped workflow's `description` is now read by a model
choosing between them, so changing one changes what chat starts. Desktop's start dialog
already shows it. `test/support/baseline.ts` holds `general` to the same two passes as the
other shipped modules, as shipped and under an unrelated id.
