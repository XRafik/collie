import { agentWork, defineWorkflow } from "collie";
import { Schema } from "effect";
export default defineWorkflow({
  id: "completed-agent",
  title: "An agent remains after completing",
  description: "A finished Run whose agent still takes steering.",
  input: Schema.Struct({ goal: Schema.String }),
  output: Schema.Struct({ verdict: Schema.String }),
  hints: { goal: "goal" },
  run: ({ input }) =>
    agentWork({
      operation: "build",
      role: "implementer",
      instructions: "{{goal}}",
      input,
      output: Schema.Struct({ verdict: Schema.String }),
    }),
});
