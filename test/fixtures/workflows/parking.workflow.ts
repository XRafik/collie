import { Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "parking",
  title: "Parks, parks the same way, parks another way, then clears",
  description: "Each park a metrics journal is meant to record once.",
  input: Schema.Struct({ goal: Schema.String }),
  output: Schema.String,
  hints: { goal: "goal" },
  run: () =>
    Effect.gen(function* () {
      const host = yield* Host;
      const { id } = yield* Run;
      yield* host.parked(id, "waiting on a pane");
      yield* host.parked(id, "waiting on a pane");
      yield* host.parked(id, "the agent has written nothing");
      yield* host.parked(id, null);
      return "parked and cleared";
    }),
});
