// How Collie reaches a forge: one interface, a GitLab adapter and a GitHub adapter, and
// the choice between them. `glab` is run only in `gitlab.ts` and `gh` only in `github.ts`
// (ADR-0050 D1); a caller asks the forge of the reference or checkout in front of it.

import type { Effect } from "effect";
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
