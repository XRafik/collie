// A Run's viewed ticks on its Diff, held by Desktop for as long as it runs, keyed as Review
// comment drafts are, and told to no host.

import { computed, reactive } from "vue";
import type { DiffFile } from "../../../../src/board-model";
import {
  tickViewed,
  untickViewed,
  viewedCount,
  viewedFiles,
  type ViewedTicks,
} from "../../../src/shared/diff-view";

const held = reactive(new Map<string, ViewedTicks>());

export const useViewedFiles = (
  run: () => { installation: string; runId: string },
  diff: () => { files: ReadonlyArray<DiffFile>; base: string },
) => {
  const key = computed(() => `${run().installation}\u0000${run().runId}`);
  const ticks = computed<ViewedTicks>(() => held.get(key.value) ?? new Map());
  return {
    viewed: computed(() => viewedFiles(ticks.value, diff().files, diff().base)),
    count: computed(() => viewedCount(ticks.value, diff().files, diff().base)),
    mark: (file: DiffFile, viewed: boolean) =>
      held.set(
        key.value,
        viewed ? tickViewed(ticks.value, file, diff().base) : untickViewed(ticks.value, file.path),
      ),
  };
};
