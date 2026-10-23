// A Run drawn as the Steps it took, built from what it recorded and what its module
// declares (ADR-draft-a-step-is-declared-where-its-work-is-written D3–D6). Pure, so every
// door that reads a Flow reads one set of rules.

import { DateTime } from "effect";
import {
  ranOn,
  type FlowAttempt,
  type FlowLane,
  type FlowNode,
  type FlowQuestion,
  type FlowRun,
  type FlowState,
  type RequestedBy,
  type RunAgent,
} from "./board-model";
import type { Launched } from "./launches";
import type { RunState } from "./runs";
import type { StepLine, StepMeta, StepPlace } from "./steps";
import { clockTime, epochMs, minutes } from "./time";

export type Execution = FlowLane["execution"];

/** A question the Run asked, as the engine stored it. */
export interface AskedFact {
  readonly name: string;
  readonly asked: string | null;
  readonly answered: string | null;
  readonly by: string | null;
  readonly open: boolean;
}

/** Everything one Run's row is built from. */
export interface LaneFacts {
  readonly run: {
    readonly id: string;
    readonly workflow: string;
    readonly title: string;
    readonly state: RunState;
    readonly requestedBy: RequestedBy | null;
    readonly execution: Execution;
    /** Why it stopped going, where it failed. */
    readonly note: string | null;
  };
  readonly machine: string;
  readonly lines: ReadonlyArray<StepLine>;
  /** Its launches in order, each with whether its Output is in. */
  readonly launches: ReadonlyArray<{ readonly launch: Launched; readonly done: boolean }>;
  readonly questions: ReadonlyArray<AskedFact>;
  readonly children: ReadonlyArray<{
    readonly id: string;
    readonly workflow: string;
    readonly state: RunState;
    readonly created: string;
  }>;
  /** When a durable timer wakes it, where it sleeps on one. */
  readonly wakes: string | null;
  /** Who stopped it, where it was stopped. */
  readonly stoppedBy: string | null;
  readonly now: number;
}

/** One call of a Step, as its records say. */
interface StepRun {
  readonly key: string;
  readonly meta: StepMeta;
  readonly place: StepPlace | null;
  readonly entered: string;
  left: string | null;
  failed: { readonly at: string; readonly why: string } | null;
  attempts: FlowAttempt[];
}

const going = (state: RunState) => state === "running" || state === "waiting";

const ordinal = (n: number) => {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
};

const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const firstLine = (text: string) => text.split("\n")[0]?.trim() ?? "";

const agentOf = (launch: Launched): RunAgent => ({
  operation: launch.operation,
  agent: launch.agent,
  harness: launch.harness,
  model: launch.model ?? null,
  effort: launch.effort ?? null,
  from: launch.from ?? null,
  why: launch.why ?? null,
  at: launch.at === undefined ? null : isoOf(launch.at),
});

const AGENT_QUESTION = /^ask-(.+)-\d+$/;

/** The operation whose agent asked this question on its Run, where an agent did. */
const askerOf = (name: string) => AGENT_QUESTION.exec(name)?.[1] ?? null;

const placeSaid = (place: StepPlace | null) =>
  place === null ? null : "item" in place ? place.item : `Round ${place.round}`;

const flowQuestion = (one: AskedFact): FlowQuestion => ({
  name: one.name,
  asked: one.asked,
  answered: one.answered,
  by: one.by,
});

