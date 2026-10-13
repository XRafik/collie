<script setup lang="ts">
defineProps<{ text: string }>();
const emit = defineEmits<{ edit: [text: string]; remove: [] }>();
</script>

<template>
  <div class="flex items-start gap-2 font-sans" data-testid="draft-edit">
    <UTextarea
      class="flex-1"
      :model-value="text"
      autoresize
      :rows="1"
      @update:model-value="(now: string) => emit('edit', now)"
    />
    <UButton
      size="xs"
      variant="ghost"
      icon="i-lucide-trash-2"
      aria-label="Remove comment"
      data-testid="remove-draft"
      @click="emit('remove')"
    />
  </div>
</template>
