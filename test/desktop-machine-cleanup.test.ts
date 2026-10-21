// What a sweep would remove on each Machine, read by Desktop's main process and drawn by the
// Cleanup dialog (ADR-0045).

import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import type * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcServer from "effect/rpc/RpcServer";
import { TestClock } from "effect/testing";
import { cleanupsOn } from "../desktop/src/bun/machine";
import {
  CLEANUP_UPGRADE_SAID,
  choose,
  cleanupView,
  type MachineCleanup,
  sweptToast,
} from "../desktop/src/shared/machine-cleanup";
import { cleanupLines } from "../src/cleanup";
import { type CleanupReport, FrontDoorRpcs, HostRefused } from "../src/board-model";

type Rpcs = RpcGroup.Rpcs<typeof FrontDoorRpcs>;

const report = (bytes: number): CleanupReport => ({
  remove: [{ kind: "worktree", target: "/w/run-1", bytes, reason: "its Run ended" }],
  keep: [],
  bytes,
});

/** The `cleanup` call alone, as a host serves it; an older host serves neither it nor `sweep`. */
const Cleanup = RpcGroup.make(
  // SAFETY: the group's own `cleanup`, which its map types as any of its Rpcs.
  FrontDoorRpcs.requests.get("cleanup") as Extract<Rpcs, { readonly _tag: "cleanup" }>,
);
const Older = RpcGroup.make(Rpc.make("ping"));

/** A host answering `cleanup` with `answer`, or too old for it; every request it is sent is kept. */
const fakeHost = (answer: Effect.Effect<CleanupReport, HostRefused> | "older") =>
  Effect.gen(function* () {
    const asked: Array<string> = [];
    let toClient: (response: RpcMessage.FromServer<Rpcs>) => Effect.Effect<void> = () =>
      Effect.void;
    const server =
      answer === "older"
        ? yield* RpcServer.makeNoSerialization(Older, {
            // SAFETY: what a host answers is the same envelope whichever group it serves.
            onFromServer: (response) => toClient(response as RpcMessage.FromServer<Rpcs>),
          }).pipe(Effect.provide(Older.toLayer({ ping: () => Effect.void })))
        : yield* RpcServer.makeNoSerialization(Cleanup, {
            onFromServer: (response) => toClient(response),
          }).pipe(Effect.provide(Cleanup.toLayer({ cleanup: () => answer })));
    const client = yield* RpcClient.makeNoSerialization(FrontDoorRpcs, {
      supportsAck: true,
      onFromClient: ({ message }) => {
        if (message._tag === "Request") asked.push(message.tag);
        // SAFETY: the host is handed a request it may have no schema for, as over the wire.
        return server.write(0, message as never);
      },
    });
    toClient = client.write;
    return { desktop: client.client, asked };
  });

const machine = (name: string) => ({ installation: `i-${name}`, profile: `p-${name}`, name });

describe("the main process reads what each Machine's sweep would remove", () => {
  test("a host that answers gives its report, and is asked only for its listing", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* fakeHost(Effect.succeed(report(2048)));
          const read = yield* cleanupsOn([[machine("vm"), host.desktop]]);
          expect(read).toEqual([
            {
              installation: "i-vm",
              profile: "p-vm",
              name: "vm",
              report: report(2048),
              problem: null,
            },
          ]);
          expect(host.asked).toEqual(["cleanup"]);
        }),
      ),
    ));

  test("a host that refuses gives its reason", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* fakeHost(
            Effect.fail(new HostRefused({ reason: "the disk is gone" })),
          );
          const [read] = yield* cleanupsOn([[machine("vm"), host.desktop]]);
          expect(read).toMatchObject({ report: null, problem: "the disk is gone" });
        }),
      ),
    ));

  test("a host that does not answer in 15 s holds back no other Machine's report", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const silent = yield* fakeHost(Effect.never);
          const answers = yield* fakeHost(Effect.succeed(report(10)));
          const reading = yield* cleanupsOn([
            [machine("slow"), silent.desktop],
            [machine("vm"), answers.desktop],
          ]).pipe(Effect.forkChild);
          yield* TestClock.adjust("15 seconds");
          const read = yield* Fiber.join(reading);
          expect(read.map(({ name, report, problem }) => [name, report, problem])).toEqual([
            ["slow", null, "its host did not answer in time"],
            ["vm", report(10), null],
          ]);
          expect([...silent.asked, ...answers.asked]).toEqual(["cleanup", "cleanup"]);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    ));

  test("a host without the call asks for an upgrade", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* fakeHost("older");
          const [read] = yield* cleanupsOn([[machine("old"), host.desktop]]);
          expect(read).toMatchObject({ report: null, problem: CLEANUP_UPGRADE_SAID });
          expect(CLEANUP_UPGRADE_SAID).toBe(
            "Can't list what it would clean up; upgrade this Machine.",
          );
        }),
      ),
    ));

  test("a connection renewed under the read says so", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const closed = yield* Deferred.make<void>();
        const reading = yield* cleanupsOn([
          [
            machine("vm"),
            { cleanup: () => Deferred.await(closed).pipe(Effect.andThen(Effect.interrupt)) },
          ],
        ]).pipe(Effect.forkChild);
        yield* Deferred.succeed(closed, undefined);
        const [read] = yield* Fiber.join(reading);
        expect(read).toMatchObject({
          report: null,
          problem: "its connection was renewed before it answered",
        });
      }),
    ));
});

