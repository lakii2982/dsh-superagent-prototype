/** Reads the deployment mode once, so the panel and the Plugin Manager config view can choose their own content. */
import { useEffect, useState } from 'react'

export type PanelMode = 'standalone' | 'manager'
export function usePanelMode(): { mode?: PanelMode; error?: string } {
  const [state, setState] = useState<{ mode?: PanelMode; error?: string }>({})
  useEffect(() => {
    const abort = new AbortController()
    void fetch('/orchestrator/mode', { signal: abort.signal }).then(async response => {
      // A DSH web server without dsh-superagent's routes answers an empty 404; the standalone panel then explains it.
      if (response.status === 404) { setState({ mode: 'standalone' }); return }
      if (!response.ok) throw new Error(`Request failed (${response.status})`)
      const value = await response.json() as { mode?: PanelMode }
      setState({ mode: value.mode === 'manager' ? 'manager' : 'standalone' })
    }).catch(error => { if (!abort.signal.aborted) setState({ error: String(error) }) })
    return () => { abort.abort() }
  }, [])
  return state
}
