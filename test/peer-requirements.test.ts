import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { Clock, Effect, Fiber, FileSystem, Schema } from "effect";
import { TestClock } from "effect/testing";
import { pairWith, peersOf, relayOf } from "../src/peers";
import { connect, ownerOf } from "../src/host";
import { runEffect } from "./support/effect";
import { FakeBin } from "./support/bin";
import { twoMachines } from "./support/peers";
import { signalProcess } from "../src/lock";
import { exec } from "./support/command";
import { until } from "./support/host";

test(
  "an unapproved first SSH pairing times out and closes its login",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-pair-limit-" });
        const fifo = `${dir}/wait`;
        const bin = yield* FakeBin.make(`${dir}/bin`);
        yield* Effect.addFinalizer(() => bin.restore());
        yield* bin.add(
          "ssh",
          `[ "$1" = -G ] && { echo 'hostname 127.0.0.1'; exit 0; }
echo "$$" > '${dir}/started'
read -r approval < '${fifo}'`,
        );
        yield* exec(["mkfifo", fifo]);
        const clock = yield* TestClock.make();
        const pairing = yield* pairWith(
          { id: "vm", label: "vm", target: "mk@vm", session: "default", enabled: true },
          { installation: "requester", name: "laptop" },
        ).pipe(Effect.result, Effect.provideService(Clock.Clock, clock), Effect.forkChild);
        yield* until(
          () => fs.exists(`${dir}/started`),
          (exists) => exists,
        );
        yield* clock.adjust("2 minutes");
        const answer = yield* Fiber.join(pairing);
        expect(
          yield* signalProcess(Number((yield* fs.readFileString(`${dir}/started`)).trim())),
        ).toBe(false);
        expect(answer._tag).toBe("Failure");
        if (answer._tag === "Failure")
          expect(
            Schema.decodeUnknownSync(Schema.Struct({ reason: Schema.String }))(answer.failure)
              .reason,
          ).toContain("within two minutes");
      }),
    ),
  30_000,
);

test(
  "a paired listener's occupied port is reported by machine list and doctor",
  () =>
    runEffect(
      twoMachines(
        "collie-port-",
        (first, second) =>
          Effect.gen(function* () {
            const server = createServer();
            yield* Effect.callback<void>((resume) => {
              server.listen(Number(second.env.COLLIE_PEER_PORT), "0.0.0.0", () =>
                resume(Effect.void),
              );
            });
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                server.close();
              }),
            );
            yield* first.lists([second]);
            const pair = yield* first.cli(["--machine", "second", "board"]);
            expect(pair.envelope.ok).toBe(false);
            const listed = yield* second.cli(["machine", "list"]);
            const views = Schema.decodeUnknownSync(
              Schema.Struct({
                machines: Schema.Array(Schema.Struct({ failure: Schema.NullOr(Schema.String) })),
              }),
            )(listed.envelope.data).machines;
            expect(
              views.some((one) =>
                one.failure?.includes(`could not listen on port ${second.env.COLLIE_PEER_PORT}`),
              ),
            ).toBe(true);
            const owner = yield* ownerOf(second.world.state);
            const checked = yield* second.cli(["doctor"]);
            const checks = Schema.decodeUnknownSync(
              Schema.Struct({
                checks: Schema.Array(
                  Schema.Struct({ name: Schema.String, ok: Schema.Boolean, detail: Schema.String }),
                ),
              }),
            )(checked.envelope.data ?? checked.envelope.error?.details).checks;
            expect(checks.find((one) => one.name === "paired links")).toMatchObject({
              ok: false,
              detail: expect.stringContaining(
                `could not listen on port ${second.env.COLLIE_PEER_PORT}`,
              ),
            });
            yield* Effect.callback<void>((resume) => {
              server.close(() => resume(Effect.void));
            });
            const recovered = yield* second.cli(["machine", "list"]);
            expect(recovered.envelope.data).toMatchObject({
              machines: [{ failure: "no control link from it yet" }],
            });
            expect((yield* ownerOf(second.world.state))?.pid).toBe(owner?.pid);
            expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(true);
          }),
        [],
      ),
    ),
  120_000,
);

