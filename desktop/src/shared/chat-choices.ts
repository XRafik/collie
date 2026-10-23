// Chat defaults and the account each window renders beside its message box.

import { Schema } from "effect";
import { DEFAULT_MODEL, HARNESS_MODELS } from "../../../src/harness-choice";
import { harnessName } from "./chat-view";
import type { DesktopSettings } from "./flock";
import { DEFAULT_CHAT_HARNESS } from "./flock-settings";

/** A harness, model and effort as a session is opened on them; `default` is the harness's own model. */
export const Resolved = Schema.Struct({
  harness: Schema.String,
  model: Schema.String,
  effort: Schema.NullOr(Schema.String),
});
export type Resolved = typeof Resolved.Type;

/** A model a harness offers, with the efforts it lists and the one an unset effort runs at. */
export const Offered = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
  efforts: Schema.Array(Schema.String),
  unsetEffort: Schema.NullOr(Schema.String),
});
export type Offered = typeof Offered.Type;

/** What a harness offers, and what its unset model and effort run as. */
export const Offer = Schema.Struct({
  from: Schema.Literals(["harness", "table"]),
  why: Schema.optionalKey(Schema.String),
  unset: Resolved,
  models: Schema.Array(Offered),
});
export type Offer = typeof Offer.Type;

/** The account of the chat every window is pushed. */
export const ChatChoices = Schema.Struct({
  /** The harness the current conversation is held on. */
  heldOn: Schema.String,
  /** What the warm session was opened on; null while none is warm. */
  runsOn: Schema.NullOr(Resolved),
  /** A turn is under way, the human's or Desktop's own. */
  turning: Schema.Boolean,
  harnesses: Schema.Array(
    Schema.Struct({
      harness: Schema.String,
      label: Schema.String,
      installed: Schema.Boolean,
      offered: Schema.Union([Schema.Struct({ from: Schema.Literal("reading") }), Offer]),
    }),
  ),
});
export type ChatChoices = typeof ChatChoices.Type;

