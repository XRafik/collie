// A workflow whose Activity dies of a refusal, as the implement gate does when a check
// cannot be run. The Run's failure has to keep the refusal's reason.

import { WorkflowError, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";

export default defineWorkflow({
  id: "refuses",
  output: Schema.String,
  run: () =>
    Activity.make({
      name: "gate.1",
      success: Schema.String,
      execute: Effect.fail(new WorkflowError({ reason: 'nothing on PATH called "bun"' })).pipe(
        Effect.orDie,
      ),
    }),
});
