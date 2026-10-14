// Collie's own `self-improve`, run the way the baseline scenarios run a shipped module:
// the real engine, agents through the dispatcher to a stand-in harness, and fakes only for
// the host's forge and report and for the children it starts.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { hostname } from "node:os";
import { Effect, FileSystem, Layer, Option, Result, Schema } from "effect";
import { Rig, FakeHerdr } from "./support/recorder";
import { runEffect } from "./support/effect";
import { exec } from "./support/command";
import { agentsLayer, type AgentHost } from "../src/agents";
import { Children, Host, Run, WorkflowError, type ChildAsk, type Issue } from "../src/sdk";
import { foundationLayer, loadEntry, runDir } from "../src/engine";
import { Store } from "../src/store";
import { redact } from "../src/conversation";
import selfImprove from "../.collie/workflows/self-improve.workflow";
import {
  type Finding,
  type Improvement,
  Pin,
  keysIn,
  markerOf,
  pinProblem,
  sha256,
  sortOut,
} from "../.collie/workflows/retrospective";

const ROOT = new URL("../", import.meta.url).pathname;
const LEAKED = `ghp_${"x".repeat(24)}`;
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

let rig: Rig;
let dir: string;
let windowRuns: Array<{ runId: string; parent: string | null }>;
let open: Issue[];
let filed: Array<{ title: string; body: string }>;
let commented: Array<{ number: number; body: string }>;
let refusing: Set<string>;
let started: ChildAsk[];
let failing: Set<string>;
let unlisted: boolean;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      const fs = yield* FileSystem.FileSystem;
      dir = `${rig.root}/host`;
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.makeDirectory(rig.projectDir, { recursive: true });
      expect((yield* exec(["cp", "-r", `${ROOT}.collie`, rig.projectDir])).exitCode).toBe(0);
      windowRuns = [
        { runId: "r-a", parent: null },
        { runId: "r-b", parent: null },
      ];
      open = [];
      filed = [];
      commented = [];
      refusing = new Set();
      started = [];
      failing = new Set();
      unlisted = false;
    }),
  ),
);
afterEach(() => runEffect(rig.close()));

const entry = () => `${rig.projectDir}/.collie/workflows/self-improve.workflow.ts`;

const hostOf = (): AgentHost => ({
  dir,
  env: rig.pluginEnv({ HERDR_PLUGIN_ROOT: ROOT }),
  herdr: new FakeHerdr(rig.pluginEnv({ HERDR_PLUGIN_ROOT: ROOT })),
  harness: "claude",
  model: "opus",
  permissions: "auto",
  compactAtTokens: 0,
  pollMs: 20,
  collectMs: 1000,
});

const forge = Layer.effect(Host)(
  Effect.gen(function* () {
    const host = yield* Host;
    return Host.of({
      ...host,
      report: (since) =>
        Effect.succeed({
          since,
          total: windowRuns.length,
          runs: windowRuns.map(({ runId, parent }) => ({
            runId,
            workflow: "implement",
            parent,
            created: since,
            status: "failed" as const,
          })),
          workflows: [],
          failed: [],
          completed: [],
          stopped: [],
        }),
      issues: () =>
        unlisted && filed.length > 0
          ? Effect.fail(new WorkflowError({ reason: "the forge did not answer" }))
          : Effect.succeed([
              ...open,
              ...filed.map(({ title, body }, at) => ({
                number: 101 + at,
                title,
                body,
                url: `https://github.com/cego/collie/issues/${101 + at}`,
              })),
            ]),
      fileIssue: ({ title, body }) =>
        refusing.has(title)
          ? Effect.fail(new WorkflowError({ reason: "it names another checkout" }))
          : Effect.sync(() => {
              filed.push({ title: redact(title), body: redact(body) });
              const number = 100 + filed.length;
              return { number, url: `https://github.com/cego/collie/issues/${number}` };
            }),
      commentIssue: ({ number, body }) => Effect.sync(() => void commented.push({ number, body })),
    });
  }),
);

