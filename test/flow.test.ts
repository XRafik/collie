// A Run's Flow as the host serves it in RunDetail and `run show`: one row of the Steps a
// module declares, or of what happened where it declares none
// (ADR-draft-a-step-is-declared-where-its-work-is-written).

import { expect, test } from "bun:test";
import type { BunServices } from "@effect/platform-bun/BunServices";
import { Clock, DateTime, Effect, FileSystem, Option, Schema, type Scope, Stream } from "effect";
import type { Flow, FlowLane, FlowNode } from "../src/board-model";
import { STEPS_FILE } from "../src/steps";
import { epochMs } from "../src/time";
import { runDir } from "../src/engine";
import { frontDoor, ownerOf, socketOf } from "../src/host";
import { until } from "./support/host";
import { collie, proves, type World } from "./support/world";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const outputsOf = (world: World) => `${world.home}/outputs.json`;
const gatesOf = (world: World) => `${world.home}/gates`;

/**
 * `collie` with the fake agents' answers, so a host it starts hands them out, on this
 * process's clock zone, so a time of day it says is one this test can say too.
 */
const cli = (world: World, args: ReadonlyArray<string>) =>
  collie(world, args, { FAKE_HERDR_OUTPUTS: outputsOf(world), TZ: "UTC" });

/** A world whose fake agents answer each prompt in turn with these Outputs. */
const flowing = <A, E>(
  prefix: string,
  body: (world: World) => Effect.Effect<A, E, BunServices | Scope.Scope>,
  answers: number,
  modules: ReadonlyArray<string> = ["stepped.workflow.ts"],
) =>
  proves(
    prefix,
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs
          .writeFileString(
            outputsOf(world),
            encode(Array.from({ length: answers }, () => ({ verdict: "done" }))),
          )
          .pipe(Effect.orDie);
        yield* fs.makeDirectory(gatesOf(world), { recursive: true }).pipe(Effect.orDie);
        return yield* body(world);
      }),
    modules,
  );

const RunId = Schema.Struct({ runId: Schema.String });

const start = (world: World, workflow: string, input: Readonly<Record<string, string>>) =>
  cli(world, [
    "run",
    "start",
    workflow,
    ...Object.entries(input).flatMap(([name, value]) => ["--input", `${name}=${value}`]),
  ]).pipe(
    Effect.flatMap(({ envelope }) => Schema.decodeUnknownEffect(RunId)(envelope.data)),
    Effect.map(({ runId }) => runId),
    Effect.orDie,
  );

const stepped = (world: World, mode: string) =>
  start(world, "stepped", { mode, gates: gatesOf(world) });

const open = (world: World, name: string) =>
  Effect.gen(function* () {
    yield* (yield* FileSystem.FileSystem)
      .writeFileString(`${gatesOf(world)}/${name}`, "")
      .pipe(Effect.orDie);
  });

/** The Run's Flow as a drawer opening on it now is sent it. */
const flowOf = (world: World, runId: string) =>
  Effect.gen(function* () {
    const door = yield* frontDoor(socketOf(world.state));
    const detail = yield* door
      .runDetail({ runId, tail: false, pages: 1, refreshMr: false })
      .pipe(Stream.runHead, Effect.timeout("30 seconds"));
    return Option.getOrNull(detail)?.flow ?? null;
  }).pipe(
    // A host between one process and the next has no socket to answer on yet.
    Effect.orElseSucceed(() => null),
  );

const until_ = (world: World, runId: string, wanted: (flow: Flow) => boolean) =>
  until(
    () => flowOf(world, runId),
    (flow) => flow !== null && wanted(flow),
  ).pipe(Effect.map((flow) => flow!));

const laneOf = (flow: Flow): FlowLane => flow.lanes[0]!;
const nodeOf = (flow: Flow, id: string): FlowNode | undefined =>
  laneOf(flow).nodes.find((node) => node.id === id);
const statesOf = (flow: Flow) =>
  laneOf(flow).nodes.map((node) => ({ id: node.id, state: node.state }));

