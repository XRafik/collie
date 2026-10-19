// A step that runs one of its Run's checks, as a gate's pass does.

import { Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";

export default defineWorkflow({
  id: "checking",
  title: "Run a check",
  description: "Runs the check named in its input once, in the directory it names.",
  input: Schema.Struct({ check: Schema.String, cwd: Schema.String }),
  hints: { check: "goal" },
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const runId = (yield* Run).id;
      return yield* Activity.make({
        name: "check",
        success: Schema.String,
        execute: host.verify({ runId, name: input.check, cwd: input.cwd, pass: "gate" }).pipe(
          Effect.map((verification) => verification.result),
          Effect.orDie,
        ),
      });
    }),
});
