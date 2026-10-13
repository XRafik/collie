import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { processStartTime } from "../src/lock";
import { inTurn } from "../tools/suite-lock";
import { runEffect } from "./support/effect";

/** A claim as `src/lock.ts` writes one. */
const asClaim = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.Int, start: Schema.NullOr(Schema.String) })),
);

const STILL = /^test: still waiting, (\d+m )?\d+s so far$/;

test("a free lock runs at once and says nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "suite-lock-" });
      const said: string[] = [];
      const got = yield* inTurn(`${dir}/suite.lock`, Effect.succeed(7), (line) =>
        Effect.sync(() => void said.push(line)),
      );
      expect(got).toBe(7);
      expect(said).toEqual([]);
    }).pipe(Effect.scoped),
  ));

test("a held lock names its holder once, then the wait as it grows, and falls quiet once it runs", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "suite-lock-" });
      const lock = `${dir}/suite.lock`;
      const holder = Bun.spawn(["sleep", "30"]);
      yield* Effect.addFinalizer(() => Effect.sync(() => holder.kill()));
      const start = yield* processStartTime(holder.pid);
      yield* fs.writeFileString(lock, `${asClaim({ pid: holder.pid, start })}\n`);

      const said: string[] = [];
      // The holder's suite ends once the waiter has said twice how long it has waited.
      const say = (line: string) =>
        Effect.gen(function* () {
          said.push(line);
          if (said.filter((one) => STILL.test(one)).length === 2) yield* fs.remove(lock);
        }).pipe(Effect.orDie);
      let atStart = -1;
      // A suite that runs for several intervals, as a real one does for minutes.
      const suite = Effect.sync(() => (atStart = said.length)).pipe(
        Effect.andThen(Effect.sleep("500 millis")),
        Effect.as("ran"),
      );
      const got = yield* inTurn(lock, suite, say, "100 millis");

      expect(got).toBe("ran");
      const [named, ...waited] = said;
      expect(named).toContain(`process ${holder.pid}`);
      expect(named).toContain("sleep 30");
      expect(named).toMatch(/since \w{3} \w{3} +\d+ \d\d:\d\d:\d\d \d{4}/);
      expect(waited.length).toBeGreaterThanOrEqual(2);
      for (const line of waited) expect(line).toMatch(STILL);
      expect(said).toHaveLength(atStart);
    }).pipe(Effect.scoped),
  ));
