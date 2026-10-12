import { Config, type Duration, Effect, Option, Path } from "effect";

const BIN = Effect.runSync(
  Path.Path.pipe(
    Effect.map((path) => path.dirname(process.execPath)),
    Effect.provide(Path.layer),
  ),
);

const BEGIN = "<<collie-env-begin-7f3a9c>>";
const END = "<<collie-env-end-7f3a9c>>";

/** How long the shell gets to start, rc files included. */
const LIMIT = "5 seconds";

/** The variables between the markers, `env -0` output; whatever the rc files printed around them is ignored. */
export const parseLoginEnv = (output: string) => {
  const start = output.indexOf(BEGIN);
  const end = output.indexOf(END, start + BEGIN.length);
  const found = new Map<string, string>();
  if (start < 0 || end < 0) return found;
  for (const entry of output.slice(start + BEGIN.length, end).split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) found.set(entry.slice(0, eq).replace(/^\n/, ""), entry.slice(eq + 1));
  }
  return found;
};

const LAUNCHER_PRELOADS = new Set(["./libcef.so", "./libvk_swiftshader.so"]);

/** Removes Electrobun's launcher variables, preserving the user's surviving entries. */
export const withoutLauncher = (env: Readonly<Record<string, string | undefined>>, bin: string) => {
  const {
    ELECTROBUN_LAUNCHER_PID: _pid,
    ELECTROBUN_INSTALL_ROOT_NAME: _root,
    LD_PRELOAD,
    LD_LIBRARY_PATH,
    ICU_DATA,
    ...inherited
  } = env;
  const kept = { ...inherited };
  const without = (list: string | undefined, launcher: (entry: string) => boolean) =>
    (list ?? "")
      .split(":")
      .filter((entry) => !launcher(entry))
      .join(":");
  const preload = without(LD_PRELOAD, (entry) => LAUNCHER_PRELOADS.has(entry));
  const libraries = without(LD_LIBRARY_PATH, (entry) => entry === bin);
  if (preload !== "") kept.LD_PRELOAD = preload;
  if (libraries !== "") kept.LD_LIBRARY_PATH = libraries;
  if (ICU_DATA !== undefined && ICU_DATA !== "" && ICU_DATA !== bin) kept.ICU_DATA = ICU_DATA;
  return kept;
};

/** Gives children the cleaned environment; Bun otherwise ignores changes made since it started. */
export const childEnv = () => withoutLauncher(desktopEnv(), BIN);

// Children inherit the process environment, not an Effect Config.
// oxlint-disable-next-line effecttsgo/process-env
const desktopEnv = () => process.env;

/** Where a bare command is found on `childEnv`'s PATH; Bun's own lookup uses the PATH it started with. */
export const which = (command: string) => Bun.which(command, { PATH: childEnv().PATH });

/** The variables `shell -ilc` exports; empty where it fails, prints none, or outlasts `limit`. */
export const readLoginEnv = (shell: string, limit: Duration.Input = LIMIT) =>
  Effect.gen(function* () {
    const child = Bun.spawn(
      [shell, "-ilc", `printf '%s' '${BEGIN}'; env -0; printf '%s' '${END}'`],
      {
        env: childEnv(),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    const output = yield* Effect.promise(() =>
      Promise.all([new Response(child.stdout).text(), child.exited]),
    ).pipe(Effect.timeoutOption(limit), Effect.ensuring(Effect.sync(() => child.kill())));
    return Option.isSome(output) && output.value[1] === 0
      ? parseLoginEnv(output.value[0])
      : new Map<string, string>();
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`Login shell environment not read from ${shell}`, cause).pipe(
        Effect.as(new Map<string, string>()),
      ),
    ),
  );

/** Merges the interactive login environment into Desktop's; true where it was taken. */
export const takeLoginEnv = Effect.gen(function* () {
  const shell = yield* Config.String("SHELL").pipe(
    Config.withDefault(process.platform === "darwin" ? "/bin/zsh" : "/bin/sh"),
  );
  const taken = yield* readLoginEnv(shell);
  if (taken.size === 0) {
    yield* Effect.logWarning(`Login shell environment not taken from ${shell}`);
    return false;
  }
  const env = desktopEnv();
  for (const [name, value] of taken) env[name] = value;
  return true;
}).pipe(Effect.orElseSucceed(() => false));

/** A plain shell preserves the resolved PATH; login profiles may reset it. */
export const localShell = (tookLoginEnv: boolean) =>
  tookLoginEnv
    ? Config.succeed(["/bin/sh", "-c"])
    : Config.String("SHELL").pipe(
        Config.withDefault("/bin/sh"),
        Config.map((shell) => [shell, "-lc"]),
      );
