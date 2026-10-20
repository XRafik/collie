// The ssh argv and bounds Desktop shares with the host, without the host's lock.

/** How long a master has to answer one control command, which it does at once when it is well. */
export const MUX_BOUND = "5 seconds";

export const quoted = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

/** `collie` as a Machine's login shell runs it over SSH. */
export const remoteCollie = (args: ReadonlyArray<string>) =>
  [`exec "\${SHELL:-/bin/sh}" -lc 'exec collie "$@"' collie`, ...args.map(quoted)].join(" ");

/**
 * A session that rides the connection and fails where it has gone: without
 * `ProxyCommand=false`, ssh would fall back to a login of its own.
 */
export const riderArgv = (path: string, target: string, remote: string, ssh = "ssh") => [
  ssh,
  "-S",
  path,
  "-o",
  "ControlMaster=no",
  "-o",
  "ProxyCommand=false",
  "-T",
  target,
  remote,
];

export type Verb = "check" | "forward" | "cancel" | "exit";

/** `ssh -S <path> -O <verb> … <destination>`: answered by an open master, or failed. */
export const muxArgv = (
  ssh: string,
  path: string,
  verb: Verb,
  destination: string,
  ...forward: ReadonlyArray<string>
) => [ssh, "-S", path, "-O", verb, ...forward, destination];
