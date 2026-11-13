<script setup lang="ts">
import type * as Monaco from 'monaco-editor'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useNav } from '@slidev/client/composables/useNav.ts'
import { lockShortcuts } from '@slidev/client/state/index.ts'
import basicStarter from './exercises/basic.ts?raw'
import advancedStarter from './exercises/advanced.ts?raw'

type Stage = 'basic' | 'advanced'
type EditorModel = Monaco.editor.ITextModel
type EditorInstance = Monaco.editor.IStandaloneCodeEditor

let editor: EditorInstance | undefined
let terminal: Terminal | undefined
let fitAddon: FitAddon | undefined
let socket: WebSocket | undefined
let monacoApi: typeof import('monaco-editor') | undefined
let pollTimer: ReturnType<typeof setInterval> | undefined
let syncTimer: ReturnType<typeof setTimeout> | undefined
let retryTimer: ReturnType<typeof setTimeout> | undefined
let loadingEditor: Promise<void> | undefined
let terminalResizeObserver: ResizeObserver | undefined
let themeObserver: MutationObserver | undefined
let releaseShortcuts: (() => void) | undefined
let terminalInputSubscription: { dispose(): void } | undefined
let terminalResizeSubscription: { dispose(): void } | undefined
let syncPromise: Promise<boolean> | undefined
let syncRevision = 0
let syncedRevision = -1
let connectingTerminal = false
let applyingRemoteFiles = false
let connectionAttempt = 0

const nav = useNav()
const slideExercise = computed<Stage | null>(() => {
  const stage = nav.currentFrontmatter.value.exercise
  return stage === 'basic' || stage === 'advanced' ? stage : null
})
const visible = computed(() => slideExercise.value !== null)
const activeStage = ref<Stage>('basic')
const ready = ref(false)
const sessionLabel = ref('参加待ち')
const terminalLabel = ref('Bashは演習開始後に接続します')
const editorHost = ref<HTMLDivElement>()
const terminalHost = ref<HTMLDivElement>()
const starters: Record<Stage, string> = {
  basic: basicStarter.trimEnd(),
  advanced: advancedStarter.trimEnd(),
}
const stateKey = 'floci-workshop-workbench-v2'
const codeByStage = reactive<Record<Stage, string>>({ ...starters })
const models: Partial<Record<Stage, EditorModel>> = {}
const viewStates: Partial<Record<Stage, Monaco.editor.ICodeEditorViewState>> = {}
const editorFontSize = ref(13)
const terminalFontSize = ref(13)

function boundedFontSize(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(11, Math.min(24, Math.round(value)))
    : 13
}

watch(slideExercise, (stage) => {
  if (!stage) return
  activeStage.value = stage
}, { immediate: true })

function lockTerminalShortcuts() {
  releaseShortcuts ??= lockShortcuts()
}

function unlockTerminalShortcuts() {
  releaseShortcuts?.()
  releaseShortcuts = undefined
}

function persist() {
  try {
    sessionStorage.setItem(stateKey, JSON.stringify({
      codeByStage,
      viewStates,
      editorFontSize: editorFontSize.value,
      terminalFontSize: terminalFontSize.value,
    }))
  } catch {
    // The editor remains usable when browser storage is unavailable.
  }
}

function restore() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(stateKey) || '{}')
    for (const stage of ['basic', 'advanced'] as const) {
      if (typeof saved.codeByStage?.[stage] === 'string') codeByStage[stage] = saved.codeByStage[stage]
      if (saved.viewStates?.[stage] && typeof saved.viewStates[stage] === 'object') {
        viewStates[stage] = saved.viewStates[stage]
      }
    }
    editorFontSize.value = boundedFontSize(saved.editorFontSize)
    terminalFontSize.value = boundedFontSize(saved.terminalFontSize)
  } catch {
    // Start from the exercise files when no saved state is available.
  }
}

function postJSON(path: string, body: unknown) {
  return fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function queueFileSync() {
  if (applyingRemoteFiles) return
  syncRevision++
  if (!ready.value) return
  clearTimeout(syncTimer)
  syncTimer = setTimeout(() => { void syncEditorFiles() }, 300)
}

async function syncEditorFiles(): Promise<boolean> {
  clearTimeout(syncTimer)
  if (!ready.value) return false
  if (!syncPromise) {
    syncPromise = (async () => {
      while (ready.value && syncedRevision < syncRevision) {
        const revision = syncRevision
        try {
          const response = await postJSON('/api/sync', { files: { ...codeByStage } })
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}))
            terminalLabel.value = payload.error || `エディタ同期エラー · HTTP ${response.status}`
            return false
          }
          syncedRevision = revision
        } catch {
          terminalLabel.value = 'エディタをMicroVMへ同期できません'
          return false
        }
      }
      return ready.value && syncedRevision === syncRevision
    })()
  }
  const activeSync = syncPromise
  const result = await activeSync
  if (syncPromise === activeSync) syncPromise = undefined
  return result && syncedRevision === syncRevision
}

