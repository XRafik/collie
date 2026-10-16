// A workflow's own question, named as an agent's question on its Run would be.

import { ask, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "named-like-an-agent",
  title: "Ask a question named like an agent's",
  input: Schema.Struct({ note: Schema.String }),
  hints: { note: "goal" },
  output: Schema.String,
  run: () => ask({ name: "ask-approval-1", prompt: "Approve?" }).pipe(Effect.map(String)),
});
