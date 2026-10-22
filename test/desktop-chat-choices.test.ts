// What the Flock chat runs on with nothing set, the account every chat window is pushed, and
// what the harness, model and effort selects beside the message box show of it.

import { expect, test } from "bun:test";
import { Effect, Stream, SubscriptionRef } from "effect";
import { chatChoicesOf, chatChoicesStream } from "../desktop/src/bun/chat-choices";
import {
  type ChatChoices,
  type ChatHeld,
  chatSelects,
  chosen,
  type Offered,
  refusedChoice,
  resolveChat,
  tableOffer,
  typedModel,
} from "../desktop/src/shared/chat-choices";
import type { DesktopSettings } from "../desktop/src/shared/flock";
import {
  type FlockSettings,
  NO_FLOCK_SETTINGS,
  takeFrom,
} from "../desktop/src/shared/flock-settings";

const LEVELS = ["low", "medium", "high", "xhigh", "max"];
const offered = (id: string, efforts: ReadonlyArray<string> = LEVELS): Offered => ({
  id,
  label: id,
  efforts,
  unsetEffort: efforts.length === 0 ? null : "medium",
});

test("unset on Claude Code, the chat runs opus at medium, and a model that lists no effort runs at none", () => {
  const models = [offered("opus"), offered("sonnet"), offered("claude-haiku-4-5", [])];
  expect(resolveChat({ harness: "claude" }, models, {})).toEqual({
    harness: "claude",
    model: "opus",
    effort: "medium",
  });
  expect(resolveChat({ harness: "claude", model: "sonnet" }, models, {})).toEqual({
    harness: "claude",
    model: "sonnet",
    effort: "medium",
  });
  expect(resolveChat({ harness: "claude", model: "sonnet", effort: "max" }, models, {})).toEqual({
    harness: "claude",
    model: "sonnet",
    effort: "max",
  });
  expect(resolveChat({ harness: "claude", model: "claude-haiku-4-5" }, models, {})).toEqual({
    harness: "claude",
    model: "claude-haiku-4-5",
    effort: null,
  });
  // A typed model off the list takes the table's efforts.
  expect(resolveChat({ harness: "claude", model: "claude-opus-5" }, models, {})).toEqual({
    harness: "claude",
    model: "claude-opus-5",
    effort: "medium",
  });
});

test("unset on Pi, the chat runs Pi's configured model at its configured level for each model", () => {
  const pi = {
    defaultProvider: "openai-codex",
    defaultModel: "gpt-6.1-sol",
    defaultThinkingLevel: "high",
    modelThinkingLevels: { "openai-codex/gpt-5.5": "low" },
  };
  const models = [offered("openai-codex/gpt-5.5"), offered("openai-codex/gpt-6-astra")];
  expect(resolveChat({ harness: "pi" }, models, pi)).toEqual({
    harness: "pi",
    model: "openai-codex/gpt-6.1-sol",
    effort: "high",
  });
  expect(resolveChat({ harness: "pi", model: "openai-codex/gpt-5.5" }, models, pi)).toEqual({
    harness: "pi",
    model: "openai-codex/gpt-5.5",
    effort: "low",
  });
  expect(resolveChat({ harness: "pi", model: "openai-codex/gpt-6-astra" }, models, pi)).toEqual({
    harness: "pi",
    model: "openai-codex/gpt-6-astra",
    effort: "high",
  });
  expect(
    resolveChat({ harness: "pi", model: "openai-codex/gpt-6-astra" }, models, {
      modelThinkingLevels: {},
    }),
  ).toEqual({ harness: "pi", model: "openai-codex/gpt-6-astra", effort: "medium" });
  // With none configured it is Pi's own default, which the driver is given no --model for.
  expect(resolveChat({ harness: "pi" }, models, { defaultThinkingLevel: "xhigh" })).toEqual({
    harness: "pi",
    model: "default",
    effort: "xhigh",
  });
  expect(
    resolveChat(
      { harness: "pi", model: "openai-codex/gpt-6-astra" },
      [offered("openai-codex/gpt-6-astra", [])],
      pi,
    ),
  ).toEqual({ harness: "pi", model: "openai-codex/gpt-6-astra", effort: null });
});

