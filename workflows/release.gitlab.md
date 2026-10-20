Merge request: {{inputs.mr}}
Repository: {{repository}}
This run's checkout: {{cwd}}
This run's directory: {{run.dir}}

A note you hand on — to a later step, another agent or a human — goes in
`{{run.dir}}/handoffs/`, never `/tmp`: the Run's record lists it, and it is kept as long
as the Run is.

This checkout is the merge request's source branch. Collie waits for the review, proves the
head with the Run's checks, asks the human for the go and merges: never merge, approve or
close the merge request yourself, and never switch this checkout's branch.

A **package** publishes from its tag pipeline and is deployed by nobody; an
**application** has deploy jobs or GitLab environments (stage, prod) of its own.

## assess

Nothing shared is touched yet: no Helle claim is held, so read only. The human's go comes
first, and the claim after it.

Decide first whether this repository is a package or an application: read its
`.gitlab-ci.yml` and `glab api projects/<id>/environments`. Deploy jobs or a `staging` or
`production` environment make it an application; a publish job on tags and no deploy makes
it a package. Say which in your Output, with the evidence.

For an application, also name from its CI configuration, in `stage_jobs`, the jobs that
deploy to stage: those a merge request's pipeline runs (`merge_request`), and those a tag's
pipeline runs (`tag`). Either list may be empty.

Then write your Output. `is_package` is the judgement everything after this branches on, so
say it plainly and say what the evidence was.

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
  `### Miscellaneous` — with one line per change, `- <what changed> [!<iid>]`, where the
  merge request reference is the only link. Write the notes to a file and tag from it with
  `--cleanup=verbatim`, or git strips the `#` headers as comments. Push the tag to origin.
- Create a GitLab release with the same notes, verbatim, where the package publishes from
  its tags.
- Watch the tag's pipeline until every job has finished. Production deploy jobs are
  mine: never play, retry or ask about them. A job waiting for somebody to start it by
  hand is a finding, not something to start.

Then write your Output, naming the tag, the version and the URL of the tag's pipeline.
Collie reads the tag back on origin and the pipeline from GitLab, not from your Output.
