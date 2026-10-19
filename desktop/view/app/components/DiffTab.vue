<script setup lang="ts">
import type { TreeItem } from "@nuxt/ui";
import { Semaphore } from "effect";
import type { Ref } from "vue";
import type { DiffFile, RunDiff } from "../../../../src/board-model";
import { inField } from "../../../src/shared/board-clicks";
import {
  activeFile,
  type DiffTreeNode,
  diffTree,
  foldersOn,
  READING_LINE,
  reachBy,
} from "../../../src/shared/diff-view";

/** Where a finding points: a file, and a line in it as it is now. */
export interface DiffTarget {
  readonly file: string;
  readonly line: number | null;
}

const props = defineProps<{
  diff: RunDiff;
  installation: string;
  runId: string;
  target: DiffTarget | null;
  /** Whether Diff is the record's tab now; nothing is measured while it is not. */
  shown: boolean;
}>();

// Each diff read has the host run git again, so this record's are four at a time.
provide("diffReads", Semaphore.makeUnsafe(4));

/** A file with more changed lines than this, or a binary one, starts collapsed. */
const BIG_FILE_LINES = 500;

const split = ref(false);
const opened = ref(new Map<string, boolean>());
const isOpen = (file: DiffFile) =>
  opened.value.get(file.path) ??
  (file.added !== null && file.added + (file.removed ?? 0) <= BIG_FILE_LINES);

const sections = ref<HTMLElement | null>(null);
const scrollIntoDiff = async (path: string) => {
  opened.value.set(path, true);
  await nextTick();
  sections.value
    ?.querySelector(`[data-testid="diff-${CSS.escape(path)}"]`)
    ?.scrollIntoView({ block: "start" });
};

/** The file being read, and the one a click or a finding's jump holds until the human scrolls. */
const active = ref<string | null>(null);
const held = ref<string | null>(null);
const show = (path: string) => {
  held.value = path;
  active.value = path;
  void scrollIntoDiff(path);
};

/** The finding's file when it is not in the diff, shown read-only above it. */
const source = ref<DiffTarget | null>(null);
watch(
  () => props.target,
  (target) => {
    if (target === null) return;
    const inDiff = props.diff.files.some((file) => file.path === target.file);
    source.value = inDiff ? null : target;
    if (!inDiff) return;
    opened.value.set(target.file, true);
    held.value = target.file;
    active.value = target.file;
  },
  { immediate: true },
);

const drawn = computed(() => diffTree(props.diff.files));

const items = computed(() => {
  const byKey = new Map<string, TreeItem>();
  const toItem = (node: DiffTreeNode): TreeItem => {
    const item: TreeItem =
      node.kind === "folder"
        ? {
            label: node.label,
            icon: "i-lucide-folder",
            path: node.key,
            children: node.children.map(toItem),
          }
        : {
            label: node.label,
            icon: "i-lucide-file",
            path: node.key,
            onSelect: () => show(node.key),
          };
    byKey.set(node.key, item);
    return item;
  };
  return { tree: drawn.value.tree.map(toItem), byKey };
});
const selected = computed(() =>
  active.value === null ? undefined : items.value.byKey.get(active.value),
);

const folders = computed(() => [
  ...new Set(drawn.value.files.flatMap((file) => foldersOn(file.path))),
]);
const closed = ref(new Set<string>());
const expanded = computed(() => folders.value.filter((folder) => !closed.value.has(folder)));
const setExpanded = (keys: ReadonlyArray<string>) =>
  (closed.value = new Set(folders.value.filter((folder) => !keys.includes(folder))));

const scroller = inject<Ref<HTMLElement | null>>("recordScroller", ref(null));
const treeBox = ref<HTMLElement | null>(null);
const visibleHeight = ref<number | null>(null);

const measure = () => {
  const box = scroller.value;
  const column = sections.value;
  if (!props.shown || box === null || column === null) return;
  if (held.value !== null && !drawn.value.files.some(({ path }) => path === held.value)) {
    held.value = null;
  }
  visibleHeight.value = box.clientHeight;
  const visibleTop = box.getBoundingClientRect().top;
  const measured = [...column.children].flatMap((section) => {
    const path = section.getAttribute("data-path");
    if (path === null) return [];
    const { top, bottom } = section.getBoundingClientRect();
    return [{ path, top: top - visibleTop, bottom: bottom - visibleTop }];
  });
  active.value = activeFile({
    sections: measured,
    readingLine: READING_LINE,
    atEnd: box.scrollTop + box.clientHeight >= box.scrollHeight - 1,
    held: held.value,
  });
};

