// Мини-агент в диалоге: показывать или нет — настройка браузера (localStorage), сервер не знает
import { ref } from 'vue'
import { ls } from './api'

const KEY = 'bot:companion'
export const companionOn = ref(ls.get(KEY) !== '0')
export function setCompanion(on: boolean) {
  companionOn.value = on
  ls.set(KEY, on ? '1' : '0')
}
