// A Run's stop of a Codex agent, at the Agents service's halt. The agent's work runs in
// the App Server Collie started for it, so the server here is a real process — the
// stand-in in `support/codex-server.ts` — and what is asserted is what a human could
// see: whether its checkout stops changing, what the stop says, and what it was sent.

import { afterEach, beforeEach, expect, test } from "bun:test";
import type { BunServices } from "@effect/platform-bun";
import { Duration, Effect, FileSystem, Path, Schema } from "effect";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { Rig } from "./support/recorder";
import { fastForward, runEffect as runLive } from "./support/effect";
import { Agents, agentWork, agentsLayer, type AgentHost } from "../src/agents";
import { asRun, enveloped } from "./support/enveloped";
import { foundationLayer } from "../src/engine";
import { FakeHerdr } from "./support/recorder";
import { agentName } from "../src/naming";
import { codexPort } from "../src/compactors";
import type { StandIn } from "./support/codex-server";

let rig: Rig;
let dir: string;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      const fs = yield* FileSystem.FileSystem;
      dir = `${rig.root}/host`;
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.makeDirectory(rig.projectDir, { recursive: true });
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      // Whatever a test left of the stand-in, so one failure does not outlive its test.
      for (const event of yield* events())
        for (const pid of [event.pid, event.child]) if (pid !== undefined) kill(pid);
      yield* rig.close();
    }),
  ),
);

const Verdict = Schema.Struct({
  verdict: Schema.Literals(["clean", "findings"]),
  note: Schema.String,
});
const work = enveloped({
  name: "agent-work",
  input: { skip: Schema.Boolean },
  success: Verdict,
});
const body = work.toLayer((payload) =>
  agentWork({
    operation: "build",
    role: "implementer",
    workflow: "agent-work",
    cwd: rig.projectDir,
    instructions: "Build it.",
    output: Verdict,
  }).pipe(asRun(payload)),
);

const runEffect = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  runLive(fastForward(effect));

const SERVER = `${import.meta.dir}/support/codex-server.ts`;
const config = () => `${rig.root}/codex-server.json`;
const eventsFile = () => `${rig.root}/codex-server.events`;
const written = () => `${rig.projectDir}/written.txt`;
const THREAD = "01a134f2-e3e2-7242-9620-c2121348e1b8";
const TURN = "01a134f4-044f-7053-93f6-1db57d18653a";

/** The stand-in's behaviour for this test: one thread in the checkout, its turn writing. */
const serve = (over: Partial<StandIn> = {}) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.writeFileString(
        config(),
        JSON.stringify({
          events: eventsFile(),
          threads: [
            {
              id: THREAD,
              cwd: rig.projectDir,
              path: `${rig.root}/rollout-${THREAD}.jsonl`,
              turn: { id: TURN, writes: written() },
            },
          ],
          ...over,
        }),
      ),
    ),
    Effect.orDie,
  );

const hostOf = (over?: Partial<AgentHost>): AgentHost => ({
  dir,
  env: rig.pluginEnv(),
  herdr: new FakeHerdr(rig.pluginEnv()),
  harness: "codex",
  model: "default",
  permissions: "auto",
  compactAtTokens: 1000,
  pollMs: 20,
  collectMs: 30_000,
  stopMs: 250_000,
  ports: {
    codex: {
      ...codexPort(`bun ${SERVER} ${config()}`),
      gate: () => Effect.void,
    },
  },
  ...over,
});

const session = <A, E>(
  run: Effect.Effect<
    A,
    E,
    WorkflowEngine.WorkflowEngine | Agents | FileSystem.FileSystem | Path.Path
  >,
  over?: Partial<AgentHost>,
) =>
  run.pipe(
    Effect.provide(body),
    Effect.provide(agentsLayer(hostOf(over))),
    Effect.provide(foundationLayer({ dir })),
    Effect.scoped,
    Effect.orDie,
  );

const agent = agentName("r1", "build", null, 1);
const started = () =>
  session(work.execute({ runId: "r1", input: { skip: false } }).pipe(Effect.result));
const halted = (over?: Partial<AgentHost>) =>
  session(Agents.pipe(Effect.flatMap((agents) => agents.halt("r1"))), over);

const Event = Schema.Struct({
  signal: Schema.optionalKey(Schema.String),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Unknown),
  pid: Schema.optionalKey(Schema.Number),
  child: Schema.optionalKey(Schema.Number),
});
const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(Event));
const events = () =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(eventsFile())),
    Effect.orElseSucceed(() => ""),
    Effect.map((text) =>
      text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => decodeEvent(line)),
    ),
  );
const signals = () =>
  events().pipe(Effect.map((all) => all.filter((one) => one.signal !== undefined)));
const sizeOf = (file: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.stat(file)),
    Effect.map((info) => Number(info.size)),
    Effect.orElseSucceed(() => 0),
  );
