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

const DEPTH = 6;
const SKIPPED = new Set([
  ".git",
  "node_modules",
  ".cache",
  ".local",
  ".claude",
  ".codex",
  ".npm",
  ".bun",
  ".cargo",
  ".rustup",
  ".nvm",
  ".pnpm-store",
  ".yarn",
  ".gradle",
  ".m2",
  ".vscode-server",
]);

/**
 * Working repositories under each of `roots` to depth six, including hidden, nested and
 * linked ones, plus each of `known` that is one; dependencies, Git metadata and tool
 * directories are not looked into. A link to nothing or a path the user cannot access is
 * skipped, other inspection errors propagate.
 */
export const publicationCheckouts = Effect.fn("Issues.publicationCheckouts")(function* (
  roots: ReadonlyArray<string>,
  known: ReadonlyArray<string> = [],
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
  const record = (dir: string) =>
    Effect.gen(function* () {
      const canonical = yield* fs.realPath(dir);
      if (canonical !== dir) aliases.push({ from: dir, to: canonical });
      if (yield* fs.exists(path.join(dir, ".git"))) {
        checkouts.add(dir);
        checkouts.add(canonical);
      }
      return canonical;
    });
  const visit = (root: string, dir: string, depth: number): Effect.Effect<void, PlatformError> =>
    Effect.gen(function* () {
      const canonical = yield* record(dir);
      const fromRoot = path.relative(root, canonical);
      if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`)) return;
      if (depth === DEPTH || visited.has(canonical)) return;
      visited.add(canonical);
      const children = (yield* fs.readDirectory(canonical)).filter((name) => !SKIPPED.has(name));
      yield* Effect.forEach(
        children,
        (name) =>
          Effect.gen(function* () {
            const child = path.join(canonical, name);
            const info = yield* fs.stat(child).pipe(Effect.catchTag("PlatformError", unseen));
            if (info?.type === "Directory") yield* visit(root, child, depth + 1);
          }),
        { concurrency: 8, discard: true },
      );
    }).pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "PermissionDenied" ? Effect.void : Effect.fail(error),
      ),
    );
  for (const root of roots) yield* visit(yield* fs.realPath(root), root, 0);
  for (const dir of known) yield* record(dir).pipe(Effect.catchTag("PlatformError", unseen));
  return { checkouts: [...checkouts].sort(), aliases };
});

/** Whether `dir/.git` leads to a Git directory; an empty `.git` or a copied submodule's gitfile does not. */
export const marksRepository = Effect.fn("Issues.marksRepository")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const marker = path.join(dir, ".git");
  const gitfile =
    (yield* fs.stat(marker)).type === "Directory"
      ? null
      : (yield* fs.readFileString(marker)).replace(/[\r\n]+$/, "");
  if (gitfile === null) return yield* fs.exists(path.join(marker, "HEAD"));
  if (!gitfile.startsWith("gitdir: ")) return false;
  const gitDir = gitfile.slice("gitdir: ".length);
  // Joined unnormalised, as Git does, so `..` leaves a linked `dir` physically.
  return yield* fs.exists(`${path.isAbsolute(gitDir) ? gitDir : `${dir}/${gitDir}`}/HEAD`);
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
