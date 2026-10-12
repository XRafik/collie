import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { Clock, Effect, Fiber, FileSystem, Schema } from "effect";
import { TestClock } from "effect/testing";
import { pairWith } from "../src/peers";
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
          }),
        [],
      ),
    ),
  120_000,
);
