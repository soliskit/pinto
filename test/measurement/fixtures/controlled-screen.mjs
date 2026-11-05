// Reconstruct only fixed, bounded synthetic diagnostic values. Partial rows survive.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const modes = [
  'no-navigation-click',
  'no-navigation-enter',
  'released-navigation-click',
  'released-navigation-enter'
]
const lines = readFileSync(process.argv[2], 'utf8').split('\n')
let valid = true
const number = (x, max = 500000) =>
  Number.isFinite(x) && x >= 0 && x <= max ? x : null
const integer = (x, max = 10000) =>
  Number.isInteger(x) && x > 0 && x <= max ? x : null
const choose = (x, values, fallback = 'inconclusive') =>
  values.includes(x) ? x : fallback
function parsed(prefix) {
  return lines
    .filter((line) => line.startsWith(prefix))
    .slice(0, 520)
    .map((line) => {
      try {
        return JSON.parse(line.slice(prefix.length))
      } catch {
        valid = false
        return null
      }
    })
}
const allRows = parsed('controlled-take=')
const timelines = parsed('controlled-timeline=')
for (const mode of modes) {
  const field = (key, allowed) => {
    const prefix = mode + (key ? '-' + key : '') + '='
    const found = lines.filter((line) => line.startsWith(prefix))
    const raw = found.length === 1 ? found[0].slice(prefix.length) : null
    const value = allowed.includes(raw) ? raw : 'unavailable'
    if (value === 'unavailable') valid = false
    console.log(prefix + value)
    return value
  }
  const result = field('', ['pass', 'inconclusive'])
  field('phase', ['setup', 'child', 'receipts'])
  field('child-phase', [
    'setup',
    'browser-launch',
    'page-create',
    'goto',
    'action',
    'destination',
    'page-close',
    'browser-close',
    'server-close',
    'done',
    'unavailable'
  ])
  const failure = field('failure', [
    'none',
    'spawn-failed',
    'child-deadline',
    'child-timeout',
    'child-failed',
    'setup-failed',
    'mapping-discrepancy'
  ])
  const cleanup = field('cleanup', ['verified-absent', 'failed', 'unverified'])
  const state = field('receipt-state', ['complete', 'incomplete'])
  const intervalSummary = field('interval-positive', [
    'yes',
    'no',
    'inconclusive'
  ])
  const explicitSummary = field('explicit-positive', [
    'yes',
    'no',
    'inconclusive'
  ])
  const countPrefix = mode + '-take-count='
  const countLines = lines.filter((line) => line.startsWith(countPrefix))
  const rawCount =
    countLines.length === 1 ? countLines[0].slice(countPrefix.length) : ''
  const count =
    /^(0|[1-9][0-9]{0,2})$/.test(rawCount) && Number(rawCount) <= 128
      ? Number(rawCount)
      : null
  const rows = allRows.filter((row) => row?.mode === mode)
  let complete =
    state === 'complete' &&
    count !== null &&
    rows.length === count &&
    rows.length <= 128
  const ts = timelines.filter((t) => t?.mode === mode)
  const t = ts.length === 1 ? ts[0] : {}
  const timeline = {
    mode,
    sessionId: integer(t.sessionId),
    explicitOrdinal: integer(t.explicitOrdinal),
    expectedCount: integer(t.expectedCount, 128),
    actionStartedAt: number(t.actionStartedAt),
    actionResolvedAt: number(t.actionResolvedAt),
    markerObservedAt: number(t.markerObservedAt),
    explicitWrittenAt: number(t.explicitWrittenAt),
    releaseIssuedAt: number(t.releaseIssuedAt),
    valid: choose(t.valid, ['yes', 'no'], 'no')
  }
  const source = [
    'function submitted() {',
    '  window.__submitted = true',
    '}',
    'document.querySelector("form").addEventListener("submit", async (event) => {',
    '  event.preventDefault()',
    '  submitted()',
    ...(mode.startsWith('released-')
      ? [
          '  await new Promise((resolve) => { window.__releaseNavigation = resolve })',
          '  location.assign("/next")'
        ]
      : []),
    '})',
    ''
  ].join('\n')
  const expectedHash = createHash('sha256').update(source).digest('hex')
  let priorWritten = 0
  for (const [i, row] of rows.slice(0, 128).entries()) {
    const clean = {
      mode,
      sessionId: integer(row.sessionId),
      ordinal: integer(row.ordinal),
      why: choose(
        row.why,
        [
          'before:goto',
          'before:click',
          'before:press',
          'poll',
          'fixture:after-action',
          'page.close',
          'context.close'
        ],
        'unavailable'
      ),
      queuedAt: number(row.queuedAt),
      initiatedAt: number(row.initiatedAt),
      respondedAt: number(row.respondedAt),
      sourceFetchedAt: number(row.sourceFetchedAt),
      writtenAt: number(row.writtenAt),
      eligible: choose(row.eligible, ['yes', 'no'], 'no'),
      relation: choose(
        row.relation,
        ['pre-action', 'post-marker', 'ambiguous'],
        'ambiguous'
      ),
      source: choose(row.source, [
        'yes',
        'no',
        'no-event-entry',
        'inconclusive'
      ]),
      sourceHash: row.sourceHash === expectedHash ? expectedHash : null,
      helperStart: row.helperStart === 0 ? 0 : null,
      helperEnd: row.helperEnd === 52 ? 52 : null,
      helperCount:
        Number.isSafeInteger(row.helperCount) &&
        row.helperCount >= 0 &&
        row.helperCount <= 10000
          ? row.helperCount
          : null,
      raw: choose(row.raw, ['yes', 'no', 'inconclusive']),
      direct: choose(row.direct, ['yes', 'no', 'inconclusive']),
      wrapper: choose(row.wrapper, ['yes', 'no', 'inconclusive']),
      helperCredit: choose(row.helperCredit, ['yes', 'no', 'inconclusive']),
      receipt: choose(row.receipt, ['complete', 'incomplete'], 'incomplete')
    }
    const times = [
      clean.queuedAt,
      clean.initiatedAt,
      clean.respondedAt,
      clean.sourceFetchedAt,
      clean.writtenAt
    ]
    const enumsValid = [
      'eligible',
      'why',
      'relation',
      'source',
      'raw',
      'direct',
      'wrapper',
      'helperCredit',
      'receipt'
    ].every((key) => clean[key] === row[key])
    const eligible =
      clean.receipt === 'complete' &&
      timeline.explicitOrdinal !== null &&
      clean.ordinal <= timeline.explicitOrdinal &&
      timeline.actionStartedAt !== null &&
      clean.respondedAt >= timeline.actionStartedAt &&
      (timeline.releaseIssuedAt === null ||
        clean.respondedAt <= timeline.releaseIssuedAt)
    if ((clean.eligible === 'yes') !== eligible) complete = false
    if (
      !enumsValid ||
      clean.why === 'unavailable' ||
      clean.ordinal !== i + 1 ||
      clean.sessionId !== timeline.sessionId ||
      clean.receipt !== 'complete' ||
      times.some((x) => x === null) ||
      times.some((x, j) => j > 0 && times[j - 1] > x) ||
      priorWritten > clean.initiatedAt ||
      (clean.relation === 'post-marker' &&
        !(
          timeline.markerObservedAt !== null &&
          clean.initiatedAt >= timeline.markerObservedAt
        )) ||
      (clean.relation === 'pre-action' &&
        !(
          timeline.actionStartedAt !== null &&
          clean.respondedAt < timeline.actionStartedAt
        )) ||
      (clean.source === 'yes' &&
        !(
          clean.sourceHash &&
          clean.helperStart === 0 &&
          clean.helperEnd === 52 &&
          clean.helperCount !== null
        ))
    )
      complete = false
    if (clean.writtenAt !== null) priorWritten = clean.writtenAt
    console.log('controlled-take=' + JSON.stringify(clean))
  }
  if (
    ts.length !== 1 ||
    timeline.valid !== 'yes' ||
    timeline.sessionId === null ||
    timeline.explicitOrdinal === null ||
    timeline.expectedCount !== rows.length ||
    [
      timeline.actionStartedAt,
      timeline.actionResolvedAt,
      timeline.markerObservedAt,
      timeline.explicitWrittenAt
    ].some((x) => x === null) ||
    !(
      timeline.actionStartedAt <= timeline.actionResolvedAt &&
      timeline.actionResolvedAt <= timeline.markerObservedAt &&
      timeline.markerObservedAt <= timeline.explicitWrittenAt
    ) ||
    !(mode.startsWith('released-')
      ? timeline.releaseIssuedAt !== null &&
        timeline.releaseIssuedAt >= timeline.explicitWrittenAt
      : timeline.releaseIssuedAt === null) ||
    rows.filter(
      (row) =>
        row.ordinal === timeline.explicitOrdinal &&
        row.why === 'fixture:after-action' &&
        row.sessionId === timeline.sessionId &&
        row.writtenAt === timeline.explicitWrittenAt
    ).length !== 1
  )
    complete = false
  console.log('controlled-timeline=' + JSON.stringify(timeline))
  console.log(countPrefix + (count ?? 'unavailable'))
  console.log(
    mode + '-screen-receipts=' + (complete ? 'complete' : 'incomplete')
  )
  if (!complete) valid = false
  const proven = rows.some(
    (row) =>
      row.eligible === 'yes' &&
      row.ordinal <= timeline.explicitOrdinal &&
      row.respondedAt >= timeline.actionStartedAt &&
      (timeline.releaseIssuedAt === null ||
        row.respondedAt <= timeline.releaseIssuedAt) &&
      row.relation === 'post-marker' &&
      row.source === 'yes' &&
      row.sourceHash === expectedHash &&
      row.raw === 'yes' &&
      row.direct === 'yes' &&
      row.wrapper === 'yes' &&
      row.helperCredit === 'yes'
  )
  const discrepancy = rows.some(
    (row) =>
      row.eligible === 'yes' &&
      row.ordinal <= timeline.explicitOrdinal &&
      row.raw === 'yes' &&
      (row.direct !== 'yes' ||
        row.wrapper !== 'yes' ||
        row.helperCredit !== 'yes')
  )
  const intervalPositive = rows.some(
    (row) =>
      row.eligible === 'yes' &&
      row.ordinal <= timeline.explicitOrdinal &&
      row.raw === 'yes' &&
      row.relation !== 'pre-action'
  )
  const explicitRow = rows.find(
    (row) => row.ordinal === timeline.explicitOrdinal
  )
  if (intervalPositive && intervalSummary !== 'yes') valid = false
  if (explicitRow && explicitRow.raw !== explicitSummary) valid = false
  if (
    result === 'pass' &&
    (!complete ||
      failure !== 'none' ||
      cleanup !== 'verified-absent' ||
      !proven ||
      discrepancy)
  )
    valid = false
}
console.log('controlled-screen=' + (valid ? 'complete' : 'incomplete'))
if (!valid) process.exitCode = 1
