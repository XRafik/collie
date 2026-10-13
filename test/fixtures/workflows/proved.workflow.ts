// A workflow held to Collie's own evidence: it reads this Run's checks before it does
// anything, and says what they were.

import { Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "proved",
  title: "A workflow that reads its checks",
  description: "Names this Run's checks.",
  input: Schema.Struct({ note: Schema.String }),
  hints: { note: "goal" },
  output: Schema.String,
  run: () =>
    Effect.gen(function* () {
      const approved = yield* (yield* Host).approved((yield* Run).id);
      return approved.map((spec) => spec.name).join(",");
    }),
});