/** One Run's row of Steps. */
export function laneOf(facts: LaneFacts): FlowLane {
  const { run, now } = facts;
  const ended = !going(run.state);
  const forecasts: Array<{ readonly at: string; readonly steps: ReadonlyArray<StepMeta> }> = [];
  const runs = new Map<string, StepRun>();
  const entries: Array<{ readonly at: string; readonly cause: "restarted" | "resumed" }> = [];
  const questionIn = new Map<string, string>();
  const childIn = new Map<string, string>();
  for (const line of facts.lines) {
    switch (line.kind) {
      case "forecast":
        forecasts.push({ at: line.at, steps: line.steps });
        break;
      case "enter":
        if (!runs.has(line.key))
          runs.set(line.key, {
            key: line.key,
            meta: line.step,
            place: line.place,
            entered: line.at,
            left: null,
            failed: null,
            attempts: [{ at: line.at, cause: null }],
          });
        break;
      case "leave": {
        const one = runs.get(line.key);
        if (one !== undefined && one.left === null) one.left = line.at;
        break;
      }
      case "fail": {
        const one = runs.get(line.key);
        if (one !== undefined) one.failed = { at: line.at, why: line.why };
        break;
      }
      case "entry":
        if (line.cause !== null) entries.push({ at: line.at, cause: line.cause });
        break;
      case "question":
        questionIn.set(line.name, line.key);
        break;
      case "child":
        childIn.set(line.run, line.key);
        break;
      case "check":
        break;
    }
  }
  // An entry that went on with a Step run left part-done is another attempt at it.
  for (const one of runs.values())
    for (const entry of entries)
      if (entry.at > one.entered && (one.left === null || entry.at < one.left))
        one.attempts.push({ at: entry.at, cause: entry.cause });

  const declared = forecasts.length > 0 || runs.size > 0;
  const keyOfLaunch = new Map<string, string>();
  for (const { launch } of facts.launches)
    if (launch.step !== undefined) keyOfLaunch.set(launch.operation, launch.step.key);
  const questionKey = (name: string) => {
    const asker = askerOf(name);
    return questionIn.get(name) ?? (asker === null ? undefined : keyOfLaunch.get(asker));
  };

  const ranOnFor = (key: string) => {
    const last = facts.launches.findLast(({ launch }) => launch.step?.key === key);
    return last === undefined ? null : ranOn(agentOf(last.launch));
  };
  const questionsFor = (key: string) =>
    facts.questions.filter((one) => questionKey(one.name) === key);

  const stateOfRun = (one: StepRun): FlowState => {
    if (one.left !== null) return "done";
    const retried = one.attempts.at(-1)!.at;
    if (one.failed !== null && one.failed.at >= retried) return "failed";
    if (run.state === "stopped") return "stopped";
    if (run.state === "failed") return "failed";
    if (run.state === "succeeded") return "done";
    if (questionsFor(one.key).some((asked) => asked.open)) return "needs-you";
    if (facts.wakes !== null) return "waiting";
    return "running";
  };

  const factOf = (state: FlowState, one: StepRun, said: string | null): string | null => {
    switch (state) {
      case "done":
        return one.left === null ? "Done" : minutes(epochMs(one.left) - epochMs(one.entered));
      case "running":
        return said ?? minutes(now - epochMs(one.attempts.at(-1)!.at));
      case "needs-you": {
        const asked = questionsFor(one.key).find((question) => question.open)?.asked;
        return asked == null ? "Asked" : `Asked ${minutes(now - epochMs(asked))} ago`;
      }
      case "waiting":
        return facts.wakes === null ? null : `Wakes at ${clockTime(epochMs(facts.wakes))}`;
      case "failed":
        return firstLine(one.failed?.why ?? run.note ?? "") || "Failed";
      case "stopped":
        return facts.stoppedBy === null ? "Stopped" : `Stopped by ${facts.stoppedBy}`;
      case "not-run":
        return "Not run";
      case "expected":
        return null;
    }
  };

  const withAttempts = (said: string | null, attempts: number) =>
    said !== null && attempts > 1 ? `${said} · ${ordinal(attempts)} attempt` : said;

  const runNode = (one: StepRun, offPath: boolean): FlowRun => {
    const state = stateOfRun(one);
    return {
      id: one.key,
      title: placeSaid(one.place) ?? one.meta.title,
      kind: one.meta.kind,
      description: one.meta.description,
      role: one.meta.role,
      declared: true,
      state,
      said: withAttempts(factOf(state, one, null), one.attempts.length),
      wait: state === "waiting" ? "timer" : null,
      produces: one.meta.produces,
      offPath,
      place: placeSaid(one.place),
      started: one.entered,
      ended: one.left,
      attempts: one.attempts,
      ranOn: ranOnFor(one.key),
      questions: questionsFor(one.key).map(flowQuestion),
    };
  };

  /** A Step none of whose runs is known yet, or one the Run ended without. */
  const unreached = (meta: StepMeta, id: string, title: string, place: string | null): FlowRun => {
    const state: FlowState = ended ? "not-run" : "expected";
    return {
      id,
      title,
      kind: meta.kind,
      description: meta.description,
      role: meta.role,
      declared: true,
      state,
      said: state === "not-run" ? "Not run" : null,
      wait: null,
      produces: meta.produces,
      offPath: false,
      place,
      started: null,
      ended: null,
      attempts: [],
      ranOn: null,
      questions: [],
    };
  };

  /** Which forecast was in force at a time: the latest made before it. */
  const forecastAt = (at: string) => forecasts.findLast((one) => one.at <= at) ?? null;
  const latest = forecasts.at(-1) ?? null;

  const stepNode = (id: string): FlowNode => {
    const calls = [...runs.values()].filter((one) => one.meta.id === id);
    const meta = calls.at(-1)!.meta;
    const first = calls[0]!;
    const inForce = forecastAt(first.entered);
    const offPath = inForce !== null && !inForce.steps.some((one) => one.id === id);
    const items = calls.findLast((one) => one.place !== null && "item" in one.place)?.place;
    const listed = items !== undefined && items !== null && "items" in items ? items.items : [];
    const called = new Set(
      calls.map((one) => (one.place !== null && "item" in one.place ? one.place.item : "")),
    );
    const made = calls.map((one) => runNode(one, offPath));
    const toCome = listed
      .filter((item) => !called.has(item))
      .map((item) => unreached(meta, `${id}@${item}`, item, item));
    const all = listed.length === 0 ? made : sortedByItems(listed, [...made, ...toCome]);
    const states = made.map((one) => one.state);
    const state: FlowState = states.includes("needs-you")
      ? "needs-you"
      : states.includes("running")
        ? "running"
        : states.includes("waiting")
          ? "waiting"
          : states.includes("failed")
            ? "failed"
            : states.includes("stopped")
              ? "stopped"
              : toCome.length > 0 && !ended
                ? "running"
                : "done";
    const current = calls.findLast((one) => stateOfRun(one) === state) ?? calls.at(-1)!;
    const position =
      listed.length > 0 && current.place !== null && "item" in current.place
        ? `Slice ${listed.indexOf(current.place.item) + 1} of ${listed.length}`
        : current.place !== null && "round" in current.place
          ? `Round ${current.place.round}`
          : null;
    const plain = factOf(state, current, state === "running" ? position : null);
    const attempts = current.attempts;
    const said = withAttempts(
      calls.length > 1 && state === "done"
        ? minutes(epochMs(calls.at(-1)!.left ?? first.entered) - epochMs(first.entered))
        : plain,
      attempts.length,
    );
    return {
      id,
      title: meta.title,
      kind: meta.kind,
      description: meta.description,
      role: meta.role,
      declared: true,
      state,
      said: offPath && said !== null ? `Off the path · ${said}` : said,
      wait: state === "waiting" ? "timer" : null,
      produces: meta.produces,
      offPath,
      place: null,
      started: first.entered,
      ended: state === "done" ? (calls.at(-1)!.left ?? null) : null,
      attempts,
      ranOn: ranOnFor(current.key),
      questions: calls.flatMap((one) => questionsFor(one.key)).map(flowQuestion),
      runs: calls.length > 1 || listed.length > 0 ? all : [],
    };
  };

  // What happened, in the order it began: each Step by its first call, and work no Step
  // declared by when it was started.
  const happened: Array<{ readonly at: string; readonly node: FlowNode }> = [];
  const seen = new Set<string>();
  for (const one of runs.values()) {
    if (seen.has(one.meta.id)) continue;
    seen.add(one.meta.id);
    happened.push({ at: one.entered, node: stepNode(one.meta.id) });
  }
  for (const node of undeclaredNodes(facts, keyOfLaunch, questionKey, childIn, ended))
    happened.push(node);
  happened.sort((one, other) => one.at.localeCompare(other.at));
  const nodes = happened.map((one) => one.node);
  for (const meta of latest?.steps ?? [])
    if (!seen.has(meta.id)) nodes.push({ ...unreached(meta, meta.id, meta.title, null), runs: [] });

  return {
    run: run.id,
    workflow: run.workflow,
    title: run.title,
    machine: facts.machine,
    requestedBy: run.requestedBy,
    execution: run.execution,
    declared,
    nodes,
  };
}

