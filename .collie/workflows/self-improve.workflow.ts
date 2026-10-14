// One day of this Machine's Runs, read for what is wrong with Collie (ADR-0053): filed on
// Collie's forge, and up to `improvements` of it planned and built, with nobody asked.

import { Children, Host, Run, WorkflowError, agentWork, contentOf, defineWorkflow } from "collie";
import { hostname } from "node:os";
import { DateTime, Duration, Effect, FileSystem, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";
import markdown from "./self-improve.md" with { type: "text" };
import {
  type Ended,
  type Finding,
  type Outcome,
  MAX_FINDINGS,
  Pin,
  Triage,
  chosen,
  goalOf,
  keysIn,
  markerOf,
  pinProblem,
  sha256,
  sortOut,
  summaryOf,
  targetOf,
} from "./retrospective";

const content = contentOf(markdown);
const triage = content.template("triage", {
  checkout: Schema.String,
  state: Schema.String,
  since: Schema.String,
  runs: Schema.String,
  report: Schema.String,
  issues: Schema.String,
  bound: Schema.String,
});

const DAY = Duration.hours(24);
const asJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const Count = Schema.Union([Schema.Int, Schema.NumberFromString.check(Schema.isInt())]).check(
  Schema.isGreaterThanOrEqualTo(0),
);

const Window = Schema.Struct({
  since: Schema.String,
  machine: Schema.String,
  runs: Schema.Array(Schema.String),
  report: Schema.Unknown,
});

const Opened = Schema.Array(
  Schema.Struct({
    number: Schema.Int,
    title: Schema.String,
    body: Schema.String,
    url: Schema.String,
    keys: Schema.Array(Schema.String),
  }),
);

const OutcomeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("filed"), number: Schema.Int, url: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("commented"), number: Schema.Int, url: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("refused"), reason: Schema.String }),
]);

