<script setup lang="ts">
import type { Panel } from "../../../../src/board-model";

const props = defineProps<{ tail: Panel | null }>();

const search = ref("");
const all = computed(() =>
  props.tail?._tag === "Text" && props.tail.text !== "" ? props.tail.text.split("\n") : [],
);
const wanted = computed(() => search.value.trim());
const lines = computed(() =>
  wanted.value === ""
    ? all.value
    : all.value.filter((line) => line.toLowerCase().includes(wanted.value.toLowerCase())),
);

const shown = ref<HTMLElement | null>(null);
/** Followed to its end unless the human scrolled up to read. */
let following = true;
const scrolled = () => {
  const box = shown.value;
  if (box !== null) following = box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
};
watch(
  lines,
  async () => {
    if (!following) return;
    await nextTick();
    shown.value?.scrollTo({ top: shown.value.scrollHeight });
  },
  { immediate: true },
);
</script>

<template>
  <div data-testid="log" class="flex flex-col gap-2">
    <UInput
      v-model="search"
      icon="i-lucide-search"
      placeholder="Search the log"
      size="sm"
      data-testid="log-search"
    />
    <p v-if="tail?._tag === 'None'" class="text-muted text-sm">{{ tail.reason }}</p>
    <p v-else-if="all.length === 0" class="text-muted text-sm" data-testid="log-empty">
      The log is empty so far.
    </p>
    <p v-else-if="lines.length === 0" class="text-muted text-sm" data-testid="log-unmatched">
      No line matches {{ wanted }}.
    </p>
    <pre
      v-else
      ref="shown"
      data-testid="log-lines"
      class="max-h-[60vh] overflow-auto rounded bg-elevated p-2 text-xs"
      @scroll="scrolled"
    ><template v-for="(line, at) in lines" :key="at">{{ line }}
</template></pre>
  </div>
</template>
