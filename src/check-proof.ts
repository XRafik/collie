// A Check's proof on a tree, and which of a Run's Checks are owed a local run: the one
// place either is read. Pure: the caller hands it the journal and the tree.

import {
  passed,
  ranCommand,
  ranOneTest,
  staleAgainst,
  type CheckCommand,
  type Snapshot,
  type Verification,
} from "./verify";

export interface Journal {
  readonly verifications: ReadonlyArray<Verification>;
  readonly final: Snapshot;
  /** The Run's Checks' commands as they resolve here; a record of exactly one counts for it, whoever asked. */
  readonly commands?: ReadonlyArray<CheckCommand>;
}

export interface CheckProof {
  readonly state: "passed" | "failed" | "unstable" | "earlier" | "never";
  /** Every run of the Check's own command, oldest first. */
  readonly runs: ReadonlyArray<Verification>;
  /** The latest of them on this tree. */
  readonly last: Verification | undefined;
}

/**
 * Whose records count, by name, for a Check whose command is not given: anyone's, or only
 * the runs Collie made itself.
 */
export type Unmatched = "anyone" | "collie";

export function checkProof(
  got: Journal,
  name: string,
  unmatched: Unmatched = "anyone",
): CheckProof {
  const command = got.commands?.find((one) => one.name === name);
  const runs = got.verifications.filter(
    (v) =>
      !ranOneTest(v) &&
      (command === undefined
        ? v.name === name && (unmatched === "anyone" || v.by === "collie")
        : ranCommand(v, command)),
  );
  const last = runs.findLast((v) => !staleAgainst(v, got.final));
  return { state: stateOf(runs, last), runs, last };
}

function stateOf(runs: ReadonlyArray<Verification>, last: Verification | undefined) {
  if (last !== undefined && passed(last)) return "passed";
  const latest = last ?? runs.at(-1);
  if (latest === undefined) return "never";
  if (latest.result === "fail" || latest.expect === "fail") return "failed";
  if (latest.result === "unstable") return "unstable";
  return "earlier";
}

/** The Checks a Run runs itself. */
export const owedLocally = <C extends { readonly name: string }>(
  checks: ReadonlyArray<C>,
): ReadonlyArray<C> => checks;
