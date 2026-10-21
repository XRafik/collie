import { expect, test } from "bun:test";
import { Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { bindingsOf, commandOf, groupOf, processOf, startedOf } from "../src/processes";
import { runEffect } from "./support/effect";

test("a process's command and start time read alone are what reading it whole says", () =>
  runEffect(
    Effect.gen(function* () {
      const whole = (yield* processOf(process.pid))!;
      expect(yield* commandOf(process.pid)).toBe(whole.command);
      expect(yield* startedOf(process.pid)).toBe(whole.started);
    }),
  ));

test("a process that is not running has no start time", () =>
  runEffect(Effect.map(startedOf(2 ** 22 + 1), (started) => expect(started).toBeNull())));

test.skipIf(process.platform !== "linux")(
  "a process gone from /proc is not looked for with ps",
  () =>
    runEffect(
      Effect.gen(function* () {
        const spawned: string[] = [];
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            if (command._tag === "StandardCommand") spawned.push(command.command);
          }).pipe(Effect.andThen(Effect.die("nothing may be spawned"))),
        );
        const started = yield* startedOf(2 ** 22 + 1).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        expect(started).toBeNull();
        expect(spawned).toEqual([]);
      }),
    ),
);

test("a running process's group and bindings are read, and a gone one has neither", () =>
  runEffect(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const leader = yield* spawner.spawn(
        ChildProcess.make("sleep", ["30"], {
          env: { COLLIE_PROBE: "carried" },
          extendEnv: true,
          detached: true,
          stdout: "ignore",
          stderr: "ignore",
        }),
      );
      expect(yield* groupOf(leader.pid)).toBe(leader.pid);
      // Without a readable /proc, a binding proves nothing.
      expect(yield* bindingsOf(leader.pid, ["COLLIE_PROBE", "COLLIE_ABSENT"])).toEqual(
        process.platform === "linux" ? { COLLIE_PROBE: "carried" } : null,
      );

      const gone = 2 ** 22 + 1;
      expect(yield* groupOf(gone)).toBeNull();
      expect(yield* bindingsOf(gone, ["COLLIE_PROBE"])).toBeNull();
    }),
  ));
