// A board answer as the card shows it until the host's board no longer has the question open.
// No Bun-only import: the view bundles this.

import type { Decision } from "../../../src/board-model";

export interface PendingAnswer {
  readonly runId: string;
  /** The question's id. */
  readonly decision: string | null;
  /** The option's title or the typed value. */
  readonly shown: string;
  readonly machine: string;
  /** Whether the host has replied that it took it. */
  readonly confirmed: boolean;
}

/**
 * What the card says in place of the question's controls, or null where they are offered:
 * no answer pending, or a board on which that Run's question is gone or is another one.
 */
export const answerShown = (pending: PendingAnswer | null, decision: Decision | null) =>
  pending === null ||
  decision?.kind !== "question" ||
  decision.run !== pending.runId ||
  decision.id !== pending.decision
    ? null
    : pending.confirmed
      ? `Answered ${pending.shown}; waiting for ${pending.machine}'s board`
      : `Sending ${pending.shown} to ${pending.machine}…`;
