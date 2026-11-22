/** Root panel shell: one left rail of work areas and a single scrolling detail column, without page tabs. */
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { usePoll, type SearchView } from './api.ts'
import { Button, Dot, Icon, Input, Modal, StateDot, type DotState, type IconName } from './controls.tsx'
import { DesktopModeSwitch, type DeploymentForm } from './deployment.tsx'
import { EvalStatus } from './eval.tsx'
import { ExecutionStatus } from './execution.tsx'
import { ticketMark } from './marks.ts'
import { GLOSSARY, GLOSSARY_VALUES, en, zh, type DshSuperagentKey } from './locales.ts'
import { OverviewPage } from './overview.tsx'
import { RepositoryPage } from './repository.tsx'
import { PanelProvider, usePanel, usePanelData } from './provider.tsx'
import { HOME, initialLocation, lastSettingsGroup, remember, routeLabel, settingsRoute, type Location, type RepoRoute, type Route,
  type SettingsGroup } from './route.ts'
import { SettingsPage } from './settings.tsx'
import { SourceStatus } from './source.tsx'
import { actorName, errorText, reasonLabel, valueLabel, type T, readableMarkers } from './text.ts'
import { ThreadPage } from './thread.tsx'
import { TicketPage } from './ticket.tsx'
import { TriggerStatus } from './trigger.tsx'
import { When } from './widgets.tsx'

export interface AppProps {
  t: T; openSession: (sessionId: string) => Promise<void>
  deploymentForm: DeploymentForm
}

