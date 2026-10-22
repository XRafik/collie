<script setup lang="ts">
import type { SelectMenuItem } from "@nuxt/ui";
import { type ChoiceSelect, typedModel } from "../../../src/shared/chat-choices";

const props = defineProps<{ select: ChoiceSelect }>();
const emit = defineEmits<{ choose: [value: string] }>();

const items = computed((): SelectMenuItem[][] => [
  props.select.options.map(({ value, label, description }) =>
    description === undefined ? { value, label } : { value, label, description },
  ),
  ...(props.select.note === null ? [] : [[{ type: "label" as const, label: props.select.note }]]),
]);
</script>

<template>
  <USelectMenu
    :model-value="select.value"
    :items="items"
    value-key="value"
    :aria-label="select.name"
    :search-input="{
      placeholder: 'Search or type a model id',
      'aria-label': 'Search or type a model id',
    }"
    create-item
    size="sm"
    color="neutral"
    variant="soft"
    class="max-w-full"
    :content="{ class: 'min-w-72' }"
    @update:model-value="(value: unknown) => emit('choose', String(value))"
    @create="(id: string) => emit('choose', id.trim())"
  >
    {{ select.label }}
    <template #create-item-label="{ item }">{{ typedModel(item) }}</template>
  </USelectMenu>
</template>
