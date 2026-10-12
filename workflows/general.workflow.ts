// One agent, one ad-hoc task, done where the Run was started.
//
// No checkout of its own, no menu, no review and no gate: the Run ends when the agent
// writes its Output. The Markdown beside this file is the content.

import { Host, Run, WorkflowError, agentWork, contentOf, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import markdown from "./general.md" with { type: "text" };

const content = contentOf(markdown);

const task = content.template("task", {
  inputs: Schema.Struct({ goal: Schema.String }),
  run: Schema.Struct({ id: Schema.String }),
  rooting: Schema.String,
});

const Done = Schema.Struct({
  summary: Schema.String.annotate({
    description: "what you did, or what you found, in a few sentences; it is what the card says",
  }),
  blocked: Schema.optionalKey(Schema.String).annotate({
    description:
      "what stopped you from finishing, where something did; leave it out when the task is done",
  }),
});

export default defineWorkflow({
  id: "general",
  title: "general — one ad-hoc task, done in place",
  description:
    "One agent does one ad-hoc task in the checkout it was started in, or finds the repository from the Projects root, and ends with its summary. Not for planning, building a change to a merge request, reviewing, renovating or an architecture survey.",
  input: Schema.Struct({ goal: Schema.String }),
  hints: { goal: "goal" },
  output: Schema.String,
  agents: { harness: "claude", model: "opus", effort: "medium" },
  run: ({ input: asked }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const run = yield* Run;
      const place = yield* host.place(run.id);
      const done = yield* agentWork({
        operation: "task",
        role: "generalist",
        instructions: task,
        input: {
          inputs: { goal: asked.goal },
          run: { id: run.id },
          rooting:
            place.options.workspace === "projects-root"
              ? (content.sections.get("projects-root") ?? "")
              : "",
        },
        output: Done,
      });
      if (done.blocked !== undefined && done.blocked !== "") {
        return yield* new WorkflowError({ reason: done.blocked });
      }
      return done.summary;
    }),
});