type Shown = Parameters<typeof cleanupView>[0][number];
const live = (name: string): Shown => ({ profile: `p-${name}`, name, state: "live", reason: null });
const listed = (name: string, report: CleanupReport): MachineCleanup => ({
  ...machine(name),
  report,
  problem: null,
});
const failed = (name: string, problem: string): MachineCleanup => ({
  ...machine(name),
  report: null,
  problem,
});
const item = (kind: string, target: string, bytes: number) => ({
  kind,
  target,
  bytes,
  reason: `${target} is done`,
});
const GiB = 1024 ** 3;

describe("the Cleanup dialog", () => {
  test("a Machine's removals are grouped by kind, largest first, each with its count and size", () => {
    const remove = [
      item("generation", "/g/1", 1024),
      item("worktree", "/w/a", GiB),
      item("generation", "/g/2", 3 * 1024),
      item("worktree", "/w/b", 2 * GiB),
      item("staged-blob", "/s/x", 5),
    ];
    const bytes = remove.reduce((sum, { bytes }) => sum + bytes, 0);
    const [row] = cleanupView([live("vm")], [listed("vm", { remove, keep: [], bytes })], null).rows;
    expect(row!.said).toBe("Would free 3.0 GiB");
    expect(row!.groups).toEqual([
      {
        kind: "worktree",
        count: 2,
        size: "3.0 GiB",
        items: [
          { target: "/w/b", size: "2.0 GiB", reason: "/w/b is done" },
          { target: "/w/a", size: "1.0 GiB", reason: "/w/a is done" },
        ],
      },
      {
        kind: "generation",
        count: 2,
        size: "4.0 KiB",
        items: [
          { target: "/g/2", size: "3.0 KiB", reason: "/g/2 is done" },
          { target: "/g/1", size: "1.0 KiB", reason: "/g/1 is done" },
        ],
      },
      {
        kind: "staged-blob",
        count: 1,
        size: "5 B",
        items: [{ target: "/s/x", size: "5 B", reason: "/s/x is done" }],
      },
    ]);
    expect(row!.kept).toBeNull();
  });

  test("its sizes read as `collie cleanup` prints them", () => {
    const remove = [item("worktree", "/w/a", 1_288_490_189)];
    const report = { remove, keep: [], bytes: 1_288_490_189 };
    const [row] = cleanupView([live("vm")], [listed("vm", report)], null).rows;
    expect(cleanupLines(report, false)).toBe(
      "would remove\tworktree\t/w/a\t1.2 GiB\t/w/a is done\nwould free\t1.2 GiB",
    );
    expect(row!.groups[0]!.items[0]!.size).toBe("1.2 GiB");
    expect(row!.said).toBe("Would free 1.2 GiB");
  });

  test("what Collie keeps opens to each kept item's kind, target and reason", () => {
    const keep = [
      { kind: "worktree", target: "/w/open", reason: "its Task is open" },
      { kind: "home", target: "/h", reason: "it is a Home" },
    ];
    const [row] = cleanupView(
      [live("vm")],
      [listed("vm", { remove: [item("worktree", "/w/a", 10)], keep, bytes: 10 })],
      null,
    ).rows;
    expect(row!.kept).toEqual({ said: "Kept 2", items: keep });
  });

  test("a Machine with nothing to remove says so and can still be chosen", () => {
    const view = cleanupView(
      [live("vm")],
      [listed("vm", { remove: [], keep: [], bytes: 0 })],
      null,
    );
    expect(view.rows[0]).toMatchObject({
      said: "Nothing to remove now",
      groups: [],
      choosable: true,
      chosen: true,
    });
  });

  test("a Machine Desktop doesn't reach says its state and reason, and can't be chosen", () => {
    const states = [
      ["connecting", "Connecting"],
      ["unreachable", "Out of reach"],
      ["sso", "Waiting for SSO"],
      ["no-collie", "Collie isn't installed"],
      ["update-desktop", "Update Desktop"],
    ] as const;
    const view = cleanupView(
      states.map(([state]) => ({ profile: `p-${state}`, name: state, state, reason: "why" })),
      [],
      null,
    );
    expect(view.rows.map(({ said, note, choosable }) => [said, note, choosable])).toEqual([
      ["Connecting: why", null, false],
      ["Out of reach: why", "Its host still cleans up there every ten minutes.", false],
      ["Waiting for SSO: why", "Its host still cleans up there every ten minutes.", false],
      ["Collie isn't installed: why", null, false],
      ["Update Desktop: why", null, false],
    ]);
    expect(view.chosen).toBe("0 Machines chosen · would free 0 B");
  });

  test("a Machine whose listing failed, or that connected after the read, says why and can't be chosen", () => {
    const view = cleanupView(
      [live("old"), live("late")],
      [failed("old", CLEANUP_UPGRADE_SAID)],
      null,
    );
    expect(view.rows.map(({ said, choosable }) => [said, choosable])).toEqual([
      [CLEANUP_UPGRADE_SAID, false],
      ["It wasn't connected when Cleanup read.", false],
    ]);
  });

  test("every row says Reading… while the read is out, and none can be chosen", () => {
    const view = cleanupView(
      [live("vm"), { profile: "p-off", name: "off", state: "unreachable", reason: "down" }],
      null,
      null,
    );
    expect(view.rows.map(({ said, choosable }) => [said, choosable])).toEqual([
      ["Reading…", false],
      ["Reading…", false],
    ]);
  });

  test("every Machine that can be chosen starts chosen; All and None act on those", () => {
    const rows = [live("a"), live("b"), live("old"), live("off")].map((row, i) =>
      i === 3 ? { ...row, state: "unreachable" as const } : row,
    );
    const read = [
      listed("a", { remove: [item("worktree", "/w", GiB)], keep: [], bytes: GiB }),
      listed("b", { remove: [], keep: [], bytes: 0 }),
      failed("old", "the disk is gone"),
    ];
    const atStart = cleanupView(rows, read, null);
    expect(atStart.rows.map(({ chosen }) => chosen)).toEqual([true, true, false, false]);
    expect(atStart.chosen).toBe("2 Machines chosen · would free 1.0 GiB");
    const none = cleanupView(rows, read, choose(atStart, "none"));
    expect(none.rows.map(({ chosen }) => chosen)).toEqual([false, false, false, false]);
    expect(none.chosen).toBe("0 Machines chosen · would free 0 B");
    const all = cleanupView(rows, read, choose(none, "all"));
    expect(all.rows.map(({ chosen }) => chosen)).toEqual([true, true, false, false]);
  });

  test("the chosen line counts the chosen Machines and adds what they would free", () => {
    const rows = [live("a"), live("b")];
    const read = [
      listed("a", { remove: [item("worktree", "/w", 3 * GiB)], keep: [], bytes: 3 * GiB }),
      listed("b", { remove: [item("worktree", "/v", 1.1 * GiB)], keep: [], bytes: 1.1 * GiB }),
    ];
    expect(cleanupView(rows, read, null).chosen).toBe("2 Machines chosen · would free 4.1 GiB");
    expect(cleanupView(rows, read, new Set(["p-b"])).chosen).toBe(
      "1 Machine chosen · would free 1.1 GiB",
    );
  });
});

