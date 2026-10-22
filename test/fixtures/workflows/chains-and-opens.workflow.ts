// A plan's shape: it works where it was started and hands the building, and the merge
// request that comes of it, to a child on a worktree of its own.

import { Children, Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "chains-and-opens",
  title: "Plan the work, then build it and open its merge request",
  description: "The build, and its merge request, as a child Run.",
  input: Schema.Struct({ mr: Schema.String }),
  output: Schema.String,
  hints: { mr: "goal" },
  run: ({ input }) =>
    Effect.gen(function* () {
      yield* (yield* Host).place((yield* Run).id);
      const children = yield* Children;
      const child = yield* children.start({
        invocation: "build",
        workflow: "opens",
        input: { work: "Add a picker", mr: input.mr },
        options: { task: "add-a-picker" },
      });
      return String(yield* children.result(child));
    }),
});
