import { readFileSync } from 'node:fs'
import { z } from 'zod'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const MIN_READY = 20
const TARGET_REDUCTION = 0.5
const identifier = z.string().trim().min(1)
const timestamp = z.iso.datetime({ offset: true }).transform(value => Date.parse(value)).pipe(z.number())
const windowSchema = z.object({ start: timestamp, end: timestamp })
const inputSchema = z.object({
  asOf: timestamp,
  followUpDays: z.number().int().min(1).max(365),
  eligibleClass: identifier,
  baseline: windowSchema,
  current: windowSchema,
  products: z.array(z.object({ id: identifier, teamId: identifier })).length(12),
  workItems: z.array(z.object({
    id: identifier,
    productId: identifier,
    workClass: identifier,
    readyAt: timestamp,
    releasedAt: timestamp.nullable(),
  })),
})

function hours(milliseconds) {
  return milliseconds === null ? null : milliseconds / HOUR
}

function summarize(items, window, followUp, asOf) {
  const mature = asOf >= window.end + followUp
  const elapsed = items.flatMap(item => item.releasedAt !== null && item.releasedAt <= item.readyAt + followUp
    ? [item.releasedAt - item.readyAt] : []).sort((left, right) => left - right)
  const readyCount = items.length
  const releasedByHorizonCount = elapsed.length
  // With complete follow-up, unresolved durations exceed the horizon. A percentile whose rank falls there is unknown.
  const lowerMiddle = elapsed[Math.floor((readyCount - 1) / 2)]
  const upperMiddle = elapsed[Math.floor(readyCount / 2)]
  const p50 = mature && lowerMiddle !== undefined && upperMiddle !== undefined ? (lowerMiddle + upperMiddle) / 2 : null
  const p90 = mature ? elapsed[Math.ceil(9 * readyCount / 10) - 1] ?? null : null
  return { p50, p90, view: {
    mature, readyCount, releasedByHorizonCount, unresolvedByHorizonCount: readyCount - releasedByHorizonCount,
    releaseByHorizonFraction: mature && readyCount ? releasedByHorizonCount / readyCount : null,
    p50Hours: hours(p50), p90Hours: hours(p90),
  } }
}

function compare(baseline, current) {
  if (!baseline.view.mature || !current.view.mature) return { status: 'insufficient_evidence', reasons: ['observation_window_open'], p50ReductionFraction: null }
  if (baseline.view.readyCount < MIN_READY || current.view.readyCount < MIN_READY) {
    return { status: 'insufficient_evidence', reasons: ['too_few_ready_items'], p50ReductionFraction: null }
  }

  const unknown = []
  const unmet = []
  let p50ReductionFraction = null
  if (baseline.p50 === 0) unknown.push('baseline_p50_zero')
  else if (baseline.p50 === null || current.p50 === null) unknown.push('p50_beyond_follow_up')
  else {
    p50ReductionFraction = (baseline.p50 - current.p50) / baseline.p50
    if (current.p50 > (1 - TARGET_REDUCTION) * baseline.p50) unmet.push('p50_reduction_below_target')
  }
  if (baseline.p90 === null || current.p90 === null) unknown.push('p90_beyond_follow_up')
  else if (current.p90 > baseline.p90) unmet.push('p90_increased')
  if (current.view.releaseByHorizonFraction < baseline.view.releaseByHorizonFraction) unmet.push('release_fraction_decreased')
  const status = unmet.length ? 'unmet' : unknown.length ? 'insufficient_evidence' : 'pass'
  return { status, reasons: [...unmet, ...unknown], p50ReductionFraction }
}

function assess(raw) {
  const input = inputSchema.parse(raw)
  const { asOf, eligibleClass, baseline, current } = input
  const duration = baseline.end - baseline.start
  if (duration <= 0 || current.end - current.start !== duration || baseline.end > current.start) {
    throw new Error('Baseline and current windows must have positive equal durations, with baseline ending at or before current starts')
  }
  if (new Set(input.products.map(product => product.id)).size !== 12) throw new Error('Exactly 12 distinct product IDs are required')
  if (new Set(input.products.map(product => product.teamId)).size !== 5) throw new Error('The product inventory must cover exactly five teams')

  const cohorts = new Map(input.products.map(product => [product.id, { ids: new Set(), baseline: [], current: [] }]))
  for (const [index, item] of input.workItems.entries()) {
    const cohort = cohorts.get(item.productId)
    if (!cohort) throw new Error(`workItems[${index}] refers to an unknown product`)
    if (cohort.ids.has(item.id)) throw new Error(`workItems[${index}] repeats a work item ID within its product`)
    if (item.readyAt > asOf || (item.releasedAt !== null && (item.releasedAt < item.readyAt || item.releasedAt > asOf))) {
      throw new Error(`workItems[${index}] must satisfy readyAt ≤ releasedAt ≤ asOf or readyAt ≤ asOf for an unreleased item`)
    }
    cohort.ids.add(item.id)
    if (item.workClass !== eligibleClass) continue
    if (item.readyAt >= baseline.start && item.readyAt < baseline.end) cohort.baseline.push(item)
    if (item.readyAt >= current.start && item.readyAt < current.end) cohort.current.push(item)
  }

  const followUp = input.followUpDays * DAY
  const statusCounts = { pass: 0, unmet: 0, insufficient_evidence: 0 }
  const products = input.products.map(product => {
    const cohort = cohorts.get(product.id)
    const before = summarize(cohort.baseline, baseline, followUp, asOf)
    const after = summarize(cohort.current, current, followUp, asOf)
    const comparison = compare(before, after)
    statusCounts[comparison.status]++
    return { ...product, ...comparison, baseline: before.view, current: after.view }
  })
  const isoWindow = window => ({ start: new Date(window.start).toISOString(), end: new Date(window.end).toISOString() })
  const status = statusCounts.unmet ? 'unmet' : statusCounts.insufficient_evidence ? 'insufficient_evidence' : 'pass'
  return { schemaVersion: 1, status, statusCounts, asOf: new Date(asOf).toISOString(), eligibleClass,
    followUpDays: input.followUpDays, comparableAt: new Date(current.end + followUp).toISOString(),
    minimumReadyItemsPerWindow: MIN_READY, targetP50ReductionFraction: TARGET_REDUCTION,
    baseline: isoWindow(baseline), current: isoWindow(current), products }
}

const usage = 'Usage: node scripts/enterprise-measure.mjs <input.json|->'
const [path, ...rest] = process.argv.slice(2)
if (path === '--help' && !rest.length) {
  process.stdout.write(`${usage}\n`)
} else {
  try {
    if (!path || rest.length) throw new Error(usage)
    const report = assess(JSON.parse(readFileSync(path === '-' ? 0 : path, 'utf8')))
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    process.exitCode = { pass: 0, unmet: 2, insufficient_evidence: 3 }[report.status]
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
