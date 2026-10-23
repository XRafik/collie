<script setup lang="ts">
import type { Flow } from "../../../../src/board-model";
import type { PlacedTask } from "../../../src/shared/flock";
import type { Gesture } from "../../../src/shared/board-clicks";
import { inField, overlayOpen } from "../../../src/shared/board-clicks";
import {
  flowAnnouncements,
  flowKey,
  flowRows,
  inspectorOf,
  rowOrigin,
  selectEntry,
  selectNode,
  type FlowPick,
  type FlowSelection,
  type FlowSpot,
} from "../../../src/shared/flow";
const props = defineProps<{ flow: Flow; placed: PlacedTask; shown: boolean }>();
const emit = defineEmits<{ run: [run: string]; open: [run: string, tab: string] }>();
const { everyTask, now } = useFlock();
const cards = computed(() =>
  everyTask.value.map((one) => ({ key: one.key, machine: one.machine, runs: one.task.runs })),
);
const away = computed(
  () => new Set(everyTask.value.filter((one) => one.asOf !== null).map((one) => one.machine)),
);
const selected = ref<FlowSelection | null>(null);
const first = () => {
  const row = flowRows(props.flow).find((one) => one.nodes.length > 0);
  return (
    props.flow.current ?? (row === undefined ? null : { run: row.run, node: row.nodes[0]!.id })
  );
};
const focused = ref<FlowSpot | null>(first());
const info = computed(() =>
  selected.value === null ? null : inspectorOf(props.flow, selected.value, now.value),
);
const source = computed(() =>
  selected.value === null ? null : rowOrigin(props.flow, selected.value.run),
);
const map = ref<{ focus: (spot: FlowSpot) => void; reveal: (spot: FlowSpot) => void } | null>(null);
const page = usePage();
const gesture = inject<(done: Gesture, tab?: string) => void>("gesture")!;
const offering = ref<{ run: string; offer: string } | null>(null);
const close = () => {
  const spot = selected.value;
  selected.value = null;
  if (spot !== null) {
    focused.value = spot;
    void nextTick(() => map.value?.focus(spot));
  }
};
const take = (picked: FlowPick) => {
  switch (picked.kind) {
    case "inspect":
      selected.value = picked.selection;
      emit("run", picked.run);
      break;
    case "close":
      close();
      break;
    case "open":
      gesture({ kind: "name", card: picked.card }, "flow");
      page.showRecord(picked.card, "flow", picked.run);
      break;
    case "offer":
      if (props.placed.asOf === null) offering.value = { run: picked.run, offer: picked.offer };
      break;
  }
};
const choose = (spot: FlowSpot) => take(selectNode(props.flow, spot, selected.value, cards.value));
const chooseItem = (id: string | null) =>
  selected.value !== null && take(selectEntry(props.flow, selected.value, id, cards.value));
const origin = (run: string, machine: string) => {
  const card = cards.value.find((one) => one.machine === machine && one.runs.includes(run));
  if (card !== undefined) take({ kind: "open", card: card.key, run });
};
const key = (event: KeyboardEvent) => {
  if (
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    inField(event.target instanceof Element ? event.target : null) ||
    overlayOpen(document) ||
    focused.value === null
  )
    return;
  const move = flowKey(
    props.flow,
    event.key === "Escape" && selected.value !== null ? selected.value : focused.value,
    event.key,
    selected.value !== null,
  );
  if (move === null) return;
  event.preventDefault();
  event.stopPropagation();
  focused.value = move.focus;
  if (move.close) close();
  else if (move.select) choose(move.focus);
  else map.value?.focus(move.focus);
};
const announcement = ref("");
watch(
  () => props.flow,
  (next, previous) => {
    const messages = flowAnnouncements(previous ?? null, next);
    if (messages.length > 0) {
      announcement.value = "";
      void nextTick(() => (announcement.value = messages.join(". ")));
    }
  },
);
let revealed = false;
watch(
  () => props.shown,
  async (shown) => {
    if (!shown || revealed) return;
    revealed = true;
    await nextTick();
    if (props.flow.current !== null) map.value?.reveal(props.flow.current);
  },
  { immediate: true },
);
</script>

<template>
  <div
    data-testid="flow"
    :data-escape-scope="selected !== null ? '' : undefined"
    class="flex min-h-0 flex-1 flex-col gap-4"
    :class="{ 'opacity-50': placed.asOf !== null }"
    @keydown="key"
  >
    <p class="text-sm">{{ placed.task.sentence }}</p>
    <p class="sr-only" aria-live="polite" aria-atomic="true">{{ announcement }}</p>
    <FlowMap
      ref="map"
      :flow="flow"
      :focused="focused"
      :selected="selected"
      :cards="cards"
      :away="away"
      :now="now"
      @choose="choose"
      @focus="focused = $event"
      @origin="origin"
    />
    <FlowInspector
      v-if="info !== null && selected !== null"
      :info="info"
      :selected="selected"
      @close="close"
      @item="chooseItem"
      @open="(run, tab) => emit('open', run, tab)"
    >
      <UButton
        v-if="source !== null"
        variant="link"
        class="self-start px-0"
        :label="`Started by ${source.run} on ${source.machine}`"
        @click="origin(source.run, source.machine)"
      />
    </FlowInspector>
    <p v-else class="text-sm text-muted">
      Select a Step to inspect its work. Use the arrow keys to move between Steps and Runs.
    </p>
    <OffersDialog
      v-if="offering !== null"
      :installation="placed.installation"
      :run-id="offering.run"
      :chosen="offering.offer"
      @close="offering = null"
    />
  </div>
</template>
