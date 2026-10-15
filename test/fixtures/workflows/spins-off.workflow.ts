import { Children, Host, Run, agentWork, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "spins-off",
  title: "Plan the work, then build it as its own Task",
  description: "One agent here, then the build as a child Run.",
  input: Schema.Struct({ target: Schema.optionalKey(Schema.String) }),
  hints: { target: "goal" },
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      yield* (yield* Host).place((yield* Run).id);
      yield* agentWork({
        operation: "plan",
        role: "planner",
        instructions: "Plan it.",
        output: Schema.Struct({ verdict: Schema.String }),
      });
      const children = yield* Children;
      const child = yield* children.start({
        invocation: "build",
        workflow: input.target === undefined ? "builds" : "targeted",
        input: input.target === undefined ? { work: "Add a picker" } : { target: input.target },
        options: input.target === undefined ? { task: "add-a-picker" } : {},
        ownTask: true,
      });
      return String(yield* children.result(child));
    }),
});
