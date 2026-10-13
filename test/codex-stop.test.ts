// A Run's stop of a Codex agent, at the Agents service: the agent's work runs in the App
// Server Collie started for it, so the stop is only a stop once that server's turns have
// ended and it is gone. The server here is a stand-in run as a real process in place of
// `codex app-server`, behind the real Codex port; herdr is the fake one.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Duration, Effect, FileSystem, Path, Schema } from "effect";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { Rig, FakeHerdr } from "./support/recorder";
import { runEffect } from "./support/effect";
import { until } from "./support/host";
import { Agents, agentWork, agentsLayer, type AgentHost } from "../src/agents";
import { asRun, enveloped } from "./support/enveloped";
import { foundationLayer } from "../src/engine";
import { agentName } from "../src/naming";
import { controlDir, readControl, type ControlRecord } from "../src/compaction";
import { codexPort } from "../src/compactors";
import type { StandInConfig } from "./support/codex-app-server";

let rig: Rig;
let dir: string;
let fs: FileSystem.FileSystem;
let path: Path.Path;

const STAND_IN = new URL("./support/codex-app-server.ts", import.meta.url).pathname;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      fs = yield* FileSystem.FileSystem;
      path = yield* Path.Path;
      rig = yield* Rig.make();
      dir = `${rig.root}/host`;
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.makeDirectory(rig.projectDir, { recursive: true });
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      // Whatever a failing test left of the stand-in and its children.
      const pids = (yield* recorded()).map((entry) => entry.child);
      pids.push((yield* readControl(rig.pluginEnv().stateDir, agent))?.pid ?? undefined);
      for (const pid of pids)
        if (pid !== undefined) yield* Effect.ignore(Effect.try(() => process.kill(pid, "SIGKILL")));
      yield* rig.close();
    }),
  ),
);

const Verdict = Schema.Struct({ verdict: Schema.String });
const work = enveloped({ name: "codex-work", input: {}, success: Verdict });
const body = work.toLayer((payload) =>
  agentWork({
    operation: "build",
    role: "implementer",
    workflow: "codex-work",
    cwd: rig.projectDir,
    instructions: "Build it.",
    input: {},
    output: Verdict,
  }).pipe(asRun(payload)),
);

const agent = agentName("r1", "build", null, 1);
const writes = () => path.join(rig.projectDir, "edits.txt");
const recordFile = () => path.join(rig.root, "stand-in.jsonl");

/** The host, with Codex's controls over the stand-in started with `config`. */
const hostWith = (
  config: Partial<StandInConfig>,
): Effect.Effect<AgentHost, unknown, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const file = path.join(rig.root, "stand-in.json");
    const full: StandInConfig = {
      cwd: rig.projectDir,
      record: recordFile(),
      writes: writes(),
      ...config,
    };
    yield* fs.writeFileString(file, encodeJson(full));
    const codex = codexPort(`bun ${STAND_IN} ${file}`, { stopMs: 1_500 });
    return {
      dir,
      env: rig.pluginEnv(),
      herdr: new FakeHerdr(rig.pluginEnv()),
      harness: "codex",
      model: "default",
      permissions: "auto",
      compactAtTokens: 1000,
      pollMs: 20,
      collectMs: 5_000,
      ports: { codex: { ...codex, gate: () => Effect.void } },
    };
  });

const session = <A, E>(
  run: Effect.Effect<
    A,
    E,
    WorkflowEngine.WorkflowEngine | Agents | FileSystem.FileSystem | Path.Path
  >,
  host: AgentHost,
) =>
  run.pipe(
    Effect.provide(body),
    Effect.provide(agentsLayer(host)),
    Effect.provide(foundationLayer({ dir })),
    Effect.scoped,
    Effect.orDie,
  );

const halted = Agents.pipe(Effect.flatMap((agents) => agents.halt("r1")));

/** A Codex agent that has done its step and whose turn is still writing in the checkout. */
const writing = (config: Partial<StandInConfig> = {}) =>
  Effect.gen(function* () {
    const host = yield* hostWith(config);
    yield* rig.queueOutputs([{ verdict: "done" }]);
    const result = yield* session(
      work.execute({ runId: "r1", input: {} }).pipe(Effect.result),
      host,
    );
    expect(result._tag).toBe("Success");
    yield* until(size, (written) => written > 0);
    return host;
  });

const size = () =>
  fs.exists(writes()).pipe(
    Effect.flatMap((there) => (there ? fs.readFileString(writes()) : Effect.succeed(""))),
    Effect.map((text) => text.length),
  );

/** One line the stand-in records: a request, a signal, a turn or child it started, its exit. */
const StandInEntry = Schema.Struct({
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(
    Schema.Struct({
      threadId: Schema.optionalKey(Schema.String),
      turnId: Schema.optionalKey(Schema.String),
    }),
  ),
  signal: Schema.optionalKey(Schema.String),
  started: Schema.optionalKey(Schema.String),
  child: Schema.optionalKey(Schema.Number),
  exit: Schema.optionalKey(Schema.Boolean),
});
const decodeEntry = Schema.decodeUnknownSync(Schema.fromJsonString(StandInEntry));