const extras = (harness: string, models: ReadonlyArray<string>): FlockSettings =>
  takeFrom(NO_FLOCK_SETTINGS, "vm-a", [
    { key: `models.${harness}`, value: [...models], at: "2026-10-22T00:00:00Z" },
  ]).flock;

test("a harness's list from Collie's table holds its models, the Flock's extras and the set model, each with the table's efforts, and nothing the check would refuse", () => {
  const claude = tableOffer("claude", "claude-opus-5", ["proxy-large"], {});
  expect(claude.from).toBe("table");
  expect(claude.models.map(({ id }) => id)).toEqual([
    "fable",
    "opus",
    "sonnet",
    "haiku",
    "opusplan",
    "proxy-large",
    "claude-opus-5",
  ]);
  expect(claude.models[1]).toEqual({
    id: "opus",
    label: "opus",
    efforts: LEVELS,
    unsetEffort: "medium",
  });
  expect(claude.unset).toEqual({ harness: "claude", model: "opus", effort: "medium" });

  const pi = tableOffer("pi", "gpt-5.5", ["openai-codex/gpt-6.1-sol"], {
    defaultProvider: "openai-codex",
    defaultModel: "gpt-6.1-sol",
    modelThinkingLevels: { "openai-codex/gpt-6.1-sol": "xhigh" },
  });
  // "gpt-5.5" names no provider, which the check refuses.
  expect(pi.models).toEqual([
    {
      id: "openai-codex/gpt-6.1-sol",
      label: "openai-codex/gpt-6.1-sol",
      efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      unsetEffort: "xhigh",
    },
  ]);
  expect(pi.unset).toEqual({ harness: "pi", model: "openai-codex/gpt-6.1-sol", effort: "xhigh" });
});

test("the account names each harness, whether it is installed, and what it offers, and the set model only on the set harness", () => {
  const held: ChatHeld = { heldOn: "claude", runsOn: null, turning: false };
  const choices = chatChoicesOf(
    held,
    { claude: true, pi: false },
    { proactive: true, chatHarness: "claude", chatModel: "claude-opus-5" },
    extras("pi", ["openai-codex/gpt-5.5"]),
    {},
  );
  expect(choices).toMatchObject({ heldOn: "claude", runsOn: null, turning: false });
  expect(
    choices.harnesses.map(({ harness, label, installed, offered }) => ({
      harness,
      label,
      installed,
      models: offered.models.map(({ id }) => id),
    })),
  ).toEqual([
    {
      harness: "claude",
      label: "Claude Code",
      installed: true,
      models: ["fable", "opus", "sonnet", "haiku", "opusplan", "claude-opus-5"],
    },
    { harness: "pi", label: "Pi", installed: false, models: ["openai-codex/gpt-5.5"] },
  ]);
});