/** Pi's model and effort defaults. */
export const PiConfig = Schema.Struct({
  defaultProvider: Schema.optionalKey(Schema.String),
  defaultModel: Schema.optionalKey(Schema.String),
  defaultThinkingLevel: Schema.optionalKey(Schema.String),
  modelThinkingLevels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export type PiConfig = typeof PiConfig.Type;

/** The chat's choice as set, each part unset where it is undefined. */
export interface SetChoice {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
}

/** The efforts `model` lists: its offered entry's, else the table's for its harness. */
export const effortsOf = (
  harness: string,
  model: string,
  offered: ReadonlyArray<Pick<Offered, "id" | "efforts">>,
): ReadonlyArray<string> =>
  offered.find(({ id }) => id === model)?.efforts ?? HARNESS_MODELS[harness]?.efforts ?? [];

const unsetModel = (harness: string, pi: PiConfig) =>
  harness === "pi"
    ? pi.defaultProvider && pi.defaultModel
      ? `${pi.defaultProvider}/${pi.defaultModel}`
      : DEFAULT_MODEL
    : (HARNESS_MODELS[harness]?.defaultModel ?? DEFAULT_MODEL);

/** What a choice runs as: an unset model and effort as its harness, or Pi's configuration, has them. */
export const runsAs = (
  set: SetChoice,
  offered: ReadonlyArray<Pick<Offered, "id" | "efforts">>,
  pi: PiConfig,
): Resolved => {
  const model =
    set.model === undefined || set.model === DEFAULT_MODEL
      ? unsetModel(set.harness, pi)
      : set.model;
  const unsetEffort =
    set.harness === "pi"
      ? (pi.modelThinkingLevels?.[model] ?? pi.defaultThinkingLevel ?? "medium")
      : "medium";
  return {
    harness: set.harness,
    model,
    effort:
      effortsOf(set.harness, model, offered).length === 0 ? null : (set.effort ?? unsetEffort),
  };
};

/** What a set choice runs as, by the resolver's answers in what its harness offers. */
export const runsAsOffered = (set: SetChoice, offer: Offer): Resolved => {
  const model =
    set.model === undefined || set.model === DEFAULT_MODEL ? offer.unset.model : set.model;
  return {
    harness: set.harness,
    model,
    effort:
      effortsOf(set.harness, model, offer.models).length === 0
        ? null
        : (set.effort ??
          offer.models.find(({ id }) => id === model)?.unsetEffort ??
          offer.unset.effort ??
          "medium"),
  };
};

/** One entry of a select; a disabled one says why in its description. */
export interface ChoiceOption {
  /** Empty is the select's default, which unsets it. */
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: true;
}

/** A select beside the message box, as its trigger and menu show it. */
export interface ChoiceSelect {
  readonly value: string;
  /** The trigger's text. */
  readonly label: string;
  /** The trigger's accessible name, carrying its value. */
  readonly name: string;
  readonly options: ReadonlyArray<ChoiceOption>;
  /** The menu's last line; null where it has none. */
  readonly note: string | null;
  readonly reading?: true;
  readonly warning?: string;
  readonly disabled: boolean;
}

export const effortLabel = (effort: string) =>
  effort === "xhigh" ? "Extra high" : `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`;

const select = (
  name: string,
  value: string,
  label: string,
  options: ReadonlyArray<ChoiceOption>,
  note: string | null,
): ChoiceSelect => ({ value, label, name: `${name}: ${label}`, options, note, disabled: false });

/** The harness, model and effort selects, as the settings and the chat's account have them. */
export const chatSelects = (settings: DesktopSettings, choices: ChatChoices | null) => {
  const harness = settings.chatHarness ?? DEFAULT_CHAT_HARNESS;
  const entry = choices?.harnesses.find((one) => one.harness === harness);
  const harnessSelect = select(
    "Harness",
    harness,
    entry?.label ?? harnessName(harness),
    (choices?.harnesses ?? []).map(({ harness, label, installed }) =>
      installed
        ? { value: harness, label }
        : {
            value: harness,
            label,
            description: "Not installed on this computer",
            disabled: true as const,
          },
    ),
    "Another harness starts a new conversation with your next message.",
  );
  const set = settings.chatModel;
  const effortSet = settings.chatEffort;
  if (entry === undefined || entry.offered.from === "reading")
    return {
      harness: harnessSelect,
      model: {
        ...select(
          "Model",
          set ?? "",
          set ?? "Default",
          [
            { value: "", label: "Default" },
            ...(set === undefined ? [] : [{ value: set, label: set }]),
          ],
          entry === undefined
            ? null
            : `Reading ${entry.label}'s models… You can still type a model id.`,
        ),
        ...(entry !== undefined && { reading: true as const }),
      },
      effort: select(
        "Effort",
        effortSet ?? "",
        effortSet === undefined ? "Default" : effortLabel(effortSet),
        [],
        null,
      ),
    };
  const offer = entry.offered;
  const modelLabel = (id: string) =>
    offer.models.find((model) => model.id === id)?.label ??
    (id === DEFAULT_MODEL ? `${entry.label}'s own` : id);
  const unsetModel = `Default · ${modelLabel(offer.unset.model)}`;
  const model: ChoiceSelect = {
    ...select(
      "Model",
      set ?? "",
      set === undefined ? unsetModel : modelLabel(set),
      [
        { value: "", label: unsetModel, description: "What the chat runs with no model set" },
        ...offer.models.map(({ id, label, description }) =>
          description === undefined ? { value: id, label } : { value: id, label, description },
        ),
        ...(set === undefined || offer.models.some(({ id }) => id === set)
          ? []
          : [{ value: set, label: set }]),
      ],
      offer.from === "table"
        ? "Collie's table, so models are named by id"
        : `Listed by ${entry.label} on this computer`,
    ),
    ...(offer.from === "table" &&
      offer.why !== undefined && {
        warning: `${entry.label}'s list could not be read: ${offer.why.replace(/\.$/, "")}. Showing Collie's table, so models are named by id.`,
      }),
  };
  const runs = runsAsOffered({ harness, model: set }, offer);
  if (runs.effort === null) {
    const none = `${modelLabel(runs.model)} takes no effort`;
    return {
      harness: harnessSelect,
      model,
      effort: {
        value: "",
        label: none,
        name: `Effort: none. ${none}`,
        options: [],
        note: null,
        disabled: true,
      },
    };
  }
  const unsetEffort = `Default · ${effortLabel(runs.effort)}`;
  return {
    harness: harnessSelect,
    model,
    effort: select(
      "Effort",
      effortSet ?? "",
      effortSet === undefined ? unsetEffort : effortLabel(effortSet),
      [
        { value: "", label: unsetEffort, description: "What the chat runs with no effort set" },
        ...effortsOf(harness, runs.model, offer.models).map((effort) => ({
          value: effort,
          label: effortLabel(effort),
        })),
      ],
      `The levels ${modelLabel(runs.model)} takes`,
    ),
  };
};

/** A typed id offered to save, where it is not already an option. */
export const typedEntry = (search: string, model: ChoiceSelect): ChoiceOption | null => {
  const id = search.trim();
  return id === "" || model.options.some(({ value }) => value === id)
    ? null
    : { value: id, label: `Use ${id}` };
};

/** A refused choice, as the alert above the message box says it. */
export const refusalSaid = (reason: string) => `${reason.replace(/\.$/, "")}. Nothing was saved.`;
