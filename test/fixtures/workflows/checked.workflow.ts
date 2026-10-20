// A gate and nothing else: it runs each of this Run's checks once, and says how each went.

import { Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "checked",
  title: "Run this Run's checks at its gate",
  description: "Runs each check once, as a gate.",
  input: Schema.Struct({ note: Schema.String }),
  hints: { note: "goal" },
  output: Schema.String,
  run: () =>
    Effect.gen(function* () {
      const runId = (yield* Run).id;
      const host = yield* Host;
      const { cwd } = yield* host.place(runId);
      const results: Array<string> = [];
      for (const spec of yield* host.approved(runId)) {
        const ran = yield* host.verify({ runId, name: spec.name, cwd, pass: "gate" });
        results.push(`${spec.name}:${ran.result}`);
      }
      return results.join(",");
    }),
});