async function initializeEditor() {
  if (editor || !editorHost.value) return
  if (loadingEditor) return loadingEditor
  loadingEditor = (async () => {
    const [loadedMonaco, { default: EditorWorker }, { default: TypeScriptWorker }] = await Promise.all([
      import('monaco-editor'),
      import('monaco-editor/editor/editor.worker?worker'),
      import('monaco-editor/language/typescript/ts.worker?worker'),
    ])
    monacoApi = loadedMonaco
    ;(window as any).MonacoEnvironment = {
      getWorker(_moduleId: string, label: string) {
        return label === 'typescript' || label === 'javascript'
          ? new TypeScriptWorker()
          : new EditorWorker()
      },
    }
    const setEditorTheme = () => monacoApi!.editor.setTheme(
      document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs',
    )
    setEditorTheme()
    themeObserver = new MutationObserver(setEditorTheme)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    monacoApi.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: false,
    })
    for (const stage of ['basic', 'advanced'] as const) {
      const path = stage === 'basic' ? 'tests/idempotency.spec.ts' : 'tests/advanced.spec.ts'
      const uri = monacoApi.Uri.parse(`file:///workshop/${path}`)
      monacoApi.editor.getModel(uri)?.dispose()
      const model = monacoApi.editor.createModel(codeByStage[stage], 'typescript', uri)
      model.onDidChangeContent(() => {
        codeByStage[stage] = model.getValue()
        persist()
        queueFileSync()
      })
      models[stage] = model
    }
    editor = monacoApi.editor.create(editorHost.value!, {
      model: models[activeStage.value],
      automaticLayout: true,
      minimap: { enabled: false },
      lineNumbers: 'on',
      wordWrap: 'on',
      wrappingIndent: 'same',
      scrollBeyondLastLine: false,
      fontSize: editorFontSize.value,
      tabSize: 2,
      padding: { top: 14, bottom: 14 },
    })
    editor.onDidFocusEditorWidget(lockTerminalShortcuts)
    editor.onDidBlurEditorWidget(unlockTerminalShortcuts)
    if (slideExercise.value) editor.revealLineInCenter(slideExercise.value === 'basic' ? 9 : 14)
  })()
  try {
    await loadingEditor
  } catch (error) {
    terminalLabel.value = `エディタを読み込めませんでした: ${String(error)}`
  } finally {
    loadingEditor = undefined
  }
}

watch(activeStage, (stage, previousStage) => {
  if (editor && previousStage) {
    viewStates[previousStage] = editor.saveViewState() || undefined
    persist()
  }
  const model = models[stage]
  if (editor && model && editor.getModel() !== model) {
    editor.setModel(model)
    const viewState = viewStates[stage]
    if (viewState) editor.restoreViewState(viewState)
    else editor.revealLineInCenter(stage === 'basic' ? 9 : 14)
  }
})

function resizeTerminal() {
  if (!visible.value) return
  requestAnimationFrame(() => {
    try { fitAddon?.fit() } catch { /* The pane may still be transitioning. */ }
  })
}

async function initializeTerminal() {
  if (terminal || !terminalHost.value) return
  terminal = new Terminal({
    allowProposedApi: false,
    convertEol: false,
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: terminalFontSize.value,
    scrollback: 4000,
    theme: {
      background: '#0b1017',
      foreground: '#d6deeb',
      cursor: '#6ee7b7',
      selectionBackground: '#40536d',
    },
  })
  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.open(terminalHost.value)
  terminalInputSubscription = terminal.onData(data => {
    if (!ready.value || socket?.readyState !== WebSocket.OPEN) return
    const currentSocket = socket
    if (data.includes('\r')) {
      void syncEditorFiles().then((ok) => {
        if (ok && currentSocket.readyState === WebSocket.OPEN) {
          currentSocket.send(JSON.stringify({ type: 'input', data }))
        }
      })
      return
    }
    currentSocket.send(JSON.stringify({ type: 'input', data }))
  })
  terminal.textarea?.addEventListener('focus', lockTerminalShortcuts)
  terminal.textarea?.addEventListener('blur', unlockTerminalShortcuts)
  terminalResizeObserver = new ResizeObserver(resizeTerminal)
  terminalResizeObserver.observe(terminalHost.value)
  terminalResizeSubscription = terminal.onResize(({ cols, rows }) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols, rows }))
  })
  resizeTerminal()
}

