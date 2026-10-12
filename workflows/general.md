The task, in my words:

{{inputs.goal}}

Project root: {{cwd}}
This run's id: {{run.id}}

{{rooting}}

## task

Do the task above, here.

If you changed code in a repository and no checks are named for this run, name the ones
that prove the change: `collie run intent verification {{run.id}} --name <name> -- <command>`,
once per check. Collie runs them when the run ends and shows what they said.

Then write your Output: a `summary` of what you did or found, and `blocked` only where
something stopped you from finishing.

## projects-root

The project root above is the Projects root, and it is not a repository: find the
repository under it that the task is about, and work there. Where the task is about no
repository, do it from here.
A check you name for that repository takes
`--cwd <its directory, relative to the project root>`, so Collie runs it there.
