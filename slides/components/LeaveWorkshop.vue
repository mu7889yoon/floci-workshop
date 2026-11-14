<script setup lang="ts">
import { ref } from 'vue'
const busy = ref(false)
const message = ref('')

async function leave() {
  if (!confirm('MicroVMを停止しますか？')) return
  busy.value = true
  try {
    const response = await fetch('/api/leave', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || '終了できませんでした')
    message.value = result.cleanupPending ? '停止処理を再試行中です。' : '演習を終了しました。'
  } catch (error) {
    message.value = String(error)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex items-center gap-3 mt-3">
    <button @click="leave" :disabled="busy" class="rounded border border-gray-500 px-3 py-2 text-sm opacity-80 hover:opacity-100 disabled:opacity-50">
      {{ busy ? '停止中…' : '演習を終了してVMを停止' }}
    </button>
    <span v-if="message" class="text-sm">{{ message }}</span>
  </div>
</template>