test(
  "a declared path is drawn in order: done with its agent, needs you, then expected",
  () =>
    flowing(
      "collie-flow-declared-",
      (world) =>
        Effect.gen(function* () {
          const runId = yield* stepped(world, "declared");
          const asking = yield* until_(
            world,
            runId,
            (flow) => nodeOf(flow, "decide")?.state === "needs-you",
          );
          expect(laneOf(asking).declared).toBe(true);
          expect(statesOf(asking)).toEqual([
            { id: "build", state: "done" },
            { id: "decide", state: "needs-you" },
            { id: "ship", state: "expected" },
          ]);
          expect(nodeOf(asking, "build")?.ranOn).toBe("claude/opus");
          expect(nodeOf(asking, "decide")?.said).toMatch(/^Asked .+ ago$/);
          expect(nodeOf(asking, "ship")?.said).toBeNull();
          expect(asking.current).toEqual({ run: runId, node: "decide" });

          const answered = yield* cli(world, ["run", "answer", runId, "yes", "--decision", "go"]);
          expect(answered.envelope.ok).toBe(true);
          const done = yield* until_(
            world,
            runId,
            (flow) => laneOf(flow).execution === "completed",
          );
          expect(laneOf(done).nodes.map((node) => node.state)).toEqual([
            "done",
            "done",
            "done",
            "done",
          ]);
          const [question] = nodeOf(done, "decide")?.questions ?? [];
          expect(question).toMatchObject({ name: "go", by: "the CLI" });
          expect(epochMs(question!.answered!)).toBeGreaterThanOrEqual(epochMs(question!.asked!));
          // Work no Step declared, in a declared lane, is drawn as it happened.
          expect(nodeOf(done, "tidy")).toMatchObject({
            declared: false,
            title: "tidy",
            said: "Done",
          });

          // An agent reads what Desktop draws.
          const shown = yield* cli(world, ["run", "show", runId]);
          const { flow } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ flow: Schema.Unknown }),
          )(shown.envelope.data).pipe(Effect.orDie);
          expect(flow).toEqual(yield* flowOf(world, runId));
        }),
      3,
    ),
  120_000,
);

test(
  "a Step called per item, per round, off the path, and under a new forecast",
  () =>
    flowing(
      "collie-flow-repeats-",
      (world) =>
        Effect.gen(function* () {
          yield* open(world, "a");
          const items = yield* stepped(world, "items");
          const second = yield* until_(
            world,
            items,
            (flow) => nodeOf(flow, "slice")?.runs.some((one) => one.id === "slice@b") ?? false,
          );
          const slice = nodeOf(second, "slice")!;
          expect(laneOf(second).nodes).toHaveLength(1);
          expect(slice).toMatchObject({ state: "running", said: "Slice 2 of 3" });
          expect(slice.runs.map((one) => [one.title, one.state])).toEqual([
            ["a", "done"],
            ["b", "running"],
            ["c", "expected"],
          ]);

          const rounds = yield* stepped(world, "rounds");
          const reviewed = yield* until_(
            world,
            rounds,
            (flow) => laneOf(flow).execution === "completed",
          );
          expect(laneOf(reviewed).nodes.map((node) => node.id)).toEqual(["review"]);
          expect(nodeOf(reviewed, "review")?.runs.map((one) => one.title)).toEqual([
            "Round 1",
            "Round 2",
          ]);

          const offpath = yield* stepped(world, "offpath");
          const off = yield* until_(
            world,
            offpath,
            (flow) => laneOf(flow).execution === "completed",
          );
          expect(laneOf(off).nodes.map((node) => node.id)).toEqual(["build", "extra", "ship"]);
          expect(nodeOf(off, "extra")?.offPath).toBe(true);
          expect(nodeOf(off, "extra")?.said).toStartWith("Off the path · ");
          expect(nodeOf(off, "ship")?.offPath).toBe(false);

          const reforecast = yield* stepped(world, "reforecast");
          const next = yield* until_(
            world,
            reforecast,
            (flow) => nodeOf(flow, "polish") !== undefined,
          );
          expect(statesOf(next)).toEqual([
            { id: "build", state: "done" },
            { id: "polish", state: "expected" },
          ]);
          yield* open(world, "polish");
          yield* open(world, "b");
          yield* open(world, "c");
        }),
      0,
    ),
  120_000,
);

test(
  "a stopped Run says who stopped the Step it was in, and what it never reached",
  () =>
    flowing(
      "collie-flow-stop-",
      (world) =>
        Effect.gen(function* () {
          const runId = yield* stepped(world, "stop");
          yield* until_(world, runId, (flow) => nodeOf(flow, "ship")?.state === "running");
          const stopped = yield* cli(world, ["run", "stop", runId]);
          expect(stopped.envelope.ok).toBe(true);
          const flow = yield* until_(world, runId, (one) => laneOf(one).execution === "stopped");
          expect(statesOf(flow)).toEqual([
            { id: "build", state: "done" },
            { id: "ship", state: "stopped" },
            { id: "wrap", state: "not-run" },
          ]);
          expect(nodeOf(flow, "ship")?.said).toBe("Stopped by the CLI");
          expect(nodeOf(flow, "wrap")?.said).toBe("Not run");
        }),
      0,
    ),
  120_000,
);

