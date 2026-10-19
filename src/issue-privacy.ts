import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";

interface DirectoryAlias {
  readonly from: string;
  readonly to: string;
}

export function remoteOf(url: string): { project: string; path: string } | null {
  const raw = url.trim();
  const parsed = raw.includes("://") ? URL.parse(raw) : null;
  const scp = parsed === null ? /^(?:[^@\s]+@)?([^:/\s]+)[:/](.+)$/.exec(raw) : null;
  const host = parsed?.host ?? scp?.[1];
  const path = (parsed?.pathname ?? scp?.[2])?.replace(/^\/+/, "").replace(/\.git$/, "");
  return host && path ? { project: `${host}/${path}`, path } : null;
}

/** Working repositories under `root`, including hidden, nested and linked ones; a link to nothing or a path the user cannot access is skipped, other inspection errors propagate. */
export const publicationCheckouts = Effect.fn("Issues.publicationCheckouts")(function* (
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const visited = new Set<string>();
  const checkouts = new Set<string>();
  const aliases: DirectoryAlias[] = [];
  // A link to nothing, such as a forwarded agent socket left by a closed login, an entry
  // removed during the walk, or a path the user cannot access, holds no checkout their Runs
  // worked in.
  const unseen = (error: PlatformError) =>
    error.reason._tag === "NotFound" || error.reason._tag === "PermissionDenied"
      ? Effect.succeed(null)
      : Effect.fail(error);
  const canonicalRoot = yield* fs.realPath(root);
  const visit = (dir: string): Effect.Effect<void, PlatformError> =>
    Effect.gen(function* () {
      const canonical = yield* fs.realPath(dir);
      if (canonical !== dir) aliases.push({ from: dir, to: canonical });
      if (yield* fs.exists(path.join(dir, ".git"))) {
        checkouts.add(dir);
        checkouts.add(canonical);
      }
      const fromRoot = path.relative(canonicalRoot, canonical);
      if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`)) return;
      if (visited.has(canonical)) return;
      visited.add(canonical);
      for (const name of yield* fs.readDirectory(canonical)) {
        const child = path.join(canonical, name);
        const info = yield* fs.stat(child).pipe(Effect.catchTag("PlatformError", unseen));
        if (info?.type === "Directory") yield* visit(child);
      }
    }).pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "PermissionDenied" ? Effect.void : Effect.fail(error),
      ),
    );
  yield* visit(root);
  return { checkouts: [...checkouts].sort(), aliases };
});

export function throughAliases(text: string, aliases: ReadonlyArray<DirectoryAlias>): string {
  let expanded = text;
  for (let pass = 0; pass <= text.length; pass++) {
    let next = expanded;
    for (const alias of aliases) next = next.replaceAll(`${alias.from}/`, `${alias.to}/`);
    if (next === expanded) return expanded;
    expanded = next;
  }
  throw new Error("directory aliases could not be resolved");
}
