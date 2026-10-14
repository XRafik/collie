// A contract against an installed harness, rather than against a mock.

import { test } from "bun:test";
import { Config, Effect, FileSystem } from "effect";
import { LIVE_HARNESSES } from "./live-switch";

/**
 * The test, where it was asked for and that harness is on this machine, and skipped
 * otherwise. What these ask — does the installed Claude still take the flag the adapter
 * passes — depends on whatever version happens to be installed, so an ordinary run never
 * fails on it, and a runner with no Claude has no answer to give.
 */
export const onMachineWith = (harness: string) =>
  Bun.env[LIVE_HARNESSES] === "1" && Bun.which(harness) !== null ? test : test.skip;

/** Removes, when the test's scope closes, the cache an installed harness keeps in `TMPDIR`. */
export const removesCache = Effect.fn("live.removesCache")(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const tmp = yield* Config.String("TMPDIR");
  yield* Effect.addFinalizer(() =>
    Effect.ignore(fs.remove(`${tmp}/${name}`, { recursive: true, force: true })),
  );
});
