/** The CLI reads synthetic Ready → release history. Tests never contact any company service. */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

type WorkItem = { id: string; productId: string; workClass: string; readyAt: string; releasedAt: string | null }
type Input = {
  asOf: string; followUpDays: number; eligibleClass: string
  baseline: { start: string; end: string }; current: { start: string; end: string }
  products: { id: string; teamId: string }[]; workItems: WorkItem[]
}
const script = fileURLToPath(new URL('../scripts/enterprise-measure.mjs', import.meta.url))
const example = new URL('../examples/enterprise-measure.example.json', import.meta.url)
const fixture = () => JSON.parse(readFileSync(example, 'utf8')) as Input
const before = '2026-01-07T00:00:00Z'
const after = '2026-03-07T00:00:00Z'
const elapsed = (readyAt: string, hours: number) => new Date(Date.parse(readyAt) + hours * 3_600_000).toISOString()

function populated(): Input {
  const input = fixture()
  for (const { id: productId } of input.products) {
    for (const [period, readyAt, hours] of [['baseline', before, 10], ['current', after, 5]] as const) {
      for (let index = 0; index < 20; index++) {
        input.workItems.push({ id: `${period}-${index}`, productId, workClass: input.eligibleClass, readyAt,
          releasedAt: elapsed(readyAt, hours) })
      }
    }
  }
  return input
}

function run(input: Input) {
  return spawnSync(process.execPath, [script, '-'], { input: JSON.stringify(input), encoding: 'utf-8' })
}

it('requires a measured reduction of 50% for every product, inclusive at the exact threshold', () => {
  const result = run(populated())
  expect(result.status).toBe(0)
  const report = JSON.parse(result.stdout)
  expect(report).toMatchObject({ status: 'pass', statusCounts: { pass: 12, unmet: 0, insufficient_evidence: 0 } })
  expect(report.products[0]).toMatchObject({ p50ReductionFraction: 0.5, baseline: { readyCount: 20, p50Hours: 10, p90Hours: 10 },
    current: { readyCount: 20, p50Hours: 5, p90Hours: 5 } })
})

it('keeps unmet P50 and tail latency on their own product and does not pool with faster products', () => {
  const input = populated()
  for (const item of input.workItems) {
    if (item.readyAt !== after) continue
    if (item.productId === 'product-01') item.releasedAt = elapsed(after, 5.01)
    if (item.productId === 'product-02' && ['current-17', 'current-18', 'current-19'].includes(item.id)) {
      item.releasedAt = elapsed(after, 12)
    }
  }
  const result = run(input)
  expect(result.status).toBe(2)
  const report = JSON.parse(result.stdout)
  expect(report.statusCounts).toEqual({ pass: 10, unmet: 2, insufficient_evidence: 0 })
  expect(report.products[0].reasons).toEqual(['p50_reduction_below_target'])
  expect(report.products[1]).toMatchObject({ reasons: ['p90_increased'], current: { p50Hours: 5, p90Hours: 12 } })
})

it('counts late and still-unreleased items so fast released work alone cannot pass', () => {
  const input = populated()
  for (const item of input.workItems) {
    if (item.productId !== 'product-01' || !['current-17', 'current-18', 'current-19'].includes(item.id)) continue
    item.releasedAt = item.id === 'current-17' ? elapsed(after, 29 * 24) : null
  }
  const result = run(input)
  expect(result.status).toBe(2)
  expect(JSON.parse(result.stdout).products[0]).toMatchObject({ status: 'unmet',
    reasons: ['release_fraction_decreased', 'p90_beyond_follow_up'],
    current: { readyCount: 20, releasedByHorizonCount: 17, unresolvedByHorizonCount: 3, p50Hours: 5, p90Hours: null },
  })

  for (const item of input.workItems) {
    if (item.productId === 'product-01' && ['baseline-17', 'baseline-18', 'baseline-19'].includes(item.id)) item.releasedAt = null
  }
  const insufficient = run(input)
  expect(insufficient.status).toBe(3)
  expect(JSON.parse(insufficient.stdout).products[0]).toMatchObject({ status: 'insufficient_evidence', reasons: ['p90_beyond_follow_up'] })
})

it('compares the same work class and assigns Ready timestamps with half-open windows', () => {
  const input = populated()
  const work = input.workItems.filter(item => item.productId === 'product-01')
  work.find(item => item.id === 'baseline-0')!.workClass = 'urgent-fix'
  work.find(item => item.id === 'current-0')!.readyAt = input.current.start
  const edge = work.find(item => item.id === 'current-1')!
  edge.readyAt = input.current.end
  edge.releasedAt = null
  const result = run(input)
  expect(result.status).toBe(3)
  expect(JSON.parse(result.stdout).products[0]).toMatchObject({ status: 'insufficient_evidence', reasons: ['too_few_ready_items'],
    baseline: { readyCount: 19 }, current: { readyCount: 19 } })
})

it('reports waiting for observation even when all present records have already shipped', () => {
  const input = populated()
  input.asOf = '2026-04-25T23:59:59Z'
  const result = run(input)
  expect(result.status).toBe(3)
  const report = JSON.parse(result.stdout)
  expect(report.comparableAt).toBe('2026-04-26T00:00:00.000Z')
  expect(report.products[0]).toMatchObject({ status: 'insufficient_evidence', reasons: ['observation_window_open'],
    current: { mature: false, readyCount: 20, p50Hours: null, p90Hours: null } })
})

it('produces no pass claim for the empty 12-product template', () => {
  const result = spawnSync(process.execPath, [script, fileURLToPath(example)], { encoding: 'utf-8' })
  expect(result.status).toBe(3)
  expect(JSON.parse(result.stdout).statusCounts).toEqual({ pass: 0, unmet: 0, insufficient_evidence: 12 })
})

it('rejects invalid input before returning comparison results', () => {
  const unknown = populated()
  unknown.workItems[0]!.productId = 'unknown'
  const duplicate = populated()
  duplicate.workItems.push(duplicate.workItems[0]!)
  const overlap = populated()
  overlap.current = overlap.baseline
  const invalidTimestamp = populated()
  invalidTimestamp.workItems[0]!.releasedAt = '2026-02-31T00:00:00Z'
  const futureRelease = populated()
  futureRelease.workItems[0]!.releasedAt = '2026-04-26T00:00:01Z'
  const teamCount = populated()
  teamCount.products[0]!.teamId = 'team-06'
  for (const input of [unknown, duplicate, overlap, invalidTimestamp, futureRelease, teamCount]) {
    const result = run(input)
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).not.toBe('')
  }
})
