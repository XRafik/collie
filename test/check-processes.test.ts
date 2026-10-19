// A check's processes, run by the host's adapter with real processes: what is left running,
// by pid and start token, and what is recorded.

import { expect, test } from "bun:test";
import { Effect, Fiber, FileSystem, Option } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  CHECK_ID,
  CHECK_INSTALLATION,
  CheckProcesses,
  endCheck,
  hostCheckProcesses,
  runningChecksDir,
} from "../src/check-processes";
import { bindingsOf, readsSessions, startedOf, stillRunning } from "../src/processes";
import { collect, readVerifications } from "../src/verify";
import { runEffect } from "./support/effect";
import { startDetached } from "./support/command";
import { until } from "./support/host";

const held = new URL("./fixtures/checks/held.sh", import.meta.url).pathname;
const installation = "installation-under-test";

/** A state directory, a directory the check notes its pids in, and the host's adapter. */
const world = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "collie-check-processes-" });
  const state = `${root}/state`;
  const notes = `${root}/notes`;
  yield* fs.makeDirectory(state, { recursive: true });
  yield* fs.makeDirectory(notes, { recursive: true });
  const checks = yield* hostCheckProcesses({ dir: state, installation });
  return { root, state, notes, checks };
});

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
