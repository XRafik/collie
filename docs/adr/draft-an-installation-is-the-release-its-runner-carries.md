# An installation is the release its runner carries

**Status: accepted, to be built.** Amends [ADR-0001](0001-compiled-runner-fetched-from-release.md)
(teammates install with `git clone`, and the build hook fetches the runner) and
[ADR-0016](0016-a-workflow-module-is-found-where-it-was-saved.md) D6 (the author's directory is
beside the installation because the installation is a checkout an upgrade fast-forwards).

`~/.collie` stops being a clone of Collie. The runner carries everything an installation
needs and writes it into `~/.collie/release/`, which every upgrade replaces whole. The
human's own definitions and settings stay in `~/.collie/user/`, which no upgrade writes.

## What was true before

`~/.collie` was a git clone of cego/collie, and the clone was the installation:

- **Install.** `git clone … ~/.collie && ~/.collie/setup.sh`. `collie onboard` and Desktop's
  onboarding cloned at the release tag. herdr linked the plugin from the clone, and its build
  hook (`install.sh`) built the runner from source in any checkout with bun, or else
  downloaded the signed `collie-<os>-<arch>`.
- **Upgrade.** `collie upgrade` ran `git pull --ff-only`, then `prepare.sh`. `--to` fetched
  tags and reset the clone to one. A clone with uncommitted changes, on another branch, or
  ahead of its remote was a "development checkout": `--to` refused it, and Desktop and
  paired peers, which upgrade through `upgrade --to`, skipped it.
- **What was read from it at runtime.** The shipped workflow modules (imported from disk,
  with their Markdown and helpers), the personas, the prompts handed to harnesses as files,
  the operator skill (linked into the skill stores), the notification logo,
  `herdr-plugin.toml` (version and minimum herdr), and the P-256 key `install.sh` checks a
  download with. Nothing else: the source, tests and docs were along for the ride.
- **The user Layer.** `~/.collie/user/`, ignored by the clone, and derived from the
  installation's path.
- **Staleness.** The board and doctor counted commits behind the clone's upstream.
- **Development.** The maintainer developed Collie in `~/.collie` itself, and plan Runs
  wrote `CONTEXT.md` and ADRs there. So the installation was dirty most of the time, and an
  upgrade meant setting that work aside by hand, on each Machine.

## Decision

**D1. The runner carries the release.** The release build embeds the release tree in the
runner: the plugin manifest, `install.sh` and `prepare.sh`, the shipped workflows with
their Markdown and helpers, the personas, the prompts, the operator skill, the notification
logo and `release-p256.pub`. Nothing else from the repository. One signed artifact per
platform stays the whole release, so Desktop's onboarding and a peer's upgrade, which carry
only a runner, carry everything.

**D2. The Collie directory.** `~/.collie`, or `COLLIE_DIR`, holds three things:

- `release/` is the **Installation**. Only the runner writes it, and every upgrade replaces
  it whole.
- `user/` is the human's: the user Layer, `config.json`, settings, verify scripts. No
  upgrade writes it. It is the user Layer whichever installation is running, rather than
  being derived from the installation's path.
- `kept/` holds edits found in a release before it was replaced (D3).

The state directory is where it was.

**D3. Placing a release.** The runner writes its tree beside the current `release/`, copies
itself in as `bin/collie`, and swaps the two. It records what it wrote, file by file. A
file in `release/` that differs from that record is copied into `kept/` before the swap,
and the upgrade names each one, with how to fork it into `user/`. Customising is forking.
An edit in `release/` is never lost, and never kept in force either.

**D4. Upgrading a release.** `collie upgrade` aims at `--to`, or at the newest release.

- **Same version as the runner:** the runner places itself.
- **Another version:** it downloads that version's runner, verifies it against the release
  key as Desktop verifies one, and hands the upgrade to it.
- **Then:** `prepare.sh` and the `desktop` step, as before.

No git is involved, so nothing local can block it. Desktop and peers keep sending
`upgrade --to`.

**D5. A development checkout.** This is a clone of Collie that a developer linked as the
plugin by running its own `prepare.sh`. Its runner is built from source.

- **Upgrading it:** Desktop and peers never do. `collie upgrade` runs `git pull --ff-only
  --autostash`, so uncommitted work rides through a pull rather than blocking it. `--to` is
  refused.
- **Going back:** running `~/.collie/release/prepare.sh` links the release again.
- **A clone at the Collie directory itself** is not a development checkout. It is an install
  made before this decision, and D6 migrates it.

**D6. Migrating a clone install.** The next `collie upgrade` or `collie onboard` of a clone
at the Collie directory places the release inside it. It excludes `release/` and `kept/`
in the clone's own `.git/info/exclude`, so the clone's status does not change.

- **Which runner:** the release's own, downloaded and verified. A runner built from that
  clone's source never places a release.
- **What moves:** the plugin link, the `collie` shim and the operator skill move to
  `release/`. The host the clone served is replaced as the same installation, so nobody is
  told to stop a pid.
- **A clone with nothing of the human's in it is deleted.** Nothing of the human's means:
  no changed or untracked file, no ignored file beyond `bin/`, `node_modules/`, `user/`,
  `release/` and `kept/`, every local commit on a remote, no stash, no linked worktree, and
  no live Run working in it. `release/`, `user/` and `kept/` are left.
- **Any other clone is left exactly as it was**, as an ordinary checkout. The upgrade says
  what in it is the human's.
- **`user/` is never moved.**

**D7. Installing without a clone.** The install becomes `curl -fsSL
https://github.com/cego/collie/releases/latest/download/setup.sh | sh`.

- **The script:** `setup.sh` is published and signed as `install-desktop.sh` is, with the
  P-256 key inline. It downloads and verifies the runner and has it place the release.
  Then it adds the keybindings, sets the status line, reloads herdr and runs doctor, as
  before.
- **Onboarding:** `collie onboard` places the release from the runner it is, rather than
  cloning.
- `COLLIE_REPO` goes.

**D8. A newer release is what staleness means.** For a release, the board and doctor say
when a newer release is out, with `collie upgrade`. They read the newest release at most
every few minutes. A development checkout keeps the commit count.

**D9. Collie is developed in a checkout like any project's.** An installation is never a
checkout to plan or build in.

## Alternatives

- **`git pull --ff-only --autostash` alone.** It ends the stash dance. But Desktop and peers
  still skip a dirty install, `--to` still refuses one, and the installation is still the
  checkout plan Runs write into. D5 keeps it for development checkouts.
- **A release tarball beside the runner.** That adds a second artifact and signature per
  platform. Desktop's onboarding and a peer's upgrade carry only the runner, so both would
  need to carry two.
- **The release at the top of `~/.collie`.** A clone with work in it would have to move out
  from under its live Runs, worktrees and panes. A subdirectory lets it stay where it is.
- **Shipped definitions read straight out of the binary.** Modules are imported from disk,
  prompts are handed to harnesses as files, and herdr links a directory. They have to be
  files.

## Consequences

- An upgrade is never blocked by anything a human or an agent wrote, and Desktop and peers
  can upgrade every release install.
- A Machine on 0.49.0 or older upgrades through git once more. A clone whose pull conflicts
  takes the new `setup.sh` instead. From then on, no upgrade touches git.
- A clone with work in it stays a checkout at `~/.collie`, with `release/` and `user/`
  inside it and ignored by it. Its `workflows/` and `personas/` are no longer what runs.
- Running unreleased Collie means linking a development checkout. The maintainer's
  `~/.collie` runs the release after its migration.
- Releases build exactly what an installation runs. A source build is a development
  checkout's alone.