/** Long enough, on the fast clock, for the stand-in's turn to have written a few times more. */
const aWhile = Effect.sleep(Duration.seconds(8));
const kill = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const serverPid = () =>
  events().pipe(Effect.map((all) => all.find((one) => one.pid !== undefined)?.pid ?? 0));

test("a stopped Codex agent's turn ends before the stop says it stopped, and nothing writes after", () =>
  runEffect(
    Effect.gen(function* () {
      yield* serve();
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* started();
      yield* aWhile;
      expect(yield* sizeOf(written())).toBeGreaterThan(0);

      const halt = yield* halted();
      const atStop = yield* sizeOf(written());
      yield* aWhile;

      expect(halt).toEqual({ stopped: [agent], left: [] });
      expect(yield* sizeOf(written())).toBe(atStop);
      expect((yield* signals()).map((one) => one.signal)).toEqual(["SIGTERM"]);
      const interrupts = (yield* events()).filter((one) => one.method === "turn/interrupt");
      expect(interrupts.map((one) => one.params)).toEqual([{ threadId: THREAD, turnId: TURN }]);
      expect(alive(yield* serverPid())).toBe(false);
    }),
  ));

const SUB_THREAD = "01a13504-4237-7000-8000-000000000001";
const SUB_TURN = "01a13504-4237-7000-8000-000000000002";
type JsonObject = typeof Schema.JsonObject.Type;
const decodeObject = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.JsonObject));
const control = () => `${rig.root}/state/compaction/${agent}/control.json`;
const panesClosed = () =>
  rig.cmds().pipe(Effect.map((cmds) => cmds.filter((cmd) => cmd === "pane close").length));
const agentsLog = () =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(`${dir}/agents/r1/agents.log`)),
    Effect.orElseSucceed(() => ""),
  );
const editControl = (edit: (record: JsonObject) => JsonObject) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.readFileString(control()).pipe(
        Effect.flatMap(decodeObject),
        Effect.flatMap((record) => fs.writeFileString(control(), JSON.stringify(edit(record)))),
      ),
    ),
    Effect.orDie,
  );
const recorded = () =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(control())),
    Effect.flatMap(decodeObject),
    Effect.orElseSucceed(() => null),
  );

/** A Run whose Codex agent is working, with the stand-in as `over` makes it. */
const working = (over: Partial<StandIn> = {}) =>
  Effect.gen(function* () {
    yield* serve(over);
    yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
    yield* started();
  });

test("a sub-agent's running turn on the same server is interrupted too", () =>
  runEffect(
    Effect.gen(function* () {
      yield* working({
        threads: [
          { id: THREAD, cwd: rig.projectDir, turn: { id: TURN, writes: written() } },
          {
            id: SUB_THREAD,
            cwd: "/elsewhere",
            parent: THREAD,
            turn: { id: SUB_TURN, writes: written() },
          },
        ],
      });
      expect(yield* halted()).toEqual({ stopped: [agent], left: [] });
      const interrupts = (yield* events()).filter((one) => one.method === "turn/interrupt");
      expect(interrupts.map((one) => one.params)).toEqual([
        { threadId: THREAD, turnId: TURN },
        { threadId: SUB_THREAD, turnId: SUB_TURN },
      ]);
    }),
  ));

test("a continuation queued behind an interrupted turn never starts", () =>
  runEffect(
    Effect.gen(function* () {
      yield* working({ continuation: true });
      expect(yield* halted()).toEqual({ stopped: [agent], left: [] });
      const atStop = yield* sizeOf(written());
      yield* aWhile;
      expect(yield* sizeOf(written())).toBe(atStop);
      expect(yield* sizeOf(written())).toBeGreaterThan(0);
    }),
  ));

test("a process left in the server's session gets one SIGTERM and ends", () =>
  runEffect(
    Effect.gen(function* () {
      yield* working({ child: "ends" });
      const child = (yield* events()).find((one) => one.child !== undefined)!.child!;
      expect(yield* halted()).toEqual({ stopped: [agent], left: [] });
      expect(alive(child)).toBe(false);
    }),
  ));

test("a process of the session that ignores SIGTERM fails the stop by its pid, and gets no second signal", () =>
  runEffect(
    Effect.gen(function* () {
      yield* working({ child: "ignores" });
      const child = (yield* events()).find((one) => one.child !== undefined)!.child!;
      const halt = yield* halted({ stopMs: 25_000 });
      expect(halt.stopped).toEqual([]);
      expect(halt.left.join("\n")).toContain(`pid ${child}`);
      expect(alive(child)).toBe(true);
      const fs = yield* FileSystem.FileSystem;
      expect((yield* fs.readFileString(`${eventsFile()}.child`)).trim().split("\n")).toEqual([
        "TERM",
      ]);
      expect((yield* signals()).map((one) => one.signal)).toEqual(["SIGTERM"]);
      expect(yield* panesClosed()).toBe(0);
    }),
  ));

