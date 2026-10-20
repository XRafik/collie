// One merge request taken the rest of the way, on a human's go.
//
// The host does everything that decides: it waits for the review at no model cost, proves
// the head with the Run's checks, asks the go, merges at that head and reads the tag back.
// The one agent assesses what kind of repository it is and tags; its Output is a claim,
// and nothing here takes it for proof.
//
// The Markdown beside this file is the content: what each step judges, and how.

import {
  AnswerSchema,
  FindingSchema,
  FixOutputSchema,
  Host,
  MergeOutcomeSchema,
  ReviewStandingSchema,
  Run,
  SettledAnswersSchema,
  TagReadSchema,
  TakeoverSchema,
  WorkflowError,
  agentWork,
  ask,
  contentOf,
  defineWorkflow,
  forgeOfRef,
  formatFindings,
  mrUrlOf,
  readMrRef,
  renderApproved,
  settleAnswers,
  type OpenComment,
  type ReviewStanding,
} from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";
import * as Workflow from "effect/workflow/Workflow";
import { WorkflowInstance } from "effect/workflow/WorkflowEngine";
import { IMPLEMENTER } from "./reviewing.ts";
import onGitlab from "./release.gitlab.md" with { type: "text" };
import onGithub from "./release.github.md" with { type: "text" };

const text = Schema.String;

/** What every step of a release is told, under the names its content asks for them by. */
export const ReleaseInput = Schema.Struct({
  inputs: Schema.Struct({ mr: text }),
  run: Schema.Struct({ dir: text, id: text }),
  repository: text,
  /** The merged commit, once there is one. */
  merged: text,
  /** What a Run recovering a release that merged is told of the Run it recovers. */
  recovery: text,
  /** A comment round's comments, and its number. */
  comments: text,
  round: text,
  /** This Run's checks, as a step that commits is held to them. */
  verify: text,
  /** A fix round's number, its bound, and what failed. */
  iteration: text,
  max_iterations: text,
  findings: text,
});

const stepsOf = (markdown: string) => {
  const content = contentOf(markdown);
  return {
    assess: content.template("assess", ReleaseInput.fields),
    answer: content.template("answer", ReleaseInput.fields),
    fix: content.template("fix", ReleaseInput.fields),
    tag: content.template("tag", ReleaseInput.fields),
  };
};

/** The shipped content per forge: the procedure differs, not only the commands (ADR-0050 D1). */
export const RELEASE_ON = { gitlab: stepsOf(onGitlab), github: stepsOf(onGithub) };

/** What each step that touches anything shared is cleared for, on the repository at `url`. */
const pushing = (url: string) =>
  `committing to the merge request's source branch on ${url} and pushing it with a plain push, never a force push`;

export const RELEASE_CLEARS = {
  answer: (url: string) => [
    pushing(url),
    `never posting on ${url} or resolving a thread there: Collie replies`,
  ],
  fix: (url: string) => [pushing(url)],
  tag: (url: string) => [
    `a release commit to ${url}'s default branch, where the repository makes one`,
    `pushing an annotated version tag of ${url} to origin`,
    `creating its release on ${url}, where the package publishes from its tags`,
    `watching the tag's pipeline on ${url}, never playing a production job`,
  ],
};

const verdict = {
  verdict: Schema.Literals(["clean", "findings"]),
  findings: Schema.optionalKey(Schema.Array(FindingSchema)),
};

export const Assessed = Schema.Struct({
  ...verdict,
  is_package: Schema.Boolean.annotate({
    description: "true where this repository publishes from its tag pipeline and deploys nowhere",
  }),
  kind_evidence: Schema.optionalKey(Schema.String).annotate({
    description: "what said it is a package or an application",
  }),
  stage_jobs: Schema.optionalKey(
    Schema.Struct({
      merge_request: Schema.Array(Schema.String),
      tag: Schema.Array(Schema.String),
    }),
  ).annotate({
    description: "an application's stage deploy jobs, of a merge request's pipeline and a tag's",
  }),
});

export const Answered = Schema.Struct({
  ...verdict,
  answers: Schema.Array(AnswerSchema).annotate({
    description: "one entry per comment you answered, by its id",
  }),
});

