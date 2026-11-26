<script setup lang="ts">
// Вложения: превью картинок и плашки файлов; с removable — кнопка «убрать»
import type { Att } from '../lib/upload'
import { fileUrl } from '../lib/upload'

defineProps<{ files: Att[], removable?: boolean, busy?: number }>()
const emit = defineEmits<{ remove: [a: Att] }>()
</script>

<template>
  <div
    v-if="files.length || busy"
    class="atts"
  >
    <div
      v-for="a in files"
      :key="a.path"
      class="att"
      :class="{ img: a.image }"
      :title="a.name"
    >
      <a
        v-if="a.image"
        :href="fileUrl(a.path)"
        target="_blank"
      ><img
        :src="a.url || fileUrl(a.path)"
        :alt="a.name"
        loading="lazy"
      ></a>
      <a
        v-else
        class="fn"
        :href="fileUrl(a.path)"
        :download="a.name"
      >📄 {{ a.name }}</a>
      <button
        v-if="removable"
        type="button"
        class="x"
        title="Убрать"
        @click="emit('remove', a)"
      >
        ×
      </button>
    </div>
    <div
      v-for="i in busy || 0"
      :key="`b${i}`"
      class="att loading"
    >
      …
    </div>
  </div>
</template>

<style scoped lang="scss">
.atts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.att {
  position: relative;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--sunk);
  overflow: hidden;
  &.img {
    width: 72px;
    height: 72px;
    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
  }
  &.loading {
    width: 72px;
    height: 72px;
    display: grid;
    place-items: center;
    color: var(--muted);
  }
  .fn {
    display: block;
    color: var(--text);
    text-decoration: none;
    padding: 6px 26px 6px 10px;
    font-size: 12.5px;
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
.x {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 0;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}
</style>
