// A Task's Flow as the host builds it: each Run's records read from its directory, its
// launches and the engine's facts, with the waits and the merge request its card reads,
// handed to `flow.ts`'s rules.

import { Clock, Effect, FileSystem } from "effect";
import type { Flow, FlowLane, MrState } from "./board-model";
import { readAudit, whoActed } from "./audit";
import type { PluginEnv } from "./env";
import {
  currentOf,
  laneOf,
  linkSaid,
  linkState,
  releaseRow,
  type ChildFact,
  type Execution,
  type LaneWait,
} from "./flow";
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

/** What a lane is given beside its own records: what the Task around it knows. */
export interface LaneContext {
  readonly children: ReadonlyArray<ChildFact>;
  readonly toCome: ReadonlyArray<{ readonly repo: string; readonly wave: number }>;
  readonly wait: LaneWait | null;
  readonly offer: { readonly id: string; readonly title: string } | null;
  readonly readiness: string | null;
}

const ALONE: LaneContext = { children: [], toCome: [], wait: null, offer: null, readiness: null };

const machineOf = (env: PluginEnv) => env.machine ?? machineName();

/** One Run's row, from what it recorded and what its Task says around it. */
export const laneFor = Effect.fn("Flow.lane")(function* (
  env: PluginEnv,
  run: RunFacts,
  context: LaneContext = ALONE,
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
    machine: machineOf(env),
    lines: yield* readStepLines(run.dir),
    launches,
    questions: run.engine?.questions ?? [],
    ...context,
    wakes: run.engine?.wakes ?? null,
    stoppedBy: run.state === "stopped" && stop !== undefined ? whoActed(stop.actor) : null,
    now: yield* Clock.currentTimeMillis,
  });
});

/** The Step of a Run that started a child, from the Run's own records. */
const startedIn = Effect.fn("Flow.startedIn")(function* (parent: RunFacts, child: string) {
  const lines = yield* readStepLines(parent.dir);
  const started = lines.findLast((line) => line.kind === "child" && line.run === child);
  if (started?.kind !== "child") return null;
  const key = started.key;
  for (const line of lines) if (line.kind === "enter" && line.key === key) return line.step.id;
  return null;
});

/** What a Task knows that its Flow is drawn from, beside each Run's own records. */
export interface TaskFacts {
  /** The Runs that are its rows: every Run of the Task but its Repo runs. */
  readonly rows: ReadonlyArray<RunFacts>;
  /** Every Run the host knows, for the children a row started outside it. */
  readonly all: ReadonlyArray<RunFacts>;
  /** A fan-out's Repo runs by their parent, and each repository's Wave. */
  readonly repoRunsOf: ReadonlyMap<string, ReadonlyArray<RunFacts>>;
  readonly waves: ReadonlyArray<{
    readonly parent: string;
    readonly repo: string;
    readonly wave: number;
    readonly run: string | null;
  }>;
  readonly leader: RunFacts;
  /** Whether the Task's work has settled, so nothing is current. */
  readonly settled: boolean;
  readonly waitOf: (run: RunFacts) => LaneWait | null;
  readonly offer: { readonly id: string; readonly title: string } | null;
  readonly mr: string | null;
  /** The Run whose merge request the Task's is. */
  readonly merging: string;
  readonly mrState: MrState | null;
  readonly mrStates: ReadonlyMap<string, MrState>;
  readonly ci: Parameters<typeof releaseRow>[0]["ci"];
  /** Ready to release's first missing fact, or its word that it is ready, while the MR is open. */
  readonly readiness: string | null;
  readonly mrOf: (run: RunFacts) => string | null;
  readonly mrLabel: (mr: string) => string;
}

/** A Task drawn as the work it took (ADR-draft-a-step-is-declared-where-its-work-is-written D3, D5). */
export const taskFlowFor = Effect.fn("Flow.task")(function* (env: PluginEnv, task: TaskFacts) {
  const rows = [...task.rows].sort((one, other) => one.created.localeCompare(other.created));
  const inTask = new Set(rows.map((run) => run.id));
  const machine = machineOf(env);

  const linkOf = Effect.fn("Flow.link")(function* (child: RunFacts) {
    const lane = yield* laneFor(env, child);
    const at = currentOf(lane);
    const mr = task.mrOf(child);
    return {
      run: child.id,
      machine,
      state: linkState(child.state),
      said: linkSaid({
        state: child.state,
        created: child.created,
        finished: child.finished,
        note: child.note,
        mr,
        mrState: mr === null ? null : (task.mrStates.get(task.mrLabel(mr)) ?? null),
        current:
          at === null ? null : (lane.nodes.find((node) => node.id === at.node)?.said ?? null),
      }),
    };
  });

  const lanes: FlowLane[] = [];
  for (const run of rows) {
    const repos = task.repoRunsOf.get(run.id) ?? [];
    const own = task.all.filter(
      (one) => one.parent === run.id && !inTask.has(one.id) && !repos.includes(one),
    );
    const children: ChildFact[] = [];
    for (const child of own)
      children.push({
        id: child.id,
        title: child.id.startsWith(`${run.id}.`) ? child.id.slice(run.id.length + 1) : child.id,
        created: child.created,
        link: yield* linkOf(child),
        wave: null,
      });
    const waves = task.waves.filter((one) => one.parent === run.id);
    const planned = (repo: RunFacts) => {
      const at = waves.findIndex((one) => one.run === repo.id);
      return at === -1 ? waves.length : at;
    };
    for (const repo of [...repos].sort((one, other) => planned(one) - planned(other)))
      children.push({
        id: repo.id,
        title: repo.repo ?? repo.id,
        created: repo.created,
        link: yield* linkOf(repo),
        wave: waves.find((one) => one.run === repo.id)?.wave ?? 1,
      });
    const lane = yield* laneFor(env, run, {
      children,
      toCome: waves.filter((one) => one.run === null),
      wait: task.waitOf(run),
      offer: run.id === task.leader.id ? task.offer : null,
      readiness: run.id === task.merging ? task.readiness : null,
    });
    const parent = run.parent === null ? undefined : rows.find((one) => one.id === run.parent);
    lanes.push(
      parent === undefined
        ? lane
        : { ...lane, startedBy: { run: parent.id, step: yield* startedIn(parent, run.id) } },
    );
  }
  const leading = lanes.find((lane) => lane.run === task.leader.id);
  return {
    lanes,
    current: task.settled || leading === undefined ? null : currentOf(leading),
    release: task.mr === null ? null : releaseRow({ mrState: task.mrState, ci: task.ci }),
  } satisfies Flow;
});