const sortedByItems = (items: ReadonlyArray<string>, runs: ReadonlyArray<FlowRun>) =>
  [...runs].sort((one, other) => items.indexOf(one.place ?? "") - items.indexOf(other.place ?? ""));

/** Work no Step declared: Operations, questions and children, as they happened. */
function undeclaredNodes(
  facts: LaneFacts,
  keyOfLaunch: ReadonlyMap<string, string>,
  questionKey: (name: string) => string | undefined,
  childIn: ReadonlyMap<string, string>,
  ended: boolean,
): ReadonlyArray<{ readonly at: string; readonly node: FlowNode }> {
  const { run, now } = facts;
  const base = {
    description: "",
    role: null,
    declared: false,
    wait: null,
    produces: null,
    offPath: false,
    place: null,
    ended: null,
    attempts: [],
    runs: [],
  } as const;
  const nodes: Array<{ readonly at: string; readonly node: FlowNode }> = [];
  const operations = new Map<
    string,
    Array<{ readonly launch: Launched; readonly done: boolean }>
  >();
  for (const one of facts.launches) {
    if (one.launch.step !== undefined || keyOfLaunch.has(one.launch.operation)) continue;
    operations.set(one.launch.operation, [...(operations.get(one.launch.operation) ?? []), one]);
  }
  for (const [operation, launches] of operations) {
    const last = launches.at(-1)!;
    const at = launches[0]!.launch.at;
    const started = at === undefined ? null : isoOf(at);
    const asked = facts.questions.filter((one) => askerOf(one.name) === operation);
    const state: FlowState = last.done
      ? "done"
      : asked.some((one) => one.open)
        ? "needs-you"
        : run.state === "stopped"
          ? "stopped"
          : run.state === "failed"
            ? "failed"
            : ended
              ? "done"
              : "running";
    nodes.push({
      at: started ?? "",
      node: {
        ...base,
        id: operation,
        title: operation,
        kind: "agent",
        state,
        said: undeclaredSaid(state, started, asked, facts, now),
        started,
        ranOn: ranOn(agentOf(last.launch)),
        questions: asked.map(flowQuestion),
      },
    });
  }
  for (const one of facts.questions) {
    if (askerOf(one.name) !== null || questionKey(one.name) !== undefined) continue;
    const state: FlowState = one.open ? "needs-you" : "done";
    nodes.push({
      at: one.asked ?? "",
      node: {
        ...base,
        id: one.name,
        title: one.name,
        kind: "question",
        state,
        said: undeclaredSaid(state, one.asked, [one], facts, now),
        started: one.asked,
        ranOn: null,
        questions: [flowQuestion(one)],
      },
    });
  }
  for (const child of facts.children) {
    if (childIn.has(child.id)) continue;
    const state = childState(child.state);
    const invocation = child.id.startsWith(`${run.id}.`)
      ? child.id.slice(run.id.length + 1)
      : child.id;
    nodes.push({
      at: child.created,
      node: {
        ...base,
        id: child.id,
        title: invocation,
        kind: "workflow",
        state,
        said: undeclaredSaid(state, child.created, [], facts, now),
        started: child.created,
        ranOn: null,
        questions: [],
      },
    });
  }
  return nodes;
}