export const Tagged = Schema.Struct({
  ...verdict,
  tag: Schema.String.annotate({ description: "the tag pushed to origin" }),
  version: Schema.optionalKey(Schema.String),
  pipeline_url: Schema.optionalKey(Schema.String).annotate({
    description: "the URL of the tag's pipeline or workflow run",
  }),
});

/** One agent for the whole Run, which each step continues. */
export const RELEASER = "release";

const GO = { release: "Release", finish: "Finish" } as const;

/** Fix rounds in a row before a failing head parks the Run, as implement's gate fixes. */
const ROUNDS = 4;

const commentLines = (comments: ReadonlyArray<OpenComment>) =>
  comments
    .map((one) => {
      const where =
        one.file === null ? "" : ` on ${one.file}${one.line === null ? "" : `:${one.line}`}`;
      const quoted = one.body
        .split("\n")
        .map((line) => `  > ${line}`)
        .join("\n");
      return `- \`${one.id}\` by ${one.author}, ${one.url}${where}:\n${quoted}`;
    })
    .join("\n");

const short = (sha: string) => sha.slice(0, 8);

/** The merged commit a Run tags, whether it holds the claim, and what a recovery is told. */
interface Landed {
  readonly sha: string;
  readonly claim: boolean;
  readonly recovery: string;
}

/** Why a standing is not the ready one a go was given for. */
const notReady = (standing: ReviewStanding) => {
  switch (standing._tag) {
    case "Waiting":
      return standing.why.join("; ");
    case "Moved":
      return `its head moved to ${short(standing.head)}`;
    case "Unanswered":
      return `${standing.comments.length} unanswered comment(s)`;
    case "Unreadable":
      return `the forge could not be read: ${standing.reason}`;
    default:
      return standing._tag.toLowerCase();
  }
};

