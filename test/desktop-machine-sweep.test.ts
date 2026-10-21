// Desktop's main process sweeps a chosen Machine: sent once, waited on for up to 10 minutes,
// and logged in `actions.log` (ADR-0045).

import { describe, expect, test } from "bun:test";
import { Effect, Exit, Fiber, Scope } from "effect";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import type * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcServer from "effect/rpc/RpcServer";
import { TestClock } from "effect/testing";
import { type Reached, sweepOn } from "../desktop/src/bun/machine";
import type { Attempted } from "../desktop/src/bun/sent";
import { ActionFailed } from "../desktop/src/shared/flock";
import { type CleanupReport, FrontDoorRpcs, HostRefused } from "../src/board-model";

type Rpcs = RpcGroup.Rpcs<typeof FrontDoorRpcs>;

const report = (bytes: number): CleanupReport => ({
  remove: [{ kind: "worktree", target: "/w/run-1", bytes, reason: "its Run ended" }],
  keep: [{ kind: "worktree", target: "/w/run-2", reason: "its Run is live" }],
  bytes,
});

/** The `sweep` call alone, as a host serves it. */
const Sweep = RpcGroup.make(
  // SAFETY: the group's own `sweep`, which its map types as any of its Rpcs.
  FrontDoorRpcs.requests.get("sweep") as Extract<Rpcs, { readonly _tag: "sweep" }>,
);

/** A host answering each `sweep` with `answer`; the request of every sweep it is sent is kept. */
const fakeHost = (name: string, answer: Effect.Effect<CleanupReport, HostRefused>) =>
  Effect.gen(function* () {
    const swept: Array<string> = [];
    let toClient: (response: RpcMessage.FromServer<Rpcs>) => Effect.Effect<void> = () =>
      Effect.void;
    const server = yield* RpcServer.makeNoSerialization(Sweep, {
      onFromServer: (response) => toClient(response),
    }).pipe(
      Effect.provide(
        Sweep.toLayer({
          sweep: ({ request }) => Effect.suspend(() => (swept.push(request), answer)),
        }),
      ),
    );
    const client = yield* RpcClient.makeNoSerialization(FrontDoorRpcs, {
      supportsAck: true,
      onFromClient: ({ message }) => server.write(0, message),
    });
    toClient = client.write;
    // SAFETY: a sweep calls only `sweep` over its door.
    const reached = { machine: { profile: `p-${name}`, name }, desktop: client.client } as Reached;
    return { reached, swept };
  });

const logged = () => {
  const lines: Attempted[] = [];
  return { lines, log: (line: Attempted) => Effect.sync(() => void lines.push(line)) };
};

const line = (request: string, ended: Attempted["ended"], reason?: string): Attempted => {
  const sent: Attempted = {
    door: "board",
    machine: "vm-mk",
    request,
    kind: "cleanup",
    about: null,
    attempt: 1,
    ended,
  };
  return reason === undefined ? sent : { ...sent, reason };
};

const TIMED_OUT =
  "vm-mk did not finish cleaning up within 10 minutes. It may still be sweeping; Try again asks for the same sweep.";

