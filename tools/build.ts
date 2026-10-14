// The release build. `bun build --compile` cannot run bundler plugins, and Solid needs
// its JSX transform, so the build is a script: `bun run tools/build.ts [target]
// [outfile]`. Every release artifact and the local `bun run build` come through here,
// so the plugin, the libc pin and the renderer gate below cannot drift apart.

import { cpSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import solidPlugin from "@opentui/solid/bun-plugin";

/**
 * `linux-x64` and `bun-linux-x64` both name the same target; CI passes the short one.
 * Bun's musl targets are their own — `bun-linux-x64-musl` — and the libc below only ever
 * decided which native renderer to embed, so a musl machine building from source got a
 * glibc-linked executable it could not run, which is not what it asked for.
 */
function bunTarget(name: string): string {
  const full = name.startsWith("bun-") ? name : `bun-${name}`;
  return libc === "musl" && full.includes("-linux-") && !full.endsWith("-musl")
    ? `${full}-musl`
    : full;
}

/**
 * Which linux C library the artifact is for. `@opentui/core` reads this at *runtime* to
 * pick its package, so both branches are reachable to the bundler and both native
 * libraries get embedded — 6 MB of the artifact for one that will never load. Pinned as
 * a build-time define instead. The releases are glibc; a musl machine building from
 * source sets `OPENTUI_LIBC=musl` and gets its own.
 */
const libc = process.env.OPENTUI_LIBC === "musl" ? "musl" : "glibc";

/**
 * The native renderer a given target must end up carrying. `@opentui/core` picks its
 * library with an `await import` per platform, so a cross-build that resolved the wrong
 * optional package produces a binary that dies on first render on the machine it was
 * built for — and nothing on the build runner can execute it to find out. The asset key
 * below is the name the bundler registers the embedded library under, so its presence in
 * the artifact is the proof; it appears in no other target's binary.
 */
function nativeMarker(target: string): string {
  const [, platform = "", arch = ""] = target.split("-");
  if (platform === "darwin") return `@opentui/core-darwin-${arch}/libopentui.dylib`;
  const suffix = platform === "linux" && libc === "musl" ? "-musl" : "";
  return `@opentui/core-${platform}-${arch}${suffix}/libopentui.so`;
}

const target = bunTarget(Bun.argv[2] ?? `${process.platform}-${process.arch}`);
const outfile = Bun.argv[3] ?? "bin/collie";
// Build beside the binary and rename over it: replacing a running runner's own file in
// place kills the process executing it. `collie upgrade` runs from that very binary, so
// this is the load-bearing half of being able to upgrade at all.
const staging = `${outfile}.new`;

/** What an Installation reads at runtime, placed by the runner as `release/`. */
const RELEASE_TREE = [
  "herdr-plugin.toml",
  "install.sh",
  "prepare.sh",
  "release-p256.pub",
  "workflows",
  "personas",
  "prompts",
  "skills/collie",
  "assets/brand/logos/collie-horizontal-light-512.png",
];
// Named `release` because the embedded directory keeps its basename: `/$bunfs/root/release`.
const tree = `${mkdtempSync(`${tmpdir()}/collie-build-`)}/release`;
for (const entry of RELEASE_TREE) cpSync(entry, `${tree}/${entry}`, { recursive: true });
const carried = readdirSync(tree, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => `release/${relative(tree, join(entry.parentPath, entry.name))}`);

await Bun.build({
  entrypoints: ["src/main.ts"],
  target: "bun",
  plugins: [solidPlugin],
  define: { "process.env.OPENTUI_LIBC": JSON.stringify(libc) },
  // Compiled ahead rather than parsed at every start: a start is a quarter of a second
  // instead of most of one, and hooks, agents and the board start one constantly. ESM,
  // because `@opentui/core` awaits at its top level, which bytecode's default CJS cannot.
  bytecode: true,
  format: "esm",
  compile: { target, outfile: staging, assets: [tree] },
});
rmSync(`${tree}/..`, { recursive: true });

const marker = nativeMarker(target);
const artifact = readFileSync(staging);
const missing = [marker, ...carried].filter((name) => !artifact.includes(name));
if (missing.length > 0) {
  rmSync(staging);
  throw new Error(`${target}: the artifact does not embed ${missing.join(", ")}; not shipping it`);
}

// `renameSync`, not a copy: it is atomic and it keeps the executable bit compile set on it.
renameSync(staging, outfile);
console.log(
  `built ${outfile} for ${target}, embedding ${marker} and ${carried.length} release files`,
);
