# A Run's own plan bounds it

**Status: accepted.**

What a Run's planner writes it will not do, and what it says done means, become
constraints in the Run's Intent, and they follow the plan as it changes.

## What was true before

Drift is judged against the constraints in a Run's Intent, and on the live host 29 of 32
Runs had none. The three that did had constraints a human typed. None came from any SPEC,
for two reasons.

`extractRequirements` read only bullets under `Requirements`, `Success criteria`,
`Boundaries` or `Constraints`. Collie's own planners write `## Out of scope` (4 of the live
SPECs) and `## Done when` (3), and none of them uses the four names. A `plan` → `implement`
hand-off seeded zero constraints from a SPEC with an `## Out of Scope` section.

The Intent was seeded once, at admission. When the plan is typed text, which is every
recent implement Run, the SPEC is written later by the Run's own planner into
`<runDir>/plan/SPEC.md`, and nothing read it.

## Decision

**D1. Read the headings planners write.** `Out of scope` and `Done when` join the heading
list. An out-of-scope bullet names something not to do, so it is read as
`Out of scope: <bullet>`; read bare, a judge would take it as something to do. Other
headings keep their bullet text, so no existing constraint id changes.

**D2. Follow the Run's own plan at every drift check.** Before `checkDrift` reads the
Intent, it reads `<runDir>/plan/SPEC.md` and, under the Run directory's lock, amends the
Intent to match: constraints the plan now has are added, and constraints from
`plan/SPEC.md` it no longer has are removed. Each amendment is by `plan:plan/SPEC.md`.
Only a Run on a worktree of its own (a workflow declaring `checkout`) does this: it builds
from its SPEC. A plan or architecture Run works in the checkout it was started for, and
its SPEC is the product it writes for a later Run, not a bound on its own work.

**D3. Anyone else's removal stands.** A constraint whose removal the history records by anyone
other than the plan is never put back. Nothing with another source, or from a plan
directory's `SPEC.md`, is touched, and authority is never read from text.

## Consequences

- Runs have constraints without the human writing any, and no new heading or command
  exists for them to learn.
- More semantic judgements: each work boundary with a semantic constraint is one model
  call. That is usage and is recorded, never a quota.
- The Intent is no longer amended only by a human. A planner that keeps rewriting its SPEC
  bumps the version. An open drift report found again at the new version is moved to it,
  so its correction and escalation carry on.
- If planners start writing other headings, they are added only when a real SPEC uses them.

## Amended 2026-10-19: a plan's constraints narrow its goal, and the goal is not evidence

run-ed73efbf.implement filed three semantic warnings and then the same three again;
run-103d22dc.implement filed six (cego/collie#129). Every one cited the Run's own goal,
`kind: plan`, as breaching an `Out of scope` constraint that the Run's `plan/SPEC.md` had cut
from that very goal, and asked for something to be removed "from the plan", which no agent
can do. The cross-run judgement gave the judge each related Run's goal and constraints side
by side and none of its work, nothing said that the constraints narrow the goal, and what
it filed was stored as the model wrote it.

- **A constraint read from the plan narrows the goal it was cut from.** A goal is what was
  asked, not work done, and it is never evidence of drift. A Run's own judgement and the
  cross-run judgement are both told so.
- **A judgement reads the work.** A Run's own judgement keeps its diff. The cross-run
  judgement is given, for each related Run, the work at its newest card, beside its
  constraints: the diff from where that card's commit left the default branch, and the
  Run's Outputs, under the caps and redaction a Run's own diff has. A file name or a
  commit subject says where work happened, not what it did, so neither is enough to judge
  by. Where a Run's work cannot be read, because it has no card yet or its commit is not in
  the judging Run's repository, the judgement is told why and judges the work it can read.
- **What is filed is checked before it is.** A report is filed only when it cites work the
  judgement was shown: a file whose diff it was given, or one of the Run's Outputs. A
  report whose evidence is a goal, another Intent's text, or a commit alone is dropped. A
  cross-run report is filed only against a constraint of the Run it names, citing that
  Run's work, and is normalised the way a Run's own report is, its kind and id set by
  Collie rather than taken from the model.
