/** Reads the live deployment mode and updates open views after a confirmed local transition. */
import { useEffect, useState } from 'react'

export type PanelMode = 'standalone' | 'manager'
interface LiveMode { mode: PanelMode; desktopMultiRepository?: boolean; modeSwitchBlocked?: string; modeSwitchError?: string }
const MODE_CHANGED = 'dsh-superagent:mode-changed'

async function readMode(signal: AbortSignal): Promise<LiveMode | undefined> {
  const response = await fetch('/orchestrator/mode', { signal, cache: 'no-store' })
  // During remount DSH answers an empty 404 until the plugin registers its route.
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`Request failed (${response.status})`)
  const value = await response.json() as Partial<LiveMode>
  return { ...value, mode: value.mode === 'manager' ? 'manager' : 'standalone' }
}

/** Wait for the host to serve the requested mode before switching the visible panel. */
export async function confirmPanelMode(expected: PanelMode, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + 20_000
  while (!signal.aborted && Date.now() < deadline) {
    const live = await readMode(AbortSignal.any([signal, AbortSignal.timeout(2_000)])).catch(() => undefined)
    if (signal.aborted) break
    if (live?.mode === expected) {
      window.dispatchEvent(new CustomEvent<LiveMode>(MODE_CHANGED, { detail: live }))
      return true
    }
    if (live?.modeSwitchError) throw new Error(live.modeSwitchError)
    if (live?.modeSwitchBlocked) return false
    await new Promise(resolve => setTimeout(resolve, 350))
  }
  return false
}

export function usePanelMode(): Partial<LiveMode> & { error?: string } {
  const [state, setState] = useState<Partial<LiveMode> & { error?: string }>({})
  useEffect(() => {
    const abort = new AbortController()
    const changed = (event: Event) => {
      const live = (event as CustomEvent<LiveMode>).detail
      if (live?.mode !== 'standalone' && live?.mode !== 'manager') return
      abort.abort()
      setState(live)
    }
    window.addEventListener(MODE_CHANGED, changed)
    void readMode(abort.signal).then(live => {
      if (!abort.signal.aborted) setState(live ?? { mode: 'standalone' })
    }).catch(error => { if (!abort.signal.aborted) setState({ error: String(error) }) })
    return () => { abort.abort(); window.removeEventListener(MODE_CHANGED, changed) }
  }, [])
  return state
}