async function connectTerminal() {
  if (!ready.value || !visible.value || connectingTerminal || socket?.readyState === WebSocket.OPEN) return
  connectingTerminal = true
  const attempt = ++connectionAttempt
  try {
    if (!await syncEditorFiles()) throw new Error('エディタをMicroVMへ同期できませんでした')
    const response = await postJSON('/api/terminal-token', {})
    const ticket = await response.json()
    if (!response.ok) throw new Error(ticket.error || `HTTP ${response.status}`)
    if (attempt !== connectionAttempt || !visible.value) return
    const endpoint = new URL(ticket.endpoint)
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
    endpoint.pathname = '/terminal'
    endpoint.search = ''
    endpoint.hash = ''
    const terminalSocket = new WebSocket(endpoint.toString(), [
      'lambda-microvms',
      `lambda-microvms.authentication.${ticket.token}`,
      `lambda-microvms.port.${ticket.port}`,
      'floci-terminal',
    ])
    socket = terminalSocket
    terminalLabel.value = 'Bashへ接続中…'
    terminalSocket.addEventListener('open', () => {
      if (socket !== terminalSocket) return
      terminalLabel.value = 'MicroVMのBashに接続済み'
      resizeTerminal()
      if (terminal && terminalSocket.readyState === WebSocket.OPEN) {
        terminalSocket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }))
      }
    })
    terminalSocket.addEventListener('message', event => {
      if (socket !== terminalSocket || typeof event.data !== 'string' || !terminal) return
      let frame: { type?: string; data?: unknown; files?: Partial<Record<Stage, string>> }
      try { frame = JSON.parse(event.data) } catch { return }
      if ((frame.type === 'output' || frame.type === 'replay') && typeof frame.data === 'string') {
        if (frame.type === 'replay') terminal.reset()
        terminal.write(frame.data)
      }
      if (frame.type === 'files' && frame.files) {
        // A file watcher can echo an older snapshot while a newer editor change
        // is still waiting for /api/sync. Never let that snapshot replace the
        // active Monaco model (and move its caret) while local edits are pending.
        if (syncedRevision < syncRevision) return
        applyingRemoteFiles = true
        try {
          for (const stage of ['basic', 'advanced'] as const) {
            const source = frame.files[stage]
            const model = models[stage]
            if (typeof source !== 'string' || !model || source === model.getValue()) continue
            const isActiveModel = editor?.getModel() === model
            const viewState = isActiveModel ? editor?.saveViewState() : undefined
            codeByStage[stage] = source
            model.setValue(source)
            if (isActiveModel && viewState && editor?.getModel() === model) {
              editor.restoreViewState(viewState)
            }
          }
        } finally {
          applyingRemoteFiles = false
          persist()
        }
      }
    })
    terminalSocket.addEventListener('close', () => {
      if (socket !== terminalSocket) return
      socket = undefined
      terminalLabel.value = ready.value ? 'Bash接続が切れました。再接続します…' : '演習環境を確認中…'
      clearTimeout(retryTimer)
      if (ready.value && visible.value) retryTimer = setTimeout(() => { void connectTerminal() }, 700)
    })
    terminalSocket.addEventListener('error', () => {
      if (socket === terminalSocket) terminalLabel.value = 'Bashへ接続できません。再試行します…'
    })
  } catch (error) {
    if (attempt === connectionAttempt) terminalLabel.value = String(error)
  } finally {
    connectingTerminal = false
  }
}

async function refreshSession() {
  try {
    const response = await fetch('/api/me', { credentials: 'same-origin' })
    const session = await response.json()
    ready.value = Boolean(session.joined && session.status === 'ready')
    sessionLabel.value = ready.value
      ? '演習環境 接続済み'
      : session.joined ? '演習環境 起動中' : '参加待ち'
    if (ready.value && visible.value) {
      await initializeTerminal()
      void connectTerminal()
    }
  } catch {
    ready.value = false
    sessionLabel.value = 'APIに未接続'
    terminalLabel.value = '演習環境の状態を取得できません'
  }
}

