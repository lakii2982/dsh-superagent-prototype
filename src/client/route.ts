/** Typed panel routes, route parser, and sessionStorage location history. */
import { THREAD_FILTERS, TICKET_FILTERS, type ThreadFilter, type TicketFilter } from '../app/api.ts'
import type { SetupPlace } from '../setup.ts'
import { DECISION_FILTERS, type DecisionFilter } from './api.ts'
import type { T } from './text.ts'

export const SETTINGS_GROUPS = ['source', 'eval', 'execution', 'prompts', 'deployment'] as const
export type SettingsGroup = typeof SETTINGS_GROUPS[number]
/** The manager control-plane pages, which belong to no single repository. */
export const MANAGER_AREAS = ['repositories', 'deliveries', 'bindings', 'feishu'] as const
export type ManagerArea = typeof MANAGER_AREAS[number]
/** Which repository's panel a page belongs to; absent in a standalone deployment. */
interface RepoScope { repo?: string }
/** A page of the repository panel: the same routes in both a standalone deployment and the manager's repository context. */
export type RepoRoute = ({ page: 'overview' | 'source' | 'repository'; id?: undefined; query?: undefined } & RepoScope)
  | ({ page: 'trigger'; id?: undefined; query?: { filter?: ThreadFilter } } & RepoScope)
  | ({ page: 'trigger'; id: string; query?: { trigger?: string } } & RepoScope)
  | ({ page: 'eval'; id?: undefined; query?: { filter?: DecisionFilter; window?: '24h' } } & RepoScope)
  | ({ page: 'execution'; id?: undefined; query?: { filter?: TicketFilter } } & RepoScope)
  | ({ page: 'execution'; id: string; query?: undefined } & RepoScope)
  | ({ page: 'settings'; id?: undefined; query: { group: SettingsGroup; source?: string; version?: string } } & RepoScope)
export type Route = RepoRoute | { page: 'manager'; id?: undefined; query: { area: ManagerArea; bindingRepositoryId?: string } }
export const HOME: Route = { page: 'overview' }
export const MANAGER_HOME: Route = { page: 'manager', query: { area: 'repositories' } }
export const MANAGER_ROUTE_KEY = 'dsh-superagent/manager/route'
export const MANAGER_NAV_EVENT = 'dsh-superagent:manager-navigate'
/** A Plugin Manager shortcut works both when the panel is mounted and when the host mounts it next. */
export function openManagerArea(area: ManagerArea): void {
  const route: Route = { page: 'manager', query: { area } }
  remember({ route, stack: [] }, MANAGER_ROUTE_KEY)
  window.dispatchEvent(new CustomEvent<Route>(MANAGER_NAV_EVENT, { detail: route }))
}
export const settingsRoute = (group: SettingsGroup, query: { source?: string; version?: string } = {}): Route =>
  ({ page: 'settings', query: { group, ...query } })
export const setupPage = (place: SetupPlace): Route =>
  place === 'deployment' ? settingsRoute('deployment') : settingsRoute('source', { source: place })
export const routeLabel = (t: T, route: Route): string => {
  if (route.page === 'manager') return t(route.query.area === 'repositories' ? 'manager.manageRepositories' : `manager.${route.query.area}`)
  return route.id ? t(route.page === 'trigger' ? 'term.thread' : 'term.ticket')
    : route.page === 'repository' ? t('nav.repository') : t(`tab.${route.page}`)
}

const pick = <V extends string>(values: readonly V[], value: unknown): V | undefined => values.find(item => item === value)
function compact<Q extends object>(query: Q): Q | undefined {
  const set = Object.entries(query).filter(([, value]) => value !== undefined)
  return set.length ? Object.fromEntries(set) as Q : undefined
}
/** Validate and normalize a stored route, dropping unrecognized query filters or removed tabs (such as the legacy `policy` tab). */
export function parseRoute(value: unknown): Route | undefined {
  const { page, id, query, repo: storedRepo } = (value ?? {}) as { page?: unknown; id?: unknown; query?: Record<string, unknown>
    repo?: unknown }
  const text = (name: string) => typeof query?.[name] === 'string' ? query[name] as string : undefined
  const record = typeof id === 'string' && id ? id : undefined
  const repo = typeof storedRepo === 'string' && storedRepo ? storedRepo : undefined
  // A standalone page has no repository, and a manager page is never scoped to one.
  const scoped = <T extends { page: string }>(route: T): T & RepoScope => repo ? { ...route, repo } : route
  switch (page) {
    case 'overview': case 'source': case 'repository': return scoped({ page })
    case 'trigger': return scoped(record ? { page, id: record, query: compact({ trigger: text('trigger') }) }
      : { page, query: compact({ filter: pick(THREAD_FILTERS, query?.filter) }) })
    case 'eval': return scoped({ page, query: compact({ filter: pick(DECISION_FILTERS, query?.filter),
      window: query?.window === '24h' ? '24h' as const : undefined }) })
    case 'execution': return scoped(record ? { page, id: record } : { page, query: compact({ filter: pick(TICKET_FILTERS, query?.filter) }) })
    case 'settings': return scoped({ page, query: { group: pick(SETTINGS_GROUPS, query?.group) ?? 'source',
      ...compact({ source: text('source'), version: text('version') }) } })
    case 'manager': {
      const area = pick(MANAGER_AREAS, query?.area) ?? 'repositories'
      return { page, query: { area, ...compact({ bindingRepositoryId: area === 'bindings' ? text('bindingRepositoryId') : undefined }) } }
    }
    default: return undefined
  }
}

const ROUTE_KEY = 'dsh-superagent/route'
export interface Location { route: Route; stack: Route[]; group?: SettingsGroup | undefined }
export const lastSettingsGroup = ({ route, group }: Location): SettingsGroup => route.page === 'settings' ? route.query.group
  : group ?? 'source'
/** A deployment keeps its own remembered location so a standalone page never reopens inside the manager. */
export function initialLocation(key = ROUTE_KEY): Location {
  try {
    const stored = JSON.parse(sessionStorage.getItem(key) ?? 'null') as { route?: unknown; stack?: unknown; group?: unknown } | null
    const route = parseRoute(stored?.route)
    const stack = Array.isArray(stored?.stack) ? stored.stack as unknown[] : []
    if (route) return { route, stack: stack.flatMap(item => parseRoute(item) ?? []), group: pick(SETTINGS_GROUPS, stored?.group) }
  } catch (error) {
    // Route memory is a convenience; an unreadable value falls back to HOME.
    void error
  }
  return { route: HOME, stack: [] }
}
export function remember(location: Location, key = ROUTE_KEY): void {
  try { sessionStorage.setItem(key, JSON.stringify(location)) } catch (failure) { void failure /* Route memory is a convenience. */ }
}
