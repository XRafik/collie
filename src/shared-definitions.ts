// The user Layer's files as a Flock shares them: each decided by its latest edit, a removal
// included, with the text an edit replaced kept under `replaced/`
// (ADR-draft-a-users-definitions-are-the-flocks).

import { Data, Effect, FileSystem, Option, Schema } from "effect";
import type { SharedDefinition } from "./definitions-model";
import { TOOLCHAIN_NAMES } from "./engine";
import { latestEdits } from "./flock-settings";
import { fileTime } from "./time";
import { ensureLockDir, withLock } from "./lock";

const KINDS = ["workflows", "personas"] as const;

/** What this Machine last saw of each shared definition, so a removal is noticed. */
const Seen = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Struct({ at: Schema.String, removed: Schema.Boolean })),
);
type Seen = typeof Seen.Type;
const SEEN_FILE = "definitions-set.json";

export const byPath = (definition: { readonly path: string }) => definition.path;

/**
 * A path a shared definition may have: a file directly in one of the two directories, and
 * neither the toolchain's nor a hidden or backup file an editor leaves beside one.
 */
const shareable = (path: string) => {
  const [kind, name, ...deeper] = path.split("/");
  return (
    KINDS.some((one) => one === kind) &&
    name !== undefined &&
    deeper.length === 0 &&
    name !== "" &&
    !name.startsWith(".") &&
    !name.endsWith("~") &&
    !TOOLCHAIN_NAMES.includes(name)
  );
};

const isLink = Effect.fn("SharedDefinitions.isLink")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readLink(file)
    .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
});

/** When the file at `file` was last modified, following a link; null where there is none. */
const modifiedAt = Effect.fn("SharedDefinitions.modifiedAt")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.stat(file).pipe(
    Effect.map((info) => Option.getOrNull(info.mtime)?.toISOString() ?? null),
    Effect.orElseSucceed(() => null),
  );
});

const onDisk = Effect.fn("SharedDefinitions.onDisk")(function* (userDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const found: Array<SharedDefinition> = [];
  for (const kind of KINDS) {
    const dir = `${userDir}/${kind}`;
    if (!(yield* fs.exists(dir))) continue;
    for (const name of (yield* fs.readDirectory(dir)).sort()) {
      const path = `${kind}/${name}`;
      if (!shareable(path) || (yield* isLink(`${dir}/${name}`))) continue;
      const info = yield* fs.stat(`${dir}/${name}`);
      const mtime = Option.getOrUndefined(info.mtime);
      if (info.type !== "File" || mtime === undefined) continue;
      found.push({
        path,
        text: yield* fs.readFileString(`${dir}/${name}`),
        at: mtime.toISOString(),
      });
    }
  }
  return found;
});

const readSeen = Effect.fn("SharedDefinitions.readSeen")(function* (userDir: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(`${userDir}/${SEEN_FILE}`).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Seen)),
    Effect.orElseSucceed((): Seen => ({})),
  );
});

const writeSeen = Effect.fn("SharedDefinitions.writeSeen")(function* (userDir: string, seen: Seen) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(`${userDir}/${SEEN_FILE}`, `${Schema.encodeSync(Seen)(seen)}\n`);
});

const locked = <A, E, R>(userDir: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const lock = `${userDir}/definitions.lock`;
    yield* ensureLockDir(lock);
    return yield* withLock(
      lock,
      Effect.fail(new Error(`${lock} could not be acquired; not writing unlocked`)),
      effect,
    );
  });

/** What is on disk now, and each file seen before and gone since, removed when first missed. */
const readShared = Effect.fn("SharedDefinitions.read")(function* (userDir: string, now: string) {
  const present = yield* onDisk(userDir);
  const seen = yield* readSeen(userDir);
  const gone = Object.entries(seen).flatMap(([path, last]): SharedDefinition[] =>
    present.some((one) => one.path === path)
      ? []
      : [{ path, text: null, at: last.removed ? last.at : now }],
  );
  const next: Seen = Object.fromEntries(
    [...present, ...gone].map((one) => [one.path, { at: one.at, removed: one.text === null }]),
  );
  if (Schema.encodeSync(Seen)(next) !== Schema.encodeSync(Seen)(seen))
    yield* writeSeen(userDir, next);
  return [...present, ...gone].sort((a, b) => a.path.localeCompare(b.path));
});

/** This Machine's shared definitions, each with when it was last edited. */
export const sharedDefinitions = (userDir: string, now: string) =>
  locked(userDir, readShared(userDir, now));

/** A shared definition given at a path that is not one, which nothing is written for. */
export class DefinitionRefused extends Data.TaggedError("DefinitionRefused")<{
  readonly reason: string;
}> {}

/**
 * The Flock's edits, each written where it is later than this Machine's, with the edit's
 * own time. The text a write replaces or removes is kept under `replaced/` first. Refused
 * whole where any path is not a shared definition's.
 */
export const takeDefinitions = (
  userDir: string,
  given: ReadonlyArray<SharedDefinition>,
  by: string,
  now: string,
) =>
  locked(
    userDir,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const outside = given.find((one) => !shareable(one.path));
      if (outside !== undefined)
        return yield* new DefinitionRefused({
          reason: `${outside.path} is not a file directly in the user Layer's workflows/ or personas/`,
        });
      const held = yield* readShared(userDir, now);
      let seen = yield* readSeen(userDir);
      for (const edit of latestEdits(held, given, byPath).take) {
        const file = `${userDir}/${edit.path}`;
        const had = held.find((one) => one.path === edit.path);
        const text = had?.text ?? null;
        // Saved by hand since it was read, or a link Collie does not write through: left alone.
        if ((yield* modifiedAt(file)) !== (text === null ? null : had?.at)) continue;
        if (had !== undefined && text !== null && text !== edit.text) {
          const kept = `${userDir}/replaced/${had.at}/${edit.path}`;
          yield* fs.makeDirectory(kept.slice(0, kept.lastIndexOf("/")), { recursive: true });
          yield* fs.writeFileString(kept, text);
          yield* Effect.logWarning(
            `${edit.path} ${edit.text === null ? "removed" : "replaced"} by a later edit from ${by}; its text is kept at ${kept}`,
          );
        }
        if (edit.text === null) yield* fs.remove(file, { force: true });
        else {
          yield* fs.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true });
          yield* fs.writeFileString(file, edit.text);
          yield* fs.utimes(file, fileTime(edit.at), fileTime(edit.at));
        }
        seen = { ...seen, [edit.path]: { at: edit.at, removed: edit.text === null } };
      }
      yield* writeSeen(userDir, seen);
      return yield* readShared(userDir, now);
    }),
  );

/** The edits of `given` that `held` now has, which a write leaves out where it was later. */
export const landed = (
  given: ReadonlyArray<SharedDefinition>,
  held: ReadonlyArray<SharedDefinition>,
) => given.filter((one) => held.some((has) => has.path === one.path && has.at === one.at));
