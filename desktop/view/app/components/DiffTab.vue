<script setup lang="ts">
import type { TreeItem } from "@nuxt/ui";
import { Semaphore } from "effect";
import type { Ref } from "vue";
import type { DiffFile, RunDiff } from "../../../../src/board-model";
import { inField } from "../../../src/shared/board-clicks";
import { landingOf } from "../../../src/shared/record";
import {
  activeFile,
  choiceForEvery,
  closedFolders,
  type DiffTreeNode,
  diffTree,
  fileBeside,
  fileOpen,
  fileSelected,
  filterTree,
  foldersOn,
  openFolders,
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

const split = ref(false);
const wrap = ref(false);
const opened = ref(new Map<string, boolean>());

const sections = ref<HTMLElement | null>(null);
const scrollToFile = async (path: string) => {
  await nextTick();
  sections.value
    ?.querySelector(`[data-testid="diff-${CSS.escape(path)}"]`)
    ?.scrollIntoView({ block: "start" });
};
const scrollIntoDiff = (path: string) => {
  opened.value.set(path, true);
  return scrollToFile(path);
};

/** The file being read, and the one a click or a finding's jump holds until the human scrolls. */
const active = ref<string | null>(null);
const held = ref<string | null>(null);
const show = (path: string) => {
  held.value = path;
  active.value = path;
  void scrollIntoDiff(path);
};
/** `j` and `k`: the next or previous file held as a click holds it, left open or closed. */
const step = (by: 1 | -1) => {
  const path = fileBeside(drawn.value.files, active.value, by);
  if (path === null) return;
  held.value = path;
  active.value = path;
  void scrollToFile(path);
};
defineExpose({ step });

/** The finding's file when it is not in the diff, shown read-only above it. */
const source = ref<DiffTarget | null>(null);
watch(
  () => props.target,
  (target) => {
    if (target === null) return;
    const landing = landingOf(
      target,
      props.diff.files.map(({ path }) => path),
    );
    source.value = landing.at === "source" ? target : null;
    if (landing.at === "source") return;
    if (landing.at === "file") return show(landing.file);
    opened.value.set(target.file, true);
    held.value = target.file;
    active.value = target.file;
  },
  { immediate: true },
);

const drawn = computed(() => diffTree(props.diff.files));
const openEvery = async (open: boolean) => {
  opened.value = new Map(choiceForEvery(drawn.value.files, open));
  held.value = null;
  await nextTick();
  measure();
};
const filter = ref("");
const filtering = computed(() => filter.value.trim() !== "");
const listed = computed(() => filterTree(drawn.value.tree, filter.value));

const { drafts } = useReviewDrafts(() => props);
const {
  viewed,
  count: viewedSoFar,
  mark,
} = useViewedFiles(
  () => props,
  () => props.diff,
);
const markViewed = (file: DiffFile, now: boolean) => {
  mark(file, now);
  if (now) opened.value.set(file.path, false);
};
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
const viewedOf = (row: Row) => viewed.value.has(row.path);

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
          };
    byKey.set(node.key, item);
    return item;
  };
  return { tree: listed.value.map(toItem), byKey };
});
const selected = computed(() =>
  active.value === null ? undefined : items.value.byKey.get(active.value),
);
const selectRow = (event: Event, row: Row) => {
  const path = fileSelected(event, row.path);
  if (path !== null) show(path);
};

const folders = computed(() => [
  ...new Set(drawn.value.files.flatMap((file) => foldersOn(file.path))),
]);
const closed = ref(new Set<string>());
const listedFolders = computed(() =>
  [...items.value.byKey.keys()].filter((key) => key.endsWith("/")),
);
const folderFacts = computed(() => ({
  all: folders.value,
  listed: listedFolders.value,
  closed: closed.value,
  filtering: filtering.value,
}));
const expanded = computed(() => [...openFolders(folderFacts.value)]);
const setExpanded = (keys: ReadonlyArray<string>) => {
  closed.value = new Set(closedFolders(folderFacts.value, keys));
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
    const hiding = foldersOn(path).filter((folder) => closed.value.has(folder));
    if (path !== was && hiding.length > 0) {
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
      <span v-if="diff.files.length > 0" class="text-muted" data-testid="diff-viewed-count">
        {{ viewedSoFar }}
      </span>
      <div class="ml-auto flex flex-wrap items-center justify-end gap-3">
        <USwitch v-model="split" label="Side by side" data-testid="split" />
        <USwitch v-model="wrap" label="Wrap long lines" data-testid="wrap" />
        <UButton
          v-if="diff.files.length > 0"
          label="Expand all"
          icon="i-lucide-chevrons-up-down"
          size="xs"
          variant="ghost"
          color="neutral"
          data-testid="diff-expand-all"
          @click="openEvery(true)"
        />
        <UButton
          v-if="diff.files.length > 0"
          label="Collapse all"
          icon="i-lucide-chevrons-down-up"
          size="xs"
          variant="ghost"
          color="neutral"
          data-testid="diff-collapse-all"
          @click="openEvery(false)"
        />
      </div>
    </div>
    <SourceFile
      v-if="source !== null"
      :target="source"
      :installation="installation"
      :run-id="runId"
      @close="source = null"
    />
    <p v-if="diff.files.length === 0" class="text-sm text-muted">Nothing has changed yet.</p>
    <div v-else class="flex items-start gap-3">
      <div
        class="sticky top-0 flex w-56 shrink-0 flex-col gap-2"
        :style="visibleHeight === null ? undefined : { maxHeight: `${visibleHeight}px` }"
      >
        <UInput
          v-model="filter"
          icon="i-lucide-search"
          placeholder="Filter files"
          size="sm"
          class="w-full"
          data-testid="diff-filter"
        />
        <div ref="treeBox" class="min-h-0 overflow-y-auto">
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
            @select="selectRow"
            @update:expanded="setExpanded"
          >
            <template #[FILE_FACTS]="{ item }">
              <DiffRowFacts :facts="factsOf(item)" :viewed="viewedOf(item)" />
            </template>
          </UTree>
        </div>
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
          :wrap="wrap"
          :target="target?.file === file.path ? target : null"
          :open="fileOpen(file, opened)"
          :viewed="viewed.has(file.path)"
          @update:viewed="(now: boolean) => markViewed(file, now)"
          @update:open="(now: boolean) => opened.set(file.path, now)"
          @missing="(missed: DiffTarget) => (source = missed)"
        />
      </div>
    </div>
  </div>
</template>
