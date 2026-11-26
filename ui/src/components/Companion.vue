<script setup lang="ts">
// Мини-агент: SVG-колобок в правом нижнем углу диалога, показывает эмоцию ИИ (см. lib/mood.ts)
import type { Mood } from '../lib/mood'
import { computed } from 'vue'
import { setCompanion } from '../lib/companion'
import { MOOD_LABEL } from '../lib/mood'

const props = defineProps<{ mood: Mood, ai: string }>()

interface Face {
  mouth: string // рот, центр около (60, 88)
  fill?: boolean // рот открыт (залит)
  eyes: number // высота глаз: 1 — открыты, 0.15 — почти закрыты
  look?: [number, number] // куда смотрят зрачки
  brows: [number, number, number] // наклон левой и правой брови (°), сдвиг по высоте
  badge?: string // значок над головой
}

const FACES: Record<Mood, Face> = {
  calm: {
    mouth: 'M50 87 Q60 94 70 87',
    eyes: 1,
    brows: [0, 0, 0],
  },
  pleased: {
    mouth: 'M47 85 Q60 98 73 85',
    eyes: 0.8,
    brows: [-6, 6, -1],
  },
  happy: {
    mouth: 'M45 84 Q60 104 75 84 Q60 90 45 84',
    fill: true,
    eyes: 0.55,
    brows: [-10, 10, -3],
    badge: '✨',
  },
  thinking: {
    mouth: 'M52 90 Q60 89 68 87',
    eyes: 1,
    look: [3, -3],
    brows: [8, -4, -2],
    badge: '…',
  },
  working: {
    mouth: 'M53 89 Q60 89 67 89',
    eyes: 0.85,
    look: [0, 2],
    brows: [10, -10, 2],
    badge: '⚙',
  },
  curious: {
    mouth: 'M56 89 Q60 83 64 89 Q60 95 56 89',
    fill: true,
    eyes: 1.15,
    look: [-2, -1],
    brows: [-12, 0, -4],
    badge: '?',
  },
  confused: {
    mouth: 'M48 91 Q54 85 60 91 Q66 97 72 91',
    eyes: 1,
    look: [-2, 0],
    brows: [14, -14, -1],
    badge: '?!',
  },
  tired: {
    mouth: 'M50 92 Q60 86 70 92',
    eyes: 0.4,
    look: [0, 2],
    brows: [-14, 14, 2],
    badge: '💧',
  },
  sleepy: {
    mouth: 'M56 90 Q60 93 64 90',
    eyes: 0.15,
    brows: [0, 0, 2],
    badge: 'z',
  },
}

const face = computed(() => FACES[props.mood] || FACES.calm)
const label = computed(() => `${props.ai} · ${MOOD_LABEL[props.mood] || props.mood}`)
const pupil = computed(() => {
  const [x, y] = face.value.look || [0, 0]
  return { transform: `translate(${x}px, ${y}px)` }
})
const eyes = computed(() => ({ transform: `scaleY(${face.value.eyes})` }))
function brow(side: 0 | 1) {
  const [l, r, dy] = face.value.brows
  return { transform: `translateY(${dy}px) rotate(${side ? r : l}deg)` }
}
</script>

<template>
  <div
    class="companion"
    :class="[mood, ai.toLowerCase()]"
    :title="label"
  >
    <div class="tip">
      {{ label }}
    </div>
    <button
      class="hide"
      title="Скрыть мини-агента (вернуть — в настройках)"
      @click="setCompanion(false)"
    >
      ×
    </button>
    <svg
      viewBox="0 0 120 130"
      width="110"
      height="119"
      role="img"
      :aria-label="`Мини-агент: ${label}`"
    >
      <ellipse
        class="shadow"
        cx="60"
        cy="123"
        rx="30"
        ry="4"
      />
      <g class="bodyg">
        <line
          x1="60"
          y1="32"
          x2="60"
          y2="16"
          class="stroke"
        />
        <circle
          class="bulb"
          cx="60"
          cy="13"
          r="5"
        />
        <ellipse
          class="body"
          cx="60"
          cy="76"
          rx="44"
          ry="44"
        />
        <ellipse
          class="belly"
          cx="60"
          cy="84"
          rx="30"
          ry="26"
        />
        <ellipse
          class="cheek"
          cx="34"
          cy="84"
          rx="6"
          ry="3.5"
        />
        <ellipse
          class="cheek"
          cx="86"
          cy="84"
          rx="6"
          ry="3.5"
        />
        <g class="brows">
          <path
            d="M37 56 L51 56"
            class="stroke brow"
            :style="brow(0)"
          />
          <path
            d="M69 56 L83 56"
            class="stroke brow"
            :style="brow(1)"
          />
        </g>
        <g class="blink">
          <g
            class="eyes"
            :style="eyes"
          >
            <ellipse
              class="eye"
              cx="44"
              cy="69"
              rx="7"
              ry="8"
            />
            <ellipse
              class="eye"
              cx="76"
              cy="69"
              rx="7"
              ry="8"
            />
            <g :style="pupil">
              <circle
                class="pupil"
                cx="45"
                cy="70"
                r="3.6"
              />
              <circle
                class="pupil"
                cx="77"
                cy="70"
                r="3.6"
              />
            </g>
          </g>
        </g>
        <path
          class="mouth"
          :class="{ fill: face.fill }"
          :d="face.mouth"
          :style="{ d: `path('${face.mouth}')` }"
        />
      </g>
    </svg>
    <transition name="pop">
      <span
        v-if="face.badge"
        :key="mood"
        class="badge"
      >{{ face.badge }}</span>
    </transition>
  </div>
</template>

