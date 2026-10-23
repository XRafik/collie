// What the Flock chat's harness, model and effort run as, and what its selects show.

import { expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { retelling, tableOffer } from "../desktop/src/bun/chat-choices";
import {
  type ChatChoices,
  chatSelects,
  type Offered,
  refusalSaid,
  runsAs,
  typedEntry,
} from "../desktop/src/shared/chat-choices";
import { NO_FLOCK_SETTINGS, takeFrom } from "../desktop/src/shared/flock-settings";

const CLAUDE: ReadonlyArray<Offered> = [
  {
    id: "opus",
    label: "Opus 5.5",
    description: "For complex work and everyday tasks",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    unsetEffort: "medium",
  },
  { id: "sonnet", label: "Sonnet 5.5", efforts: ["low", "medium", "high"], unsetEffort: "medium" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", efforts: [], unsetEffort: null },
];

test("Claude Code runs an unset model as opus, an unset effort at medium, and a model that lists no effort with none", () => {
  expect(runsAs({ harness: "claude" }, CLAUDE, {})).toEqual({
    harness: "claude",
    model: "opus",
    effort: "medium",
  });
  expect(runsAs({ harness: "claude", model: "sonnet", effort: "high" }, CLAUDE, {})).toEqual({
    harness: "claude",
    model: "sonnet",
    effort: "high",
  });
  expect(runsAs({ harness: "claude", model: "claude-haiku-4-5" }, CLAUDE, {})).toEqual({
    harness: "claude",
    model: "claude-haiku-4-5",
    effort: null,
  });
  expect(runsAs({ harness: "claude", model: "claude-opus-5" }, CLAUDE, {})).toEqual({
    harness: "claude",
    model: "claude-opus-5",
    effort: "medium",
  });
});

test("Pi runs an unset model as its configured default, else its own, and an unset effort at the model's configured level, else its default level, else medium", () => {
  const configured = {
    defaultProvider: "openai-codex",
    defaultModel: "gpt-6.1-sol",
    defaultThinkingLevel: "low",
    modelThinkingLevels: { "openai-codex/gpt-5.5": "xhigh", "openai-codex/gpt-6.1-sol": "high" },
  };
  expect(runsAs({ harness: "pi" }, [], configured)).toEqual({
    harness: "pi",
    model: "openai-codex/gpt-6.1-sol",
    effort: "high",
  });
  expect(runsAs({ harness: "pi", model: "openai-codex/gpt-5.5" }, [], configured)).toEqual({
    harness: "pi",
    model: "openai-codex/gpt-5.5",
    effort: "xhigh",
  });
  expect(runsAs({ harness: "pi", model: "openai-codex/gpt-6-astra" }, [], configured)).toEqual({
    harness: "pi",
    model: "openai-codex/gpt-6-astra",
    effort: "low",
  });
  expect(
    runsAs({ harness: "pi", model: "openai-codex/gpt-5.5", effort: "minimal" }, [], configured),
  ).toEqual({ harness: "pi", model: "openai-codex/gpt-5.5", effort: "minimal" });
  expect(runsAs({ harness: "pi" }, [], {})).toEqual({
    harness: "pi",
    model: "default",
    effort: "medium",
  });
  const none: ReadonlyArray<Offered> = [
    { id: "openai-codex/gpt-6.1-sol", label: "Sol", efforts: [], unsetEffort: null },
  ];
  expect(runsAs({ harness: "pi" }, none, configured)).toEqual({
    harness: "pi",
    model: "openai-codex/gpt-6.1-sol",
    effort: null,
  });
});

const extra = (models: ReadonlyArray<string>, hour: number) =>
  takeFrom(NO_FLOCK_SETTINGS, "vm-a", [
    {
      key: "models.claude",
      value: [...models],
      at: `2026-10-07T${String(hour).padStart(2, "0")}:00:00.000Z`,
    },
  ]).flock;

test("a harness's list from the table holds its models, the Flock's extras and the set model, labelled by id with the table's efforts, and not what the check refuses", () => {
  const offer = tableOffer(
    "claude",
    { proactive: true, chatModel: "claude-opus-5" },
    extra(["proxy-large"], 9),
    {},
  );
  expect(offer.unset).toEqual({ harness: "claude", model: "opus", effort: "medium" });
  expect(offer.models.map(({ id }) => id)).toEqual([
    "fable",
    "opus",
    "sonnet",
    "haiku",
    "opusplan",
    "proxy-large",
    "claude-opus-5",
  ]);
  expect(offer.models[1]).toEqual({
    id: "opus",
    label: "opus",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    unsetEffort: "medium",
  });
  expect(
    tableOffer(
      "claude",
      { proactive: true, chatModel: "gpt-6.1-sol" },
      NO_FLOCK_SETTINGS,
      {},
    ).models.map(({ id }) => id),
  ).not.toContain("gpt-6.1-sol");
  expect(
    tableOffer(
      "pi",
      { proactive: true, chatHarness: "pi", chatModel: "openai-codex/gpt-5.5" },
      NO_FLOCK_SETTINGS,
      {
        defaultProvider: "openai-codex",
        defaultModel: "gpt-6.1-sol",
        modelThinkingLevels: { "openai-codex/gpt-5.5": "high" },
      },
    ),
  ).toEqual({
    from: "table",
    unset: { harness: "pi", model: "openai-codex/gpt-6.1-sol", effort: "medium" },
    models: [
      {
        id: "openai-codex/gpt-5.5",
        label: "openai-codex/gpt-5.5",
        efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        unsetEffort: "high",
      },
    ],
  });
  expect(
    tableOffer("pi", { proactive: true, chatModel: "sonnet" }, NO_FLOCK_SETTINGS, {}).models,
  ).toEqual([]);
});

test("the account is retold for each saved settings change and each change of the Flock's models, and nothing else", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const told = yield* retelling(
        Stream.make({ proactive: true }, { proactive: false }),
        Stream.make(
          NO_FLOCK_SETTINGS,
          takeFrom(NO_FLOCK_SETTINGS, "vm-a", [
            { key: "scope", value: "all", at: "2026-10-07T09:00:00.000Z" },
          ]).flock,
          extra(["proxy-large"], 10),
          extra(["proxy-large"], 11),
        ),
      ).pipe(Stream.runCollect);
      expect(told).toHaveLength(2);
    }),
  ));

