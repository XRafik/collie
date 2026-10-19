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
  filterTree,
  foldersOn,
  READING_LINE,
  reachBy,
  rowFacts,
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
const filter = ref("");
const filtering = computed(() => filter.value.trim() !== "");
const listed = computed(() => filterTree(drawn.value.tree, filter.value));

const { drafts } = useReviewDrafts(() => props);
const facts = computed(() => {
  const onDiff = drafts.value.flatMap(({ anchor }) =>
    anchor._tag === "Diff" ? [anchor.path] : [],
  );
  return new Map(drawn.value.files.map((file) => [file.path, rowFacts(file, onDiff)]));
});

type Row = TreeItem & { path: string };
/** Nuxt UI draws a row's `<slot>-trailing`, which its slot types do not name. */
const FILE_FACTS = "file-trailing";
const factsOf = (row: Row) => facts.value.get(row.path);

const items = computed(() => {
  const byKey = new Map<string, Row>();
  const toItem = (node: DiffTreeNode): Row => {
    const item: Row =
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
            slot: "file",
            onSelect: () => show(node.key),
          };
    byKey.set(node.key, item);
    return item;
  };
  return { tree: listed.value.map(toItem), byKey };
});
const selected = computed(() =>
  active.value === null ? undefined : items.value.byKey.get(active.value),
);

const folders = computed(() => [
  ...new Set(drawn.value.files.flatMap((file) => foldersOn(file.path))),
]);
const closed = ref(new Set<string>());
const listedFolders = computed(() =>
  [...items.value.byKey.keys()].filter((key) => key.endsWith("/")),
);
/** Folders closed while the filter is in effect; the human's own are kept for after it. */
const closedFiltered = ref(new Set<string>());
watch(filter, () => (closedFiltered.value = new Set()));
const expanded = computed(() =>
  filtering.value
    ? listedFolders.value.filter((folder) => !closedFiltered.value.has(folder))
    : folders.value.filter((folder) => !closed.value.has(folder)),
);
const setExpanded = (keys: ReadonlyArray<string>) => {
  const shut = (all: ReadonlyArray<string>) => new Set(all.filter((key) => !keys.includes(key)));
  if (filtering.value) closedFiltered.value = shut(listedFolders.value);
  else closed.value = shut(folders.value);
};

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
  [active, () => props.shown, listed],
  async ([path, shown], [was]) => {
    if (path === null) return;
    const reopen = (folders: Ref<Set<string>>) => {
      const hiding = foldersOn(path).filter((folder) => folders.value.has(folder));
      if (hiding.length > 0) {
        folders.value = new Set([...folders.value].filter((folder) => !hiding.includes(folder)));
      }
    };
    if (path !== was) {
      reopen(closed);
      reopen(closedFiltered);
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
        <UInput
          v-model="filter"
          icon="i-lucide-search"
          placeholder="Filter files"
          size="sm"
          class="sticky top-0 z-10 mb-2 w-full bg-default"
          data-testid="diff-filter"
        />
        <p v-if="items.tree.length === 0" class="text-sm text-muted" data-testid="diff-no-match">
          No file matches
        </p>
        <UTree
          v-else
          :items="items.tree"
          :get-key="(item: Row) => item.path"
          :model-value="selected"
          :expanded="expanded"
          data-testid="diff-tree"
          @update:expanded="setExpanded"
        >
          <template #[FILE_FACTS]="{ item }">
            <DiffRowFacts :facts="factsOf(item)" />
          </template>
        </UTree>
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
