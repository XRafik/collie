// What the Flock chat runs on with nothing set, what every chat window is told of it, and what
// the harness, model and effort selects beside the message box show. No Bun-only import: the
// view bundles this.

import { Schema } from "effect";
import { DEFAULT_MODEL, HARNESS_MODELS, resolveChoice } from "../../../src/harness-choice";
import type { DesktopSettings, DesktopSettingsChange } from "./flock";
import { DEFAULT_CHAT_HARNESS, harnessLabel } from "./flock-settings";

/** What a session runs on: no effort where its model takes none. */
export const Resolved = Schema.Struct({
  harness: Schema.String,
  model: Schema.String,
  effort: Schema.NullOr(Schema.String),
});
export type Resolved = typeof Resolved.Type;

/** A model a harness offers, with the efforts it takes and the one it runs at with none set. */
export const Offered = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
  efforts: Schema.Array(Schema.String),
  unsetEffort: Schema.NullOr(Schema.String),
});
export type Offered = typeof Offered.Type;

/** What a harness offers, and what it runs on with no model or effort set. */
export const Offer = Schema.Struct({
  from: Schema.Literal("table"),
  unset: Resolved,
  models: Schema.Array(Offered),
});
export type Offer = typeof Offer.Type;

/** What the chat module knows: the harness its conversation is held on, its warm session and turn. */
export const ChatHeld = Schema.Struct({
  heldOn: Schema.String,
  /** What the warm session was opened on; null while none is warm. */
  runsOn: Schema.NullOr(Resolved),
  /** A turn is under way, the human's or Desktop's own. */
  turning: Schema.Boolean,
});
export type ChatHeld = typeof ChatHeld.Type;

/** What every chat window is told of what the chat holds, runs on and could run on. */
export const ChatChoices = Schema.Struct({
  ...ChatHeld.fields,
  harnesses: Schema.Array(
    Schema.Struct({
      harness: Schema.String,
      label: Schema.String,
      installed: Schema.Boolean,
      offered: Offer,
    }),
  ),
});
export type ChatChoices = typeof ChatChoices.Type;

