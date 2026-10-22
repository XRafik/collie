// What the human set in Desktop, kept on this computer beside the Flock chat's session.

import { Effect, FileSystem, Path, Schema, Semaphore, SubscriptionRef } from "effect";
import { resolveChoice } from "../../../src/harness-choice";
import { isString } from "../../../src/schema";
import { ActionFailed, DesktopSettings, type DesktopSettingsChange } from "../shared/flock";
import { CHAT_HARNESSES, DEFAULT_CHAT_HARNESS, type FlockSettings } from "../shared/flock-settings";

const SettingsFile = Schema.fromJsonString(DesktopSettings);
const FILE = "settings.json";

/** The saved settings, or the defaults where nothing is saved or it cannot be read. */
export const readSettings = Effect.fn("Settings.read")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString((yield* Path.Path).join(dir, FILE)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SettingsFile)),
    Effect.orElseSucceed(() => Schema.decodeUnknownSync(DesktopSettings)({})),
  );
});

export const writeSettings = Effect.fn("Settings.write")(function* (
  dir: string,
  settings: DesktopSettings,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(
    (yield* Path.Path).join(dir, FILE),
    Schema.encodeSync(SettingsFile)(settings),
  );
});

/** `change` over `settings`; another harness unsets a model and effort chosen for the one before. */
export const applyChange = (
  settings: DesktopSettings,
  change: DesktopSettingsChange,
): DesktopSettings => {
  const { chatModel, chatEffort, ...rest } = { ...settings, ...change };
  let applied: DesktopSettings = rest;
  const otherHarness =
    change.chatHarness !== undefined &&
    change.chatHarness !== (settings.chatHarness ?? DEFAULT_CHAT_HARNESS);
  const model = change.chatModel ?? (otherHarness ? undefined : chatModel);
  const effort = change.chatEffort ?? (otherHarness ? undefined : chatEffort);
  if (model !== undefined && model !== "") applied = { ...applied, chatModel: model };
  if (effort !== undefined && effort !== "") applied = { ...applied, chatEffort: effort };
  return applied;
};

/** Extra models per harness, from the Flock's `models.<harness>`. */
export const extraModels = (flock: FlockSettings) =>
  Object.fromEntries(
    Object.entries(flock.settings).flatMap(([key, { value }]) =>
      key.startsWith("models.") && Array.isArray(value) && value.every(isString)
        ? [[key.slice("models.".length), value]]
        : [],
    ),
  );

/** The harness, model and effort the Flock chat is set to, checked as a Run's are. */
export const chatChoice = (settings: DesktopSettings, flock: FlockSettings) => {
  const harness = settings.chatHarness ?? DEFAULT_CHAT_HARNESS;
  if (!CHAT_HARNESSES.includes(harness))
    return {
      ok: false as const,
      problem: `the Flock chat has no harness called "${harness}" (${CHAT_HARNESSES.join(", ")})`,
    };
  const resolved = resolveChoice(
    [{ harness, model: settings.chatModel, effort: settings.chatEffort }],
    extraModels(flock),
  );
  if (
    !resolved.ok &&
    harness === "pi" &&
    settings.chatModel !== undefined &&
    !settings.chatModel.includes("/")
  )
    return {
      ok: false as const,
      problem: `${resolved.problem}. Write provider/model, for example openai-codex/gpt-6.1-sol.`,
    };
  return resolved;
};

/** The settings `change` makes, or why it is refused; a change that leaves the chat alone is not checked. */
export const changeSettings = (
  settings: DesktopSettings,
  flock: FlockSettings,
  change: DesktopSettingsChange,
): DesktopSettings | { readonly refused: string } => {
  const changed = applyChange(settings, change);
  if (
    change.chatHarness === undefined &&
    change.chatModel === undefined &&
    change.chatEffort === undefined
  )
    return changed;
  const checked = chatChoice(changed, flock);
  return checked.ok ? changed : { refused: checked.problem };
};

/**
 * Desktop's settings, read once and changed only here: each change is checked, saved, then
 * published to every window and to the chat.
 */
export const heldSettings = Effect.fn("Settings.held")(function* (
  dir: string,
  flock: () => FlockSettings,
) {
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const held = yield* SubscriptionRef.make(yield* readSettings(dir));
  const one = Semaphore.makeUnsafe(1);
  const save = (change: DesktopSettingsChange) =>
    Effect.gen(function* () {
      const merged = changeSettings(SubscriptionRef.getUnsafe(held), flock(), change);
      if ("refused" in merged) return yield* new ActionFailed({ reason: merged.refused });
      yield* writeSettings(dir, merged).pipe(
        Effect.mapError((error) => new ActionFailed({ reason: error.message })),
      );
      yield* SubscriptionRef.set(held, merged);
      return merged;
    }).pipe(one.withPermits(1), Effect.provideContext(services));
  return {
    current: () => SubscriptionRef.getUnsafe(held),
    changes: SubscriptionRef.changes(held),
    save,
    /** The chat's harness, model or effort, trimmed; why it was refused, or null once saved. */
    setChatHarness: (set: { harness?: string; model?: string; effort?: string }) => {
      const change: Partial<Record<"chatHarness" | "chatModel" | "chatEffort", string>> = {};
      if (set.harness !== undefined) change.chatHarness = set.harness;
      if (set.model !== undefined) change.chatModel = set.model.trim();
      if (set.effort !== undefined) change.chatEffort = set.effort.trim();
      return save(change).pipe(
        Effect.as(null),
        Effect.catch(({ reason }) => Effect.succeed(reason)),
      );
    },
  };
});
