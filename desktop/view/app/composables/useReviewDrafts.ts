// A Run's Review comment drafts, held by Desktop for as long as it runs and sent to no host
// until they are delivered (ADR-0051 D1).

import { computed, reactive } from "vue";
import {
  type Anchor,
  addDraft,
  clearSent,
  type Draft,
  editDraft,
  removeDraft,
} from "../../../src/shared/review-comments";

const held = reactive(new Map<string, Draft[]>());
/** Drafts live only as long as Desktop does, so a count names each one. */
let made = 0;

export const useReviewDrafts = (run: () => { installation: string; runId: string }) => {
  const key = computed(() => `${run().installation}\u0000${run().runId}`);
  const drafts = computed<ReadonlyArray<Draft>>(() => held.get(key.value) ?? []);
  const change = (next: (drafts: ReadonlyArray<Draft>) => Draft[]) =>
    held.set(key.value, next(drafts.value));
  return {
    drafts,
    add: (anchor: Anchor, text: string) =>
      change((now) => addDraft(now, { id: String(++made), anchor, text })),
    edit: (id: string, text: string) => change((now) => editDraft(now, id, text)),
    remove: (id: string) => change((now) => removeDraft(now, id)),
    clear: (sent: ReadonlyArray<Draft>) => change((now) => clearSent(now, sent)),
  };
};