const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
watch(
  [() => props.shown, scroller, sections],
  ([shown, box, column], _, onCleanup) => {
    if (!shown || box === null || column === null) return;
    const release = () => (held.value = null);
    const releaseOnKey = (event: KeyboardEvent) => {
      const typedIn = event.composedPath()[0];
      if (SCROLL_KEYS.has(event.key) && !(typedIn instanceof Element && inField(typedIn)))
        release();
    };
    const releaseOnScrollbar = (event: PointerEvent) => event.target === box && release();
    const resized = new ResizeObserver(measure);
    resized.observe(box);
    resized.observe(column);
    box.addEventListener("scroll", measure, { passive: true });
    box.addEventListener("wheel", release, { passive: true });
    box.addEventListener("touchmove", release, { passive: true });
    box.addEventListener("keydown", releaseOnKey);
    box.addEventListener("pointerdown", releaseOnScrollbar);
    measure();
    onCleanup(() => {
      resized.disconnect();
      box.removeEventListener("scroll", measure);
      box.removeEventListener("wheel", release);
      box.removeEventListener("touchmove", release);
      box.removeEventListener("keydown", releaseOnKey);
      box.removeEventListener("pointerdown", releaseOnScrollbar);
    });
  },
  { immediate: true, flush: "post" },
);
watch(() => drawn.value.files, measure, { flush: "post" });

watch(
  [active, () => props.shown],
  async ([path, shown]) => {
    if (path === null) return;
    const hiding = foldersOn(path).filter((folder) => closed.value.has(folder));
    if (hiding.length > 0) {
      closed.value = new Set([...closed.value].filter((folder) => !hiding.includes(folder)));
    }
    if (!shown) return;
    await nextTick();
    const box = treeBox.value;
    const row = box?.querySelector("[data-selected]");
    if (!box || !row) return;
    box.scrollTop += reachBy(box.getBoundingClientRect(), row.getBoundingClientRect());
  },
  { flush: "post" },
);
</script>

<template>
  <div data-testid="diff" class="flex flex-col gap-3">
    <div class="flex items-center gap-3 text-sm">
      <UBadge
        variant="subtle"
        :color="diff.live ? 'info' : 'neutral'"
        :label="diff.live ? 'Live' : 'Final'"
      />
      <span class="text-muted">
        {{ diff.files.length }} {{ diff.files.length === 1 ? "file" : "files" }} against
        <code>{{ diff.base.slice(0, 7) }}</code>
      </span>
      <USwitch v-model="split" class="ml-auto" label="Side by side" data-testid="split" />
    </div>
    <SourceFile
      v-if="source !== null"
      :path="source.file"
      :line="source.line"
      :installation="installation"
      :run-id="runId"
      @close="source = null"
    />
    <p v-if="diff.files.length === 0" class="text-sm text-muted">Nothing has changed yet.</p>
    <div v-else class="flex items-start gap-3">
      <div
        ref="treeBox"
        class="sticky top-0 w-56 shrink-0 overflow-y-auto"
        :style="visibleHeight === null ? undefined : { maxHeight: `${visibleHeight}px` }"
      >
        <UTree
          :items="items.tree"
          :get-key="(item: TreeItem) => item.path"
          :model-value="selected"
          :expanded="expanded"
          data-testid="diff-tree"
          @update:expanded="setExpanded"
        />
      </div>
      <div ref="sections" class="flex min-w-0 flex-1 flex-col gap-3">
        <DiffFile
          v-for="file in drawn.files"
          :key="file.path"
          :data-path="file.path"
          :file="file"
          :installation="installation"
          :run-id="runId"
          :base="diff.base"
          :split="split"
          :target="target?.file === file.path ? target : null"
          :open="isOpen(file)"
          @update:open="(now: boolean) => opened.set(file.path, now)"
          @missing="(missed: DiffTarget) => (source = missed)"
        />
      </div>
    </div>
  </div>
</template>
