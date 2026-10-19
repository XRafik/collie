<script setup lang="ts">
import { offersTerminal, opensHerdrWithoutPane } from "../../../src/shared/record-terminal";
import type { PlacedTask } from "../../../src/shared/flock";
import { mrTab } from "../../../src/shared/links";
import {
  landingOf,
  recordTabs,
  rememberScroll,
  type ScrollMemory,
  scrollToRestore,
  tabShown,
} from "../../../src/shared/record";
import { runDetailAtom, runDetailKey } from "../flock";
import type { DiffTarget } from "./DiffTab.vue";

const props = defineProps<{ placed: PlacedTask }>();
const emit = defineEmits<{ close: [] }>();

const { value: read, trouble } = useHeld(() =>
  runDetailAtom(
    runDetailKey({ installation: props.placed.installation, runId: props.placed.task.run }),
  ),
);
const detail = computed(() => read.value ?? null);
const { notLive, protocolOf } = useFlock();
const away = computed(() => notLive(props.placed.installation));
const loading = computed(
  () => trouble.value === null && away.value === null && read.value === undefined,
);

/** The location last followed: opened in the diff, or read-only in Review where there is none. */
const target = ref<DiffTarget | null>(null);
const landing = computed(() =>
  target.value === null
    ? null
    : landingOf(target.value, detail.value?.diff?.files.map(({ path }) => path) ?? null),
);
/** Whether the tab shown was reached by a jump, which lands on its target rather than restoring. */
const landed = ref(false);
let jumping = false;
const jump = (file: string, line: number | null) => {
  target.value = { file, line };
  const next = landing.value?.tab ?? "review";
  jumping = next !== tab.value;
  landed.value = true;
  stopRestoring();
  chosen.value = next;
};
provide("jumpTo", jump);

const scroller = ref<HTMLElement | null>(null);
provide("recordScroller", scroller);

const tabs = computed(() => {
  const shown = detail.value;
  return recordTabs({
    loaded: shown !== null,
    plan: Boolean(shown?.plan),
    reviewText: shown?.review._tag === "Text",
    findings: (shown?.findings.length ?? 0) > 0,
    target: target.value !== null,
    diff: Boolean(shown?.diff),
    terminal: offersTerminal(props.placed.asOf, chosen.value),
    mr: shown?.mr ? mrTab(props.placed.task.mr) : null,
  });
});
/** The tab the human chose while it is there, else the first: Summary, where there is one. */
const chosen = ref<string>();
const { asked: tabAsked, taken } = usePage();
const wentToPane = ref(false);
watch(
  tabAsked,
  (asked) => {
    if (asked === null) return;
    chosen.value = asked;
    wentToPane.value = opensHerdrWithoutPane(asked);
    taken();
  },
  { immediate: true },
);
const tab = computed({
  get: () => tabShown(tabs.value, chosen.value),
  set: (value) => (chosen.value = value),
});

watch(tab, (now) => now !== "terminal" && (wentToPane.value = false));

const body = ref<HTMLElement | null>(null);
let memory: ScrollMemory = new Map();
let stopRestoring = () => {};
const HUMAN_SCROLLS = ["wheel", "touchmove", "keydown", "pointerdown"] as const;
/** Shows the position, waiting while the tab is still too short for it until the human scrolls. */
const restore = (position: number) => {
  const box = scroller.value;
  const content = body.value;
  if (box === null) return;
  const reached = () => {
    box.scrollTop = position;
    return box.scrollTop >= position - 1;
  };
  if (reached() || content === null) return;
  const grown = new ResizeObserver(() => reached() && stopRestoring());
  grown.observe(content);
  const gaveUp = () => stopRestoring();
  HUMAN_SCROLLS.forEach((event) => box.addEventListener(event, gaveUp, { passive: true }));
  stopRestoring = () => {
    grown.disconnect();
    HUMAN_SCROLLS.forEach((event) => box.removeEventListener(event, gaveUp));
    stopRestoring = () => {};
  };
};
// Before the tab shown changes in the page, so the one left is measured as it was.
watch(tab, (now, was) => {
  const box = scroller.value;
  if (box !== null && was !== undefined) memory = rememberScroll(memory, was, box.scrollTop);
  stopRestoring();
  if (jumping) {
    jumping = false;
    return;
  }
  landed.value = false;
  const position = scrollToRestore(memory, now);
  if (position !== null) void nextTick(() => restore(position));
});
onBeforeUnmount(() => stopRestoring());

/** Mounted from its first visit on and kept, so its toggles and open files stay as left. */
const diffSeen = ref(false);
watch(tab, (now) => now === "diff" && (diffSeen.value = true), { immediate: true });