const ACCOUNT: ChatChoices = {
  heldOn: "claude",
  runsOn: null,
  turning: false,
  harnesses: [
    {
      harness: "claude",
      label: "Claude Code",
      installed: true,
      offered: {
        from: "table",
        unset: { harness: "claude", model: "opus", effort: "medium" },
        models: CLAUDE,
      },
    },
    {
      harness: "pi",
      label: "Pi",
      installed: false,
      offered: {
        from: "table",
        unset: { harness: "pi", model: "openai-codex/gpt-6.1-sol", effort: "low" },
        models: [
          {
            id: "openai-codex/gpt-5.5",
            label: "openai-codex/gpt-5.5",
            efforts: ["low", "medium", "high", "xhigh"],
            unsetEffort: "xhigh",
          },
        ],
      },
    },
  ],
};

test("the harness select names each harness, and one not installed is disabled, saying so", () => {
  const { harness } = chatSelects({ proactive: true }, ACCOUNT);
  expect(harness).toMatchObject({
    value: "claude",
    label: "Claude Code",
    note: "Another harness starts a new conversation with your next message.",
    disabled: false,
  });
  expect(harness.options).toEqual([
    { value: "claude", label: "Claude Code" },
    { value: "pi", label: "Pi", description: "Not installed on this computer", disabled: true },
  ]);
});

test("the model select starts with the default named by what it runs as, then the offered models, and shows a set model nobody offers", () => {
  const { model } = chatSelects({ proactive: true }, ACCOUNT);
  expect(model.options).toEqual([
    { value: "", label: "Default · Opus 5.5", description: "What the chat runs with no model set" },
    { value: "opus", label: "Opus 5.5", description: "For complex work and everyday tasks" },
    { value: "sonnet", label: "Sonnet 5.5" },
    { value: "claude-haiku-4-5", label: "Haiku 4.5" },
  ]);
  expect(model).toMatchObject({ value: "", label: "Default · Opus 5.5" });
  const typed = chatSelects({ proactive: true, chatModel: "claude-opus-5" }, ACCOUNT).model;
  expect(typed).toMatchObject({ value: "claude-opus-5", label: "claude-opus-5" });
  expect(typed.options.at(-1)).toEqual({ value: "claude-opus-5", label: "claude-opus-5" });
  expect(chatSelects({ proactive: true, chatHarness: "pi" }, ACCOUNT).model.options[0]!.label).toBe(
    "Default · openai-codex/gpt-6.1-sol",
  );
});

