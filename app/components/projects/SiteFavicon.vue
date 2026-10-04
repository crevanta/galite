<script setup>
import { ref, watch } from 'vue'

const props = defineProps({
  src: { type: String, default: '' },
  fallbackIcon: { type: String, default: 'ri:global-line' },
})
const broken = ref(false)
watch(() => props.src, () => { broken.value = false })
</script>

<template>
  <img
    v-if="src && !broken"
    :key="src"
    :src="src"
    class="size-full object-contain"
    loading="lazy"
    decoding="async"
    referrerpolicy="no-referrer"
    alt=""
    @error="broken = true"
  />
  <NuxtIcon v-else :name="fallbackIcon" class="size-3 text-gray-400" />
</template>