function Glossary({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = usePanel()
  const chinese = t('tab.overview') === zh['tab.overview']
  const [own, other] = chinese ? [zh, en] : [en, zh]
  const heading = (group: keyof typeof GLOSSARY) => t(group === 'roles' ? 'glossaryGroup.roles' : `tab.${group}`)
  return <Modal className="dt-glossary-modal" open={open} onClose={onClose} title={t('glossary')} closeLabel={t('close')}
    description={t('glossaryIntro')} footer={<Button variant="primary" onClick={onClose}>{t('close')}</Button>}>
    <div className="dt-glossary-body">
      <table className="dt-glossary">
        <thead><tr>
          <th>{t(chinese ? 'glossaryChinese' : 'glossaryEnglish')}</th><th>{t(chinese ? 'glossaryEnglish' : 'glossaryChinese')}</th>
          <th>{t('glossaryMeaning')}</th>
        </tr></thead>
        {Object.entries(GLOSSARY).map(([group, keys]) => <tbody key={group}>
          <tr><th colSpan={3} scope="rowgroup" className="dt-glossary-group">{heading(group as keyof typeof GLOSSARY)}</th></tr>
          {keys.map(key => <tr key={key}><td>{own[`term.${key}`]}</td><td>{other[`term.${key}`]}</td><td>{own[`meaning.${key}`]}</td></tr>)}
        </tbody>)}
      </table>
      <p className="dt-legend-title">{t('legendTitle')}</p>
      <ul className="dt-legend">{(['done', 'ongoing', 'warning', 'error', 'idle'] as const).map(state => <li key={state}>
        <Dot state={state} /><span>{t(`legend.${state}`)}</span>
      </li>)}</ul>
      <dl className="dt-values">{Object.entries(GLOSSARY_VALUES).map(([group, values]) => <div key={group} style={{ display: 'contents' }}>
        <dt>{own[`term.${group}` as DshSuperagentKey]}</dt>
        <dd>{values.map(key => `${own[key]} ${other[key]}`).join(' · ')}</dd>
      </div>)}</dl>
    </div>
  </Modal>
}

function Highlight({ text, query }: { text: string; query: string }) {
  const index = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1
  if (index < 0) return <>{text}</>
  return <>{text.slice(0, index)}<mark className="dt-mark">{text.slice(index, index + query.length)}</mark>{text.slice(index + query.length)}</>
}
function Result({ name, open, children }: { name: ReactNode; open: (() => void) | undefined; children: ReactNode }) {
  return <li className="dt-row dt-link"><div className="dt-row-main">
    <div className="dt-row-title">{open ? <button type="button" className="dt-open" onClick={open}>{name}</button> : name}</div>
    <div className="dt-row-meta">{children}</div>
  </div></li>
}
function SearchResults({ result, query, onClose }: { result: SearchView; query: string; onClose: () => void }) {
  const { t, navigate } = usePanel()
  const { setup } = usePanelData()
  const empty = !result.items.length && !result.threads.length && !result.tickets.length
  const counts = { tickets: result.tickets.length, threads: result.threads.length, items: result.items.length }
  const go = (route: Route) => () => { onClose(); navigate(route) }
  return <div className="dt-search-results" role="region" aria-label={t('searchLabel')}>
    <div className="dt-search-head">
      <span className="dt-hint">{empty ? t(setup?.accounts?.feishu ? 'searchNone' : 'searchNoneGithub')
        : t(result.items.length >= 20 ? 'searchFoundCapped' : 'searchFound', counts)}</span>
      <Button variant="ghost" size="sm" icon={<Icon name="close" size={14} />} aria-label={t('close')} onClick={onClose} />
    </div>
    {!empty && <ul className="dt-list">
      {result.tickets.map(ticket => <Result key={ticket.id} name={<Highlight text={ticket.title} query={query} />}
        open={go({ page: 'execution', id: ticket.id })}>
        <span>{t('term.ticket')}</span><span>{ticket.stage === 'ended' ? t('ticket.ended') : ticketMark(t, ticket).label}</span>
      </Result>)}
      {result.threads.map(thread => <Result key={thread.key} name={readableMarkers(t, thread.title)} open={go({ page: 'trigger',
        id: thread.key })}>
        <span>{t('term.thread')}</span>
      </Result>)}
      {/* Filtered triggers have no Thread and display their filter reason instead of a link. */}
      {result.items.map(item => <Result key={item.id} name={<Highlight text={readableMarkers(t, item.preview) || t('empty')}
        query={query} />}
        open={item.filtered === undefined ? go({ page: 'trigger', id: item.threads[0]!, query: { trigger: item.id } }) : undefined}>
        <span>{valueLabel(t, 'source', item.source)}</span><span>{actorName(t, item.actor)}</span><When at={item.at} />
        {item.threadTitle && <span className="dt-ellipsis">{t('inThread', { thread: readableMarkers(t, item.threadTitle) })}</span>}
        {item.filtered !== undefined && <span>{t('searchFiltered', { reason: reasonLabel(t, item.filtered) })}</span>}
      </Result>)}
    </ul>}
  </div>
}

/** The detail column's title area: the work area's name, global search, the glossary and the main Session shortcut. */
export function Header({ title, masterId, actions }: { title: string | undefined; masterId: string | undefined; actions?: ReactNode }) {
  const { t, call, openSession, notify, remote } = usePanel()
  const [glossary, setGlossary] = useState(false)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{ query: string; value: SearchView }>()
  // Ignore responses from superseded or cleared search requests.
  const latest = useRef(0)
  const show = (value?: { query: string; value: SearchView }) => { latest.current++; setResult(value) }
  const search = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (!result) return
    const close = (event: PointerEvent) => { if (!search.current?.contains(event.target as Node)) show() }
    document.addEventListener('pointerdown', close)
    return () => { document.removeEventListener('pointerdown', close) }
  }, [result])
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const text = query.trim()
    if (!text) { show(); return }
    const request = ++latest.current
    call('GET search', { query: { q: text } }).then(value => { if (request === latest.current) setResult({ query: text, value }) },
      failure => { if (request === latest.current) notify(errorText(failure)) })
  }
  return <header className="dt-head">
    {title && <h1 className="dt-title">{title}</h1>}
    <div className="dt-toolbar">
      <form ref={search} className="dt-search" role="search" onSubmit={submit} onKeyDown={event => { if (event.key === 'Escape') show() }}>
        <Input type="search" icon={<Icon name="search" />} value={query} placeholder={t('searchPlaceholder')} aria-label={t('searchLabel')}
          onChange={event => { setQuery(event.target.value); if (!event.target.value) show() }} />
        {result && <SearchResults result={result.value} query={result.query} onClose={() => { show() }} />}
      </form>
      <Button variant="ghost" size="sm" icon={<Icon name="question" />} aria-label={t('glossary')} title={t('glossary')} aria-haspopup="dialog"
        onClick={() => setGlossary(true)} />
      {openSession && <Button variant="outline" size="sm" icon={<Icon name="session" size={14} />} disabled={!masterId}
        onClick={() => { if (masterId) openSession(masterId).catch(failure => notify(errorText(failure))) }}>{t(remote
          ? 'manager.openWorkspace' : 'openMaster')}</Button>}
      {actions}
    </div>
    <Glossary open={glossary} onClose={() => setGlossary(false)} />
  </header>
}