const review = useWhole(
  () => ({ installation: props.placed.installation, runId: props.placed.task.run }),
  "review",
  () => detail.value?.review ?? { _tag: "None", reason: "" },
  useActions().textOf,
);
const locationOf = (file: string, line: number | null) =>
  line === null ? file : `${file}:${line}`;
</script>

<template>
  <section data-testid="record" class="flex flex-col bg-default">
    <PageHeader :title="placed.task.name" @back="emit('close')">
      <p class="text-sm text-muted" data-testid="record-description">
        {{ detail?.title ?? placed.task.run }}
      </p>
    </PageHeader>
    <div
      ref="scroller"
      class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
      :class="{ '[scrollbar-gutter:stable]': tab !== 'terminal' }"
    >
      <div class="flex flex-col gap-4" :class="readingClass">
        <RetryNotice
          v-if="trouble !== null"
          title="This Run's details could not be read; showing what they last said"
          :trouble="trouble"
        />
        <UAlert
          v-else-if="away !== null"
          data-testid="record-away"
          color="warning"
          variant="subtle"
          :icon="away.icon"
          :title="`${away.title}; showing what it last said`"
          :description="away.reason"
        />
        <p v-else-if="read === null" class="text-muted text-sm">
          This Run's details are not on its Machine.
        </p>
        <div v-if="loading" data-testid="record-loading" class="flex flex-col gap-4">
          <div class="flex gap-4">
            <USkeleton v-for="at in 5" :key="at" class="h-6 w-20" />
          </div>
          <USkeleton class="h-4 w-1/3" />
          <USkeleton class="h-4 w-full" />
          <USkeleton class="h-4 w-5/6" />
          <USkeleton class="h-4 w-2/3" />
        </div>
        <UTabs v-else v-model="tab" :items="tabs" :content="false" variant="link" />
      </div>
      <div
        v-if="!loading"
        ref="body"
        class="flex flex-col gap-4"
        :class="[columnClass(tab ?? ''), { 'min-h-0 flex-1': tab === 'terminal' }]"
      >
        <template v-if="detail !== null">
          <ReviewComments
            v-if="tab === 'plan' || tab === 'diff'"
            :installation="placed.installation"
            :run-id="detail.id"
            :launches="detail.agents"
            :live="placed.task.agents"
            :protocol="protocolOf(placed.installation)"
          />
          <SummaryTab v-if="tab === 'summary'" :detail="detail" />
          <PlanTab
            v-else-if="tab === 'plan' && detail.plan"
            :plan="detail.plan"
            :installation="placed.installation"
            :run-id="detail.id"
          />
          <div v-else-if="tab === 'review'" data-testid="review" class="flex flex-col gap-4">
            <SourceFile
              v-if="landing?.tab === 'review'"
              :path="landing.file"
              :line="landing.line"
              :reveal="landed"
              :installation="placed.installation"
              :run-id="detail.id"
              @close="target = null"
            />
            <template v-if="review !== null">
              <RichMarkdown :text="review.text" />
              <p v-if="review.cut" class="text-muted text-sm" data-testid="cut">
                {{ review.cut }}
              </p>
            </template>
            <ul
              v-if="detail.findings.length > 0"
              class="flex flex-col gap-2"
              data-testid="findings"
            >
              <li
                v-for="(finding, at) in detail.findings"
                :key="at"
                class="rounded border border-default p-2 text-sm"
              >
                <div class="flex items-center gap-2">
                  <UBadge variant="subtle" :label="finding.severity" />
                  <strong>{{ finding.title }}</strong>
                </div>
                <UButton
                  v-if="finding.file"
                  variant="link"
                  size="xs"
                  class="px-0 font-mono"
                  data-testid="finding-location"
                  :label="locationOf(finding.file, finding.line)"
                  @click="jump(finding.file, finding.line)"
                />
                <p v-if="finding.detail" class="mt-1 whitespace-pre-wrap">{{ finding.detail }}</p>
              </li>
            </ul>
          </div>
          <EvidenceTab
            v-else-if="tab === 'evidence'"
            :detail="detail"
            :installation="placed.installation"
          />
          <LogTab v-else-if="tab === 'log'" :tail="detail.tail" />
          <MrPanel v-else-if="tab === 'mr' && detail.mr" :mr="detail.mr" />
          <DiffTab
            v-if="detail.diff && diffSeen"
            v-show="tab === 'diff'"
            :diff="detail.diff"
            :installation="placed.installation"
            :run-id="detail.id"
            :target="target"
            :shown="tab === 'diff'"
          />
        </template>
        <FactsTab
          v-if="tab === 'facts'"
          :task="placed.task"
          :detail="detail"
          :installation="placed.installation"
        />
        <TerminalTab v-if="tab === 'terminal'" :placed="placed" :went-to-pane="wentToPane" />
      </div>
    </div>
  </section>
</template>
