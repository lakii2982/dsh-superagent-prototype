/**
 * Write scope of a ticket inside one repository: which files and directories it may change, whether two tickets' writes can
 * touch the same path, and which ticket makes another wait. Paths are repository-relative; an absent or empty scope is the
 * whole repository, since an unknown scope must not let a second writer in.
 */

/** A ticket's write occupancy in one repository, as registered before its worker starts writing. */
export interface ScopeClaim { ticketId: string; title: string; repositoryId: string; scope: string[] }
/** A ticket a wait is for: the holder of overlapping writes, the paths that overlap, and where those writes go. */
export interface ScopeBlock { ticketId: string; title: string; repositoryId: string; scope: string[]; paths: string[] }

/**
 * Normalize a repository-relative path for comparison: forward slashes, no leading `./`, no repeated or trailing slashes,
 * parent segments folded, and lower case, so a comparison does not depend on the platform's case sensitivity or on how the
 * same path was spelled.
 */
export function normalizeScopePath(path: string): string {
  const kept: string[] = []
  for (const part of path.trim().replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') { kept.pop(); continue }
    kept.push(part)
  }
  return kept.join('/').toLowerCase()
}
/** Whether `a` is the same path as `b`, or a directory that contains it (an empty path is the repository root). */
export const covers = (a: string, b: string): boolean => a === '' || a === b || b.startsWith(`${a}/`)
/** Whether two scopes overlap: an empty scope is the whole repository and overlaps every scope, and a directory covers its descendants. */
export function overlaps(a: readonly string[], b: readonly string[]): boolean {
  const left = unique(a), right = unique(b)
  if (!left.length || !right.length) return true
  return left.some(one => right.some(two => covers(one, two) || covers(two, one)))
}
/** The normalized paths that make two scopes overlap, deduplicated, for the task page's blocking source; empty when the whole repository is involved. */
export function overlappingPaths(a: readonly string[], b: readonly string[]): string[] {
  const left = unique(a), right = unique(b)
  if (!left.length || !right.length) return []
  return left.flatMap(one => right.filter(two => covers(one, two) || covers(two, one)).map(two => covers(one, two) ? one : two))
    .filter((path, index, all) => path !== '' && all.indexOf(path) === index)
}
/** The scope paths normalized, without empty duplicates. */
export function normalizeScope(scope: readonly string[] | undefined): string[] {
  return unique(scope ?? [])
}
function unique(scope: readonly string[]): string[] {
  const paths = scope.map(normalizeScopePath)
  return paths.filter((path, index) => paths.indexOf(path) === index)
}
/** A claim holds the whole repository when it states no path, which no other claim of the same repository can overlap safely. */
export const wholeRepository = (scope: readonly string[]): boolean => normalizeScope(scope).length === 0

/**
 * The write occupancy of all running tickets, in memory: a ticket claims its scope before it writes and releases it when its
 * worker stops or hands over to a person, and a ticket whose scope overlaps a holder's waits with that holder recorded as the
 * blocking source. Claims of different repositories never conflict.
 */
export class ScopeQueue {
  private readonly claims = new Map<string, ScopeClaim>()
  /** Register `claim` for its ticket, replacing an earlier claim of the same ticket. */
  claim(claim: ScopeClaim): void {
    this.claims.set(claim.ticketId, { ...claim, scope: normalizeScope(claim.scope) })
  }
  /** Release the claim of `ticketId`; returns whether it held one. */
  release(ticketId: string): boolean {
    return this.claims.delete(ticketId)
  }
  /** The claim `ticketId` holds, if any. */
  held(ticketId: string): ScopeClaim | undefined { return this.claims.get(ticketId) }
  /** The tickets of `repositoryId` whose writes overlap `scope`. */
  blockers(ticketId: string, repositoryId: string, scope: readonly string[]): ScopeBlock[] {
    const wanted = normalizeScope(scope)
    return [...this.claims.values()]
      .filter(claim => claim.ticketId !== ticketId && claim.repositoryId === repositoryId && overlaps(claim.scope, wanted))
      .map(claim => ({ ticketId: claim.ticketId, title: claim.title, repositoryId: claim.repositoryId, scope: claim.scope,
        paths: overlappingPaths(claim.scope, wanted) }))
  }
  /** Every claim of `repositoryId`, for capacity and status views. */
  holders(repositoryId: string): ScopeClaim[] {
    return [...this.claims.values()].filter(claim => claim.repositoryId === repositoryId)
  }
}

/** Durable scope state of a ticket's worker, so the task page shows what it waits for after a restart. */
export interface ScopeStatus { state: 'writing' | 'waiting'; scope: string[]; blockers: ScopeBlock[]; at: string }
