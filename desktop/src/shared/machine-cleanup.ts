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

/** What the dialog draws of a Machines page row. */
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

export interface CleanupRowView {
  readonly profile: string;
  readonly name: string;
  readonly said: string;
  /** That its host still sweeps where Desktop can't reach it. */
  readonly note: string | null;
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

const rowOf = (
  shown: CleanupShown,
  read: ReadonlyArray<MachineCleanup> | null,
): Omit<CleanupRowView, "chosen"> => {
  const row = (said: string, over: Partial<CleanupRowView> = {}) => ({
    profile: shown.profile,
    name: shown.name,
    said,
    note: null,
    choosable: false,
    groups: [],
    kept: null,
    bytes: 0,
    ...over,
  });
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
    groups: groupsOf(remove),
    kept: keep.length === 0 ? null : { said: `Kept ${keep.length}`, items: keep },
    bytes,
  });
};

/**
 * The dialog over the Machines page's rows, in their order, joined to the listings by profile.
 * `read` is null while it is out; `chosen` null chooses every Machine that can be.
 */
export const cleanupView = (
  shown: ReadonlyArray<CleanupShown>,
  read: ReadonlyArray<MachineCleanup> | null,
  chosen: ReadonlySet<string> | null,
): CleanupView => {
  const rows = shown.map((one) => {
    const row = rowOf(one, read);
    return { ...row, chosen: row.choosable && (chosen?.has(row.profile) ?? true) };
  });
  const picked = rows.filter((row) => row.chosen);
  const total = picked.reduce((sum, { bytes }) => sum + bytes, 0);
  return {
    rows,
    choosable: rows.filter((row) => row.choosable).map(({ profile }) => profile),
    chosen: `${picked.length} Machine${picked.length === 1 ? "" : "s"} chosen · would free ${humanBytes(total)}`,
  };
};

/** What All and None choose. */
export const choose = (view: CleanupView, which: "all" | "none"): ReadonlySet<string> =>
  new Set(which === "all" ? view.choosable : []);
