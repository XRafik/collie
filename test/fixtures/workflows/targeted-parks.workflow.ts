import { Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import { WorkflowInstance } from "effect/workflow/WorkflowEngine";
import * as Workflow from "effect/workflow/Workflow";

export default defineWorkflow({
  id: "targeted-parks",
  title: "A workflow pointed at a change that parks",
  description: "Parks until resumed, so a merge finds it still going.",
  input: Schema.Struct({ target: Schema.String }),
  output: Schema.String,
  hints: { target: "diff-target" },
  outcome: { fixed: "review" },
  run: () =>
    Effect.gen(function* () {
      yield* (yield* Host).parked((yield* Run).id, "waiting on a pane");
      return yield* Workflow.suspend(yield* WorkflowInstance);
    }),
});
