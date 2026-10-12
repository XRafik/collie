// A Run parked at the old evidence gate, as one started before ADR-0055 still is, until a
// check is named and it is resumed.

import { Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import { WorkflowInstance } from "effect/workflow/WorkflowEngine";
import * as Workflow from "effect/workflow/Workflow";

const oldGate = (run: string) =>
  "nothing is approved for Collie to run, so no command can prove this Run. " +
  `Grant it one with \`collie run intent verification ${run} --name <name> -- <command>\` ` +
  `and \`collie run resume ${run}\`; for Runs started later, add .collie/verify.json, ` +
  "or `collie run intent remember <run>` once a Run has them, for that repository's later Runs, " +
  "or verify.json in your Collie config — a Run reads that file only when it starts";

export default defineWorkflow({
  id: "gated",
  title: "Hold at the old evidence gate until a check is named",
  description: "Parks with no check named, then names what was.",
  input: Schema.Struct({ note: Schema.String }),
  hints: { note: "goal" },
  output: Schema.String,
  run: () =>
    Effect.gen(function* () {
      const runId = (yield* Run).id;
      const host = yield* Host;
      const approved = yield* host.approved(runId);
      if (approved.length === 0) {
        yield* host.parked(runId, oldGate(runId));
        return yield* Workflow.suspend(yield* WorkflowInstance);
      }
      yield* host.parked(runId, null);
      return approved.map((spec) => spec.name).join(",");
    }),
});
