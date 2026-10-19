// A check's processes, run by the host's adapter with real processes: what is left running,
// by pid and start token, and what is recorded.

import { expect, test } from "bun:test";
import { Clock, Deferred, Duration, Effect, Fiber, FileSystem, Option } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  CHECK_ID,
  CHECK_INSTALLATION,
  CheckProcesses,
  endAllWithin,
  endCheck,
  hostCheckProcesses,
  runningChecksDir,
  type LeftoverEnd,
} from "../src/check-processes";
import { bindingsOf, readsSessions, startedOf, stillRunning } from "../src/processes";
import { collect, readVerifications } from "../src/verify";
import { runEffect } from "./support/effect";
import { startDetached } from "./support/command";
import { until } from "./support/host";

const held = new URL("./fixtures/checks/held.sh", import.meta.url).pathname;
const installation = "installation-under-test";

/** A state directory, a directory the check notes its pids in, and the host's adapter. */
const worldWith = (
  options: Omit<Parameters<typeof hostCheckProcesses>[0], "dir" | "installation"> = {},
  adapterFs?: FileSystem.FileSystem,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "collie-check-processes-" });
    const state = `${root}/state`;
    const notes = `${root}/notes`;
    yield* fs.makeDirectory(state, { recursive: true });
    yield* fs.makeDirectory(notes, { recursive: true });
    const checks = yield* hostCheckProcesses({ dir: state, installation, ...options }).pipe(
      Effect.provideService(FileSystem.FileSystem, adapterFs ?? fs),
    );
    return { root, state, notes, checks };
  });
const world = worldWith();

const check = { run: "run-1", name: "held", by: "collie" } as const;

/** The check's leader and its `setsid` child once both have started, each with its start token. */
const startedIn = (notes: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pidIn = (file: string) =>
      until(
        () => fs.readFileString(`${notes}/${file}`).pipe(Effect.orElseSucceed(() => "")),
        (text) => text.trim() !== "",
      ).pipe(Effect.map((text) => Number(text.trim().split("\n").at(-1))));
    const ones = [yield* pidIn("starts"), yield* pidIn("children")];
    return yield* Effect.forEach(ones, (pid) =>
      Effect.map(startedOf(pid), (started) => ({ pid, started: started ?? "" })),
    );
  });

const noneRunning = (ones: ReadonlyArray<{ readonly pid: number; readonly started: string }>) =>
  Effect.map(Effect.forEach(ones, stillRunning), (running) => !running.some(Boolean));

const records = (state: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readDirectory(runningChecksDir(state))),
    Effect.orElseSucceed((): Array<string> => []),
  );

test.skipIf(process.platform !== "linux")(
  "an interrupted check that ignores SIGTERM is gone with its child, and leaves no record",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { state, notes, checks } = yield* world;
        const running = yield* Effect.forkScoped(
          Effect.scoped(
            checks
              .run(check, { executable: held, argv: [notes], cwd: notes })
              .pipe(Effect.flatMap((one) => one.exit)),
          ),
        );
        const ones = yield* startedIn(notes);

        yield* Fiber.interrupt(running).pipe(Effect.timeout("5 seconds"));
        expect(yield* noneRunning(ones)).toBe(true);
        expect(yield* records(state)).toEqual([]);
      }),
    ),
  30_000,
);

test.skipIf(process.platform !== "linux")(
  "a check its host ended reports no exit, even once it is gone, and records nothing",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { root, notes, checks } = yield* world;
        const evidence = `${root}/evidence`;
        const collecting = yield* Effect.forkScoped(
          collect(evidence, {
            ...check,
            executable: held,
            argv: [notes],
            cwd: notes,
          }).pipe(Effect.provideService(CheckProcesses, checks)),
        );
        const ones = yield* startedIn(notes);

        expect((yield* checks.endAll).map((one) => one.name)).toEqual(["held"]);
        yield* checks.killEnded;
        yield* until(() => noneRunning(ones), Boolean);

        const after = yield* Fiber.join(collecting).pipe(Effect.timeoutOption("1 second"));
        expect(Option.isNone(after)).toBe(true);
        expect(yield* readVerifications(evidence).pipe(Effect.orElseSucceed(() => []))).toEqual([]);
      }),
    ),
  30_000,
);

