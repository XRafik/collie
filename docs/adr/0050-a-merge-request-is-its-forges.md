# A merge request is its forge's, and the checkout's remote names the forge

**Status: accepted, to be built.**

Collie works the same on a GitHub repository as on a GitLab one. One forge interface
stands between Collie and both, with a GitLab adapter and a GitHub adapter behind it. The
remote of the checkout a Run works in, or the address of the merge request it was given,
decides which adapter answers.

## What was true before

GitLab was built in throughout. `src/mr.ts` read, noted and assigned merge requests
through `glab`. The prompts of `implement`, `review` and `renovate` told agents to run
`glab`. Branch names were namespaced under whoever `glab api user` said, and the doctor
checked only `glab`. Only the merge watch knew a GitHub pull request: it asked `gh` for
its state and checks, and nothing else did. A checkout counted as "on GitLab" when any of
its remotes mentioned `gitlab`. So `cego/collie`, whose `origin` is GitHub and which
still has an old `gitlab` remote, was given a `glab`-only merge request step and opened
no pull request. On a Machine with only `gh`, a Run could not name its branch, because
`glab api user` asked gitlab.com.

## Decision

**D1. One forge interface, two adapters.** Everything Collie does with a merge request
goes through the forge interface: reading one, noting on it, approving it, finding a
branch's open one, reading its deployments, finding the repository's template, saying
who is logged in, cloning a repository, checking the CLI, and writing the commands an
agent is told to run. Every `glab` invocation in `src/` and `workflows/` is in the GitLab
adapter, and every `gh` invocation is in the GitHub adapter. No prompt names a forge's
CLI of its own; the adapter writes the CLI, the nouns and the commands into the prompt.
A test holds the boundary. The named exceptions are installation, not work:

- `collie onboard`'s GitLab login and SSH key;
- Desktop giving the Flock's GitLab token to each Machine;
- the installers fetching a release.

**D2. The remote decides the forge.** A checkout's forge is the forge of its `origin`
remote, or of `upstream` where `origin` names none. Any other remote is not consulted. A
merge request's forge is the forge of the host in its URL or target.

- `github.com` is GitHub.
- The Flock's `gitlab_host`, or any host whose name contains `gitlab`, is GitLab.
- Any other host has no forge. A step that needs one says so: "`<host>` is neither GitHub
  nor GitLab". GitHub Enterprise is not supported.

**D3. "Merge request" is the domain's word for both.** A GitHub pull request is a merge
request to Collie. Code, the glossary and the Run's records say merge request. Whatever a
human reads says the forge's own word and the forge's own name:

- GitLab: merge request `group/app!42`, its pipeline;
- GitHub: pull request `owner/repo#30`, its checks.

A target is `mr:<host>/<group>/<project>!<iid>` on GitLab, unchanged, or
`mr:github.com/<owner>/<repo>#<number>` on GitHub. An older bare `mr:<iid>` is GitLab's.
A number a human types (`42`, `!42` or `#42`) is a merge request of the checkout they are
in, written in that checkout's forge's shape.

**D4. What Collie decides on, it reads itself; what an agent runs, the adapter writes.**
Collie reads these through the adapter, never from an agent's Output:

- whether a merge request merged, closed or deployed;
- its checks;
- whether a branch already has one, and whether that one merges itself once green;
- who is logged in, and who is assigned.

`implement` does not hand an agent the decision not to push onto someone else's merge
request that has auto-merge on. Collie reads that and does not run the step. An agent is
still the one that opens a merge request and writes its description, with the command
the adapter wrote for it.

**D5. Who a branch and a merge request belong to is the checkout's forge's login.** A
generated branch is namespaced under the login the checkout's forge reports, and a merge
request is assigned to it, unless the human set someone:

| Forge  | Branch namespace, set by | Otherwise    | Assignee, set by  | Otherwise    |
| ------ | ------------------------ | ------------ | ----------------- | ------------ |
| GitLab | `GITLAB_USER_LOGIN`      | `glab`'s own | `gitlab.assignee` | `glab`'s own |
| GitHub | `GITHUB_ACTOR`           | `gh`'s own   | `github.assignee` | `gh`'s own   |

A login on one forge is never used on the other. `mk` on gitlab.cego.dk and `mk` on
github.com are two different people.

**D6. Posting a review that leaves nothing to fix also approves it.** "Post" puts the
review on the merge request as one note, on both forges. Where nothing in the review is
still live, it also approves the merge request. Where findings remain, it posts the note
alone. The refusal to post to a merge request assigned to whoever is running Collie
stands on both forges.

**D7. Deploy status is read the same way on both forges.** A merged merge request is "On
stage." or "In production." when the newest successful deployment to that environment
carries its merge commit.

- On GitLab, the environment's tier decides which is which, as before.
- On GitHub, production is a deployment marked as production, or an environment named
  `production` or `prod`. Staging is an environment named `staging` or `stage`.
- Either forge's own comparison of the two commits decides "carries".

**D8. The doctor checks each forge the checkouts use.** GitLab is checked as before,
against the Flock's `gitlab_host`, because onboarding sets it up on every Machine. GitHub's
`gh` and its login to github.com are checked when any checkout under the Projects root
has a GitHub remote. A failure there fails the doctor, as a missing `glab` does.

**D9. The repository strategy is `repository`.** The launch strategy a roaming Workflow
hints is `repository`: a GitLab or GitHub repository URL, or a local checkout. The old
`gitlab-repository` is still read, in a module's hints and in a Run's records, as
`repository`. This is how `plan-dir` is still read as `work-source`.

## Consequences

- Collie's own Runs on `cego/collie` open, watch and review pull requests.
- On GitHub, a branch is namespaced under the `gh` login (`madskronborg/…`), unless
  `GITHUB_ACTOR` says otherwise. Its pull request is assigned to that login, unless
  `github.assignee` says otherwise.
- A fake of each forge lives in `test/support`. The forge contract runs once against
  each fake.
- Not decided here: giving each Machine a GitHub login from Desktop or `collie onboard`,
  a push check for github.com, and any forge other than these two.