test("the effort select starts with the level an unset effort runs at, then follows the set model's levels", () => {
  const sonnet = chatSelects({ proactive: true, chatModel: "sonnet", chatEffort: "high" }, ACCOUNT);
  expect(sonnet.effort.options).toEqual([
    { value: "", label: "Default · Medium", description: "What the chat runs with no effort set" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ]);
  expect(sonnet.effort).toMatchObject({
    value: "high",
    label: "High",
    note: "The levels Sonnet 5.5 takes",
    disabled: false,
  });
  expect(
    chatSelects({ proactive: true }, ACCOUNT).effort.options.map(({ label }) => label),
  ).toEqual(["Default · Medium", "Low", "Medium", "High", "Extra high", "Max"]);
  const onPi = (chatModel?: string) =>
    chatSelects(
      { proactive: true, chatHarness: "pi", ...(chatModel !== undefined && { chatModel }) },
      ACCOUNT,
    ).effort.options[0]!.label;
  expect(onPi("openai-codex/gpt-5.5")).toBe("Default · Extra high");
  expect(onPi()).toBe("Default · Low");
});

test("a model that lists no effort disables the effort select, which reads that the model takes none", () => {
  expect(chatSelects({ proactive: true, chatModel: "claude-haiku-4-5" }, ACCOUNT).effort).toEqual({
    value: "",
    label: "Haiku 4.5 takes no effort",
    name: "Effort: none. Haiku 4.5 takes no effort",
    options: [],
    note: null,
    disabled: true,
  });
});

test("the accepted default model id uses the resolved model's effort choices", () => {
  const selects = chatSelects({ proactive: true, chatModel: "default" }, ACCOUNT);
  expect(selects.effort.note).toBe("The levels Opus 5.5 takes");
  const pi = chatSelects({ proactive: true, chatHarness: "pi", chatModel: "default" }, ACCOUNT);
  expect(pi.effort.note).toBe("The levels openai-codex/gpt-6.1-sol takes");
  expect(pi.effort.options[0]?.label).toBe("Default · Low");
});

test("a typed model keeps the table's effort choices when the default model takes none", () => {
  const choices: ChatChoices = {
    ...ACCOUNT,
    harnesses: [
      {
        ...ACCOUNT.harnesses[0]!,
        offered: {
          from: "table",
          unset: { harness: "claude", model: "claude-haiku-4-5", effort: null },
          models: CLAUDE,
        },
      },
    ],
  };
  const { effort } = chatSelects({ proactive: true, chatModel: "claude-opus-5" }, choices);
  expect(effort.disabled).toBe(false);
  expect(effort.options.map(({ value }) => value)).toEqual([
    "",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  expect(effort.label).toBe("Default · Medium");
});

test("each select's accessible name carries its value", () => {
  const selects = chatSelects({ proactive: true, chatModel: "sonnet" }, ACCOUNT);
  expect([selects.harness.name, selects.model.name, selects.effort.name]).toEqual([
    "Harness: Claude Code",
    "Model: Sonnet 5.5",
    "Effort: Default · Medium",
  ]);
});

test("a typed id that is no option is offered to save as Use <id>", () => {
  const { model } = chatSelects({ proactive: true }, ACCOUNT);
  expect(typedEntry("  claude-opus-5 ", model)).toEqual({
    value: "claude-opus-5",
    label: "Use claude-opus-5",
  });
  expect(typedEntry("sonnet", model)).toBeNull();
  expect(typedEntry(" ", model)).toBeNull();
});

test("a refused choice says nothing was saved after its reason", () => {
  expect(refusalSaid('"gpt-6.1-sol" is not a model claude takes (default, opus)')).toBe(
    '"gpt-6.1-sol" is not a model claude takes (default, opus). Nothing was saved.',
  );
  expect(refusalSaid("Write provider/model, for example openai-codex/gpt-6.1-sol.")).toBe(
    "Write provider/model, for example openai-codex/gpt-6.1-sol. Nothing was saved.",
  );
});

test("before the account arrives, each select shows what is set", () => {
  const selects = chatSelects({ proactive: true, chatHarness: "pi", chatEffort: "high" }, null);
  expect([selects.harness.label, selects.model.label, selects.effort.label]).toEqual([
    "Pi",
    "Default",
    "High",
  ]);
});