test.skipIf(process.platform !== "linux")(
  "a check is recorded and marked while it runs, and reports its exit once it ends by itself",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { state, notes, checks } = yield* world;
        const exit = yield* Effect.forkScoped(
          Effect.scoped(
            checks
              .run(check, { executable: held, argv: [notes], cwd: notes })
              .pipe(Effect.flatMap((one) => one.exit)),
          ),
        );
        const ones = yield* startedIn(notes);

        expect(yield* records(state)).toHaveLength(1);
        const bound = yield* Effect.forEach(ones, ({ pid }) =>
          bindingsOf(pid, [CHECK_INSTALLATION, CHECK_ID]),
        );
        expect(bound.every((one) => one?.[CHECK_INSTALLATION] === installation)).toBe(true);
        expect(new Set(bound.map((one) => one?.[CHECK_ID])).size).toBe(1);
        expect(bound[0]?.[CHECK_ID]).toStartWith("run-1@");

        yield* fs.writeFileString(`${notes}/release`, "");
        expect(yield* Fiber.join(exit)).toBe(0);
        expect(yield* records(state)).toEqual([]);
      }),
    ),
  30_000,
);

test.skipIf(process.platform !== "linux")(
  "a recorded pid with another start, and another installation's check, are never signalled",
  () =>
    runEffect(
      Effect.gen(function* () {
        expect(yield* readsSessions).toBe(true);
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const sleeper = (env: Record<string, string>) =>
          spawner.spawn(
            ChildProcess.make("sleep", ["30"], {
              env,
              extendEnv: true,
              stdout: "ignore",
              stderr: "ignore",
            }),
          );
        const reused = yield* sleeper({});
        const theirs = yield* sleeper({
          [CHECK_INSTALLATION]: "another-installation",
          [CHECK_ID]: "run-1@1-theirs",
        });

        expect(
          yield* endCheck(
            {
              id: "run-1@1-mine",
              leader: { pid: reused.pid, started: "not-its-start", group: reused.pid },
            },
            installation,
          ),
        ).toBe(true);
        expect(
          yield* endCheck(
            { id: "run-1@1-theirs", leader: { pid: 2 ** 22 + 1, started: "", group: 2 ** 22 + 1 } },
            installation,
          ),
        ).toBe(true);

        expect(yield* reused.isRunning).toBe(true);
        expect(yield* theirs.isRunning).toBe(true);
      }),
    ),
  30_000,
);

/** The held check, left running by nobody, marked as check `id` of `installation`. */
const leftBehind = (
  notes: string,
  marker: { readonly installation: string; readonly id: string },
) =>
  startDetached([
    "env",
    `${CHECK_INSTALLATION}=${marker.installation}`,
    `${CHECK_ID}=${marker.id}`,
    held,
    notes,
  ]);

test.skipIf(process.platform !== "linux")(
  "a check of a Run ends what another host left of that Run before it starts, and nothing of another Run",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { root, notes, checks } = yield* world;
        const others = `${root}/others`;
        yield* fs.makeDirectory(others);
        yield* Effect.addFinalizer(() =>
          Effect.all([
            fs.writeFileString(`${notes}/release`, ""),
            fs.writeFileString(`${others}/release`, ""),
          ]).pipe(Effect.ignore),
        );
        yield* leftBehind(notes, { installation, id: "run-1@1-left" });
        yield* leftBehind(others, { installation, id: "run-2@1-left" });
        const left = yield* startedIn(notes);
        const another = yield* startedIn(others);

        const exit = yield* Effect.forkScoped(
          Effect.scoped(
            checks
              .run(check, { executable: held, argv: [notes], cwd: notes })
              .pipe(Effect.flatMap((one) => one.exit)),
          ),
        );
        yield* until(
          () => fs.readFileString(`${notes}/starts`),
          (text) => text.trim().split("\n").length === 2,
        );

        expect(yield* noneRunning(left)).toBe(true);
        expect(yield* fs.exists(`${notes}/overlaps`)).toBe(false);
        expect(yield* Effect.forEach(another, stillRunning)).toEqual([true, true]);
        yield* fs.writeFileString(`${notes}/release`, "");
        expect(yield* Fiber.join(exit)).toBe(0);
        yield* fs.writeFileString(`${others}/release`, "");
        yield* until(() => noneRunning(another), Boolean);
      }),
    ),
  30_000,
);

