// One open merge request's head put on stage for testing, unmerged, until the human is done
// with it. Nothing here waits on its review: staging ships nothing, and its rollback takes it
// back (ADR-draft-an-open-merge-request-is-staged-by-a-run-of-its-own).

import {
  Host,
  ReviewHeadSchema,
  ReviewStandingSchema,
  Run,
  WorkflowError,
  agentWork,
  ask,
  contentOf,
  defineWorkflow,
  forgeOfRef,
  mrUrlOf,
  readMrRef,
} from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";
import * as Workflow from "effect/workflow/Workflow";
import { WorkflowInstance } from "effect/workflow/WorkflowEngine";
import { IMPLEMENTER } from "./reviewing.ts";
import {
  Assessed,
  RolledBack,
  StagedMergeRequest,
  claiming,
  nth,
  plays,
  quoted,
  short,
  staging,
} from "./staging.ts";
import onGitlab from "./stage.gitlab.md" with { type: "text" };
import onGithub from "./stage.github.md" with { type: "text" };

const text = Schema.String;

/** What every step of a Stage Run is told, under the names its content asks for them by. */
export const StageInput = Schema.Struct({
  inputs: Schema.Struct({ mr: text }),
  run: Schema.Struct({ dir: text, id: text }),
  repository: text,
  /** The merge request's head a step puts on stage or takes off it. */
  head: text,
  /** The stage deploy jobs of the merge request's pipeline, as the assessment named them. */
  stage_jobs: text,
  /** Why stage comes off. */
  failure: text,
});

const stepsOf = (markdown: string) => {
  const content = contentOf(markdown);
  return {
    assess: content.template("assess", StageInput.fields),
    stage: content.template("stage", StageInput.fields),
    unstage: content.template("unstage", StageInput.fields),
  };
};

/** The shipped content per forge: the procedure differs, not only the commands (ADR-0050 D1). */
export const STAGE_ON = { gitlab: stepsOf(onGitlab), github: stepsOf(onGithub) };

export const STAGE_CLEARS = {
  stage: (url: string, jobs: ReadonlyArray<string>) => [
    `playing, retrying and watching ${quoted(jobs)} of ${url}'s merge request pipeline, and the stage check jobs (e2e-stage, smoke or the like) that follow them`,
    `rolling back only the stage environments those jobs deploy to on ${url}, to the newest release production carries`,
    "never a production job",
  ],
  unstage: (url: string, jobs: ReadonlyArray<string>) => [
    `rolling back only the stage environments ${quoted(jobs)} deployed to on ${url}, to the newest release production carries, never a production job`,
  ],
};

/** One agent for the whole Run, which each step continues. */
export const STAGER = "stage";

const STAGED = { done: "Done", again: "Stage again", leave: "Leave it on stage" } as const;
const UNCLAIMED = {
  again: "Try again",
  without: "Stage without a Helle claim",
  finish: "Finish",
} as const;

