import { expect, test } from "bun:test";
import { Effect, FileSystem, Path } from "effect";
import { runEffect } from "./support/effect";

// ADR-0050 D1: `glab` is run only by the GitLab adapter and `gh` only by the GitHub one,
// and no workflow's content names either.

const ADAPTER = new Map([
  ["src/forge/gitlab.ts", "glab"],
  ["src/forge/github.ts", "gh"],
  ["src/forge/gitlab-checks.ts", "glab"],
  ["src/forge/github-checks.ts", "gh"],
]);

/** Files that still reach a forge's CLI themselves, and the ticket that moves each. */
const ALLOWED = new Map([
  // Permanent (ADR-0050 D1): onboarding's GitLab login and SSH key.
  ["src/onboard.ts", "permanent"],
  ["src/worktree.ts", "09: the roaming clone"],
  ["workflows/renovate.md", "10: renovate's content per forge"],
]);

/** A command a TypeScript file runs: the CLI as an argument, or a command line in a string. */
const INVOKES =
  /(["'])(glab|gh)\1|["'`](glab|gh) (?:mr|pr|api|auth|repo|issue|ci|release|run|workflow)\b/g;
/** Workflow content that names a CLI at all. */
const NAMES = /\b(glab|gh)\b/g;

const matcherOf = (file: string) =>
  /^(src|workflows)\/.*\.tsx?$/.test(file)
    ? INVOKES
    : /^workflows\/.*\.md$/.test(file)
      ? NAMES
      : null;

/** Each file under `src/` and `workflows/` that runs or names a forge CLI, and which. */
const scan = Effect.fn("boundary.scan")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.dirname(yield* path.fromFileUrl(new URL("./", import.meta.url)));
  const found = new Map<string, Set<string>>();
  for (const dir of ["src", "workflows"]) {
    for (const entry of yield* fs.readDirectory(path.join(root, dir), { recursive: true })) {
      const file = `${dir}/${entry}`;
      const matcher = matcherOf(file);
      if (matcher === null) continue;
      const text = yield* fs.readFileString(path.join(root, file));
      const clis = new Set([...text.matchAll(matcher)].map((m) => m[2] ?? m[3] ?? m[1] ?? ""));
      if (clis.size > 0) found.set(file, clis);
    }
  }
  return found;
});

test("glab and gh are run only by their adapters, and only the allowlist still runs either", () =>
  runEffect(
    Effect.gen(function* () {
      const strays: string[] = [];
      for (const [file, clis] of yield* scan())
        for (const cli of clis)
          if (ADAPTER.get(file) !== cli && !ALLOWED.has(file)) strays.push(`${file} runs ${cli}`);
      expect(strays).toEqual([]);
    }),
  ));

test("every allowlisted file still runs a forge CLI, so a moved one leaves the list", () =>
  runEffect(
    Effect.gen(function* () {
      const found = yield* scan();
      expect([...ALLOWED.keys()].filter((file) => !found.has(file))).toEqual([]);
    }),
  ));