/** A FileSystem whose first read of a process's `stat` once `armed` waits for `release`. */
const gatedStat = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const gate = {
    armed: false,
    reached: yield* Deferred.make<void>(),
    release: yield* Deferred.make<void>(),
  };
  const gated: FileSystem.FileSystem = {
    ...fs,
    readFileString: (path, encoding) => {
      if (!gate.armed || !/^\/proc\/\d+\/stat$/.test(path))
        return fs.readFileString(path, encoding);
      gate.armed = false;
      return Deferred.succeed(gate.reached, undefined).pipe(
        Effect.andThen(Deferred.await(gate.release)),
        Effect.andThen(fs.readFileString(path, encoding)),
      );
    },
  };
  return { gate, gated };
});

const runHeld = (checks: Effect.Success<typeof world>["checks"], notes: string) =>
  Effect.forkScoped(
    Effect.scoped(
      checks
        .run(check, { executable: held, argv: [notes], cwd: notes })
        .pipe(Effect.flatMap((one) => one.exit)),
    ),
  );

test.skipIf(process.platform !== "linux")(
  "a check interrupted between its spawn and its record is gone with its child, and leaves no record",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { gate, gated } = yield* gatedStat;
        const { state, notes, checks } = yield* worldWith({}, gated);
        gate.armed = true;
        const running = yield* runHeld(checks, notes);
        yield* Deferred.await(gate.reached);
        const ones = yield* startedIn(notes);

        const interrupted = yield* Effect.forkScoped(Fiber.interrupt(running));
        yield* Deferred.succeed(gate.release, undefined);
        yield* Fiber.join(interrupted).pipe(Effect.timeout("10 seconds"));
        expect(yield* noneRunning(ones)).toBe(true);
        expect(yield* records(state)).toEqual([]);
      }),
    ),
  30_000,
);

test.skipIf(process.platform !== "linux")(
  "a check asked for once its host has begun to end is never started",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { notes, checks } = yield* world;
        expect(yield* checks.endAll).toEqual([]);

        const exit = yield* runHeld(checks, notes);
        expect(Option.isNone(yield* Fiber.join(exit).pipe(Effect.timeoutOption("1 second")))).toBe(
          true,
        );
        expect(yield* checks.collecting).toEqual([]);
        expect(yield* fs.exists(`${notes}/starts`)).toBe(false);
      }),
    ),
  30_000,
);

test.skipIf(process.platform !== "linux")(
  "a check whose spawn is under way as its host begins to end is ended with the rest",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { gate, gated } = yield* gatedStat;
        const { notes, checks } = yield* worldWith({}, gated);
        gate.armed = true;
        const exit = yield* runHeld(checks, notes);
        yield* Deferred.await(gate.reached);
        const ones = yield* startedIn(notes);

        yield* checks.endAll;
        yield* Deferred.succeed(gate.release, undefined);
        yield* until(
          () => checks.collecting,
          (ids) => ids.length === 1,
        );
        yield* checks.killEnded;
        yield* until(() => noneRunning(ones), Boolean);
        expect(Option.isNone(yield* Fiber.join(exit).pipe(Effect.timeoutOption("1 second")))).toBe(
          true,
        );
      }),
    ),
  30_000,
);

test.skipIf(process.platform !== "linux")(
  "a check whose spawn lands once its host's checks are killed is killed too",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { gate, gated } = yield* gatedStat;
        const { notes, checks } = yield* worldWith({}, gated);
        gate.armed = true;
        yield* runHeld(checks, notes);
        yield* Deferred.await(gate.reached);
        const ones = yield* startedIn(notes);

        yield* checks.endAll;
        const killed = yield* Effect.forkScoped(checks.killEnded);
        yield* Deferred.succeed(gate.release, undefined);
        yield* Fiber.join(killed);
        const gone = yield* until(() => noneRunning(ones), Boolean).pipe(
          Effect.timeoutOption("3 seconds"),
        );
        expect(Option.isSome(gone)).toBe(true);
      }),
    ),
  30_000,
);