/** What of Pi's own `settings.json` decides what it runs with nothing set. */
export const PiConfig = Schema.Struct({
  defaultProvider: Schema.optionalKey(Schema.String),
  defaultModel: Schema.optionalKey(Schema.String),
  defaultThinkingLevel: Schema.optionalKey(Schema.String),
  modelThinkingLevels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export type PiConfig = typeof PiConfig.Type;

/** The chat's harness, model and effort as set. */
export interface ChatSet {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
}

const tableEfforts = (harness: string) => HARNESS_MODELS[harness]?.efforts ?? [];

/** The efforts `model` takes: its own where it is offered, else the table's for its harness. */
export const effortsOf = (harness: string, model: string, models: ReadonlyArray<Offered>) =>
  models.find(({ id }) => id === model)?.efforts ?? tableEfforts(harness);

/**
 * What the chat runs on: the set model and effort, an unset model as the harness's default
 * (Pi's configured one, else its own) and an unset effort at medium (on Pi, its configured
 * level for that model), and no effort on a model that takes none.
 */
export const resolveChat = (
  set: ChatSet,
  models: ReadonlyArray<Offered>,
  pi: PiConfig,
): Resolved => {
  const { harness } = set;
  const onPi = harness === "pi";
  const model =
    set.model ??
    (onPi && pi.defaultProvider && pi.defaultModel
      ? `${pi.defaultProvider}/${pi.defaultModel}`
      : (HARNESS_MODELS[harness]?.defaultModel ?? DEFAULT_MODEL));
  if (effortsOf(harness, model, models).length === 0) return { harness, model, effort: null };
  const level = onPi ? (pi.modelThinkingLevels?.[model] ?? pi.defaultThinkingLevel) : undefined;
  return { harness, model, effort: set.effort ?? level ?? "medium" };
};

/**
 * What Collie's table offers on `harness`: its models, the Flock's extras and the set model,
 * each with the table's efforts and named by its id, but none the change check would refuse.
 */
export const tableOffer = (
  harness: string,
  setModel: string | undefined,
  extras: ReadonlyArray<string>,
  pi: PiConfig,
): Offer => {
  const ids = [
    ...new Set([
      ...(HARNESS_MODELS[harness]?.models ?? []),
      ...extras,
      ...(setModel === undefined ? [] : [setModel]),
    ]),
  ].filter(
    (id) =>
      id !== DEFAULT_MODEL && resolveChoice([{ harness, model: id }], { [harness]: extras }).ok,
  );
  const listed = ids.map((id) => ({
    id,
    label: id,
    efforts: tableEfforts(harness),
    unsetEffort: null,
  }));
  const models = listed.map((model) => ({
    ...model,
    unsetEffort: resolveChat({ harness, model: model.id }, listed, pi).effort,
  }));
  return { from: "table", unset: resolveChat({ harness }, models, pi), models };
};

/** What `set` runs as, by the account: each unset choice as its harness resolved it. */
export const runsAs = (set: ChatSet, choices: ChatChoices): Resolved => {
  const { harness } = set;
  const offer = choices.harnesses.find((one) => one.harness === harness)?.offered;
  const models = offer?.models ?? [];
  const model = set.model ?? offer?.unset.model ?? DEFAULT_MODEL;
  if (effortsOf(harness, model, models).length === 0) return { harness, model, effort: null };
  const level =
    set.model === undefined
      ? offer?.unset.effort
      : (models.find(({ id }) => id === model)?.unsetEffort ?? offer?.unset.effort);
  return { harness, model, effort: set.effort ?? level ?? null };
};

/** The value of a select's `Default · …` entry, which unsets it. */
export const DEFAULT_ENTRY = "default";

export interface ChoiceOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  /** Why it cannot be chosen. */
  readonly disabled?: string;
}

export interface ChoiceSelect {
  readonly value: string;
  /** What its trigger reads. */
  readonly label: string;
  /** Its accessible name, carrying its value. */
  readonly name: string;
  readonly options: ReadonlyArray<ChoiceOption>;
  /** The menu's last line. */
  readonly note: string | null;
  /** Why it cannot be opened. */
  readonly disabled: string | null;
}

const EFFORT_LABELS = new Map([
  ["off", "Off"],
  ["minimal", "Minimal"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
  ["max", "Max"],
]);
const effortLabel = (effort: string) => EFFORT_LABELS.get(effort) ?? effort;

/** The harness, model and effort selects, as the settings and the account have them. */
export const chatSelects = (settings: DesktopSettings, choices: ChatChoices) => {
  const harness = settings.chatHarness ?? DEFAULT_CHAT_HARNESS;
  const entry = choices.harnesses.find((one) => one.harness === harness);
  const models = entry?.offered.models ?? [];
  const unset = entry?.offered.unset ?? { harness, model: DEFAULT_MODEL, effort: null };
  const named = (model: string) =>
    models.find(({ id }) => id === model)?.label ??
    (model === DEFAULT_MODEL ? `${harnessLabel(harness)}'s own default` : model);
  const select = (
    value: string | undefined,
    label: string,
    title: string,
    rest: Pick<ChoiceSelect, "options" | "note">,
  ): ChoiceSelect => ({
    value: value ?? DEFAULT_ENTRY,
    label,
    name: `${title}: ${label}`,
    disabled: null,
    ...rest,
  });

  const unsetModel = `Default · ${named(unset.model)}`;
  const model = select(
    settings.chatModel,
    settings.chatModel === undefined ? unsetModel : named(settings.chatModel),
    "Model",
    {
      options: [
        {
          value: DEFAULT_ENTRY,
          label: unsetModel,
          description: "What the chat runs with no model set",
        },
        ...models.map(({ id, label, description }) =>
          description === undefined ? { value: id, label } : { value: id, label, description },
        ),
        ...(settings.chatModel === undefined || models.some(({ id }) => id === settings.chatModel)
          ? []
          : [{ value: settings.chatModel, label: settings.chatModel }]),
      ],
      note: "Collie's table lists these, so each model is named by its id.",
    },
  );

  const runs = settings.chatModel ?? unset.model;
  const takes = effortsOf(harness, runs, models);
  const noEffort = `${named(runs)} takes no effort`;
  const unsetLevel = runsAs({ harness, model: settings.chatModel }, choices).effort;
  const unsetEffort = `Default · ${effortLabel(unsetLevel ?? "")}`;
  const effort: ChoiceSelect =
    takes.length === 0
      ? {
          value: DEFAULT_ENTRY,
          label: noEffort,
          name: `Effort: none. ${noEffort}`,
          options: [],
          note: null,
          disabled: noEffort,
        }
      : select(
          settings.chatEffort,
          settings.chatEffort === undefined ? unsetEffort : effortLabel(settings.chatEffort),
          "Effort",
          {
            options: [
              {
                value: DEFAULT_ENTRY,
                label: unsetEffort,
                description: "What the chat runs with no effort set",
              },
              ...takes.map((level) => ({ value: level, label: effortLabel(level) })),
            ],
            note: `The levels ${named(runs)} takes`,
          },
        );

  return {
    harness: select(harness, harnessLabel(harness), "Harness", {
      options: choices.harnesses.map(({ harness, label, installed }) =>
        installed
          ? { value: harness, label }
          : { value: harness, label, disabled: "not installed on this computer" },
      ),
      note: "Another harness starts a new conversation with your next message.",
    }),
    model,
    effort,
  };
};

/** The model menu's entry for an id typed into its search. */
export const typedModel = (id: string) => `Use ${id}`;

/** What choosing `value` in a select saves. */
export const chosen = (
  which: "harness" | "model" | "effort",
  value: string,
): DesktopSettingsChange => {
  if (which === "harness") return { chatHarness: value };
  const unset = value === DEFAULT_ENTRY ? "" : value;
  return which === "model" ? { chatModel: unset } : { chatEffort: unset };
};

/** What the message box says of a choice the change check refused. */
export const refusedChoice = (reason: string) =>
  `${reason}${reason.endsWith(".") ? "" : "."} Nothing was saved.`;
