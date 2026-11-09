// Evidence-only helper. No application imports or browser dependency.
export const phases = [
  'operation',
  'contextClose',
  'browserClose',
  'serverStop'
]

function valueSummary(value) {
  if (value === null) return null
  if (typeof value === 'string') return value.slice(0, 256)
  if (typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return `[${typeof value}]`
}

function errorSummary(error) {
  const result = { thrownType: error === null ? 'null' : typeof error }
  if (
    (typeof error !== 'object' || error === null) &&
    typeof error !== 'function'
  ) {
    result.value = valueSummary(error)
    return result
  }
  // Read data properties only. Never invoke getters, toJSON or arbitrary coercion.
  for (const key of ['name', 'message', 'code', 'expected', 'actual']) {
    try {
      let target = error
      let descriptor
      for (let depth = 0; target !== null && depth < 4; depth++) {
        descriptor = Object.getOwnPropertyDescriptor(target, key)
        if (descriptor) break
        target = Object.getPrototypeOf(target)
      }
      if (descriptor && Object.hasOwn(descriptor, 'value')) {
        result[key] = valueSummary(descriptor.value)
      }
    } catch {
      result[key] = '[unreadable]'
    }
  }
  return result
}

export async function runEvidenceCase(identity, steps, emit) {
  const errors = []
  const receipt = {
    schema: 1,
    case: identity.case,
    engine: identity.engine,
    mode: identity.mode,
    arm: identity.arm,
    assertionReached: false,
    phases: {}
  }
  for (const phase of phases) {
    const step = steps[phase]
    if (!step) {
      receipt.phases[phase] = { state: 'not-acquired', error: null }
      continue
    }
    try {
      await step(
        phase === 'operation'
          ? () => {
              receipt.assertionReached = true
            }
          : undefined
      )
      receipt.phases[phase] = { state: 'completed', error: null }
    } catch (error) {
      errors.push({ phase, error })
      receipt.phases[phase] = { state: 'failed', error: errorSummary(error) }
    }
  }
  // Cleanups finish before receipt emission; receipt failure is also a real error.
  try {
    await emit(receipt)
  } catch (error) {
    errors.push({ phase: 'receipt', error })
  }
  if (errors.length === 1) throw errors[0].error
  if (errors.length > 1) {
    throw new AggregateError(
      errors.map(({ error }) => error),
      'Evidence operation or cleanup failed',
      { cause: errors[0].error }
    )
  }
  return receipt
}