export default defineWorkflow({
  id: "release",
  title: "release — merge and tag a merge request on a human's go",
  description:
    "Takes one merge request the rest of the way: it waits, at no model cost, until the merge request is approved, answered, green and mergeable at a head the Run's checks proved, asks the human for the go, then claims the repository, merges at that head, tags the release and reads the tag back on origin.",
  input: Schema.Struct({
    mr: Schema.String.annotate({ description: "The merge request or pull request to release" }),
  }),
  output: Schema.String,
  agents: { roles: { implementer: IMPLEMENTER } },
  hints: { mr: "diff-target" },
  // A failed release is released again: before its merge as any Run, after it by taking
  // the landing over, and through the adopt question where it kept the claim.
  followUps: [
    {
      id: "release-again",
      title: "Release again",
      workflow: "self",
      when: "failed",
      inputs: { mr: "started-with" },
    },
  ],
  run: ({ input: asked }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const runId = (yield* Run).id;
      const fail = (reason: string) => new WorkflowError({ reason });
      const park = (reason: string) =>
        Effect.gen(function* () {
          const why = `${reason}. Repair it, then resume ${runId}.`;
          yield* host.record(runId, why);
          yield* host.parked(runId, why);
          return yield* Workflow.suspend(yield* WorkflowInstance);
        });

      const ref = readMrRef(asked.mr);
      const mr = ref === null ? null : mrUrlOf(ref);
      if (ref === null || mr === null)
        return yield* fail(`${asked.mr || "an empty mr"} is not a merge request this Run can find`);
      yield* host.mergeRequest(runId, mr);
      const checkout = yield* Activity.make({
        name: "checkout",
        success: Schema.Union([
          Schema.Struct({ cwd: Schema.String, branch: Schema.String }),
          Schema.Struct({ refused: Schema.String }),
        ]),
        execute: host.checkoutReviewed(runId),
      });
      if ("refused" in checkout)
        return yield* fail(`${mr} has no checkout to release from: ${checkout.refused}`);
      const cwd = checkout.cwd;
      const place = yield* host.place(runId);
      const forge = forgeOfRef(ref);
      const steps = RELEASE_ON[forge];
      const url = `https://${ref.project ?? ""}`;
      const input = {
        inputs: { mr },
        run: { dir: place.dir, id: runId },
        repository: url,
        merged: "",
        recovery: "",
        comments: "",
        round: "",
        verify: "",
        iteration: "",
        max_iterations: "",
        findings: "",
      };
      const as = (operation: string) => ({
        operation,
        agent: RELEASER,
        role: "implementer",
        input,
      });

      const start = yield* Activity.make({
        name: "start",
        success: ReviewStandingSchema,
        error: WorkflowError,
        execute: host.review({ runId, cwd, proved: "", seen: [] }),
      });
      if (start._tag === "Unreadable")
        return yield* fail(`${mr} could not be read: ${start.reason}`);
      if (start._tag === "Closed") return yield* fail(`${mr} is closed, so nothing was released`);
      const recovering =
        start._tag !== "Merged"
          ? null
          : yield* Activity.make({
              name: "take-over",
              success: TakeoverSchema,
              error: WorkflowError,
              execute: host.takeOverLanding({ runId, cwd }),
            });
      if (recovering?._tag === "Refused") return yield* fail(recovering.why);
      if (recovering === null) {
        const merging = yield* Activity.make({
          name: "auto-merging",
          success: Schema.NullOr(Schema.String),
          error: WorkflowError,
          execute: host.autoMerging(cwd),
        });
        if (merging !== null)
          return yield* fail(
            `${mr} is set to merge itself once green, so this Run leaves it to do that`,
          );
      }

      // The go's options depend on this, so it comes before the checks and the wait. It
      // reads only: no claim is held yet.
      const assessed = yield* agentWork({
        ...as("assess"),
        instructions: steps.assess,
        output: Assessed,
      });
      if (!assessed.is_package)
        return yield* fail(
          `releasing an application is not supported yet${assessed.kind_evidence ? `: ${assessed.kind_evidence}` : ""}`,
        );

      const claimed = () =>
        host.claim({
          runId,
          cwd,
          adopting: ask({
            name: "adopt-claim",
            prompt: "You already hold or are queued for this project's claim. Take it over?",
            options: ["yes", "no"],
          }).pipe(Effect.map((answer) => answer === "yes")),
          say: (line) => host.record(runId, line),
        });

      let landed: Landed;
      if (recovering !== null) {
        // That go was given and spent: no wait, no go and no merge, only what is left.
        const claim = yield* claimed();
        landed = {
          sha: recovering.sha,
          claim: claim !== null,
          recovery: `This Run recovers the release of ${mr} that ${recovering.from} merged at \`${recovering.sha}\` and then failed: ${recovering.failure} Where a tag on origin already carries \`${recovering.sha}\`, finish that tag's release and pipeline instead of making another.`,
        };
      } else {
        const moveTo = (at: number, head: string) =>
          Activity.make({
            name: `fast-forward.${at}`,
            success: Schema.String,
            execute: Effect.gen(function* () {
              const moved = yield* host.fastForward({ runId, cwd, head });
              if (moved._tag === "Refused") return yield* park(moved.why);
              return moved.head;
            }),
          });
        const checksNow = Effect.map(host.approved(runId), renderApproved);
        // `parkWith` says why another fix round would not help, so a failure parks the Run
        // here, where a resume runs the checks again.
        const checksAt = (
          name: string,
          pass: { readonly pass: "fix"; readonly round: number } | null,
          parkWith: string | null,
        ) =>
          Activity.make({
            name,
            success: Schema.Struct({ head: Schema.String, failed: Schema.Array(Schema.String) }),
            execute: Effect.gen(function* () {
              const checks = yield* host.approved(runId);
              const failed: string[] = [];
              for (const spec of checks.filter((one) => one.ci === undefined)) {
                const ran = yield* host
                  .verify({ runId, name: spec.name, cwd, ...pass })
                  .pipe(Effect.result);
                if (ran._tag === "Failure") failed.push(`${spec.name}: ${ran.failure.reason}`);
                else if (ran.success.result !== "pass") failed.push(`${spec.name} failed`);
              }
              for (const spec of checks.filter((one) => one.ci !== undefined)) {
                const read = yield* host.ciJob({
                  runId,
                  cwd,
                  name: spec.name,
                  wait: true,
                  settle: true,
                });
                if (!("proved" in read) && read.before === undefined) failed.push(read.unproved);
              }
              const head = (yield* host.evidence(runId, cwd)).final.head_sha;
              if (failed.length > 0 && parkWith !== null)
                return yield* park(
                  `The checks failed at ${short(head)} ${parkWith}: ${failed.join("; ")}`,
                );
              return { head, failed };
            }),
          });
        const treeNow = Effect.map(host.evidence(runId, cwd), ({ final }) => ({
          head: final.head_sha,
          fingerprint: final.fingerprint,
        }));
        const Tree = Schema.Struct({ head: Schema.String, fingerprint: Schema.String });
        let fixes = 0;
        /** The head proved by the checks, after as many fix rounds as it takes, up to ROUNDS. */
        const prove = (
          name: string,
          pass: { readonly pass: "fix"; readonly round: number } | null,
        ) =>
          Effect.gen(function* () {
            let at = yield* checksAt(name, pass, null);
            for (let rounds = 1; at.failed.length > 0; rounds++) {
              fixes += 1;
              const n = fixes;
              const before = yield* Activity.make({
                name: `fix-${n}.before`,
                success: Tree,
                execute: treeNow,
              });
              const findings = at.failed.map((title) => ({
                severity: "blocker",
                title,
                detail: `Collie ran this Run's checks on ${short(at.head)}, the merge request's head, and this is what failed.`,
              }));
              const fixed = yield* agentWork({
                ...as(`fix-${n}`),
                pushes: true,
                clears: RELEASE_CLEARS.fix(url),
                instructions: steps.fix,
                input: {
                  ...input,
                  verify: yield* checksNow,
                  iteration: String(rounds),
                  max_iterations: String(ROUNDS),
                  findings: formatFindings(findings),
                },
                output: FixOutputSchema,
              });
              const after = yield* Activity.make({
                name: `fix-${n}.after`,
                success: Tree,
                execute: treeNow,
              });
              const disputed = fixed.disputed ?? [];
              const stalled =
                after.head === before.head &&
                after.fingerprint === before.fingerprint &&
                (fixed.fixed ?? []).length === 0;
              at = yield* checksAt(
                `fix-${n}.checks`,
                { pass: "fix", round: n },
                stalled
                  ? `after fix-${n} changed nothing${disputed.length === 0 ? "" : `, disputing ${disputed.map((one) => `${one.title}: ${one.reason ?? "no reason given"}`).join("; ")}`}`
                  : rounds >= ROUNDS
                    ? `after ${ROUNDS} fix rounds`
                    : null,
              );
            }
            return at.head;
          });
        const awaited = (at: number, proved: string) =>
          Activity.make({
            name: `review.${at}`,
            success: ReviewStandingSchema,
            error: WorkflowError,
            execute: Effect.gen(function* () {
              const standing = yield* host.awaitReview({ runId, cwd, proved, seen: [] });
              if (standing._tag === "Held") return yield* Workflow.suspend(yield* WorkflowInstance);
              return standing;
            }),
          });

        yield* moveTo(0, start._tag === "Moved" ? start.head : "");
        let proved = yield* prove("checks.0", null);
        let waits = 0;
        let rounds = 0;
        let gos = 0;
        let merged: { readonly sha: string; readonly claim: boolean } | null = null;
        while (merged === null) {
          waits += 1;
          const standing = yield* awaited(waits, proved);
          if (standing._tag === "Merged")
            return yield* fail(
              `${mr} was merged outside this Run by ${standing.by || "someone"}, so nothing was tagged`,
            );
          if (standing._tag === "Closed")
            return yield* fail(`${mr} was closed, so nothing was released`);
          if (standing._tag === "Moved") {
            yield* moveTo(waits, standing.head);
            proved = yield* prove(`checks.${waits}`, null);
            continue;
          }
          if (standing._tag === "Unanswered") {
            rounds += 1;
            const n = rounds;
            const given = standing.comments;
            const answered = yield* agentWork({
              ...as(`answer-${n}`),
              pushes: true,
              clears: RELEASE_CLEARS.answer(url),
              instructions: steps.answer,
              input: {
                ...input,
                comments: commentLines(given),
                round: String(n),
                verify: yield* checksNow,
              },
              output: Answered,
            });
            const settled = yield* Activity.make({
              name: `answer-${n}.settle`,
              success: Schema.Struct({ head: Schema.String, answers: SettledAnswersSchema }),
              error: WorkflowError,
              execute: Effect.gen(function* () {
                const read = yield* host.reviewHead({
                  runId,
                  cwd,
                  commits: answered.answers.flatMap((one) =>
                    one.commit === undefined ? [] : [one.commit],
                  ),
                });
                const answers = settleAnswers({
                  given,
                  answers: answered.answers,
                  onHead: read.carries,
                  open: read.open,
                });
                if (answers.replies.length === 0 && answers.carried.length > 0)
                  return yield* park(
                    `answer-${n} answered none of the comments it was given: ${answers.carried.map((one) => one.url).join(", ")}`,
                  );
                return { head: read.head, answers };
              }),
            });
            for (const reply of settled.answers.replies)
              yield* Activity.make({
                name: `answer-${n}.reply.${reply.id}`,
                success: Schema.Literals(["posted", "already"]),
                error: WorkflowError,
                execute: host.reply({ runId, cwd, comment: reply.id, body: reply.body }),
              });
            if (settled.head !== proved)
              proved = yield* prove(`answer-${n}.checks`, { pass: "fix", round: n });
            continue;
          }
          if (standing._tag !== "Ready") continue;

          gos += 1;
          const head = standing.head;
          const approvers = standing.approvers.join(", ") || "nobody the forge names";
          const answer = yield* ask({
            name: `go-${gos}`,
            prompt: `Release ${mr} at ${short(head)}, approved by ${approvers}? Release merges it at that head and tags it; Finish leaves it open.`,
            options: [GO.release, GO.finish],
          });
          if (answer !== GO.release) {
            yield* host.record(runId, `go ${gos}: finished with ${mr} left open`);
            return `${mr} was left open`;
          }
          const still = yield* Activity.make({
            name: `go-${gos}.check`,
            success: ReviewStandingSchema,
            error: WorkflowError,
            execute: host.review({ runId, cwd, proved: head, seen: [] }),
          });
          if (still._tag !== "Ready") {
            yield* host.record(
              runId,
              `go ${gos} no longer holds for ${short(head)}: ${notReady(still)}`,
            );
            continue;
          }
          const claim = yield* claimed();
          const giveBack = claim === null ? Effect.void : host.release(runId);
          const outcome = yield* Activity.make({
            name: `merge.${gos}`,
            success: MergeOutcomeSchema,
            error: WorkflowError,
            execute: host.merge({ runId, cwd, head }),
          });
          if (outcome._tag === "Merged") {
            merged = { sha: outcome.sha, claim: claim !== null };
            continue;
          }
          yield* giveBack;
          if (outcome._tag === "HeadMoved") {
            yield* host.record(
              runId,
              `go ${gos} no longer holds: the head moved to ${short(outcome.head)} before the merge`,
            );
            continue;
          }
          if (outcome._tag === "MergedOutside")
            return yield* fail(
              `${mr} was merged outside this Run by ${outcome.by}, so nothing was tagged`,
            );
          return yield* fail(`the forge refused to merge ${mr}: ${outcome.reason}`);
        }
        landed = { ...merged, recovery: "" };
      }

      const tagged = yield* agentWork({
        ...as("tag"),
        input: { ...input, merged: landed.sha, recovery: landed.recovery },
        clears: RELEASE_CLEARS.tag(url),
        instructions: steps.tag,
        output: Tagged,
      });
      // A tag that is not proved leaves shared work half-done, so the claim stays with this
      // Run for `Release again` to take over.
      const read = yield* Activity.make({
        name: "read-tag",
        success: TagReadSchema,
        execute: host.readTag({
          runId,
          cwd,
          tag: tagged.tag,
          merged: landed.sha,
          pipeline: tagged.pipeline_url || null,
          proves: "finished",
        }),
      });
      if (read._tag === "Unproved")
        return yield* fail(
          `${mr} merged at ${landed.sha}, but ${tagged.tag} is not released: ${read.why}`,
        );
      if (landed.claim) yield* host.release(runId);
      return `${mr} merged at ${landed.sha}, released as ${tagged.tag}`;
    }),
});