test(
  "replacing a pairing changes its relay name and credentials without restarting either host",
  () =>
    runEffect(
      twoMachines(
        "collie-replace-",
        (first, second) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const renamed = { ...second, name: "second-renamed" };
            yield* first.lists([second, renamed]);
            expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(true);
            const local = yield* connect(first.world.state);
            const remote = yield* connect(second.world.state);
            const owner = yield* ownerOf(first.world.state);
            const farOwner = yield* ownerOf(second.world.state);
            const peer = (yield* peersOf(first.world.state))[0]!;
            const changed = { ...peer, name: renamed.name };
            yield* local.pair({ peer: changed });
            expect((yield* first.cli(["--machine", renamed.name, "board"])).envelope.ok).toBe(true);
            yield* until(
              () => fs.exists(relayOf(first.world.state, peer.name)),
              (exists) => !exists,
            );
            const inward = (yield* peersOf(second.world.state))[0]!;
            const invited = yield* remote.invite({
              for: inward.installation,
              name: inward.name,
              address: "127.0.0.1",
            });
            expect(invited.secret).not.toBe(changed.secret);
            yield* local.pair({
              peer: { ...changed, secret: invited.secret, certificate: invited.certificate },
            });
            expect((yield* first.cli(["--machine", renamed.name, "board"])).envelope.ok).toBe(true);
            yield* until(
              () => remote.peers(),
              (peers) => peers.some((one) => one.state === "live"),
            );
            expect((yield* second.cli(["--machine", inward.name, "board"])).envelope.ok).toBe(true);
            expect((yield* ownerOf(first.world.state))?.pid).toBe(owner?.pid);
            expect((yield* ownerOf(second.world.state))?.pid).toBe(farOwner?.pid);
          }),
        [],
      ),
    ),
  120_000,
);

test(
  "concurrent invitations and additions keep every pairing and one serving listener",
  () =>
    runEffect(
      twoMachines(
        "collie-concurrent-pairs-",
        (first, second) =>
          Effect.gen(function* () {
            expect((yield* first.cli(["machine", "list"])).envelope.ok).toBe(true);
            expect((yield* second.cli(["machine", "list"])).envelope.ok).toBe(true);
            const caller = yield* connect(first.world.state);
            const receiver = yield* connect(second.world.state);
            const names = Array.from({ length: 8 }, (_, i) => `inviter-${i}`);
            const invited = yield* Effect.forEach(
              names,
              (name) =>
                receiver.invite({ for: name, name, address: "127.0.0.1" }).pipe(Effect.result),
              { concurrency: "unbounded" },
            );
            expect(invited.map((result) => result._tag)).toEqual(names.map(() => "Success"));
            expect((yield* receiver.peers()).map((peer) => peer.installation).sort()).toEqual(
              [...names].sort(),
            );
            expect(
              (yield* peersOf(second.world.state)).map((peer) => peer.installation).sort(),
            ).toEqual([...names].sort());
            const additions = yield* Effect.forEach(
              names,
              (installation) =>
                caller
                  .pair({
                    peer: {
                      installation,
                      name: installation,
                      dials: "in",
                      secret: `test-secret-${installation}`,
                    },
                  })
                  .pipe(Effect.result),
              { concurrency: "unbounded" },
            );
            expect(additions.map((result) => result._tag)).toEqual(names.map(() => "Success"));
            expect((yield* caller.peers()).map((peer) => peer.installation).sort()).toEqual(
              [...names].sort(),
            );
            expect(
              (yield* peersOf(first.world.state)).map((peer) => peer.installation).sort(),
            ).toEqual([...names].sort());
          }),
        [],
      ),
    ),
  120_000,
);