const recorded = () =>
  fs.exists(recordFile()).pipe(
    Effect.flatMap((there) => (there ? fs.readFileString(recordFile()) : Effect.succeed(""))),
    Effect.map((text) =>
      text
        .split("\n")
        .filter(Boolean)
        .map((line) => decodeEntry(line)),
    ),
  );

const signals = () => recorded().pipe(Effect.map((all) => all.filter((entry) => entry.signal)));

const interrupts = () =>
  recorded().pipe(
    Effect.map((all) =>
      all.filter((entry) => entry.method === "turn/interrupt").map((entry) => entry.params),
    ),
  );

const log = () => fs.readFileString(`${dir}/agents/r1/agents.log`);

const controlFile = () =>
  controlDir(rig.pluginEnv().stateDir, agent).pipe(
    Effect.map((at) => path.join(at, "control.json")),
  );

/** Whether the agent's file is still growing, over a stretch longer than its writes' spacing. */
const stillWriting = () =>
  Effect.gen(function* () {
    const before = yield* size();
    yield* Effect.sleep(Duration.millis(300));
    return (yield* size()) > before;
  });

test(
  "a stop ends the Codex agent's running turn before it says the agent stopped",
  () =>
    runEffect(
      Effect.gen(function* () {
        const host = yield* writing();

        const halt = yield* session(halted, host);

        expect(halt).toEqual({ stopped: [agent], left: [] });
        expect(yield* stillWriting()).toBe(false);
        expect((yield* signals()).map((entry) => entry.signal)).toEqual(["SIGTERM"]);
        expect(yield* interrupts()).toEqual([
          {
            threadId: "019a0001-0000-7000-8000-000000000001",
            turnId: "019a0002-0000-7000-8000-00000000000a",
          },
        ]);
        expect((yield* recorded()).some((entry) => entry.exit)).toBe(true);
      }),
    ),
  30_000,
);

const MAIN = {
  thread: "019a0001-0000-7000-8000-000000000001",
  turn: "019a0002-0000-7000-8000-00000000000a",
};
const SUB = {
  thread: "019a0001-0000-7000-8000-000000000002",
  turn: "019a0002-0000-7000-8000-00000000000b",
};

const paneClosed = () => rig.cmds().pipe(Effect.map((cmds) => cmds.includes("pane close")));

const control = () =>
  readControl(rig.pluginEnv().stateDir, agent).pipe(
    Effect.flatMap((record) =>
      record === null
        ? Effect.die(new Error(`${agent} has no control record`))
        : Effect.succeed(record),
    ),
  );

test(
  "the agents log says submitted, acknowledged and quiet, each with every id",
  () =>
    runEffect(
      Effect.gen(function* () {
        const host = yield* writing();
        const { endpoint, pid } = yield* control();

        yield* session(halted, host);

        const lines = (yield* log()).split("\n");
        const transcript = `/rollouts/${MAIN.thread}.jsonl`;
        for (const state of ["interrupt submitted", "interrupt acknowledged"])
          expect(lines).toContain(
            `${agent}: ${state}: thread ${MAIN.thread} turn ${MAIN.turn} on ${endpoint} pid ${pid}, transcript ${transcript}`,
          );
        expect(lines).toContain(
          `${agent} is quiet: thread ${MAIN.thread} turn ${MAIN.turn} (transcript ${transcript}) on codex server ${endpoint} pid ${pid}`,
        );
        expect(lines).toContain(`stopped ${agent}`);
        // Quiet, so the record has nothing left to find.
        expect(yield* fs.exists(yield* controlFile())).toBe(false);
      }),
    ),
  30_000,
);

test(
  "a sub-agent's running turn on the same server is interrupted too",
  () =>
    runEffect(
      Effect.gen(function* () {
        const host = yield* writing({ subagent: true });

        expect((yield* session(halted, host)).stopped).toEqual([agent]);

        expect(yield* interrupts()).toEqual(
          expect.arrayContaining([
            { threadId: MAIN.thread, turnId: MAIN.turn },
            { threadId: SUB.thread, turnId: SUB.turn },
          ]),
        );
        expect(yield* stillWriting()).toBe(false);
      }),
    ),
  30_000,
);

test(
  "a queued continuation never starts a turn after the stop",
  () =>
    runEffect(
      Effect.gen(function* () {
        const host = yield* writing({ queued: true });

        expect((yield* session(halted, host)).stopped).toEqual([agent]);

        expect((yield* recorded()).filter((entry) => entry.started)).toHaveLength(1);
        expect(yield* stillWriting()).toBe(false);
      }),
    ),
  30_000,
);

test(
  "a child left in the server's session gets one SIGTERM and ends",
  () =>
    runEffect(
      Effect.gen(function* () {
        const host = yield* writing({ child: "plain" });
        const child = (yield* recorded()).find((entry) => entry.child !== undefined)?.child;

        expect(yield* session(halted, host)).toEqual({
          stopped: [agent],
          left: [],
        });

        expect(alive(child)).toBe(false);
      }),
    ),
  30_000,
);

