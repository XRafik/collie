<script setup lang="ts">
import { type ChoiceSelect, typedEntry } from "../../../src/shared/chat-choices";

const props = defineProps<{ select: ChoiceSelect }>();
const emit = defineEmits<{ choose: [value: string] }>();

// Reka requires a nonempty option value.
const UNSET = "(default)";
const search = ref("");
const items = computed(() => {
  const [first, ...rest] = props.select.options.map((option) => ({
    ...option,
    value: option.value || UNSET,
    onSelect: () => emit("choose", option.value),
  }));
  const typed = typedEntry(search.value, props.select);
  return [
    ...(first === undefined ? [] : [[first]]),
    rest,
    ...(typed === null
      ? []
      : [
          [
            {
              ...typed,
              icon: "i-lucide-plus",
              typed: typed.value,
              onSelect: () => emit("choose", typed.value),
            },
          ],
        ]),
  ];
});
</script>

<template>
  <USelectMenu
    v-model:search-term="search"
    :model-value="select.value || UNSET"
    :items="items"
    value-key="value"
    :aria-label="select.name"
    :search-input="{ placeholder: 'Search or type a model id' }"
    :filter-fields="['label', 'value']"
    color="neutral"
    variant="soft"
    size="sm"
    class="max-w-full"
    :ui="{ content: 'min-w-72' }"
  >
    <span class="truncate">{{ select.label }}</span>
    <template #item-label="{ item }">
      <template v-if="'typed' in item">
        Use <strong class="font-semibold">{{ item.typed }}</strong>
      </template>
      <template v-else>{{ item.label }}</template>
    </template>
    <template v-if="select.note !== null" #content-bottom>
      <p class="border-t border-default px-3 py-2 text-xs text-muted">{{ select.note }}</p>
    </template>
  </USelectMenu>
</template>
