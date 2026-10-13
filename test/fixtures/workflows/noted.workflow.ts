import { Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "noted",
  title: "Pending work with a park note",
  description: "Keeps working while a note is visible.",
  input: Schema.Struct({ note: Schema.String }),
  output: Schema.String,
  hints: { note: "goal" },
  run: ({ input }) =>
    Effect.gen(function* () {
      yield* (yield* Host).parked((yield* Run).id, input.note);
      return yield* Effect.never;
    }),
});