/** The work area a route belongs to, used for the rail's current item and for its title. */
type Area = 'inbox' | 'tasks' | 'repository' | 'source' | 'trigger' | 'eval' | 'prompts' | 'settings'
function areaOf(route: RepoRoute): Area {
  switch (route.page) {
    case 'overview': return 'inbox'
    case 'execution': return 'tasks'
    case 'repository': return 'repository'
    case 'settings': return route.query.group === 'prompts' ? 'prompts' : 'settings'
    default: return route.page
  }
}
const AREA_LABEL: Record<Area, DshSuperagentKey> = {
  inbox: 'nav.inbox', tasks: 'nav.tasks', repository: 'nav.repository', source: 'tab.source', trigger: 'tab.trigger',
  eval: 'tab.eval', prompts: 'nav.prompts', settings: 'tab.settings',
}
const isRepoRoute = (route: Route): route is RepoRoute => route.page !== 'manager'
/**
 * The detail title names the work area, except while a Thread or Ticket is open: that page carries its own title and a back
 * button, so the header only keeps the global tools.
 */
export function titleOf(t: T, route: RepoRoute): string | undefined {
  const detail = (route.page === 'trigger' || route.page === 'execution') && route.id !== undefined
  return detail ? undefined : t(AREA_LABEL[areaOf(route)])
}

/** One navigation row, shared by the standalone rail and the manager's control rail. */
export interface NavItem {
  key: string; label: string; icon: IconName; active: boolean; selected?: boolean; count?: number; dot?: DotState
  onSelect: () => void
}
/** A titled group of navigation rows. */
export interface NavGroup { title: string; items: NavItem[] }
/** The one left rail used by every panel context; the detail column decides the page, the rail only navigates. */
export function NavRail({ brand, groups, label }: { brand: { name: string; subtitle?: string }; groups: NavGroup[]; label: string }) {
  const [expanded, setExpanded] = useState(false)
  const navId = useId()
  const active = groups.flatMap(group => group.items).find(item => item.active)?.label
  return <aside className="dt-rail" data-expanded={expanded || undefined}>
    <div className="dt-rail-brand"><span className="dt-rail-mark" aria-hidden="true"><Icon name="layers" size={20} /></span><span className="dt-rail-ident">
      <span className="dt-rail-name">{brand.name}</span>{brand.subtitle && <span className="dt-rail-sub">{brand.subtitle}</span>}
    </span><button type="button" className="dt-rail-toggle" aria-label={label} aria-expanded={expanded} aria-controls={navId}
      onClick={() => setExpanded(!expanded)}><span>{active}</span><Icon name={expanded ? 'close' : 'menu'} /></button></div>
    <nav className="dt-rail-nav" id={navId} aria-label={label}>
      {groups.filter(group => group.items.length).map(group => <div key={group.title} className="dt-rail-group">
        <p className="dt-rail-group-title">{group.title}</p>
        {group.items.map(item => <button key={item.key} type="button" className="dt-rail-item"
          aria-current={item.active ? 'page' : item.selected ? 'location' : undefined} data-selected={item.selected || undefined} title={item.label}
          onClick={() => { item.onSelect(); setExpanded(false) }}>
          <span className="dt-rail-icon"><Icon name={item.icon} size={16} /></span>
          <span className="dt-rail-label">{item.label}</span>
          {item.count ? <span className="dt-rail-count">{item.count}</span> : null}
          {item.dot && <StateDot state={item.dot} className="dt-rail-dot" />}
        </button>)}
      </div>)}
    </nav>
  </aside>
}

/** The repository panel's areas, shared with the manager so a managed repository keeps the same nine work areas. */
export function useRepoNav(route: RepoRoute, settingsGroup: SettingsGroup): NavGroup[] {
  const { t, call, navigate } = usePanel()
  const { state } = usePanelData()
  const { data: overview } = usePoll(() => call('GET overview'), [])
  const active = areaOf(route)
  const item = (area: Area, label: string, icon: IconName, target: Route, count?: number): NavItem =>
    ({ key: area, label, icon, active: active === area, count, onSelect: () => navigate(target) })
  return [
    { title: t('nav.groupWork'), items: [
      item('inbox', t('nav.inbox'), 'inbox', { page: 'overview' }, overview?.person.length),
      item('tasks', t('nav.tasks'), 'queue', { page: 'execution' }, state?.load.running),
      item('repository', t('nav.repository'), 'hash', { page: 'repository' }),
    ] },
    { title: t('nav.groupFlow'), items: [
      item('source', t('tab.source'), 'hash', { page: 'source' }),
      item('trigger', t('tab.trigger'), 'message', { page: 'trigger' }),
      item('eval', t('tab.eval'), 'decision', { page: 'eval' }),
    ] },
    { title: t('nav.groupConfigure'), items: [
      item('prompts', t('nav.prompts'), 'review', settingsRoute('prompts')),
      item('settings', t('tab.settings'), 'settings', settingsRoute(route.page === 'settings' ? 'source' : settingsGroup)),
    ] },
  ]
}