test(
  "a child that ignores SIGTERM fails the stop by its pid, and gets nothing more",
  () =>
    runEffect(
      Effect.gen(function* () {
        const host = yield* writing({ child: "stubborn" });
        const child = (yield* recorded()).find((entry) => entry.child !== undefined)?.child;

        const halt = yield* session(halted, host);

        expect(halt.stopped).toEqual([]);
        expect(halt.left.join("\n")).toContain(`pid ${child}`);
        // One SIGTERM it ignored, and no SIGKILL: it is still there.
        expect(alive(child)).toBe(true);
        expect(yield* signals()).toHaveLength(1);
        expect(yield* paneClosed()).toBe(false);
      }),
    ),
  30_000,
);

test(
  "an agent whose pane herdr no longer lists still has its server stopped",
  () =>
    runEffect(
      Effect.gen(function* () {
        const host = yield* writing();

        const halt = yield* session(halted, {
          ...host,
          herdr: new FakeHerdr(rig.pluginEnv({ FAKE_HERDR_AGENTS_GONE: agent })),
        });

        expect(halt).toEqual({ stopped: [agent], left: [] });
        expect(yield* stillWriting()).toBe(false);
        expect(yield* paneClosed()).toBe(false);
      }),
    ),
  30_000,
);

test(
  "a server that takes the interrupt and never exits is left acknowledged, pane open, record kept",
  () =>
    runEffect(
      Effect.gen(function* () {
        const host = yield* writing({ neverExit: true });
        const before = yield* control();

        const halt = yield* session(halted, host);

        expect(halt.stopped).toEqual([]);
        const said = halt.left.join("\n");
        expect(said).toContain(`${agent} is not stopped, only acknowledged`);
        for (const id of [MAIN.thread, MAIN.turn, `${before.endpoint} pid ${before.pid}`])
          expect(said).toContain(id);
        expect(yield* paneClosed()).toBe(false);
        const kept = yield* control();
        expect(kept).toMatchObject({
          endpoint: before.endpoint,
          pid: before.pid,
          started: before.started,
          stop: {
            state: "acknowledged",
            turns: [{ thread: MAIN.thread, turn: MAIN.turn }],
          },
        });
        expect(kept.started).toEqual(expect.any(String));
      }),
    ),
  30_000,
);

const refused = (config: Partial<StandInConfig>, tamper?: (record: ControlRecord) => object) =>
  Effect.gen(function* () {
    const host = yield* writing(config);
    if (tamper)
      yield* fs.writeFileString(yield* controlFile(), encodeJson(tamper(yield* control())));

    const halt = yield* session(halted, host);

    expect(halt.stopped).toEqual([]);
    expect(halt.left.join("\n")).toContain(`${agent} is not stopped, only failed`);
    expect(yield* signals()).toEqual([]);
    expect(yield* paneClosed()).toBe(false);
    expect((yield* control()).stop?.state).toBe("failed");
    return halt.left.join("\n");
  });

test(
  "a connection that drops mid-stop is refused, and nothing is signalled",
  () =>
    runEffect(
      Effect.map(refused({ dropConnection: true }), (said) =>
        expect(said).toContain("did not answer"),
      ),
    ),
  30_000,
);

test(
  "an endpoint holding a thread of another directory is refused, and nothing is signalled",
  () =>
    runEffect(
      Effect.map(refused({ foreignThread: true }), (said) =>
        expect(said).toContain("/somewhere/else"),
      ),
    ),
  30_000,
);

test(
  "a pid whose start time is not the recorded one is refused, and nothing is signalled",
  () =>
    runEffect(
      Effect.map(
        refused({}, (record) => ({ ...record, started: "1" })),
        (said) => expect(said).toContain("ambiguous identity"),
      ),
    ),
  30_000,
);

test(
  "a record an older build wrote, with no start time, is still stopped",
  () =>
    runEffect(
      Effect.gen(function* () {
        const host = yield* writing();
        const { started: _, stop: __, ...older } = yield* control();
        yield* fs.writeFileString(yield* controlFile(), encodeJson(older));

        expect(yield* session(halted, host)).toEqual({
          stopped: [agent],
          left: [],
        });
        expect(yield* stillWriting()).toBe(false);
      }),
    ),
  30_000,
);

test(
  "a stop repeated after the agent is quiet sends nothing and changes nothing",
  () =>
    runEffect(
      Effect.gen(function* () {
        const host = yield* writing();
        yield* session(halted, host);
        const seen = (yield* recorded()).length;
        const cmds = (yield* rig.cmds()).length;

        expect(yield* session(halted, host)).toEqual({ stopped: [], left: [] });

        expect((yield* recorded()).length).toBe(seen);
        expect(
          (yield* rig.cmds())
            .slice(cmds)
            .filter((cmd) => cmd !== "agent list" && cmd !== "pane list"),
        ).toEqual([]);
      }),
    ),
  30_000,
);

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
