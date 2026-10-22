// Builds on a branch of its own and records the merge request it opened there.

import { Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "opens",
  title: "Build the work and open its merge request",
  description: "Records the merge request it was given as the one it opened.",
  input: Schema.Struct({ work: Schema.String, mr: Schema.String }),
  output: Schema.String,
  hints: { work: "work-source" },
  checkout: "branch",
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const run = yield* Run;
      const place = yield* host.place(run.id);
      yield* host.mergeRequest(run.id, input.mr);
      return place.cwd;
    }),
});