test("an agent whose pane herdr no longer lists still has its server stopped", () =>
  runEffect(
    Effect.gen(function* () {
      yield* working();
      rig.dropAgent(agent);
      expect(yield* halted()).toEqual({ stopped: [agent], left: [] });
      expect(alive(yield* serverPid())).toBe(false);
      expect(yield* recorded()).toBeNull();
    }),
  ));

test("a server that acknowledges but never exits is left, acknowledged, with its pane open and its record kept", () =>
  runEffect(
    Effect.gen(function* () {
      yield* working({ ignoreInterrupt: true });
      const halt = yield* halted({ stopMs: 25_000 });
      const pid = yield* serverPid();
      expect(halt.stopped).toEqual([]);
      expect(halt.left).toHaveLength(1);
      expect(halt.left[0]).toContain(`${agent} is not stopped: acknowledged`);
      for (const id of [THREAD, TURN, `pid ${pid}`, "ws://127.0.0.1:"])
        expect(halt.left[0]).toContain(id);
      expect(yield* panesClosed()).toBe(0);
      expect(alive(pid)).toBe(true);
      expect(yield* recorded()).toMatchObject({
        pid,
        endpoint: expect.stringContaining("ws://127.0.0.1:"),
        started: expect.any(String),
        stop: { state: "acknowledged", turns: [{ thread: THREAD, turn: TURN }] },
      });
      expect((yield* signals()).map((one) => one.signal)).toEqual(["SIGTERM"]);
    }),
  ));

for (const [what, over, edit, why] of [
  [
    "a connection that drops mid-stop",
    () => ({ dropOn: "thread/turns/list" }),
    null,
    /connection closed/,
  ],
  [
    "an endpoint that answers with a thread in another directory",
    () => ({
      threads: [
        { id: THREAD, cwd: rig.projectDir, turn: { id: TURN } },
        { id: SUB_THREAD, cwd: "/somewhere/else" },
      ],
    }),
    null,
    /works in \/somewhere\/else/,
  ],
  [
    "a pid whose start time does not match the record",
    () => ({}),
    (record: JsonObject) => ({ ...record, started: "1" }),
    /started at .*, not 1/,
  ],
] as const) {
  test(`${what} is refused as failed, with no signal sent and the pane open`, () =>
    runEffect(
      Effect.gen(function* () {
        yield* working(over());
        if (edit !== null) yield* editControl(edit);
        const halt = yield* halted();
        expect(halt.stopped).toEqual([]);
        expect(halt.left.join("\n")).toMatch(/is not stopped: failed/);
        expect(halt.left.join("\n")).toMatch(why);
        expect(yield* signals()).toEqual([]);
        expect(yield* panesClosed()).toBe(0);
        expect(alive(yield* serverPid())).toBe(true);
      }),
    ));
}

test("a stop repeated once the agent is Quiet sends nothing and changes nothing", () =>
  runEffect(
    Effect.gen(function* () {
      yield* working();
      expect(yield* halted()).toEqual({ stopped: [agent], left: [] });
      const before = (yield* events()).length;
      const closes = yield* panesClosed();
      expect((yield* halted()).left).toEqual([]);
      expect((yield* events()).length).toBe(before);
      expect(yield* panesClosed()).toBe(closes);
    }),
  ));

test("a record from the previous build, with no start time, is stopped once its command and endpoint are proven", () =>
  runEffect(
    Effect.gen(function* () {
      yield* working();
      yield* editControl((record) =>
        Object.fromEntries(
          Object.entries(record).filter(([key]) => key !== "started" && key !== "stop"),
        ),
      );
      expect(yield* halted()).toEqual({ stopped: [agent], left: [] });
      expect(alive(yield* serverPid())).toBe(false);
    }),
  ));

test("the agents log has each state reached with the full ids, and only a quiet agent as stopped", () =>
  runEffect(
    Effect.gen(function* () {
      yield* working();
      yield* halted();
      const lines = (yield* agentsLog()).split("\n");
      const transcript = `${rig.root}/rollout-${THREAD}.jsonl`;
      for (const state of ["interrupt submitted", "interrupt acknowledged", "quiet"]) {
        const line = lines.find((one) => one.includes(`${agent}: ${state}`));
        expect(line).toBeDefined();
        for (const fact of [
          THREAD,
          TURN,
          "ws://127.0.0.1:",
          `pid ${yield* serverPid()}`,
          transcript,
        ])
          expect(line).toContain(fact);
      }
      expect(lines.some((one) => one.includes(`stopped ${agent}`))).toBe(true);
    }),
  ));
