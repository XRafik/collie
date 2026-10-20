Pull request: {{inputs.mr}}
Repository: {{repository}}
This run's checkout: {{cwd}}
This run's directory: {{run.dir}}

A note you hand on — to a later step, another agent or a human — goes in
`{{run.dir}}/handoffs/`, never `/tmp`: the Run's record lists it, and it is kept as long
as the Run is.

This checkout is the pull request's head branch. Collie waits for the review, proves the
head with the Run's checks, asks the human for the go and merges: never merge, approve or
close the pull request yourself, and never switch this checkout's branch.

A **package** publishes from a tag or release and is deployed by nobody; an
**application** has deploy workflows or GitHub environments (staging, production) of its
own.

## assess

Nothing shared is touched yet: no Helle claim is held, so read only. The human's go comes
first, and the claim after it.

Decide first whether this repository is a package or an application: read its
`.github/workflows/` and `gh api repos/{owner}/{repo}/environments`. A deploy workflow or a
`staging` or `production` environment make it an application; a workflow that publishes
on tags or releases and no deploy makes it a package. Say which in your Output, with the
evidence.

For an application, also name from its workflows, in `stage_jobs`, the jobs that deploy
to staging: those a pull request's workflow runs start (`merge_request`), and those a tag's
start (`tag`). Either list may be empty.

Then write your Output. `is_package` is the judgement everything after this branches on, so
say it plainly and say what the evidence was.

## answer

Comment round {{round}}. These review comments on {{inputs.mr}} are unanswered:

{{comments}}

Check each one against the code. Where it holds, fix it test first, with
{{skill:tdd}}: the failing test, then the fix. Commit each fix to this checkout's
branch, the pull request's head branch, and push with a plain `git push origin HEAD` — never a force push.
Where you judge a comment wrong, change nothing for it and dispute it with your reason.

Collie replies to each comment on the forge for you, and never resolves a thread: never
post on the pull request, reply to a comment or resolve a thread yourself.

This Run's checks, which Collie runs on the head you push:

{{verify}}

Run the typecheck and the test files you touched, each through `collie verify`, and never
the whole suite.

Then write your Output: one entry in `answers` per comment, by its id. `fixed` names in
`commit` the pushed commit that fixes it, and `note` says what changed; `disputed` says in
`note` why nothing changed. Collie counts a fix only once the pull request's head carries its
commit, and a comment you leave out goes to the next round.

## fix

Fix round {{iteration}} of at most {{max_iterations}}. Collie ran this Run's checks on
the pull request's head, and this failed:

{{findings}}

Fix the cause test first, with {{skill:tdd}}, commit it to this checkout's branch and push
with a plain `git push origin HEAD` — never a force push. Where you are sure a failure is not this
branch's, change nothing and record it under `disputed` with your reason. The checks:

{{verify}}

Run the typecheck and the test files you touched, each through `collie verify`, and never
the whole suite. Collie runs the checks again on the head you push.

Then write your Output. `file` and `title` in `fixed` and `disputed` are exactly as the
finding above gives them; `checks` names every test and lint command you ran.

## tag

{{recovery}}

Collie merged {{inputs.mr}}, and the merged commit is `{{merged}}`. Release it:

- Work in a worktree of your own at the merged commit — `git fetch origin`, then
  `git worktree add {{run.dir}}/release {{merged}}` — and leave this checkout as it is.
- Diff the merged commit against the previous version tag and choose the next version
  from that and from the repository's own versioning conventions.
- Where the repository makes a release commit — a version file or a changelog bumped on
  release — commit it on the default branch on top of the merged commit, and push it.
- Tag annotated, following the repository's own tag and notes conventions. Where it has
  none, the tag notes are a changelog entry in the shape of changelog-gen: a heading
  `## <version> - <YYYY-MM-DD>`, then only the sections that have entries, in this order
  and under these names — `### Features and Improvements`, `### Bug fixes`,
  `### Miscellaneous` — with one line per change, `- <what changed> [#<n>]`, where the
  pull request reference is the only link. Write the notes to a file and tag from it with
  `--cleanup=verbatim`, or git strips the `#` headers as comments. Push the tag to origin.
- Create a GitHub release with the same notes, verbatim — `gh release create <tag>
  --notes-file <file> --verify-tag` — where the package publishes from a tag or release.
- Watch the workflow runs the tag started — `gh run list --commit <sha>`, then `gh run
  watch` — until every job has finished. Production deploy jobs are mine: never approve,
  rerun or ask about them. A job waiting for somebody to approve or start it by hand is a
  finding, not something to start.

Then write your Output, naming the tag, the version and the URL of the tag's workflow run.
Collie reads the tag back on origin and the run from GitHub, not from your Output.
