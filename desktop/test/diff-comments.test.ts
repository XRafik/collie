import { expect, test } from "bun:test";
import { processFile } from "@pierre/diffs";
import { useDiffComments, WRITING } from "../view/app/composables/useDiffComments";
import { useReviewDrafts } from "../view/app/composables/useReviewDrafts";

const file = processFile(
  "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n context\n-old\n+new\n",
  { isGitDiff: true },
)!;

test("the Diff tab takes a comment on a line range on either side", () => {
  for (const side of ["additions", "deletions"] as const) {
    for (const handler of ["onGutterUtilityClick", "onLineSelectionEnd"] as const) {
      const store = useReviewDrafts(() => ({ installation: "test", runId: side + handler }));
      let cleared = 0;
      const comments = useDiffComments(
        () => "a.txt",
        () => file,
        () => store.drafts.value,
        store.add,
        () => {
          cleared++;
        },
      );
      expect(comments.pending.value).toBeNull();
      comments.handlers[handler]({ start: 1, end: 2, side });
      expect(comments.pending.value).toEqual({
        _tag: "Diff",
        path: "a.txt",
        side,
        first: 1,
        last: 2,
        lines: ["context", side === "additions" ? "new" : "old"],
      });
      expect(comments.annotations.value).toEqual([{ side, lineNumber: 2, metadata: WRITING }]);
      comments.settle("Keep my words.\n  Exactly.");
      expect(comments.pending.value).toBeNull();
      expect(store.drafts.value).toHaveLength(1);
      expect(store.drafts.value[0]?.text).toBe("Keep my words.\n  Exactly.");
      expect(store.drafts.value[0]?.anchor).toMatchObject({
        path: "a.txt",
        side,
        first: 1,
        last: 2,
      });
      expect(comments.annotations.value).toEqual([
        { side, lineNumber: 2, metadata: store.drafts.value[0]!.id },
      ]);
      expect(cleared).toBe(1);
      comments.handlers[handler]({ start: 2, end: 2, side });
      comments.settle(null);
      expect(comments.pending.value).toBeNull();
      expect(store.drafts.value).toHaveLength(1);
      expect(cleared).toBe(2);
      store.remove(store.drafts.value[0]!.id);
      expect(comments.annotations.value).toEqual([]);
    }
  }
});
