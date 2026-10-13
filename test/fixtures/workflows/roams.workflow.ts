import { Host, Run, WorkflowError, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "roams",
  title: "Roam a repository's branches",
  description: "Works in the one checkout the host cut for this repository.",
  input: Schema.Struct({ work: Schema.String }),
  hints: { work: "goal" },
  output: Schema.String,
  checkout: "roaming",
  run: ({ input }) =>
    Effect.gen(function* () {
      const cwd = (yield* (yield* Host).place((yield* Run).id)).cwd;
      if (input.work === "fail") return yield* new WorkflowError({ reason: `failed in ${cwd}` });
      return cwd;
    }),
});
