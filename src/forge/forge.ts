// How Collie reaches a forge: one interface, a GitLab adapter and a GitHub adapter, and
// the choice between them. `glab` is run only in `gitlab.ts` and `gh` only in `github.ts`
// (ADR-0050 D1); a caller asks the forge of the reference or checkout in front of it.

import type { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { forgeOfRef, type MrForge, type MrPanel, type MrRef } from "../board-model";
import type { Runner } from "../mr";
import type { Posted } from "../sdk";
import { github } from "./github";
import { gitlab } from "./gitlab";

export interface Readiness {
  readonly ok: boolean;
  /** Why not, phrased for the runner's skip note. */
  readonly reason: string;
}

export type DeployTier = "production" | "staging";

/** A branch's open merge request, none, or why the forge could not say. */
export type ForBranch =
  | {
      readonly ok: true;
      readonly open: {
        readonly iid: string;
        readonly url: string;
        readonly autoMerge: boolean;
      } | null;
    }
  | { readonly ok: false; readonly reason: string };

/** The command lines an agent is told to run, written for the forge they run on. */
export interface Commands {
  /** Opens one, with `<title>` and `<file>` (the description) left for the agent. */
  readonly create: string;
  /** Posts `<file>` as a note on the existing one; empty where there is none. */
  readonly comment: string;
}

/** What Collie asks a forge. Every answer is a value: a forge that cannot be asked says why. */
export interface Forge {
  readonly name: MrForge;
  /** The CLI is installed and logged in to `project`'s host; a null project asks the checkout at `cwd`. */
  readonly ready: <R>(
    project: string | null,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<Readiness, never, R>;
  /** Who the CLI is logged in as, or null where it will not say. */
  readonly login: <R>(cwd: string, run: Runner<R>) => Effect.Effect<string | null, never, R>;
  /** One merge request as the panel shows it. */
  readonly details: <R>(
    ref: MrRef,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<MrPanel, never, R>;
  /** How far a merged commit has been deployed, or null where the forge does not say. */
  readonly liveTier: <R>(
    ref: MrRef,
    mergedSha: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<DeployTier | null, never, R>;
  /** The open merge request whose source branch is `branch`, if any. */
  readonly forBranch: <R>(
    project: string,
    branch: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<ForBranch, never, R>;
  /** The repository's merge request template, relative to the checkout, or null. */
  readonly template: (
    cwd: string,
  ) => Effect.Effect<string | null, PlatformError, FileSystem.FileSystem | Path.Path>;
  /** What an agent runs to open one, or to note on `existing`. */
  readonly commands: (options: {
    readonly project: string;
    readonly branch: string;
    readonly assignee: string;
    readonly existing: string | null;
  }) => Commands;
  /** "GitLab" or "GitHub". */
  readonly display: string;
  /** "merge request" or "pull request". */
  readonly noun: string;
  /** One note on the merge request. */
  readonly note: <R>(
    ref: MrRef,
    body: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<Posted, never, R>;
}

export const FORGES: Readonly<Record<MrForge, Forge>> = { gitlab, github };

/** The forge a merge request is on. */
export function forgeOf(ref: MrRef): Forge {
  return FORGES[forgeOfRef(ref)];
}

/**
 * The forge a host is on (ADR-0050 D2): GitHub on `github.com`, GitLab on the Flock's
 * GitLab host or any host whose name says `gitlab`, and none anywhere else.
 */
export function forgeOfHost(host: string, gitlabHost?: string): MrForge | null {
  const name = host.toLowerCase();
  if (name === "github.com") return "github";
  if (name === gitlabHost?.toLowerCase() || name.includes("gitlab")) return "gitlab";
  return null;
}
