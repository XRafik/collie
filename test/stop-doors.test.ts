// A stop that left an agent running fails at every door, in one sentence: the CLI, chat and
// the TUI board through the lifecycle's operation, and Desktop's board action.

import { expect, test } from "bun:test";
import { Effect } from "effect";
import { act, type Door } from "../desktop/src/bun/machine";
import { ActionFailed } from "../desktop/src/shared/flock";
import { controlFailure, type Controlled } from "../src/board-model";

const machine = { profile: "vm", name: "vm-mk" };

const LEFT =
  "r-1-build is not stopped, only acknowledged: thread th-1 turn tu-1 on codex server ws://127.0.0.1:4100 pid 42 (the server was still up after 30s); its pane is left open";

const answered = (left: ReadonlyArray<string>): typeof Controlled.Type => ({
  runId: "r-1",
  control: "stop",
  set: true,
  applied: true,
  detail: "",
  left,
});

/** A door whose `control` answers `done`. */
const controlling = (done: typeof Controlled.Type) => {
  // SAFETY: `Control` never asks to discard the reply, so it is the answer.
  const fake: Partial<Door> = { control: () => Effect.succeed(done as never) };
  // SAFETY: a `Control` action calls only `control`.
  return { machine, desktop: fake as Door };
};

const stop = { _tag: "Control", runId: "r-1", control: "stop", set: true } as const;

test("a stop with an agent left is a failed operation naming it", () => {
  expect(controlFailure(answered([LEFT]))).toBe(`Recorded stop r-1, but ${LEFT}.`);
  expect(controlFailure({ ...answered([LEFT]), closed: [] })).toBe(
    `r-1 has finished, but ${LEFT}.`,
  );
  expect(controlFailure(answered([]))).toBeNull();
});

test("Desktop's stop fails in that sentence when the host left an agent running", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const failed = yield* act(controlling(answered([LEFT])), "stop-1", stop).pipe(Effect.flip);
      expect(failed).toEqual(
        new ActionFailed({ request: "stop-1", reason: `Recorded stop r-1, but ${LEFT}.` }),
      );
    }),
  ));

test("Desktop's stop says Stopped only when nothing was left", () =>
  Effect.runPromise(
    Effect.map(act(controlling(answered([])), "stop-2", stop), (said) =>
      expect(said).toBe("Stopped r-1"),
    ),
  ));
