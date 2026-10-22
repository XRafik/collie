// A start about a merge request that has an agent work on it, where its Run was placed.

import { Host, Run, agentWork, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "releases",
  title: "Release a merge request",
  description: "One agent, pointed at the merge request it was given.",
  input: Schema.Struct({ mr: Schema.String }),
  output: Schema.String,
  hints: { mr: "diff-target" },
  run: ({ input }) =>
    Effect.gen(function* () {
      const place = yield* (yield* Host).place((yield* Run).id);
      const done = yield* agentWork({
        operation: "release",
        role: "implementer",
        cwd: place.cwd,
        instructions: "Release {{mr}}.",
        input: { mr: input.mr },
        output: Schema.Struct({ verdict: Schema.String }),
      });
      return done.verdict;
    }),
});
