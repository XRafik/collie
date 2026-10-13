// A builder and then a reviewer, both left alive once the Run succeeds: whom a steer that
// names nobody reaches after a review round.

import { agentWork, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "steered",
  title: "Build it, then review it",
  description: "An implementer, then a reviewer.",
  input: Schema.Struct({ work: Schema.String }),
  output: Schema.String,
  hints: { work: "goal" },
  run: ({ input }) =>
    Effect.gen(function* () {
      for (const [operation, role] of [
        ["build", "implementer"],
        ["review", "reviewer"],
      ] as const) {
        yield* agentWork({
          operation,
          role,
          instructions: "Do {{work}}.",
          input: { work: input.work },
          output: Schema.Struct({ verdict: Schema.String }),
        });
      }
      return "steered";
    }),
});