export default defineWorkflow({
  id: "stage",
  title: "stage — put an open merge request on stage for testing, unmerged",
  description:
    "Puts one open merge request's head on stage for testing, unmerged, and does nothing more: it asks for no approval, answered comments, passed pipeline or Go, and never merges, tags, posts or deploys to production. It claims the Helle projects stage deploys under, plays the merge request pipeline's stage jobs, proves every stage environment carries the head, and holds stage until the human says Done, which rolls it back, Stage again, or Leave it on stage.",
  input: Schema.Struct({
    mr: Schema.String.annotate({ description: "The merge request or pull request to stage" }),
  }),
  output: Schema.String,
  agents: { roles: { implementer: IMPLEMENTER } },
  hints: { mr: "diff-target" },
  followUps: [
    {
      id: "stage-again",
      title: "Stage again",
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
        return yield* fail(`${mr} has no checkout to stage from: ${checkout.refused}`);
      const cwd = checkout.cwd;
      const place = yield* host.place(runId);
      const steps = STAGE_ON[forgeOfRef(ref)];
      const url = `https://${ref.project ?? ""}`;
      const input = {
        inputs: { mr },
        run: { dir: place.dir, id: runId },
        repository: url,
        head: "",
        stage_jobs: "",
        failure: "",
      };
      const as = (operation: string) => ({
        operation,
        agent: STAGER,
        role: "implementer",
        input,
      });

      // Judged against no proved head, so an open merge request answers with its head.
      const start = yield* Activity.make({
        name: "start",
        success: ReviewStandingSchema,
        error: WorkflowError,
        execute: host.review({ runId, cwd, proved: "", seen: [] }),
      });
      if (start._tag === "Unreadable")
        return yield* fail(`${mr} could not be read: ${start.reason}`);
      if (start._tag === "Merged")
        return yield* fail(`${mr} is merged, so its stage is its release's: nothing was staged`);
      if (start._tag === "Closed") return yield* fail(`${mr} is closed, so nothing was staged`);

      const assessed = yield* agentWork({
        ...as("assess"),
        instructions: steps.assess,
        output: Assessed,
      });
      const evidence = assessed.kind_evidence ? `: ${assessed.kind_evidence}` : "";
      if (assessed.is_package)
        return yield* fail(`${mr} is a package, so there is nothing to stage${evidence}`);
      const jobs = assessed.stage_jobs?.merge_request ?? [];
      if (jobs.length === 0)
        return yield* fail(
          `${mr} is an application with no stage deploy job on its merge request's pipeline, so nothing was staged${evidence}`,
        );

      const moveTo = (name: string, head: string) =>
        Activity.make({
          name,
          success: Schema.String,
          execute: Effect.gen(function* () {
            const moved = yield* host.fastForward({ runId, cwd, head });
            if (moved._tag === "Refused") return yield* park(moved.why);
            return moved.head;
          }),
        });
      yield* moveTo("fast-forward", "head" in start ? start.head : "");

      const claimed = claiming({
        runId,
        cwd,
        deploys: { applications: assessed.applications ?? [], jobs },
        park,
        words: {
          adopt: "You already hold or are queued for a claim this stage needs. Take it over?",
          unclaimed: (why) =>
            `${mr} cannot hold the Helle claims its stage needs: ${why}. Nothing goes on stage without them. ${UNCLAIMED.again} claims them again; ${UNCLAIMED.without} goes on holding none; ${UNCLAIMED.finish} stops here.`,
          ...UNCLAIMED,
          went: (why) => `staged without a Helle claim on the human's say: ${why}`,
        },
      });
      const slugs = yield* claimed("claim");
      if (slugs === null) return `${mr} was not staged`;
      const holding =
        slugs.length === 0
          ? "This Run holds no Helle claim."
          : `This Run holds the Helle claims of ${slugs.join(", ")}.`;
      const giveBack =
        slugs.length === 0
          ? Effect.void
          : Activity.make({ name: "give-back", execute: Effect.asVoid(host.release(runId)) });

      const stage = staging({
        runId,
        cwd,
        jobs,
        stage: (name, head) =>
          agentWork({
            ...as(name),
            input: { ...input, head, stage_jobs: quoted(jobs) },
            clears: STAGE_CLEARS.stage(url, jobs),
            instructions: steps.stage,
            output: StagedMergeRequest,
          }),
        unstage: (name, head, failure) =>
          agentWork({
            ...as(name),
            input: { ...input, head, failure, stage_jobs: quoted(jobs) },
            clears: STAGE_CLEARS.unstage(url, jobs),
            instructions: steps.unstage,
            output: RolledBack,
          }),
      });
      let asks = 0;
      for (let n = 1; ; n++) {
        // Hours may have passed since the head was read, waiting on the claims or the human.
        const now = yield* Activity.make({
          name: `head.${n}`,
          success: ReviewHeadSchema,
          execute: host
            .reviewHead({ runId, cwd, commits: [] })
            .pipe(Effect.catch((failed) => park(failed.reason))),
        });
        const head = yield* moveTo(`fast-forward.${n}`, now.head);
        const { read } = yield* stage.put(nth("stage", n), head);
        if (read._tag === "Moved") {
          yield* host.record(
            runId,
            `the head moved from ${short(head)} to ${short(read.head)} before stage was proved, so that head is staged instead`,
          );
          continue;
        }
        if (read._tag === "Failed") {
          const failed = `stage of ${mr} at ${short(head)} failed: ${read.why}`;
          yield* stage.off(nth("unstage", n), read.why, failed);
          yield* giveBack;
          return yield* fail(`${failed}; stage is back on what production carries`);
        }
        asks += 1;
        const answer = yield* ask({
          name: `staged-${asks}`,
          prompt: `Stage carries ${mr} at \`${short(head)}\` for testing, unmerged: ${plays(read.jobs)}. ${holding} Test it there, then: ${STAGED.done} rolls stage back and gives the claims back; ${STAGED.again} stages the merge request's head as it is then, keeping the claims; ${STAGED.leave} gives the claims back and leaves stage as it is.`,
          options: [STAGED.done, STAGED.again, STAGED.leave],
        });
        if (answer === STAGED.again) continue;
        if (answer === STAGED.leave) {
          yield* giveBack;
          return `stage carries ${mr} at ${short(head)}, unmerged`;
        }
        yield* stage.off(
          nth("unstage", n),
          `the human is done testing ${mr}`,
          `${mr} was staged at ${short(head)} for testing`,
        );
        yield* giveBack;
        return `${mr} was staged at ${short(head)} for testing; stage is rolled back`;
      }
    }),
});