describe("the main process sweeps a chosen Machine", () => {
  test("a sweep that answers gives its report, with one accepted line", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { lines, log } = logged();
          const host = yield* fakeHost("vm-mk", Effect.succeed(report(2048)));
          const doors = new Map([["i-vm", host.reached]]);
          const swept = yield* sweepOn(
            doors,
            { installation: "i-vm", machine: "vm-mk" },
            "s-1",
            log,
          );
          expect(swept).toEqual(report(2048));
          expect(host.swept).toEqual(["s-1"]);
          expect(lines).toEqual([line("s-1", "accepted")]);
        }),
      ),
    ));

  test("a refusal gives the host's reason, with a refused line", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { lines, log } = logged();
          const host = yield* fakeHost(
            "vm-mk",
            Effect.fail(new HostRefused({ reason: "the disk is gone" })),
          );
          const failed = yield* sweepOn(
            new Map([["i-vm", host.reached]]),
            { installation: "i-vm", machine: "vm-mk" },
            "s-1",
            log,
          ).pipe(Effect.flip);
          expect(failed).toEqual(new ActionFailed({ request: "s-1", reason: "the disk is gone" }));
          expect(lines).toEqual([line("s-1", "refused", "the disk is gone")]);
        }),
      ),
    ));

  test("a connection renewed mid-sweep names the Machine, with a failed line", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { lines, log } = logged();
        const door = yield* Scope.make();
        const host = yield* fakeHost("vm-mk", Effect.never).pipe(Scope.provide(door));
        const sweeping = yield* sweepOn(
          new Map([["i-vm", host.reached]]),
          { installation: "i-vm", machine: "vm-mk" },
          "s-1",
          log,
        ).pipe(Effect.flip, Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Scope.close(door, Exit.void);
        expect(yield* Fiber.join(sweeping)).toEqual(
          new ActionFailed({
            request: "s-1",
            reason: "vm-mk's connection was renewed before this finished",
          }),
        );
        expect(lines).toEqual([
          line("s-1", "failed", "the connection was renewed before this finished"),
        ]);
      }),
    ));

  test("an answer after 45 s is waited for: sent once, and its whole report returned", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { lines, log } = logged();
          const host = yield* fakeHost(
            "vm-mk",
            Effect.sleep("45 seconds").pipe(Effect.as(report(3 * 1024 ** 3))),
          );
          const sweeping = yield* sweepOn(
            new Map([["i-vm", host.reached]]),
            { installation: "i-vm", machine: "vm-mk" },
            "s-1",
            log,
          ).pipe(Effect.forkChild);
          yield* TestClock.adjust("45 seconds");
          expect(yield* Fiber.join(sweeping)).toEqual(report(3 * 1024 ** 3));
          expect(host.swept).toEqual(["s-1"]);
          expect(lines).toEqual([line("s-1", "accepted")]);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    ));

  test("no answer in 10 minutes times out, having sent one sweep", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { lines, log } = logged();
          const host = yield* fakeHost("vm-mk", Effect.never);
          const sweeping = yield* sweepOn(
            new Map([["i-vm", host.reached]]),
            { installation: "i-vm", machine: "vm-mk" },
            "s-1",
            log,
          ).pipe(Effect.flip, Effect.forkChild);
          yield* TestClock.adjust("10 minutes");
          expect(yield* Fiber.join(sweeping)).toEqual(
            new ActionFailed({ request: "s-1", reason: TIMED_OUT }),
          );
          expect(host.swept).toEqual(["s-1"]);
          expect(lines).toEqual([line("s-1", "timed-out", TIMED_OUT)]);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    ));

  test("Try again sends the same request", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { log } = logged();
          const host = yield* fakeHost(
            "vm-mk",
            Effect.fail(new HostRefused({ reason: "the disk is gone" })),
          );
          const doors = new Map([["i-vm", host.reached]]);
          const machine = { installation: "i-vm", machine: "vm-mk" };
          yield* sweepOn(doors, machine, "s-1", log).pipe(Effect.ignore);
          yield* sweepOn(doors, machine, "s-1", log).pipe(Effect.ignore);
          expect(host.swept).toEqual(["s-1", "s-1"]);
        }),
      ),
    ));

  test("a Machine that isn't connected is sent nothing, with a not-sent line", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { lines, log } = logged();
        const failed = yield* sweepOn(
          new Map(),
          { installation: "i-vm", machine: "vm-mk" },
          "s-1",
          log,
        ).pipe(Effect.flip);
        expect(failed).toEqual(
          new ActionFailed({
            request: "s-1",
            reason: "Not sent to vm-mk: that Machine is not connected.",
          }),
        );
        expect(lines).toEqual([
          { ...line("s-1", "not-sent", "that Machine is not connected"), attempt: 0 },
        ]);
      }),
    ));

  test("two Machines swept at once: one failing does not stop the other's report", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { log } = logged();
          const failing = yield* fakeHost(
            "vm-a",
            Effect.fail(new HostRefused({ reason: "the disk is gone" })),
          );
          const answering = yield* fakeHost(
            "vm-b",
            Effect.sleep("45 seconds").pipe(Effect.as(report(10))),
          );
          const doors = new Map([
            ["i-a", failing.reached],
            ["i-b", answering.reached],
          ]);
          const sweeping = yield* Effect.all(
            [
              sweepOn(doors, { installation: "i-a", machine: "vm-a" }, "s-a", log).pipe(
                Effect.exit,
              ),
              sweepOn(doors, { installation: "i-b", machine: "vm-b" }, "s-b", log).pipe(
                Effect.exit,
              ),
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.forkChild);
          yield* TestClock.adjust("45 seconds");
          const [a, b] = yield* Fiber.join(sweeping);
          expect(a).toEqual(
            Exit.fail(new ActionFailed({ request: "s-a", reason: "the disk is gone" })),
          );
          expect(b).toEqual(Exit.succeed(report(10)));
          expect([...failing.swept, ...answering.swept]).toEqual(["s-a", "s-b"]);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    ));
});