export default defineWorkflow({
  id: "self-improve",
  title: "self-improve — file and fix what a day of Runs shows is wrong with Collie",
  description:
    "Reads this Machine's Runs of the last 24 hours with the vendored retro skill, files or comments on Collie's issues, and starts up to `improvements` plans that build themselves.",
  input: Schema.Struct({
    improvements: Schema.optionalKey(
      Count.annotate({ description: "how many Improvements to start; 0 files without building" }),
    ),
  }),
  hints: { improvements: "goal" },
  output: Schema.String,
  agents: { harness: "claude", model: "opus", effort: "xhigh" },
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const run = yield* Run;
      const children = yield* Children;
      const place = yield* host.place(run.id);
      const bound = input.improvements ?? 3;

      const window = yield* Activity.make({
        name: "window",
        success: Window,
        error: WorkflowError,
        execute: Effect.gen(function* () {
          const since = DateTime.formatIso(DateTime.subtractDuration(yield* DateTime.now, DAY));
          const report = yield* host.report(since);
          const runs = report.runs
            .filter(({ runId, parent }) => runId !== run.id && parent !== run.id)
            .map(({ runId }) => runId);
          return { since, machine: hostname(), runs, report };
        }),
      });
      if (window.runs.length === 0) return `No Runs since ${window.since}`;

      yield* Activity.make({
        name: "pin",
        success: Schema.Void,
        error: WorkflowError,
        execute: Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const skills = `${place.cwd}/.collie/skills`;
          const pin = yield* fs.readFileString(`${skills}/pin.json`).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Pin))),
            Effect.mapError(
              () =>
                new WorkflowError({ reason: ".collie/skills/pin.json is missing or unreadable" }),
            ),
          );
          const hashes = new Map<string, string | null>();
          for (const file of pin.files)
            hashes.set(
              file.path,
              yield* fs.readFile(`${skills}/${file.path}`).pipe(
                Effect.map(sha256),
                Effect.orElseSucceed(() => null),
              ),
            );
          const problem = pinProblem(pin, hashes);
          if (problem !== null) return yield* new WorkflowError({ reason: problem });
        }),
      });

      const open = yield* Activity.make({
        name: "issues",
        success: Opened,
        error: WorkflowError,
        execute: host
          .issues(run.id)
          .pipe(
            Effect.map((issues) => issues.map((issue) => ({ ...issue, keys: keysIn(issue.body) }))),
          ),
      });

      const triaged = yield* agentWork({
        operation: "triage",
        role: "retrospective",
        instructions: triage,
        input: {
          checkout: place.cwd,
          state: host.dir,
          since: window.since,
          runs: window.runs.join("\n"),
          report: asJson(window.report),
          issues:
            open.length === 0
              ? "None."
              : open
                  .map(
                    ({ number, title, url, body }) =>
                      `### #${number} ${title}\n\n${url}\n\n${body}`,
                  )
                  .join("\n\n"),
          bound: String(bound),
        },
        output: Triage,
      });

      const sorted = sortOut(triaged.findings, new Set(window.runs), open);
      const acted: Array<{ finding: Finding; outcome: Outcome }> = [];
      for (const finding of sorted.kept.slice(0, MAX_FINDINGS)) {
        const target = targetOf(finding, open);
        const outcome = yield* Activity.make({
          name: `finding.${finding.key}`,
          success: OutcomeSchema,
          execute: (target === null
            ? host
                .fileIssue({
                  runId: run.id,
                  title: finding.title,
                  body: [
                    finding.body,
                    markerOf(finding.key),
                    `Filed by Collie's self-improve Run ${run.id} on ${window.machine}.`,
                  ].join("\n\n"),
                })
                .pipe(Effect.map((filed): Outcome => ({ kind: "filed", ...filed })))
            : host
                .commentIssue({
                  runId: run.id,
                  number: target.number,
                  body: `Seen again in ${finding.runs.join(", ")} on ${window.machine}, by self-improve Run ${run.id}.\n\n${markerOf(finding.key)}`,
                })
                .pipe(
                  Effect.as<Outcome>({
                    kind: "commented",
                    number: target.number,
                    url: target.url,
                  }),
                )
          ).pipe(
            Effect.catch((refusal) =>
              Effect.succeed<Outcome>({ kind: "refused", reason: refusal.reason }),
            ),
          ),
        });
        acted.push({ finding, outcome });
      }

      const outcomes = new Map(acted.map(({ finding, outcome }) => [finding.key, outcome]));
      const filedFor = (key: string) =>
        acted.flatMap(({ finding, outcome }) =>
          finding.key === key && outcome.kind === "filed"
            ? [{ finding, number: outcome.number, url: outcome.url }]
            : [],
        );
      const improvements: ReadonlyArray<Ended> = yield* Effect.all(
        chosen(triaged.improvements, outcomes, bound).map((improvement) =>
          Effect.gen(function* () {
            const child = yield* children.start({
              invocation: `improvement-${improvement.name}`,
              workflow: "plan",
              input: {
                goal: goalOf(improvement, improvement.keys.flatMap(filedFor)),
                // oxlint-disable-next-line unicorn/no-thenable -- plan's Input is named `then`
                then: "implement",
              },
              ownTask: true,
            });
            return yield* children.result(child).pipe(
              Effect.as<Ended>({ name: improvement.name, runId: child.runId, ended: "succeeded" }),
              Effect.catch((failure) =>
                Effect.succeed<Ended>({
                  name: improvement.name,
                  runId: child.runId,
                  ended: `failed: ${failure.reason}`,
                }),
              ),
            );
          }).pipe(
            Effect.catch((failure) =>
              Effect.succeed<Ended>({
                name: improvement.name,
                runId: null,
                ended: `failed to start: ${failure.reason}`,
              }),
            ),
          ),
        ),
        { concurrency: "unbounded" },
      );

      const file = `${place.dir}/summary.md`;
      yield* Activity.make({
        name: "summary",
        success: Schema.Void,
        error: WorkflowError,
        execute: FileSystem.FileSystem.pipe(
          Effect.flatMap((fs) =>
            fs.writeFileString(
              file,
              summaryOf({
                runId: run.id,
                since: window.since,
                acted,
                improvements,
                leftOut: [...triaged.left_out, ...sorted.leftOut],
              }),
            ),
          ),
          Effect.mapError((cause) => new WorkflowError({ reason: cause.message })),
        ),
      });
      const count = (kind: Outcome["kind"]) =>
        acted.filter(({ outcome }) => outcome.kind === kind).length;
      const failed = improvements.filter(({ ended }) => ended !== "succeeded").length;
      return `Filed ${count("filed")}, commented ${count("commented")}, refused ${count("refused")}; ${improvements.length} Improvements, ${failed} failed. ${file}`;
    }),
});
