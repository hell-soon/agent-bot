<script setup lang="ts">
// Значки в стиле lucide: тонкая линия, currentColor
defineProps<{ name: string, size?: number }>()
const P: Record<string, string> = {
  bot: '<rect x="4.5" y="8" width="15" height="11.5" rx="4"/><path d="M12 8V5"/><circle cx="12" cy="3.6" r="1.1" fill="currentColor" stroke="none"/><path d="M9.5 13.2v.6M14.5 13.2v.6"/><path d="M2.5 13v2M21.5 13v2"/>',
  task: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  issue: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1.5"/>',
  idea: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>',
  bug: '<path d="M9 7.1V6a3 3 0 1 1 6 0v1.1M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6zM12 20v-9M6 13H2M22 13h-4"/>',
  pr: '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M6 9v12M13 6h3a2 2 0 0 1 2 2v7"/>',
  queue: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  chain: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  triage: '<path d="M3 6h18M7 12h10M10 18h4"/>',
  tickets: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5"/>',
  gear: '<path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.8l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.8v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  mem: '<path d="M12 5a3 3 0 1 0-6 0 3 3 0 0 0-3 3c0 1.2.7 2.2 1.7 2.7A3 3 0 0 0 6 16a3 3 0 0 0 6 0V5zM12 5a3 3 0 1 1 6 0 3 3 0 0 1 3 3c0 1.2-.7 2.2-1.7 2.7A3 3 0 0 1 18 16a3 3 0 0 1-6 0"/>',
  swap: '<path d="M7 16V4M3 8l4-4 4 4M17 8v12M21 16l-4 4-4-4"/>',
  home: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  limit: '<path d="M12 20a8 8 0 1 0-8-8M12 12l4-3"/>',
  clip: '<path d="M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
  graph: '<circle cx="5" cy="6" r="2.2"/><circle cx="18" cy="5" r="2.2"/><circle cx="12" cy="13" r="2.6"/><circle cx="6" cy="19" r="2.2"/><circle cx="19" cy="18" r="2.2"/><path d="M6.8 7.3l3.4 3.9M16.4 6.4l-2.9 4.6M10.4 14.9l-2.8 2.6M14.2 14.5l3 2.3"/>',
  arch: '<rect x="2.5" y="9.5" width="5" height="5" rx="1"/><rect x="16.5" y="3" width="5" height="5" rx="1"/><rect x="16.5" y="16" width="5" height="5" rx="1"/><path d="M7.5 12c5 0 4-6.5 9-6.5M7.5 12c5 0 4 6.5 9 6.5"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  dot: '<circle cx="12" cy="12" r="4"/>',
  ext: '<path d="M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
}
</script>

<template>
  <svg
    class="icon"
    :width="size || 18"
    :height="size || 18"
    viewBox="0 0 24 24"
    aria-hidden="true"
    v-html="P[name] || P.task"
  />
</template>

<style scoped>
.icon {
  flex: none;
  stroke: currentColor;
  fill: none;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