watch(visible, async (shown) => {
  if (!shown) return
  await nextTick()
  await initializeEditor()
  await initializeTerminal()
  resizeTerminal()
  await refreshSession()
})

watch(ready, (isReady) => {
  if (isReady && visible.value) void connectTerminal()
})

async function clearTerminal() {
  terminal?.clear()
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'clear' }))
}

function changeEditorFontSize(delta: number) {
  editorFontSize.value = boundedFontSize(editorFontSize.value + delta)
  editor?.updateOptions({ fontSize: editorFontSize.value })
  persist()
}

function changeTerminalFontSize(delta: number) {
  terminalFontSize.value = boundedFontSize(terminalFontSize.value + delta)
  if (terminal) terminal.options.fontSize = terminalFontSize.value
  resizeTerminal()
  persist()
}

async function resetWorkshop() {
  if (!confirm('演習コードを初期状態に戻し、Bashを再起動しますか？')) return
  try {
    const response = await postJSON('/api/reset', {})
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'Reset failed')
    for (const stage of ['basic', 'advanced'] as const) {
      codeByStage[stage] = starters[stage]
      models[stage]?.setValue(starters[stage])
    }
    persist()
    syncRevision++
    syncedRevision = -1
    terminal?.reset()
    terminalLabel.value = 'Bashを再起動しています…'
    await syncEditorFiles()
  } catch (error) {
    terminal?.writeln(`\r\nReset failed: ${String(error)}`)
  }
}

onMounted(async () => {
  restore()
  if (visible.value) {
    await nextTick()
    await initializeEditor()
    await initializeTerminal()
    await refreshSession()
  }
  pollTimer = setInterval(() => {
    if (visible.value) void refreshSession()
  }, 4000)
})

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
  clearTimeout(syncTimer)
  clearTimeout(retryTimer)
  connectionAttempt++
  socket?.close()
  terminalResizeObserver?.disconnect()
  themeObserver?.disconnect()
  terminalInputSubscription?.dispose()
  terminal?.textarea?.removeEventListener('focus', lockTerminalShortcuts)
  terminal?.textarea?.removeEventListener('blur', unlockTerminalShortcuts)
  terminalResizeSubscription?.dispose()
  releaseShortcuts?.()
  terminal?.dispose()
  if (editor) viewStates[activeStage.value] = editor.saveViewState() || undefined
  persist()
  editor?.dispose()
  for (const model of Object.values(models)) model?.dispose()
})

const filenames: Record<Stage, string> = {
  basic: 'tests/idempotency.spec.ts',
  advanced: 'tests/advanced.spec.ts',
}
</script>

<template>
  <section v-show="visible" class="workbench" aria-label="演習ワークスペース">
    <div class="pane editor-pane">
      <div class="pane-tools editor-tools" aria-label="エディタ操作">
        <span class="file-name">{{ filenames[activeStage] }}</span>
        <div class="tool-group font-controls" aria-label="エディタ文字サイズ">
          <button title="エディタの文字を小さく" aria-label="エディタの文字を小さく" @click="changeEditorFontSize(-1)">A−</button>
          <span aria-live="polite">{{ editorFontSize }}</span>
          <button title="エディタの文字を大きく" aria-label="エディタの文字を大きく" @click="changeEditorFontSize(1)">A＋</button>
        </div>
        <button class="tool-button reset-button" :disabled="!ready" title="コードとBashを初期化" @click="resetWorkshop">Reset</button>
      </div>
      <div ref="editorHost" class="editor-host" />
    </div>

    <div class="pane terminal-pane">
      <div class="pane-tools terminal-tools" aria-label="ターミナル操作">
        <span class="terminal-state" :class="{ ready }" :title="`${sessionLabel} · ${terminalLabel}`"><i />{{ terminalLabel }}</span>
        <div class="tool-group font-controls" aria-label="ターミナル文字サイズ">
          <button title="ターミナルの文字を小さく" aria-label="ターミナルの文字を小さく" @click="changeTerminalFontSize(-1)">A−</button>
          <span aria-live="polite">{{ terminalFontSize }}</span>
          <button title="ターミナルの文字を大きく" aria-label="ターミナルの文字を大きく" @click="changeTerminalFontSize(1)">A＋</button>
        </div>
        <button class="tool-button" title="ターミナル画面を消去" aria-label="ターミナル画面を消去" @click="clearTerminal">消去</button>
        <nav class="slide-nav" aria-label="スライド移動">
          <button title="前のスライド" :disabled="!nav.hasPrev.value" @click="nav.prevSlide()">←</button>
          <button title="次のスライド" :disabled="!nav.hasNext.value" @click="nav.nextSlide()">→</button>
        </nav>
      </div>
      <div ref="terminalHost" class="terminal-host" aria-label="参加者専用MicroVMのBash" />
    </div>
  </section>
