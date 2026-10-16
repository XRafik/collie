import { child, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "targeted-parent",
  title: "A workflow pointed at a change that waits on a child of another Task",
  description: "Starts a parking child in a Task of its own and waits on it.",
  input: Schema.Struct({ target: Schema.String }),
  output: Schema.String,
  hints: { target: "diff-target" },
  outcome: { fixed: "review" },
  run: () =>
    Effect.gen(function* () {
      yield* child({
        invocation: "aside",
        workflow: "targeted-parks",
        input: { target: "worktree" },
        ownTask: true,
      });
      return "done";
    }),
});
