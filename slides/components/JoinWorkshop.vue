<script setup lang="ts">
import { onMounted, ref } from 'vue'

const joined = ref(false)
const status = ref('')
const loading = ref(false)
const message = ref('')

async function readSession() {
  const response = await fetch('/api/me', { credentials: 'same-origin' })
  const result = await response.json()
  joined.value = Boolean(result.joined)
  status.value = result.status || ''
  return result
}

async function waitUntilReady() {
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await readSession()
    if (result.status === 'ready') {
      message.value = '接続完了。基礎編から始めてください。'
      return
    }
    if (!result.joined) throw new Error('セッションが見つかりません。もう一度参加してください。')
    status.value = 'starting'
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error('起動に時間がかかっています。少し待ってから接続状態を確認してください。')
}

onMounted(async () => {
  try {
    const result = await readSession()
    if (result.joined && result.status !== 'ready') {
      loading.value = true
      status.value = 'starting'
      await waitUntilReady()
    }
  } catch {
    message.value = '演習APIに接続できません。ページを再読み込みしてください。'
  } finally {
    loading.value = false
  }
})

async function join() {
  loading.value = true
  message.value = ''
  status.value = 'starting'
  try {
    const requestId = sessionStorage.getItem('floci-workshop-join-request') || crypto.randomUUID()
    sessionStorage.setItem('floci-workshop-join-request', requestId)
    const response = await fetch('/api/join', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId }),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || '接続に失敗しました')
    sessionStorage.removeItem('floci-workshop-join-request')
    joined.value = true
    await waitUntilReady()
  } catch (error) {
    status.value = ''
    message.value = String(error)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <section class="rounded-xl border border-gray-400/30 p-5 max-w-2xl bg-gray-500/5">
    <div v-if="joined && status === 'ready'" class="text-green-600 font-semibold">✓ 専用演習環境に接続済み</div>
    <div v-else-if="loading || status === 'starting'" class="font-semibold">専用MicroVMとFlociを準備中…</div>
    <form v-else @submit.prevent="join">
      <button type="submit" :disabled="loading" class="join-button rounded px-4 py-2 disabled:opacity-60">参加して環境を起動</button>
    </form>
    <p v-if="message" class="text-sm mt-2">{{ message }}</p>
    <p class="text-xs opacity-70 mt-2">会場コードやAWSアカウントは不要です。1人ずつ専用の実行環境を割り当てます。</p>
  </section>
</template>

<style scoped>
.join-button {
  border: 0;
  color: #fff;
  background: #333;
}

.join-button:hover:not(:disabled) {
  background: #1a1a1a;
}
</style>
