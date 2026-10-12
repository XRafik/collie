// What a card's record decides about its Terminal tab.

import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  agentTabs,
  offersTerminal,
  shownAgent,
  opensHerdrWithoutPane,
  recipients,
  switches,
} from "../src/shared/record-terminal";

test("the Terminal tab is offered on a reached Machine and kept while shown after it drops", () => {
  expect(offersTerminal(null, undefined)).toBe(true);
  expect(offersTerminal(1_791_000_000_000, "terminal")).toBe(true);
  expect(offersTerminal(1_791_000_000_000, "log")).toBe(false);
});

test("only Go to pane falls back to herdr's own client where there is no pane", () => {
  expect(opensHerdrWithoutPane("terminal")).toBe(true);
  expect(opensHerdrWithoutPane("diff")).toBe(false);
});

const live = (name: string, role: string | undefined, status = "idle", run = "run-1") => {
  const agent = { name, status, now: `${name}'s title`, run };
  return role === undefined ? agent : { ...agent, role };
};

test.each([
  {
    case: "each agent is its role, and a shared role is numbered in the board's order",
    agents: [
      live("plan-1", "planner"),
      live("review-1", "reviewer", "working", "run-1.implement"),
      live("impl-1", "implementer", "blocked", "run-1.implement"),
      live("review-2", "reviewer", "done", "run-1.implement"),
    ],
    shown: null,
    entries: [
      ["plan-1", "run-1", "planner", "idle", false],
      ["review-1", "run-1.implement", "reviewer 1", "working", false],
      ["impl-1", "run-1.implement", "implementer", "blocked", false],
      ["review-2", "run-1.implement", "reviewer 2", "done", false],
    ],
  },
  {
    case: "an agent from an older host, with no role, is its herdr name",
    agents: [live("impl-1", undefined, "unknown"), live("impl-2", undefined)],
    shown: null,
    entries: [
      ["impl-1", "run-1", "impl-1", "unknown", false],
      ["impl-2", "run-1", "impl-2", "idle", false],
    ],
  },
  {
    case: "the agent the host focused is the one marked as shown",
    agents: [live("impl-1", "implementer", "working"), live("review-1", "reviewer")],
    shown: live("review-1", "reviewer"),
    entries: [
      ["impl-1", "run-1", "implementer", "working", false],
      ["review-1", "run-1", "reviewer", "idle", true],
    ],
  },
  {
    case: "the agent shown stays listed, ended, once the board no longer has it",
    agents: [live("impl-1", "implementer", "working"), live("review-1", "reviewer")],
    shown: live("review-2", "reviewer", "working"),
    entries: [
      ["impl-1", "run-1", "implementer", "working", false],
      ["review-1", "run-1", "reviewer 1", "idle", false],
      ["review-2", "run-1", "reviewer 2", "ended", true],
    ],
  },
])("$case", ({ agents, shown, entries }) => {
  expect(
    agentTabs(agents, shown).map((one) => [one.name, one.run, one.label, one.state, one.shown]),
  ).toEqual(entries.map((entry) => [...entry]));
});

test("the agent shown is the board's entry for it, kept once it leaves, and none before it arrives", () => {
  const review = live("review-1", "reviewer", "working");
  const later = { ...review, status: "idle" };
  expect(shownAgent([review], "review-1", null)).toEqual(review);
  expect(shownAgent([later], "review-1", review)).toEqual(later);
  expect(shownAgent([], "review-1", later)).toEqual(later);
  expect(shownAgent([], "review-1", null)).toBeNull();
  expect(shownAgent([review], undefined, review)).toBeNull();
});

const switching = (log: string[]) =>
  switches(() => {
    log.push("let go");
    return Effect.runPromise(Effect.sleep("1 millis"));
  });

test("a switch opens only after the pane shown is let go, and only the newest of those waiting", () => {
  const log: string[] = [];
  const tab = switching(log);
  return Effect.runPromise(
    Effect.promise(() =>
      Promise.all([tab.to(() => log.push("review-1")), tab.to(() => log.push("impl-1"))]),
    ).pipe(Effect.map(() => expect(log).toEqual(["let go", "let go", "impl-1"]))),
  );
});

test("a switch still waiting when the tab closes never opens", () => {
  const log: string[] = [];
  const tab = switching(log);
  return Effect.runPromise(
    Effect.promise(() => Promise.all([tab.to(() => log.push("review-1")), tab.stop()])).pipe(
      Effect.map(() => expect(log).toEqual(["let go", "let go"])),
    ),
  );
});

const launched = (...agents: string[]) => agents.map((agent) => ({ agent }));

test.each([
  {
    case: "the Run's agents herdr still has, in launch order, newest last",
    launches: launched("plan-1", "review-1", "plan-2"),
    live: [live("plan-1", "planner"), live("plan-2", "planner"), live("other-1", "reviewer")],
    offered: [
      ["plan-1", "planner 1"],
      ["plan-2", "planner 2"],
    ],
  },
  {
    case: "an agent the board lists under another of the Task's Runs is still this Run's",
    launches: launched("plan-1"),
    live: [live("plan-1", "planner", "idle", "run-1.implement")],
    offered: [["plan-1", "planner"]],
  },
  {
    case: "an agent launched again counts at its newest launch",
    launches: launched("plan-1", "review-1", "plan-1"),
    live: [live("plan-1", "planner"), live("review-1", "reviewer")],
    offered: [
      ["review-1", "reviewer"],
      ["plan-1", "planner"],
    ],
  },
  {
    case: "a live agent of the Task the Run never launched is not offered",
    launches: launched("plan-1"),
    live: [live("impl-1", "implementer")],
    offered: [],
  },
  {
    case: "a Run whose details name no agents has none",
    launches: undefined,
    live: [live("impl-1", "implementer")],
    offered: [],
  },
])("$case", ({ launches, live: agents, offered }) => {
  expect(recipients(launches, agents).map((one) => [one.name, one.label])).toEqual(
    offered.map((entry) => [...entry]),
  );
});