const children = Layer.succeed(Children)(
  Children.of({
    start: (ask) =>
      Effect.gen(function* () {
        started.push(ask);
        const parent = Option.getOrUndefined(yield* Effect.serviceOption(Run))?.id;
        return {
          runId: `${parent}-${ask.invocation}`,
          workflow: ask.workflow,
          invocation: ask.invocation,
          fresh: true,
        };
      }),
    result: (child) =>
      failing.has(child.invocation)
        ? Effect.fail(new WorkflowError({ reason: `${child.invocation} parked` }))
        : Effect.succeed("done"),
  }),
);

const ran = (runId: string, input: Readonly<Record<string, Schema.Json>>) =>
  Effect.gen(function* () {
    const made = yield* loadEntry(entry()).pipe(
      Effect.map((described) => described.make(`${described.id}@${runId}`)),
    );
    const store = yield* Store;
    yield* store.admit({
      request: runId,
      run: runId,
      workflow: made.workflow.name,
      project: rig.projectDir,
      input,
      provenance: {},
      options: {},
      generation: `${made.workflow.name}@${runId}`,
      execution: runId,
      task: null,
      parent: null,
    });
    return yield* made.workflow
      .execute({ runId, input })
      .pipe(Effect.result, Effect.provide(made.layer));
  }).pipe(
    Effect.provide(agentsLayer(hostOf())),
    Effect.provide(children),
    Effect.provide(
      forge.pipe(
        Layer.provideMerge(
          foundationLayer({
            dir,
            userDir: rig.userDir,
            placing: { herdr: hostOf().herdr, env: hostOf().env },
          }),
        ),
      ),
    ),
    Effect.scoped,
    Effect.orDie,
  );

const launches = () =>
  rig.calls().pipe(Effect.map((calls) => calls.filter((call) => call.cmd === "agent prompt")));

const read = (file: string) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.readFileString(file)));

const isWorkflowError = Schema.is(WorkflowError);
const said = (result: Result.Result<unknown, unknown>) =>
  Result.isSuccess(result) ? String(result.success) : "";
const reasonOf = (result: Result.Result<unknown, unknown>) =>
  Result.isFailure(result) && isWorkflowError(result.failure) ? result.failure.reason : "";

const finding = (over: Partial<Finding> & Pick<Finding, "key">): Finding => ({
  category: "defect",
  title: `Collie ${over.key}`,
  body: `What Collie did: ${over.key}.`,
  severity: "high",
  runs: ["r-a"],
  records: ["runs/r-a/audit.jsonl"],
  issue: null,
  ...over,
});

const triage = (
  findings: ReadonlyArray<Finding>,
  improvements: ReadonlyArray<Improvement> = [],
) => ({
  findings,
  improvements,
  left_out: [{ what: "a test in another project failed", why: "a project's own code" }],
});

test("the committed retro skill is upstream's bytes at the pinned commit", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pin = Schema.decodeUnknownSync(Schema.fromJsonString(Pin))(
        yield* fs.readFileString(`${ROOT}.collie/skills/pin.json`),
      );
      expect(pin).toEqual({
        repository: "mattpocock/skills",
        commit: "49dd158d1076134a641b33efb035946536778336",
        files: [
          {
            upstream: "skills/engineering/retro/SKILL.md",
            path: "retro/SKILL.md",
            sha256: "33fbc28568e3146f20fd908b12998bc0ab30aa4f4c87288199a40793efa94696",
          },
          {
            upstream: "skills/productivity/writing-for-agents/SKILL.md",
            path: "writing-for-agents/SKILL.md",
            sha256: "551adca942227b44192edba88acd4e8db911f0121ce58ad16944ccf6a896a74a",
          },
          {
            upstream: "LICENSE",
            path: "LICENSE",
            sha256: "0e7ac423bf2c6e223b7c5b156f8cf72da49d748e56a1641402c31f22ad07dbb5",
          },
        ],
      });
      const hashes = new Map<string, string | null>();
      for (const file of pin.files)
        hashes.set(file.path, sha256(yield* fs.readFile(`${ROOT}.collie/skills/${file.path}`)));
      expect(pinProblem(pin, hashes)).toBeNull();
      expect(pinProblem(pin, new Map([...hashes, ["LICENSE", null]]))).toBe(
        ".collie/skills/LICENSE is missing",
      );
      expect(
        pinProblem(pin, new Map([...hashes, ["retro/SKILL.md", sha256(new Uint8Array())]])),
      ).toContain(".collie/skills/retro/SKILL.md is not");
    }),
  ));

