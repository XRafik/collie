import { Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "parked-pending",
  title: "Parks its work and stays pending",
  description: "A park whose status never says suspended.",
  input: Schema.Struct({ goal: Schema.String }),
  output: Schema.String,
  hints: { goal: "goal" },
  run: () =>
    Effect.gen(function* () {
      const host = yield* Host;
      yield* host.parked((yield* Run).id, "the pane will not take a prompt");
      return yield* Effect.never;
    }),
});
