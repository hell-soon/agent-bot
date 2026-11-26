<script setup lang="ts">
import { reactive } from 'vue'
import { api } from '../lib/api'
import { loadDocReview, loadGh, store, toast } from '../lib/store'

const publishing = reactive(new Set<string>())

async function createIssue(id: string) {
  const repo = store.curRepo
  publishing.add(id)
  try {
    await api('/api/doc-review/issue', { repo, id })
    if (repo === store.curRepo) {
      await loadDocReview()
      void loadGh(true)
    }
  }
  catch (error) {
    toast(error instanceof Error
      ? error.message
      : 'Не удалось создать issue')
  }
  finally {
    publishing.delete(id)
  }
}
</script>

<template>
  <section
    v-if="store.docReview && (store.docReview.enabled || store.docReview.findings.length)"
    class="doc-review"
  >
    <h2>Документация после слияния</h2>
    <p
      v-if="store.docReview.error"
      class="error"
    >
      Проверка прервалась. Панель повторит её автоматически.
    </p>
    <p
      v-else-if="!store.docReview.findings.length"
      role="status"
    >
      {{ store.docReview.checking ? 'Проверяем слитые PR…' : 'Пока нет находок.' }}
    </p>
    <article
      v-for="finding in store.docReview.findings"
      :key="finding.id"
    >
      <header>
        <code>{{ finding.file }}:{{ finding.line }}</code>
        <a
          :href="finding.pr.url"
          target="_blank"
          rel="noopener noreferrer"
        >PR #{{ finding.pr.number }} · {{ finding.pr.title }} ↗</a>
      </header>
      <dl>
        <dt>Устаревший фрагмент</dt>
        <dd><pre>{{ finding.fragment }}</pre></dd>
        <dt>Предложение по правке</dt>
        <dd><pre>{{ finding.suggestion }}</pre></dd>
      </dl>
      <a
        v-if="finding.issue"
        class="btn sm"
        :href="finding.issue.url"
        target="_blank"
        rel="noopener noreferrer"
      >Issue #{{ finding.issue.number }} ↗</a>
      <button
        v-else
        class="btn sm"
        type="button"
        :disabled="publishing.has(finding.id)"
        @click="createIssue(finding.id)"
      >
        {{ publishing.has(finding.id) ? 'Создаём issue…' : 'Создать issue' }}
      </button>
    </article>
  </section>
</template>

<style scoped lang="scss">
.doc-review {
  margin-top: 28px;
  h2 {
    margin: 0 0 10px 2px;
    color: var(--muted);
    font-size: 13px;
    font-weight: 600;
  }
  p {
    color: var(--muted);
    font-size: 13px;
  }
  .error {
    color: var(--warn);
  }
  article {
    margin-bottom: 10px;
    padding: 14px;
    border: 1px solid var(--line);
    border-radius: 12px;
    font-size: 13px;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 14px;
    overflow-wrap: anywhere;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 4px 0 8px;
  }
  pre {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
}
</style>
