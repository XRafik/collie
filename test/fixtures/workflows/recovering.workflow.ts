import { Host, Run, defineWorkflow } from "collie";
import { Effect, FileSystem, Schema } from "effect";
import * as Workflow from "effect/workflow/Workflow";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";

export default defineWorkflow({
  id: "recovering",
  title: "Work recovered into its next state",
  description: "An external signal settles pending work or parks it for a new reason.",
  input: Schema.Struct({ file: Schema.String }),
  output: Schema.String,
  hints: { file: "goal" },
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const runId = (yield* Run).id;
      const next = yield* (yield* FileSystem.FileSystem)
        .readFileString(input.file)
        .pipe(Effect.orElseSucceed(() => "pending"));
      yield* host.record(runId, `entered ${next}`);
      if (next === "complete") return "recovered";
      yield* host.parked(runId, next === "pending" ? "old reason" : "current recovery reason");
      if (next === "pending") return yield* Effect.never;
      return yield* Workflow.suspend(yield* WorkflowEngine.WorkflowInstance);
    }),
});