<style scoped lang="scss">
.companion {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 20;
  width: 110px;
  user-select: none;
  // свой цвет по ИИ, а не акцент темы: у Codex акцент чёрный или белый — лицо на нём не видно
  --c-base: #e08a66;
  --c-body: var(--c-base);
  --c-ink: #1d1d22;
  &.codex {
    --c-base: #7b9bff;
  }
  &:hover .tip,
  &:hover .hide {
    opacity: 1;
    transform: none;
  }
}
svg {
  display: block;
  overflow: visible;
}
.body {
  fill: var(--c-body);
  transition: fill 0.4s;
}
.belly {
  fill: #fff;
  opacity: 0.16;
}
.cheek {
  fill: #ff7a90;
  opacity: 0.35;
  transition: opacity 0.4s;
}
.shadow {
  fill: #000;
  opacity: 0.12;
}
.stroke {
  stroke: var(--c-ink);
  stroke-width: 3.4;
  stroke-linecap: round;
  fill: none;
}
.bulb {
  fill: var(--c-body);
  stroke: var(--c-ink);
  stroke-width: 3;
  transition: fill 0.4s;
}
.eye {
  fill: #fff;
}
.pupil {
  fill: var(--c-ink);
}
.mouth {
  fill: none;
  stroke: var(--c-ink);
  stroke-width: 3.4;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition:
    d 0.35s ease,
    fill 0.3s;
  &.fill {
    fill: var(--c-ink);
  }
}
// всё, что меняется плавно, крутится вокруг своего центра
.brow,
.eyes,
.blink,
.pupil,
.eyes > g,
.bodyg {
  transform-box: fill-box;
  transform-origin: center;
  transition: transform 0.35s ease;
}
.blink {
  animation: blink 4.6s infinite;
}
.bodyg {
  transform-origin: 50% 100%;
  animation: breathe 3.2s ease-in-out infinite;
}

// --- настроение ---
.working {
  .bodyg {
    animation: bob 0.7s ease-in-out infinite;
  }
  .bulb {
    animation: glow 0.7s ease-in-out infinite alternate;
  }
}
.thinking .bodyg {
  animation: sway 2.6s ease-in-out infinite;
}
.happy {
  .bodyg {
    animation: jump 0.9s cubic-bezier(0.3, 0, 0.4, 1) infinite;
  }
  .cheek {
    opacity: 0.7;
  }
  .bulb {
    fill: #ffd34d;
  }
}
.pleased .cheek {
  opacity: 0.55;
}
.curious .bodyg {
  animation: tilt 1.8s ease-in-out infinite;
}
.confused {
  --c-body: color-mix(in srgb, var(--c-base) 55%, var(--bad));
  .bodyg {
    animation: shake 2.4s ease-in-out infinite;
  }
}
.tired {
  --c-body: color-mix(in srgb, var(--c-base) 50%, #8a8a95);
  .bodyg {
    animation: breathe 5s ease-in-out infinite;
  }
}
.sleepy {
  --c-body: color-mix(in srgb, var(--c-base) 65%, #8a8a95);
  .blink {
    animation: none;
  }
  .bodyg {
    animation: breathe 4.5s ease-in-out infinite;
  }
}

// --- значок над головой и подсказка ---
.badge {
  position: absolute;
  top: -6px;
  right: 6px;
  min-width: 26px;
  height: 26px;
  padding: 0 6px;
  border-radius: 13px;
  display: grid;
  place-items: center;
  background: var(--card);
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
  animation: float 2.4s ease-in-out infinite;
}
.working .badge {
  animation: spin 2s linear infinite;
}
.tip {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 0;
  white-space: nowrap;
  padding: 4px 9px;
  border-radius: 8px;
  background: var(--card);
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
  font-size: 12px;
  color: var(--muted);
  opacity: 0;
  transform: translateY(4px);
  transition: 0.15s;
  pointer-events: none;
}
.hide {
  position: absolute;
  top: 18px;
  left: 0;
  width: 20px;
  height: 20px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--muted);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
  &:focus-visible {
    opacity: 1;
  }
}
.pop-enter-active {
  transition: 0.25s cubic-bezier(0.3, 1.6, 0.5, 1);
}
.pop-enter-from {
  transform: scale(0.3);
  opacity: 0;
}

@keyframes blink {
  0%,
  92%,
  100% {
    transform: scaleY(1);
  }
  95% {
    transform: scaleY(0.1);
  }
}
@keyframes breathe {
  0%,
  100% {
    transform: scale(1, 1);
  }
  50% {
    transform: scale(1.025, 0.975);
  }
}
@keyframes bob {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-3px);
  }
}
@keyframes sway {
  0%,
  100% {
    transform: rotate(-3deg);
  }
  50% {
    transform: rotate(3deg);
  }
}
@keyframes tilt {
  0%,
  100% {
    transform: rotate(0);
  }
  40%,
  60% {
    transform: rotate(-8deg);
  }
}
@keyframes jump {
  0%,
  100% {
    transform: translateY(0) scale(1.04, 0.96);
  }
  40% {
    transform: translateY(-14px) scale(0.97, 1.03);
  }
}
@keyframes shake {
  0%,
  70%,
  100% {
    transform: rotate(0);
  }
  75%,
  85% {
    transform: rotate(-5deg);
  }
  80%,
  90% {
    transform: rotate(5deg);
  }
}
@keyframes glow {
  to {
    fill: #ffd34d;
  }
}
@keyframes float {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-4px);
  }
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .companion * {
    animation: none !important;
  }
}
// на узком экране — меньше и выше строки ответа, на совсем узком — прячем
@media (max-width: 1180px) {
  .companion {
    transform: scale(0.75);
    transform-origin: 100% 100%;
    right: 12px;
    bottom: 92px;
  }
}
@media (max-width: 640px) {
  .companion {
    display: none;
  }
}
</style>