test("improvements is a whole number, as the CLI's text or as a number", () => {
  const decode = Schema.decodeUnknownSync(selfImprove.input ?? Schema.Never);
  expect(decode({ improvements: "3" })).toEqual({ improvements: 3 });
  expect(decode({ improvements: 0 })).toEqual({ improvements: 0 });
  for (const wrong of ["-1", "x", 1.5]) expect(() => decode({ improvements: wrong })).toThrow();
});

test("a finding recurs in two of the window's Runs or on an open issue, and a defect in one", () => {
  const window = new Set(["r-a", "r-b"]);
  const issues = [{ number: 8, title: "", url: "", keys: keysIn(`x\n${markerOf("known")}`) }];
  const { kept, leftOut } = sortOut(
    [
      finding({ key: "crash" }),
      finding({ key: "once", category: "navigation" }),
      finding({ key: "twice", category: "navigation", runs: ["r-a", "r-b"] }),
      finding({ key: "known", category: "navigation" }),
      finding({ key: "elsewhere", runs: ["r-z"] }),
    ],
    window,
    issues,
  );
  expect(kept.map(({ key }) => key)).toEqual(["crash", "twice", "known"]);
  expect(leftOut.map(({ why }) => why)).toEqual(["seen once", "no Run of the window"]);
});

test(
  "with no Runs in the window, it says so and starts no agent",
  () =>
    runEffect(
      Effect.gen(function* () {
        windowRuns = [
          { runId: "r-none", parent: null },
          { runId: "r-none-improvement-x", parent: "r-none" },
        ];
        const result = yield* ran("r-none", {});
        expect(said(result)).toStartWith("No Runs since ");
        expect(yield* launches()).toEqual([]);
      }),
    ),
  60_000,
);