test.skipIf(process.platform !== "linux")(
  "a slow look at /proc while a host's checks get SIGTERM does not hold back their SIGKILL",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const listing = { armed: false, release: yield* Deferred.make<void>() };
        const slow: FileSystem.FileSystem = {
          ...fs,
          readDirectory: (path, options) => {
            if (!listing.armed || path !== "/proc") return fs.readDirectory(path, options);
            listing.armed = false;
            return Deferred.await(listing.release).pipe(
              Effect.andThen(fs.readDirectory(path, options)),
            );
          },
        };
        const { notes, checks } = yield* worldWith({}, slow);
        yield* Effect.addFinalizer(() => Deferred.succeed(listing.release, undefined));
        yield* runHeld(checks, notes);
        const ones = yield* startedIn(notes);

        listing.armed = true;
        yield* endAllWithin(checks, Duration.millis(2_000), () => Effect.void);
        expect(yield* noneRunning(ones)).toBe(true);
      }),
    ),
  30_000,
);

const refusal = () => Object.assign(new Error("kill EPERM"), { code: "EPERM" });

test.skipIf(process.platform !== "linux")(
  "a check of a Run does not start while a leftover of that Run survives being ended",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const refused = new Set<number>();
        const outcomes: LeftoverEnd[] = [];
        const { notes, checks } = yield* worldWith({
          kill: (target, name) => {
            if (refused.has(Math.abs(target))) throw refusal();
            process.kill(target, name);
          },
          onRun: (_leftover, outcome) => Effect.sync(() => outcomes.push(outcome)),
        });
        yield* Effect.addFinalizer(() =>
          fs.writeFileString(`${notes}/release`, "").pipe(Effect.ignore),
        );
        yield* leftBehind(notes, { installation, id: "run-1@1-left" });
        const left = yield* startedIn(notes);
        for (const { pid } of left) refused.add(pid);

        const exit = yield* runHeld(checks, notes);
        yield* until(
          () => Effect.succeed(outcomes),
          (seen) => seen.includes("still running"),
        );
        refused.clear();
        yield* until(
          () => fs.readFileString(`${notes}/starts`),
          (text) => text.trim().split("\n").length === 2,
        );

        expect(yield* noneRunning(left)).toBe(true);
        expect(yield* fs.exists(`${notes}/overlaps`)).toBe(false);
        yield* fs.writeFileString(`${notes}/release`, "");
        expect(yield* Fiber.join(exit)).toBe(0);
      }),
    ),
  60_000,
);

test.skipIf(process.platform !== "linux")(
  "killing what a host ended takes no longer for many checks that refuse it than for one",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        let refusing = false;
        const { root, checks } = yield* worldWith({
          kill: (target, name) => {
            if (refusing) throw refusal();
            process.kill(target, name);
          },
        });
        const dirs = [`${root}/one`, `${root}/two`, `${root}/three`];
        for (const dir of dirs) {
          yield* fs.makeDirectory(dir);
          yield* runHeld(checks, dir);
          yield* startedIn(dir);
        }
        // Before the checks' own finalizers, which would be refused too.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => (refusing = false)).pipe(
            Effect.andThen(Effect.forEach(dirs, (dir) => fs.writeFileString(`${dir}/release`, ""))),
            Effect.ignore,
          ),
        );

        refusing = true;
        expect(yield* checks.endAll).toHaveLength(3);
        const began = yield* Clock.currentTimeMillis;
        yield* checks.killEnded;
        expect((yield* Clock.currentTimeMillis) - began).toBeLessThan(2_000);
      }),
    ),
  30_000,
);

test("ending a host's checks is done by its grace, however long their kill takes", () =>
  runEffect(
    Effect.gen(function* () {
      const killing = yield* Deferred.make<void>();
      const checks = {
        ...(yield* CheckProcesses),
        endAll: Effect.succeed([check]),
        killEnded: Deferred.succeed(killing, undefined).pipe(Effect.andThen(Effect.never)),
      };

      const began = yield* Clock.currentTimeMillis;
      const done = yield* endAllWithin(checks, Duration.millis(500), () => Effect.void).pipe(
        Effect.timeoutOption("3 seconds"),
      );
      expect(Option.isSome(done)).toBe(true);
      expect((yield* Clock.currentTimeMillis) - began).toBeLessThan(900);
      expect(yield* Deferred.isDone(killing)).toBe(true);
    }),
  ));
