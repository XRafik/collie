import { Host, Run, ask, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "roams-and-waits",
  title: "Roam a repository's branches, after a question",
  description: "Holds the repository's roaming checkout while it waits for an answer.",
  input: Schema.Struct({ work: Schema.String }),
  hints: { work: "goal" },
  output: Schema.String,
  checkout: "roaming",
  run: () =>
    Effect.gen(function* () {
      yield* ask({ name: "go", prompt: "Go on?" });
      return (yield* (yield* Host).place((yield* Run).id)).cwd;
    }),
});
