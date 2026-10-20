// Stands in for a Run that lands its merge request: records it, then merges it at a head.

import { Host, MergeOutcomeSchema, Run, WorkflowError, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";

export default defineWorkflow({
  id: "merges",
  input: Schema.Struct({ mr: Schema.String, head: Schema.String }),
  hints: { mr: "goal" },
  output: MergeOutcomeSchema,
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const run = yield* Run;
      if (input.mr !== "") yield* host.mergeRequest(run.id, input.mr);
      const { cwd } = yield* host.place(run.id);
      return yield* Activity.make({
        name: "merge",
        success: MergeOutcomeSchema,
        error: WorkflowError,
        execute: host.merge({ runId: run.id, cwd, head: input.head }),
      });
    }),
});
