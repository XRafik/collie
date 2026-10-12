// A Flock's latest edits, shared by Desktop and paired hosts.

import { Effect, Option, Schema } from "effect";
import type { SharedSetting } from "./board-model";
import { parseShared, SettingValue, settingText } from "./settings";
import { epochMs } from "./time";

export const FlockSetting = Schema.Struct({
  value: Schema.NullOr(Schema.Json),
  at: Schema.String,
  /** The Machine whose edit it is, or Desktop. */
  from: Schema.String,
  /** Taken over a different value another Machine had, which Settings says once. */
  differed: Schema.Boolean,
});
export type FlockSetting = typeof FlockSetting.Type;

export const FlockSettings = Schema.Struct({
  settings: Schema.Record(Schema.String, FlockSetting),
  /** The Machines synced at least once: only a first sync says where a value came from. */
  synced: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});
export type FlockSettings = typeof FlockSettings.Type;

export const NO_FLOCK_SETTINGS: FlockSettings = { settings: {}, synced: [] };

const valueOf = (value: Schema.Json | null) =>
  Option.getOrNull(Schema.decodeUnknownOption(SettingValue)(value));

const same = (a: Schema.Json | null, b: Schema.Json | null) =>
  settingText(valueOf(a)) === settingText(valueOf(b));

/** Desktop's own, given to every Machine and never taken from one: its token is made for it. */
const GIVEN_ONLY = "gitlab_host";

/**
 * What a Machine has, taken into the Flock's where it is the later edit and a value its
 * setting takes, and what the Machine should then be given: each key whose latest edit it
 * lacks.
 */
export const takeFrom = (
  flock: FlockSettings,
  machine: string,
  has: ReadonlyArray<SharedSetting>,
) => {
  const settings = { ...flock.settings };
  const first = !flock.synced.includes(machine);
  for (const { key, value, at } of has) {
    const kept = settings[key];
    if (key === GIVEN_ONLY || "refused" in parseShared(key, value)) continue;
    if (kept !== undefined && epochMs(at) <= epochMs(kept.at)) continue;
    settings[key] = {
      value,
      at,
      from: machine,
      differed: first && kept !== undefined && kept.from !== machine && !same(kept.value, value),
    };
  }
  const give = Object.entries(settings).flatMap(([key, { value, at }]): SharedSetting[] => {
    const theirs = has.find((one) => one.key === key);
    return theirs !== undefined && epochMs(theirs.at) >= epochMs(at) ? [] : [{ key, value, at }];
  });
  const synced = first ? [...flock.synced, machine] : flock.synced;
  return { flock: { settings, synced } satisfies FlockSettings, give };
};
