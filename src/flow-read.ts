// A Run's Flow as the host builds it: its records read from its directory, its launches and
// the engine's facts, handed to `flow.ts`'s rules.

import { Clock, Effect, FileSystem } from "effect";
import type { Flow } from "./board-model";
import { readAudit, whoActed } from "./audit";
import type { PluginEnv } from "./env";
import { currentOf, laneOf, type Execution } from "./flow";
import { readLaunches } from "./launches";
import { runTitle } from "./naming";
import { machineName } from "./peers";
import type { RunFacts, RunState } from "./runs";
import { readStepLines } from "./steps";

const executionOfState = (state: RunState): Execution => {
  switch (state) {
    case "running":
      return "running";
    case "waiting":
      return "suspended";
    case "succeeded":
      return "completed";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
  }
};

/** One Run's row, from what it recorded. */
export const laneFor = Effect.fn("Flow.lane")(function* (
  env: PluginEnv,
  run: RunFacts,
  runs: ReadonlyArray<RunFacts>,
) {
  const fs = yield* FileSystem.FileSystem;
  const launches = yield* Effect.forEach(yield* readLaunches(env.stateDir, run.id), (launch) =>
    fs.exists(launch.output).pipe(
      Effect.orElseSucceed(() => false),
      Effect.map((done) => ({ launch, done })),
    ),
  );
  const stop = (yield* readAudit(run.dir).pipe(Effect.orElseSucceed(() => []))).findLast(
    (line) => line.operation === "stop",
  );
  return laneOf({
    run: {
      id: run.id,
      workflow: run.workflow,
      title: runTitle(run),
      state: run.state,
      requestedBy: run.requestedBy ?? null,
      execution: run.engine?.execution ?? executionOfState(run.state),
      note: run.note,
    },
    machine: env.machine ?? machineName(),
    lines: yield* readStepLines(run.dir),
    launches,
    questions: run.engine?.questions ?? [],
    children: runs
      .filter((one) => one.parent === run.id)
      .map((one) => ({
        id: one.id,
        workflow: one.workflow,
        state: one.state,
        created: one.created,
      })),
    wakes: run.engine?.wakes ?? null,
    stoppedBy: run.state === "stopped" && stop !== undefined ? whoActed(stop.actor) : null,
    now: yield* Clock.currentTimeMillis,
  });
});

/** The Flow a Run's details and `run show` carry. */
export const flowFor = Effect.fn("Flow.of")(function* (
  env: PluginEnv,
  run: RunFacts,
  runs: ReadonlyArray<RunFacts>,
) {
  const lane = yield* laneFor(env, run, runs);
  return { lanes: [lane], current: currentOf(lane) } satisfies Flow;
});