test("the account is sent when subscribed, and again on every change to what the chat holds, to Settings and to the Flock's models", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const held = yield* SubscriptionRef.make<ChatHeld>({
        heldOn: "claude",
        runsOn: null,
        turning: false,
      });
      const settings = yield* SubscriptionRef.make<DesktopSettings>({ proactive: true });
      const flock = yield* SubscriptionRef.make(NO_FLOCK_SETTINGS);
      const sent: ChatChoices[] = [];
      yield* chatChoicesStream({
        held: SubscriptionRef.changes(held),
        settings: SubscriptionRef.changes(settings),
        flock: SubscriptionRef.changes(flock),
        installed: { claude: true, pi: true },
        pi: Effect.succeed({}),
      }).pipe(
        Stream.runForEach((choices) => Effect.sync(() => sent.push(choices))),
        Effect.forkChild,
      );
      /** Lets the stream catch up, then sees it sent `count` accounts so far. */
      const told = (count: number) =>
        Effect.gen(function* () {
          for (let turn = 0; turn < 1000 && sent.length < count + 1; turn++) yield* Effect.yieldNow;
          expect(sent).toHaveLength(count);
        });
      yield* told(1);
      yield* SubscriptionRef.set(held, { heldOn: "claude", runsOn: null, turning: true });
      yield* told(2);
      yield* SubscriptionRef.set(settings, { proactive: true, chatModel: "sonnet" });
      yield* told(3);
      // Another setting of the Flock's changes no harness's models.
      yield* SubscriptionRef.set(
        flock,
        takeFrom(NO_FLOCK_SETTINGS, "vm-a", [
          { key: "effort", value: "high", at: "2026-10-22T00:00:00Z" },
        ]).flock,
      );
      yield* told(3);
      yield* SubscriptionRef.set(flock, extras("pi", ["openai-codex/gpt-5.5"]));
      yield* told(4);
      yield* SubscriptionRef.set(held, {
        heldOn: "claude",
        runsOn: { harness: "claude", model: "sonnet", effort: "medium" },
        turning: false,
      });
      yield* told(5);
      const pi = (choices: ChatChoices) =>
        choices.harnesses
          .find(({ harness }) => harness === "pi")!
          .offered.models.map(({ id }) => id);
      expect(sent.map(({ turning }) => turning)).toEqual([false, true, true, true, false]);
      expect(sent.map(pi)).toEqual([
        [],
        [],
        [],
        ["openai-codex/gpt-5.5"],
        ["openai-codex/gpt-5.5"],
      ]);
      expect(sent[2]!.harnesses[0]!.offered.models.map(({ id }) => id)).toContain("sonnet");
      expect(sent[4]!.runsOn).toEqual({ harness: "claude", model: "sonnet", effort: "medium" });
    }).pipe(Effect.scoped),
  ));

/** The account as the table offers it, with both harnesses installed unless said otherwise. */
const account = (
  settings: DesktopSettings,
  installed: Readonly<Record<string, boolean>> = { claude: true, pi: true },
) =>
  chatChoicesOf(
    { heldOn: "claude", runsOn: null, turning: false },
    installed,
    settings,
    NO_FLOCK_SETTINGS,
    {},
  );

test("the harness select names each harness, and one not installed is disabled saying so", () => {
  const settings = { proactive: true };
  const { harness } = chatSelects(settings, account(settings, { claude: true, pi: false }));
  expect(harness.label).toBe("Claude Code");
  expect(harness.name).toBe("Harness: Claude Code");
  expect(harness.options).toEqual([
    { value: "claude", label: "Claude Code" },
    { value: "pi", label: "Pi", disabled: "not installed on this computer" },
  ]);
  expect(harness.note).toBe("Another harness starts a new conversation with your next message.");
});

test("the model select starts with the default, named by what it runs as, then the offered models, and shows the set model even when it is not offered", () => {
  const unset = { proactive: true };
  const { model } = chatSelects(unset, account(unset));
  expect(model.options[0]).toEqual({
    value: "default",
    label: "Default · opus",
    description: "What the chat runs with no model set",
  });
  expect(model.options.slice(1).map(({ value }) => value)).toEqual([
    "fable",
    "opus",
    "sonnet",
    "haiku",
    "opusplan",
  ]);
  expect(model.label).toBe("Default · opus");
  expect(model.name).toBe("Model: Default · opus");

  const pi = { proactive: true, chatHarness: "pi" };
  expect(chatSelects(pi, account(pi)).model.options[0]!.label).toBe("Default · Pi's own default");

  const sonnet = { proactive: true, chatModel: "sonnet" };
  const described: ChatChoices = {
    ...account(sonnet),
    harnesses: [
      {
        harness: "claude",
        label: "Claude Code",
        installed: true,
        offered: {
          from: "table",
          unset: { harness: "claude", model: "opus", effort: "medium" },
          models: [{ ...offered("opus"), label: "Opus 5.5", description: "For the hardest work" }],
        },
      },
    ],
  };
  const shown = chatSelects(sonnet, described).model;
  expect(shown.options).toEqual([
    {
      value: "default",
      label: "Default · Opus 5.5",
      description: "What the chat runs with no model set",
    },
    { value: "opus", label: "Opus 5.5", description: "For the hardest work" },
    { value: "sonnet", label: "sonnet" },
  ]);
  expect(shown.name).toBe("Model: sonnet");
  expect(typedModel("openai-codex/gpt-5.5")).toBe("Use openai-codex/gpt-5.5");
});