const childState = (state: RunState): FlowState => {
  switch (state) {
    case "succeeded":
      return "done";
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
  }
};

function undeclaredSaid(
  state: FlowState,
  started: string | null,
  asked: ReadonlyArray<AskedFact>,
  facts: LaneFacts,
  now: number,
): string | null {
  switch (state) {
    case "done":
      return "Done";
    case "running":
      return started === null ? null : minutes(now - epochMs(started));
    case "needs-you": {
      const open = asked.find((one) => one.open)?.asked;
      return open == null ? "Asked" : `Asked ${minutes(now - epochMs(open))} ago`;
    }
    case "failed":
      return firstLine(facts.run.note ?? "") || "Failed";
    case "stopped":
      return facts.stoppedBy === null ? "Stopped" : `Stopped by ${facts.stoppedBy}`;
    default:
      return null;
  }
}

/** Where the work is: the last node of a Run still going that is not done or to come. */
export function currentOf(lane: FlowLane): { readonly run: string; readonly node: string } | null {
  if (lane.execution !== "running" && lane.execution !== "suspended") return null;
  const at = lane.nodes.findLast(
    (node) => node.state === "running" || node.state === "needs-you" || node.state === "waiting",
  );
  return at === undefined ? null : { run: lane.run, node: at.id };
}
