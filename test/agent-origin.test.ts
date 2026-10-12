import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { machineName } from "../src/peers";
import { connect } from "../src/host";
import { readAudit } from "../src/audit";
import { runDir } from "../src/engine";
import { everyRegistered } from "../src/registry";
import { runEffect } from "./support/effect";
import { stopHost, until } from "./support/host";
import { twoMachines } from "./support/peers";

const encodeValue = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

test(
  "a piped CLI command in an agent's pane records its Run and agent, and a plain pane remains CLI",
  () =>
    runEffect(
      twoMachines(
        "collie-agent-origin-",
        (first) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const outputs = `${first.world.home}/outputs.json`;
            yield* fs.writeFileString(
              outputs,
              Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))([{ verdict: "done" }]),
            );
            const start = yield* first.cli(
              ["run", "start", "attended", "--input", "work=identity"],
              { FAKE_HERDR_OUTPUTS: outputs },
            );
            const { runId } = Schema.decodeUnknownSync(Schema.Struct({ runId: Schema.String }))(
              start.envelope.data,
            );
            const host = yield* connect(first.world.state);
            yield* until(
              () => host.run({ runId }),
              (view) => (view?.waiting ?? []).some((one) => one.answer === null),
            );
            const agent = (yield* everyRegistered(first.world.state)).find(
              (entry) => entry.runId === runId,
            )!;
            const prompt = yield* fs.readFileString(
              `${first.world.state}/agents/${runId}/build.prompt.md`,
            );
            expect(prompt).toContain(`You are ${agent.agent} of ${runId} on ${machineName()}.`);
            const words = "my exact words\n  and spacing";
            expect(
              (yield* first.cli(["run", "steer", runId, words, "--request-id", "from-agent"], {
                HERDR_PANE_ID: agent.paneId,
              })).envelope,
            ).toMatchObject({ ok: true });
            expect(
              (yield* first.cli(
                ["run", "steer", runId, "from a plain pane", "--request-id", "from-cli"],
                { HERDR_PANE_ID: "not-an-agent" },
              )).envelope.ok,
            ).toBe(true);
            const trail = yield* readAudit(runDir(first.world.state, runId));
            expect(trail.find((line) => line.request === "from-agent")?.actor).toMatchObject({
              origin: "agent",
              from: {
                run: runId,
                agent: agent.agent,
                machine: { installation: expect.any(String) },
              },
            });
            expect(trail.find((line) => line.request === "from-cli")?.actor.origin).toBe("cli");
            expect(yield* fs.readFileString(first.herdrLog)).toContain(
              `From ${agent.agent} of ${runId} on `,
            );
          }),
        ["attended.workflow.ts"],
      ),
    ),
  180_000,
);

test(
  "two paired hosts carry an agent conversation and resolve Native chat reads by Run",
  () =>
    runEffect(
      twoMachines(
        "collie-talk-",
        (first, second) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const startOn = (side: typeof first) =>
              Effect.gen(function* () {
                yield* fs.writeFileString(
                  `${side.env.PATH!.split(":")[0]}/claude`,
                  "#!/bin/sh\necho 2.1.300\n",
                  { mode: 0o755 },
                );
                const outputs = `${side.world.home}/outputs.json`;
                yield* fs.writeFileString(outputs, encodeValue([{ verdict: "done" }]));
                const start = yield* side.cli(
                  ["run", "start", "attended", "--input", "work=conversation"],
                  { FAKE_HERDR_OUTPUTS: outputs },
                );
                const { runId } = Schema.decodeUnknownSync(Schema.Struct({ runId: Schema.String }))(
                  start.envelope.data,
                );
                const host = yield* connect(side.world.state);
                yield* until(
                  () => host.run({ runId }),
                  (view) => (view?.waiting ?? []).some((one) => one.answer === null),
                );
                const entry = (yield* everyRegistered(side.world.state)).find(
                  (one) => one.runId === runId,
                )!;
                return { runId, agent: entry.agent, pane: entry.paneId };
              });
            const here = yield* startOn(first);
            const there = yield* startOn(second);
            yield* first.lists([second]);
            expect((yield* first.cli(["--machine", "second", "board"])).envelope).toMatchObject({
              ok: true,
            });
            const words = "Can you explain this?\n  Keep these words.";
            const told = yield* first.cli(
              [
                "tools",
                "call",
                "collie_do",
                "--input",
                encodeValue({
                  actions: [{ kind: "deliver", run: there.runId, agent: there.agent, text: words }],
                }),
              ],
              { COLLIE_RUN: here.runId, COLLIE_AGENT: here.agent },
            );
            expect(
              Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }))(told.envelope.data)
                .text,
            ).toContain("deliver: applied");
            const remote = yield* readAudit(runDir(second.world.state, there.runId));
            expect(remote.find((one) => one.operation === "deliver")?.actor).toMatchObject({
              origin: "agent",
              from: { run: here.runId, agent: here.agent, machine: { name: machineName() } },
            });
            const log = yield* fs.readFileString(second.herdrLog);
            expect(log).toContain(`From ${here.agent} of ${here.runId} on ${machineName()}.`);
            expect(log).toContain(words.replaceAll("\n", "\\n"));
            const replied = yield* second.cli(
              ["run", "steer", here.runId, "Here is the answer.", "--operation", here.agent],
              { HERDR_PANE_ID: there.pane },
            );
            expect(replied.envelope).toMatchObject({ ok: true });
            expect(yield* fs.readFileString(first.herdrLog)).toContain(
              `From ${there.agent} of ${there.runId} on second.`,
            );
            for (const tool of ["collie_run", "collie_receipts"]) {
              const read = yield* first.cli([
                "tools",
                "call",
                tool,
                "--input",
                encodeValue({ run: there.runId }),
              ]);
              expect(
                Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }))(read.envelope.data)
                  .text,
              ).toContain(there.runId);
            }
            const listed = yield* first.cli(["run", "list"]);
            expect(listed.envelope.data).toMatchObject({
              runs: expect.arrayContaining([
                expect.objectContaining({ runId: here.runId, machine: machineName() }),
                expect.objectContaining({ runId: there.runId, machine: "second" }),
              ]),
              machines: expect.any(Array),
            });
            const forged = yield* first.cli([
              "tools",
              "call",
              "collie_do",
              "--input",
              encodeValue({ sender: "somebody", actions: [{ kind: "stop", run: there.runId }] }),
            ]);
            expect(
              Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }))(forged.envelope.data)
                .text,
            ).toContain("refus");
            const stopped = yield* first.cli([
              "tools",
              "call",
              "collie_do",
              "--input",
              encodeValue({ actions: [{ kind: "stop", run: there.runId }] }),
            ]);
            expect(
              Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }))(
                stopped.envelope.data,
              ).text,
            ).toContain("stop: applied");
            const disposed = yield* first.cli([
              "tools",
              "call",
              "collie_do",
              "--input",
              encodeValue({
                actions: [{ kind: "disposition", run: there.runId, became: "abandoned" }],
              }),
            ]);
            expect(
              Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }))(
                disposed.envelope.data,
              ).text,
            ).toContain("disposition: applied");
            const beforeSsh = yield* fs.readFileString(first.sshLog);
            yield* stopHost(second.world.state);
            const away = yield* first.cli(["run", "list"]);
            expect(away.envelope.data).toMatchObject({
              machines: [expect.objectContaining({ machine: "second", state: "away" })],
            });
            expect(yield* fs.readFileString(first.sshLog)).toBe(beforeSsh);
          }),
        ["attended.workflow.ts"],
      ),
    ),
  180_000,
);