</template>

<style>
.workbench {
  position: absolute;
  z-index: 30;
  inset: auto 0 0;
  height: 60%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  color: #d6deeb;
  background: #10151e;
  border-top: 1px solid #283446;
  box-shadow: 0 -12px 28px #0b101a30;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.pane { position: relative; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.editor-pane { background: #111823; border-right: 1px solid #283446; }
.terminal-pane { background: #0b1017; }
.pane-tools {
  position: absolute;
  z-index: 2;
  top: 5px;
  left: 8px;
  right: 8px;
  min-height: 27px;
  display: flex;
  align-items: center;
  gap: 5px;
  pointer-events: none;
}
.file-name { min-width: 0; flex: 1; overflow: hidden; color: #9cacbf; font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; white-space: nowrap; text-shadow: 0 1px 3px #0b1017; pointer-events: auto; }
.tool-group, .tool-button, .slide-nav { pointer-events: auto; }
.tool-group { display: inline-flex; align-items: center; gap: 2px; padding: 2px; border: 1px solid #344154; border-radius: 5px; color: #c6d1df; background: #111823dd; box-shadow: 0 2px 8px #0003; }
.font-controls button { min-width: 25px; height: 22px; padding: 0 4px; border: 0; border-radius: 3px; color: #d6deeb; background: transparent; cursor: pointer; font-size: 11px; font-weight: 600; }
.font-controls button:hover { color: #6ee7b7; background: #253244; }
.font-controls span { min-width: 16px; color: #9cacbf; font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; text-align: center; }
.tool-button { min-width: 30px; height: 27px; padding: 0 6px; border: 1px solid #344154; border-radius: 5px; color: #aab8c9; background: #111823dd; box-shadow: 0 2px 8px #0003; cursor: pointer; font-size: 10px; }
.tool-button:hover:not(:disabled) { color: #fff; border-color: #6ee7b7; }
.tool-button:disabled { cursor: not-allowed; opacity: 0.45; }
.terminal-state { min-width: 0; flex: 1; display: inline-flex; align-items: center; gap: 6px; overflow: hidden; color: #91a0b4; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; text-shadow: 0 1px 3px #0b1017; }
.terminal-state i { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: #fbbf24; }
.terminal-state.ready i { background: #4ade80; box-shadow: 0 0 7px #4ade8070; }
.slide-nav { display: flex; gap: 4px; margin-left: 4px; }
.slide-nav button { width: 26px; height: 25px; border: 1px solid #344154; border-radius: 4px; color: #c6d1df; background: #1b2533; cursor: pointer; }
.slide-nav button:hover:not(:disabled) { border-color: #6ee7b7; color: #6ee7b7; }
.slide-nav button:disabled { opacity: 0.3; cursor: default; }
.editor-host { flex: 1; min-height: 0; padding-top: 32px; }
.terminal-host { flex: 1; min-height: 0; padding: 34px 12px 6px; background: #0b1017; overflow: hidden; }
.terminal-host .xterm { height: 100%; }
.terminal-host .xterm-viewport { scrollbar-color: #3a4657 #0b1017; }

@media (max-width: 900px) {
  .pane-tools { left: 5px; right: 5px; gap: 3px; }
  .file-name { font-size: 9px; }
  .terminal-state { font-size: 9px; }
  .tool-button { min-width: 25px; padding: 0 4px; }
  .font-controls button { min-width: 22px; }
  .editor-host { padding-top: 30px; }
  .terminal-host { padding: 32px 6px 6px; }
  .slide-nav button { width: 22px; height: 23px; }
}

@media (max-width: 520px) {
  .workbench { height: 60%; }
  .file-name { max-width: 38%; }
  .terminal-state { font-size: 8px; }
  .tool-group { gap: 0; }
  .font-controls button { min-width: 20px; font-size: 10px; }
  .tool-button { font-size: 9px; }
  .slide-nav { gap: 2px; margin-left: 0; }
}
</style>
