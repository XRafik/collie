You are reading one day of this Machine's Collie Runs for what is wrong with Collie: its
host, its Workflows, its Personas and its docs. Nobody is watching this Run, and nobody is
asked anything. You edit nothing; what you find becomes issues and Improvements.

Collie's checkout: {{checkout}}
Collie's state directory on this Machine: {{state}}
The window: the Runs admitted since {{since}}.

## triage

Use the `retro` skill: read `{{checkout}}/.collie/skills/retro/SKILL.md` and follow it.
Where it calls for the `writing-for-agents` skill, read
`{{checkout}}/.collie/skills/writing-for-agents/SKILL.md`. Read those two files, and no
installed copy of either skill on this Machine.

Where `retro` and this page differ, this page wins:

- **The session is the window's Runs**, listed below. `retro`'s primary sources are only
  each Run's records:
  - `{{state}}/runs/<run id>/`: its audit trail, log, drift, check passes, deliveries
    and parks;
  - `{{state}}/agents/<run id>/`: its launches, prompts and Outputs, with their
    assumptions and disputed findings;
  - `{{state}}/host.log`, and the News under `{{state}}/herd/`, for the same day.

  Read a harness transcript only where one of those records points to it. Never read the
  Flock chat's transcripts, another Machine's Runs, or any other session log on this
  Machine.

- **`retro`'s categories are each finding's `category`:** `navigation`,
  `automated-checks`, `coding-standards`, `agents-md`, `tool-economy`, `no-ops`,
  `information-access`, and `defect` for Collie misbehaving: a Run that failed, parked,
  looped, stalled or needed rescue. A `coding-standards` finding says in `rule` whether
  the rule is `mechanical`, which wants a deterministic check, or a `judgement` call,
  which belongs to the reviewer's standards.
- **"Present to the user in order of severity" is your Output**, most severe first.
- **What `retro` would change is what you file**, as findings and Improvements. Change
  no file.

What counts as a finding:

- a defect or a friction in what Collie's repository builds, backed by at least one Run
  of the window and the record that shows it;
- recurring: shown by two of the window's Runs, or matching an issue already open. A
  `defect` needs one Run. Anything else seen once is left out.

What is left out, with why, under `left_out`:

- a project's own code or tests;
- an outage of a service Collie does not run;
- a person's deliberate choice, such as stopping a Run they no longer wanted.

What may reach Collie's public tracker, in a title, a body and an Improvement:

- what Collie did, citing Run ids and Collie's own files;
- never a Run's goal, a person's words, an agent's transcript, or another repository's
  name, paths or content. The host redacts credential-shaped values and refuses another
  checkout's paths; write so it has nothing to do.

Match each finding against every open issue below, whoever filed it, and set `issue` to
the one it is about. An issue whose body carries `<!-- collie-finding: <key> -->` is
that key's finding's issue. Give the
same problem the same kebab-case `key` it had before.

At most ten findings. Then group the findings that will be filed new, with no `issue`,
into `improvements`, each one merge request's worth, in the order they should be built.
At most {{bound}} of them are started.

The window's Runs:

{{runs}}

Collie's report of them:

{{report}}

The open issues:

{{issues}}