test(
  "a host killed inside a Step is that Step's second attempt, entered once",
  () =>
    flowing(
      "collie-flow-crash-",
      (world) =>
        Effect.gen(function* () {
          const runId = yield* stepped(world, "crash");
          yield* until_(world, runId, (flow) => nodeOf(flow, "build")?.state === "running");
          const owner = yield* ownerOf(world.state);
          process.kill(owner!.pid, "SIGKILL");
          // The next command starts the next host, which recovers the Run.
          yield* cli(world, ["run", "show", runId]);
          yield* open(world, "build");
          const flow = yield* until_(world, runId, (one) => laneOf(one).execution === "completed");
          const build = nodeOf(flow, "build")!;
          expect(build.attempts.map((one) => one.cause)).toEqual([null, "restarted"]);
          expect(build.said).toEndWith(" · 2nd attempt");
          const lines = (yield* (yield* FileSystem.FileSystem)
            .readFileString(`${runDir(world.state, runId)}/${STEPS_FILE}`)
            .pipe(Effect.orDie))
            .split("\n")
            .filter((line) => line.includes('"kind":"enter"') && line.includes('"key":"build"'));
          expect(lines).toHaveLength(1);
        }),
      0,
    ),
  120_000,
);

test(
  "a Run resumed after its Step parked takes that Step again, as resumed",
  () =>
    flowing(
      "collie-flow-resume-",
      (world) =>
        Effect.gen(function* () {
          const runId = yield* stepped(world, "parks");
          yield* until_(world, runId, (flow) => laneOf(flow).execution === "suspended");
          yield* open(world, "build");
          const resumed = yield* cli(world, ["run", "resume", runId]);
          expect(resumed.envelope.ok).toBe(true);
          const flow = yield* until_(world, runId, (one) => laneOf(one).execution === "completed");
          expect(nodeOf(flow, "build")?.attempts.map((one) => one.cause)).toEqual([
            null,
            "resumed",
          ]);
        }),
      0,
    ),
  120_000,
);

test(
  "a Step asleep on a durable timer is waiting, and says when it wakes",
  () =>
    flowing(
      "collie-flow-timer-",
      (world) =>
        Effect.gen(function* () {
          const before = yield* Clock.currentTimeMillis;
          const runId = yield* stepped(world, "timer");
          const flow = yield* until_(
            world,
            runId,
            (one) => nodeOf(one, "nap")?.state === "waiting",
          );
          const nap = nodeOf(flow, "nap")!;
          expect(nap.wait).toBe("timer");
          // The host was started on UTC, as this process is.
          const wakes = (at: number) =>
            `Wakes at ${DateTime.formatIso(DateTime.makeUnsafe(at + 3_600_000)).slice(11, 16)}`;
          const after = yield* Clock.currentTimeMillis;
          expect([wakes(before), wakes(after)]).toContain(nap.said!);
        }),
      0,
    ),
  120_000,
);

test(
  "a module that declares nothing is drawn as what happened, by name, with nothing to come",
  () =>
    flowing(
      "collie-flow-undeclared-",
      (world) =>
        Effect.gen(function* () {
          const runId = yield* start(world, "attended", { work: "it" });
          const asking = yield* until_(world, runId, (flow) =>
            laneOf(flow).nodes.some((node) => node.state === "needs-you"),
          );
          expect(laneOf(asking).declared).toBe(false);
          expect(statesOf(asking)).toEqual([
            { id: "build", state: "done" },
            { id: "go", state: "needs-you" },
          ]);
          const build = nodeOf(asking, "build")!;
          expect(build).toMatchObject({
            declared: false,
            title: "build",
            said: "Done",
            ended: null,
          });
          yield* cli(world, ["run", "answer", runId, "yes", "--decision", "go"]);
          const done = yield* until_(
            world,
            runId,
            (flow) => laneOf(flow).execution === "completed",
          );
          expect(laneOf(done).nodes.map((node) => [node.title, node.state])).toEqual([
            ["build", "done"],
            ["go", "done"],
            ["check", "done"],
          ]);
        }),
      2,
      ["attended.workflow.ts"],
    ),
  120_000,
);

test(
  "workflow check refuses a path that lists one Step twice, by its id",
  () =>
    flowing(
      "collie-flow-check-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const source = yield* fs
            .readFileString(`${world.user}/stepped.workflow.ts`)
            .pipe(Effect.orDie);
          yield* fs
            .writeFileString(
              `${world.user}/stepped.workflow.ts`,
              source.replace("path: [build, decide, ship]", "path: [build, decide, build]"),
            )
            .pipe(Effect.orDie);
          const checked = yield* cli(world, ["workflow", "check", "stepped"]);
          expect(checked.exit).not.toBe(0);
          expect(checked.envelope.error?.message ?? "").toContain(
            'path lists the Step "build" more than once',
          );
        }),
      0,
    ),
  120_000,
);
