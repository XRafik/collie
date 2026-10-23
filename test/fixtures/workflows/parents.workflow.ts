// A parent that starts one `plain` child, into its own Task or into a Task of the child's
// own, inside a Step or outside every Step, so a test can read where its Flow draws it.

import { child, defineWorkflow, step } from "collie";
import { Effect, Schema } from "effect";

const spawn = step({ id: "spawn", title: "Start the child", kind: "workflow" });
const wrap = step({ id: "wrap", title: "Wrap up", kind: "check" });

export default defineWorkflow({
  id: "parents",
  title: "Start a child",
  description: "Starts one plain child in the shape its mode names.",
  input: Schema.Struct({ mode: Schema.Literals(["same", "loose", "own"]) }),
  hints: { mode: "goal" },
  output: Schema.String,
  path: [spawn, wrap],
  run: ({ input }) =>
    Effect.gen(function* () {
      const started = child({
        invocation: "kid",
        workflow: "plain",
        input: { note: input.mode },
        ownTask: input.mode === "own",
      });
      yield* input.mode === "loose" ? started : spawn(started);
      yield* wrap(Effect.void);
      return input.mode;
    }),
});