/** The repository rail: the standard areas, with the manager's groups prepended when the repository is managed. */
export function Rail({ route, settingsGroup, extraGroups = [], subtitle }: {
  route: RepoRoute; settingsGroup: SettingsGroup; extraGroups?: NavGroup[]; subtitle?: string
}) {
  const { t } = usePanel()
  return <NavRail brand={{ name: t('panel'), ...subtitle ? { subtitle } : {} }} groups={[...extraGroups, ...useRepoNav(route, settingsGroup)]}
    label={t('pagesLabel')} />
}

/** The shared shell frame: one left rail and one scrolling detail column. */
export function ShellFrame({ rail, children }: { rail: ReactNode; children: ReactNode }) {
  return <div className="dt-shell-container"><div className="dt-shell">
    {rail}
    <main className="dt-workspace" id="dt-page">
      <div className="dt-workspace-inner">{children}</div>
    </main>
  </div></div>
}

export function Content({ route, deploymentForm }: { route: RepoRoute; deploymentForm: DeploymentForm }) {
  const { t } = usePanel()
  const { state, error, reload } = usePanelData()
  const waiting = error ? <p className="dt-error" role="alert">{error.message}</p> : <p className="dt-hint">{t('loading')}</p>
  switch (route.page) {
    case 'overview': return <OverviewPage />
    case 'source': return <SourceStatus />
    case 'trigger': return route.id !== undefined ? <ThreadPage key={route.id} id={route.id} target={route.query?.trigger} />
      : <TriggerStatus filter={route.query?.filter ?? 'subscribed'} />
    case 'eval': return <EvalStatus filter={route.query?.filter ?? 'work'} window={route.query?.window}
      paused={!!state?.paused} />
    case 'execution': return route.id !== undefined ? <TicketPage key={route.id} id={route.id} />
      : state ? <ExecutionStatus filter={route.query?.filter ?? 'open'} state={state} reload={reload} /> : waiting
    case 'settings': return state ? <SettingsPage key={state.masterId} group={route.query.group} query={route.query} state={state}
      deploymentForm={deploymentForm} /> : waiting
    case 'repository': return <RepositoryPage />
  }
}

/** The standalone shell: a grouped left rail and one scrolling detail column. */
function Shell({ route, deploymentForm, settingsGroup }: { route: RepoRoute; deploymentForm: DeploymentForm; settingsGroup: SettingsGroup }) {
  const { t } = usePanel()
  const { state, error } = usePanelData()
  return <ShellFrame rail={<Rail route={route} settingsGroup={settingsGroup} />}>
    <Header title={titleOf(t, route)} masterId={state?.masterId} actions={<DesktopModeSwitch t={t} form={deploymentForm}
      mode="standalone" running={state?.load.running} />} />
    {error && state && <p className="dt-error" role="status">{error.message}</p>}
    <Content route={route} deploymentForm={deploymentForm} />
  </ShellFrame>
}

/** Root panel component managing route history and shared panel state. */
export function App({ t, openSession, deploymentForm }: AppProps) {
  const [location, setLocation] = useState<Location>(() => {
    const stored = initialLocation()
    return isRepoRoute(stored.route) ? { ...stored, stack: stored.stack.filter(isRepoRoute) } : { route: HOME, stack: [] }
  })
  useEffect(() => { remember(location) }, [location])
  // Preserve the last opened settings group across navigation so the Settings area reopens where it was.
  const move = useCallback((next: (current: Location) => Pick<Location, 'route' | 'stack'>) =>
    setLocation(current => ({ ...next(current), group: lastSettingsGroup(current) })), [])
  /** Navigates to `route`; `replace` swaps the current entry (filters, paging) instead of pushing a back step. */
  const navigate = useCallback((route: Route, replace = false) => move(current => ({ route,
    stack: replace ? current.stack : [...current.stack, current.route].slice(-20) })), [move])
  const back = useCallback(() => move(current => {
    const previous = current.stack.at(-1)
    return { route: previous && isRepoRoute(previous) ? previous : HOME, stack: current.stack.slice(0, -1) }
  }), [move])
  const route: RepoRoute = isRepoRoute(location.route) ? location.route : { page: 'overview' }
  return <PanelProvider t={t} openSession={openSession} navigate={navigate} back={back} backLabel={routeLabel(t, location.stack.at(-1) ?? HOME)}>
    <Shell route={route} deploymentForm={deploymentForm} settingsGroup={lastSettingsGroup(location)} />
  </PanelProvider>
}
