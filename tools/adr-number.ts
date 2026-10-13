// `bun run tools/adr-number.ts [--base <ref>]`: numbers this branch's draft ADRs before it
// lands. A draft is `docs/adr/draft-<slug>.md`, named in text as `ADR-draft-<slug>`. Each
// takes the next number above the highest on the default branch and on this branch, in slug
// order, and every reference to it in the repository is rewritten. Nothing is committed.
// Numbers the default branch already has twice are reported and left as they are.

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Data, Effect, FileSystem, Option } from "effect";

class NumberingRefused extends Data.TaggedError("NumberingRefused")<{ readonly message: string }> {}

const ADR_DIR = "docs/adr";

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.suspend(() => {
    const done = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    return done.exitCode === 0
      ? Effect.succeed(done.stdout.toString())
      : Effect.fail(
          new NumberingRefused({
            message: `git ${args.join(" ")}: ${done.stderr.toString().trim()}`,
          }),
        );
  });

const numberOf = (name: string) => /^(\d{4})-/.exec(name)?.[1];
const slugOf = (name: string) => /^draft-([a-z0-9-]+)\.md$/.exec(name)?.[1];

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = (yield* git(".", "rev-parse", "--show-toplevel")).trim();
  const flag = process.argv.indexOf("--base");
  const base =
    flag === -1
      ? yield* git(root, "rev-parse", "--abbrev-ref", "origin/HEAD").pipe(
          Effect.map((ref) => ref.trim()),
          Effect.orElseSucceed(() => "master"),
        )
      : process.argv[flag + 1]!;

  const onBase = (yield* git(root, "ls-tree", "--name-only", base, `${ADR_DIR}/`))
    .split("\n")
    .filter(Boolean)
    .map((path) => path.slice(ADR_DIR.length + 1));
  const onBranch = yield* fs.readDirectory(`${root}/${ADR_DIR}`);

  const byNumber = new Map<string, string[]>();
  for (const name of onBase) {
    const number = numberOf(name);
    if (number !== undefined) byNumber.set(number, [...(byNumber.get(number) ?? []), name]);
  }
  for (const [number, names] of byNumber) {
    if (names.length > 1) {
      yield* Effect.log(
        `${base} has ${names.length} ADRs numbered ${number}, left as they are: ${names.join(", ")}`,
      );
    }
  }

  const drafts = onBranch
    .map(slugOf)
    .filter((slug) => slug !== undefined)
    .sort();
  if (drafts.length === 0) return yield* Effect.log("No draft ADRs to number.");

  let highest = Math.max(0, ...[...onBase, ...onBranch].map((name) => Number(numberOf(name) ?? 0)));
  const numbered = drafts.map((slug) => ({ slug, number: String(++highest).padStart(4, "0") }));

  for (const { slug, number } of numbered) {
    const from = `${ADR_DIR}/draft-${slug}.md`;
    const to = `${ADR_DIR}/${number}-${slug}.md`;
    yield* fs.rename(`${root}/${from}`, `${root}/${to}`);
    yield* Effect.log(`${from} -> ${to}`);
  }

  const rewrite = (text: string) =>
    numbered.reduce(
      (out, { slug, number }) =>
        out
          .replace(new RegExp(`(?<![a-z0-9-])draft-${slug}\\.md`, "g"), `${number}-${slug}.md`)
          .replace(new RegExp(`ADR-draft-${slug}(?![a-z0-9-])`, "g"), `ADR-${number}`),
      text,
    );

  const files = (yield* git(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"))
    .split("\0")
    .filter(Boolean);
  for (const file of new Set(files)) {
    const path = `${root}/${file}`;
    const text = yield* fs.readFileString(path).pipe(Effect.option);
    if (Option.isNone(text) || text.value.includes("\0")) continue;
    const rewritten = rewrite(text.value);
    if (rewritten !== text.value) {
      yield* fs.writeFileString(path, rewritten);
      yield* Effect.log(`rewrote ${file}`);
    }
  }
});

BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)));