test("the effort select starts with the default level, then the levels the set model takes", () => {
  const settings = { proactive: true, chatModel: "sonnet", chatEffort: "high" };
  const choices: ChatChoices = {
    ...account(settings),
    harnesses: [
      {
        harness: "claude",
        label: "Claude Code",
        installed: true,
        offered: {
          from: "table",
          unset: { harness: "claude", model: "opus", effort: "medium" },
          models: [
            offered("opus"),
            { ...offered("sonnet", ["low", "high"]), label: "Sonnet 5.5", unsetEffort: "low" },
          ],
        },
      },
    ],
  };
  const { effort } = chatSelects(settings, choices);
  expect(effort.options).toEqual([
    {
      value: "default",
      label: "Default · Low",
      description: "What the chat runs with no effort set",
    },
    { value: "low", label: "Low" },
    { value: "high", label: "High" },
  ]);
  expect(effort.label).toBe("High");
  expect(effort.name).toBe("Effort: High");
  expect(effort.disabled).toBeNull();
  expect(effort.note).toBe("The levels Sonnet 5.5 takes");

  const unset = { proactive: true };
  const opus = chatSelects(unset, account(unset)).effort;
  expect(opus.options.map(({ label }) => label)).toEqual([
    "Default · Medium",
    "Low",
    "Medium",
    "High",
    "Extra high",
    "Max",
  ]);
  expect(opus.name).toBe("Effort: Default · Medium");
  expect(opus.note).toBe("The levels opus takes");
});

test("for a model that lists no effort, the effort select is disabled and says the model takes none", () => {
  const settings = { proactive: true, chatModel: "claude-haiku-4-5" };
  const choices: ChatChoices = {
    ...account(settings),
    harnesses: [
      {
        harness: "claude",
        label: "Claude Code",
        installed: true,
        offered: {
          from: "table",
          unset: { harness: "claude", model: "opus", effort: "medium" },
          models: [{ ...offered("claude-haiku-4-5", []), label: "Haiku 4.5" }],
        },
      },
    ],
  };
  const { effort } = chatSelects(settings, choices);
  expect(effort.disabled).toBe("Haiku 4.5 takes no effort");
  expect(effort.label).toBe("Haiku 4.5 takes no effort");
  expect(effort.name).toBe("Effort: none. Haiku 4.5 takes no effort");
  expect(effort.options).toEqual([]);
});

test("choosing a select's default unsets it, and any other entry sets it", () => {
  expect(chosen("model", "default")).toEqual({ chatModel: "" });
  expect(chosen("effort", "default")).toEqual({ chatEffort: "" });
  expect(chosen("model", "sonnet")).toEqual({ chatModel: "sonnet" });
  expect(chosen("effort", "high")).toEqual({ chatEffort: "high" });
  expect(chosen("harness", "pi")).toEqual({ chatHarness: "pi" });
});

test("a refused choice is said with its reason, ending that nothing was saved", () => {
  expect(refusedChoice('"max" is not an effort sonnet takes (low, high)')).toBe(
    '"max" is not an effort sonnet takes (low, high). Nothing was saved.',
  );
  expect(
    refusedChoice(
      '"gpt-5.5" is not a model pi takes. Write provider/model, for example openai-codex/gpt-6.1-sol.',
    ),
  ).toBe(
    '"gpt-5.5" is not a model pi takes. Write provider/model, for example openai-codex/gpt-6.1-sol. Nothing was saved.',
  );
});