test(
  "a checkout whose vendored skill is changed or missing fails, naming it, before any agent or issue",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${rig.projectDir}/.collie/skills/retro/SKILL.md`, "changed\n");
        const changed = yield* ran("r-changed", {});
        expect(reasonOf(changed)).toContain(".collie/skills/retro/SKILL.md");
        yield* fs.remove(`${rig.projectDir}/.collie/skills/LICENSE`);
        yield* fs.writeFileString(
          `${rig.projectDir}/.collie/skills/retro/SKILL.md`,
          yield* read(`${ROOT}.collie/skills/retro/SKILL.md`),
        );
        const missing = yield* ran("r-missing", {});
        expect(reasonOf(missing)).toContain(".collie/skills/LICENSE is missing");
        expect(yield* launches()).toEqual([]);
        expect([filed, commented]).toEqual([[], []]);
      }),
    ),
  60_000,
);

test(
  "a day's findings are filed or commented, all-new Improvements start, and the summary says so",
  () =>
    runEffect(
      Effect.gen(function* () {
        open = [
          { number: 7, title: "Reads are slow", body: "Slow.", url: "https://x/issues/7" },
          {
            number: 8,
            title: "Checks unwired",
            body: `Unwired.\n\n${markerOf("unwired-checks")}`,
            url: "https://x/issues/8",
          },
        ];
        refusing = new Set(["Collie refused-text"]);
        failing = new Set(["improvement-second"]);
        yield* rig.queueOutputs([
          triage(
            [
              finding({ key: "host-crash", body: `Leaked ${LEAKED} in its log.` }),
              finding({ key: "once", category: "navigation" }),
              finding({ key: "costly-reads", category: "tool-economy", runs: ["r-a", "r-b"] }),
              finding({ key: "slow-reads", category: "navigation", issue: 7 }),
              finding({ key: "unwired-checks", category: "automated-checks" }),
              finding({ key: "refused-text" }),
              finding({ key: "third", severity: "low" }),
            ],
            [
              { name: "first", keys: ["host-crash"], why: "one crash" },
              { name: "with-open", keys: ["third", "slow-reads"], why: "related" },
              { name: "second", keys: ["costly-reads"], why: "one read" },
              { name: "beyond", keys: ["third"], why: "over the bound" },
            ],
          ),
        ]);

        const result = yield* ran("r-day", { improvements: 2 });

        expect(said(result)).toContain("Filed 3, commented 2, refused 1; 2 Improvements, 1 failed");
        const prompt = yield* read(`${dir}/agents/r-day/triage.prompt.md`);
        expect(prompt).toContain(`${rig.projectDir}/.collie/skills/retro/SKILL.md`);
        expect(prompt).toContain(`${rig.projectDir}/.collie/skills/writing-for-agents/SKILL.md`);
        expect(prompt).toContain("this page wins");
        expect(prompt).not.toMatch(/\.(claude|agents|codex)\/skills/);
        expect(yield* read(`${dir}/agents/r-day/triage.persona.md`)).toContain("retrospective");

        expect(filed.map(({ title }) => title)).toEqual([
          "Collie host-crash",
          "Collie costly-reads",
          "Collie third",
        ]);
        expect(filed[0]?.body).toEndWith(
          `${markerOf("host-crash")}\n\nFiled by Collie's self-improve Run r-day on ${hostname()}.`,
        );
        expect(commented.map(({ number }) => number)).toEqual([7, 8]);
        expect(commented[0]?.body).toStartWith("Seen again in r-a ");

        expect(
          started.map(({ invocation, workflow, ownTask }) => [invocation, workflow, ownTask]),
        ).toEqual([
          ["improvement-first", "plan", true],
          ["improvement-second", "plan", true],
        ]);
        expect(started[0]?.input.then).toBe("implement");
        expect(started[0]?.input.goal).toContain("`Closes #101`");
        expect(started[0]?.input.goal).toContain("Leaked <github token> in its log.");
        expect(encode(started)).not.toContain(LEAKED);
        expect(started[1]?.input.goal).toContain("`Closes #102`");

        const summary = yield* read(`${runDir(dir, "r-day")}/summary.md`);
        expect(summary.indexOf("### defect")).toBeLessThan(summary.indexOf("### tool-economy"));
        expect(summary).toContain("refused, it names another checkout");
        expect(summary).toContain("commented #7");
        expect(summary).toContain("r-day-improvement-second, failed: improvement-second parked");
        expect(summary).toContain("Collie once: seen once");
        expect(summary).toContain("a project's own code");

        yield* ran("r-day", { improvements: 2 });
        expect([filed.length, commented.length, started.length]).toEqual([3, 2, 2]);
      }),
    ),
  120_000,
);

test(
  "an Improvement whose issues cannot be read back fails to start, and the day still ends with its summary",
  () =>
    runEffect(
      Effect.gen(function* () {
        unlisted = true;
        yield* rig.queueOutputs([
          triage(
            [finding({ key: "host-crash" })],
            [{ name: "first", keys: ["host-crash"], why: "one crash" }],
          ),
        ]);
        const result = yield* ran("r-unlisted", { improvements: 1 });
        expect(said(result)).toContain("Filed 1, commented 0, refused 0; 1 Improvements, 1 failed");
        expect(started).toEqual([]);
        expect(yield* read(`${runDir(dir, "r-unlisted")}/summary.md`)).toContain(
          "the forge did not answer",
        );
      }),
    ),
  120_000,
);

test(
  "a triage Output with an unknown category, or more than ten findings, gets its one repair",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([
          { ...triage([]), findings: [{ ...finding({ key: "odd" }), category: "vibes" }] },
          triage([finding({ key: "fixed" })]),
          triage(Array.from({ length: 11 }, (_, at) => finding({ key: `many-${at}` }))),
          triage([finding({ key: "fewer" })]),
        ]);
        expect(said(yield* ran("r-odd", { improvements: 0 }))).toContain("Filed 1");
        expect(said(yield* ran("r-many", { improvements: 0 }))).toContain("Filed 1");
        expect(filed.map(({ title }) => title)).toEqual(["Collie fixed", "Collie fewer"]);
        expect((yield* launches()).length).toBe(4);
        expect(started).toEqual([]);
      }),
    ),
  120_000,
);