describe("the Cleanup dialog while and after it sweeps", () => {
  const rows = [live("a"), live("b"), live("c")];
  const read = [
    listed("a", { remove: [item("worktree", "/w", 3 * GiB)], keep: [], bytes: 3 * GiB }),
    listed("b", { remove: [item("worktree", "/v", GiB)], keep: [], bytes: GiB }),
    listed("c", { remove: [item("generation", "/g", 1024)], keep: [], bytes: 1024 }),
  ];
  const chosen = new Set(["p-a", "p-b"]);

  test("the button counts the chosen Machines and is disabled when none is", () => {
    expect(cleanupView(rows, read, null).button).toEqual({
      said: "Clean up 3 Machines",
      disabled: false,
    });
    expect(cleanupView(rows, read, new Set(["p-a"])).button).toEqual({
      said: "Clean up 1 Machine",
      disabled: false,
    });
    expect(cleanupView(rows, read, new Set()).button).toMatchObject({ disabled: true });
    expect(cleanupView(rows, null, null).button).toMatchObject({ disabled: true });
  });

  test("a sweeping Machine says Cleaning…, the choice is fixed, and the button is disabled", () => {
    const view = cleanupView(
      rows,
      read,
      chosen,
      new Map([
        ["p-a", { state: "running", request: "s-a" }],
        ["p-b", { state: "running", request: "s-b" }],
      ]),
    );
    expect(
      view.rows.map(({ said, chosen, choosable, warn }) => [said, chosen, choosable, warn]),
    ).toEqual([
      ["Cleaning…", true, false, false],
      ["Cleaning…", true, false, false],
      ["Would free 1.0 KiB", false, false, false],
    ]);
    expect(view.rows[2]!.groups).toHaveLength(1);
    expect(view.choosable).toEqual([]);
    expect(view.button).toEqual({ said: "Clean up 2 Machines", disabled: true });
  });

  test("a done sweep says what it freed, its removals by kind, and what it kept and why", () => {
    const swept = {
      remove: [item("worktree", "/w/a", 2 * GiB), item("worktree", "/w/b", 1.2 * GiB)],
      keep: [{ kind: "worktree", target: "/w/open", reason: "its Task is open" }],
      bytes: 3.2 * GiB,
    };
    const view = cleanupView(
      rows,
      read,
      chosen,
      new Map([["p-a", { state: "done", report: swept }]]),
    );
    expect(view.rows[0]).toMatchObject({
      said: "Freed 3.2 GiB",
      warn: false,
      reason: null,
      tryAgain: false,
      groups: [{ kind: "worktree", count: 2, size: "3.2 GiB" }],
      kept: { said: "Kept 1", items: swept.keep },
    });
    expect(view.button.disabled).toBe(true);
  });

  test("a sweep that removed nothing says so", () => {
    const view = cleanupView(
      rows,
      read,
      chosen,
      new Map([["p-a", { state: "done", report: { remove: [], keep: [], bytes: 0 } }]]),
    );
    expect(view.rows[0]).toMatchObject({ said: "Nothing removed", groups: [], kept: null });
  });

  test("a failed sweep says Not cleaned with its reason, and offers Try again", () => {
    const view = cleanupView(
      rows,
      read,
      chosen,
      new Map([["p-b", { state: "failed", request: "s-b", reason: "the disk is gone" }]]),
    );
    expect(view.rows[1]).toMatchObject({
      said: "Not cleaned",
      reason: "the disk is gone",
      tryAgain: true,
      warn: true,
      groups: [],
    });
    expect(view.rows[0]).toMatchObject({ tryAgain: false, reason: null });
  });

  test("each sweep's end is told in a toast", () => {
    expect(
      sweptToast("vm-mk", { state: "done", report: { remove: [], keep: [], bytes: 3.2 * GiB } }),
    ).toEqual({ title: "Cleaned up vm-mk: freed 3.2 GiB", color: "success" });
    expect(
      sweptToast("vm-mk", { state: "failed", request: "s-1", reason: "the disk is gone" }),
    ).toEqual({ title: "vm-mk not cleaned: the disk is gone", color: "error" });
  });
});
