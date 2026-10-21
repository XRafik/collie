// What a sweep would remove on each Machine, as the Cleanup dialog draws it (ADR-0045). Pure,
// so the main process and the view read one thing.

import { Schema } from "effect";
import { type CleanupItem, type CleanupKept, CleanupReport } from "../../../src/board-model";
import { humanBytes } from "../../../src/bytes";
import type { MachineRow } from "./flock";
import { NOT_LIVE_SAID } from "./in-sync";

/** What one Machine's host listed, or why it listed nothing. */
export const MachineCleanup = Schema.Struct({
  installation: Schema.String,
  profile: Schema.String,
  name: Schema.String,
  report: Schema.NullOr(CleanupReport),
  problem: Schema.NullOr(Schema.String),
});
export type MachineCleanup = typeof MachineCleanup.Type;

export const CLEANUP_UPGRADE_SAID = "Can't list what it would clean up; upgrade this Machine.";

export type CleanupShown = Pick<MachineRow, "profile" | "name" | "state" | "reason">;

export interface CleanupGroup {
  readonly kind: string;
  readonly count: number;
  readonly size: string;
  readonly items: ReadonlyArray<{
    readonly target: string;
    readonly size: string;
    readonly reason: string;
  }>;
}

export type CleanupSweep =
  | { readonly state: "running"; readonly request: string }
  | { readonly state: "done"; readonly report: CleanupReport }
  | { readonly state: "failed"; readonly request: string; readonly reason: string };

export interface CleanupRowView {
  readonly profile: string;
  readonly name: string;
  readonly said: string;
  /** That its host still sweeps where Desktop can't reach it. */
  readonly note: string | null;
  /** Why its sweep failed. */
  readonly reason: string | null;
  readonly tryAgain: boolean;
  /** That `said` is why it can't be chosen or wasn't cleaned. */
  readonly warn: boolean;
  readonly choosable: boolean;
  readonly chosen: boolean;
  /** What it would free. */
  readonly bytes: number;
  readonly groups: ReadonlyArray<CleanupGroup>;
  readonly kept: { readonly said: string; readonly items: ReadonlyArray<CleanupKept> } | null;
}

export interface CleanupView {
  readonly rows: ReadonlyArray<CleanupRowView>;
  /** The profiles that can be chosen. */
  readonly choosable: ReadonlyArray<string>;
  /** `2 Machines chosen · would free 4.1 GiB`. */
  readonly chosen: string;
  /** Disabled with nothing chosen, and from the first press until the dialog reads again. */
  readonly button: { readonly said: string; readonly disabled: boolean };
}

const STILL_SWEPT = "Its host still cleans up there every ten minutes.";

const groupsOf = (remove: ReadonlyArray<CleanupItem>): ReadonlyArray<CleanupGroup> => {
  const byKind = Map.groupBy(remove, ({ kind }) => kind);
  return [...byKind]
    .map(([kind, items]) => ({
      kind,
      bytes: items.reduce((sum, { bytes }) => sum + bytes, 0),
      items: items.toSorted((a, b) => b.bytes - a.bytes),
    }))
    .toSorted((a, b) => b.bytes - a.bytes)
    .map(({ kind, bytes, items }) => ({
      kind,
      count: items.length,
      size: humanBytes(bytes),
      items: items.map(({ target, bytes, reason }) => ({
        target,
        size: humanBytes(bytes),
        reason,
      })),
    }));
};

const keptOf = (keep: ReadonlyArray<CleanupKept>) =>
  keep.length === 0 ? null : { said: `Kept ${keep.length}`, items: keep };

const rowOf = (
  shown: CleanupShown,
  read: ReadonlyArray<MachineCleanup> | null,
  sweep: CleanupSweep | undefined,
): Omit<CleanupRowView, "chosen"> => {
  const row = (said: string, over: Partial<CleanupRowView> = {}) => ({
    profile: shown.profile,
    name: shown.name,
    said,
    note: null,
    reason: null,
    tryAgain: false,
    choosable: false,
    groups: [],
    kept: null,
    bytes: 0,
    warn: true,
    ...over,
  });
  if (sweep?.state === "running") return row("Cleaning…", { warn: false });
  if (sweep?.state === "failed")
    return row("Not cleaned", { reason: sweep.reason, tryAgain: true });
  if (sweep?.state === "done") {
    const { remove, keep, bytes } = sweep.report;
    return row(remove.length === 0 ? "Nothing removed" : `Freed ${humanBytes(bytes)}`, {
      groups: groupsOf(remove),
      kept: keptOf(keep),
      warn: false,
    });
  }
  if (read === null) return row("Reading…");
  if (shown.state !== "live") {
    const word = shown.state === "connecting" ? "Connecting" : NOT_LIVE_SAID[shown.state];
    return row(shown.reason === null ? word : `${word}: ${shown.reason}`, {
      note: shown.state === "unreachable" || shown.state === "sso" ? STILL_SWEPT : null,
    });
  }
  const listing = read.find(({ profile }) => profile === shown.profile);
  if (listing === undefined) return row("It wasn't connected when Cleanup read.");
  if (listing.report === null) return row(listing.problem ?? "");
  const { remove, keep, bytes } = listing.report;
  return row(remove.length === 0 ? "Nothing to remove now" : `Would free ${humanBytes(bytes)}`, {
    choosable: true,
    warn: false,
    groups: groupsOf(remove),
    kept: keptOf(keep),
    bytes,
  });
};

/**
 * The dialog over the Machines page's rows, in their order, joined to the listings and sweeps
 * by profile. `read` is null while it is out; `chosen` null chooses every Machine that can be.
 * Once any Machine is swept, the choice is fixed.
 */
export const cleanupView = (
  shown: ReadonlyArray<CleanupShown>,
  read: ReadonlyArray<MachineCleanup> | null,
  chosen: ReadonlySet<string> | null,
  sweeps: ReadonlyMap<string, CleanupSweep> = new Map(),
): CleanupView => {
  const swept = sweeps.size > 0;
  const rows = shown.map((one) => {
    const listed = rowOf(one, read, undefined);
    const row = rowOf(one, read, sweeps.get(one.profile));
    const picked = swept
      ? sweeps.has(one.profile)
      : listed.choosable && (chosen?.has(one.profile) ?? true);
    return { ...row, choosable: !swept && row.choosable, chosen: picked, bytes: listed.bytes };
  });
  const picked = rows.filter((row) => row.chosen);
  const total = picked.reduce((sum, { bytes }) => sum + bytes, 0);
  const machines = `${picked.length} Machine${picked.length === 1 ? "" : "s"}`;
  return {
    rows,
    choosable: rows.filter((row) => row.choosable).map(({ profile }) => profile),
    chosen: `${machines} chosen · would free ${humanBytes(total)}`,
    button: { said: `Clean up ${machines}`, disabled: swept || picked.length === 0 },
  };
};

export const sweptToast = (
  name: string,
  sweep: Exclude<CleanupSweep, { state: "running" }>,
): { readonly title: string; readonly color: "success" | "error" } =>
  sweep.state === "done"
    ? { title: `Cleaned up ${name}: freed ${humanBytes(sweep.report.bytes)}`, color: "success" }
    : { title: `${name} not cleaned: ${sweep.reason}`, color: "error" };

export const choose = (view: CleanupView, which: "all" | "none"): ReadonlySet<string> =>
  new Set(which === "all" ? view.choosable : []);
