import { ask, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "waits-here",
  title: "Wait for an answer where it was started",
  description: "Declares no checkout, so it works in the directory it was started from.",
  input: Schema.Struct({ work: Schema.String }),
  hints: { work: "goal" },
  output: Schema.String,
  run: () =>
    Effect.gen(function* () {
      return yield* ask({ name: "go", prompt: "Go on?" });
    }),
});
