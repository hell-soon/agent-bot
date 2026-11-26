// Вложения: загрузка в uploads/ бота (ИИ получает пути), превью, вставка из буфера и перетаскивание
import { ref } from 'vue'
import { toast } from './store'

export interface Att { path: string, name: string, image: boolean, url?: string }
export const fileUrl = (p: string) => `/api/file?p=${encodeURIComponent(p)}`

async function uploadOne(f: File): Promise<Att> {
  const r = await fetch('/api/upload', {
    method: 'POST',
    headers: { 'x-name': encodeURIComponent(f.name || 'image.png'), 'content-type': f.type || 'application/octet-stream' },
    body: f,
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok)
    throw new Error(d.error || r.statusText)
  return { ...d, url: d.image ? URL.createObjectURL(f) : undefined }
}

// Список вложений для формы: add — из input/буфера/перетаскивания, clear — после отправки
export function useAttach(max = 10) {
  const atts = ref<Att[]>([])
  const busy = ref(0)
  async function add(files: Iterable<File> | null | undefined) {
    // копия сразу: FileList «живой» — после сброса input он пустеет
    for (const f of [...(files || [])]) {
      if (atts.value.length + busy.value >= max) { toast(`Не больше ${max} файлов`); break }
      busy.value++
      try { atts.value.push(await uploadOne(f)) }
      catch (e: any) { toast(`${f.name}: ${e.message}`) }
      finally { busy.value-- }
    }
  }
  function onPaste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.files || [])]
    if (!files.length)
      return
    e.preventDefault(); add(files)
  }
  function onDrop(e: DragEvent) {
    if (!e.dataTransfer?.files.length)
      return
    e.preventDefault(); add(e.dataTransfer.files)
  }
  function remove(a: Att) {
    if (a.url)
      URL.revokeObjectURL(a.url)
    atts.value = atts.value.filter(x => x !== a)
  }
  function clear() { atts.value.forEach(a => a.url && URL.revokeObjectURL(a.url)); atts.value = [] }
  const paths = () => atts.value.map(a => a.path)
  return { atts, busy, add, onPaste, onDrop, remove, clear, paths }
}
