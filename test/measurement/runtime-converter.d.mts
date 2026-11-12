import type { RuntimeCoverageData } from './runtime-coverage.mjs'

export interface RuntimeConverter {
  load(): Promise<void>
  destroy(): void
  // Raw input is deliberately not a validation certificate. Invalid values
  // keep reaching the same throwable library call, not a new schema check.
  applyCoverage(blocks: unknown): void
  toIstanbul(): Partial<Record<string, RuntimeCoverageData>>
}
export declare function createConverter(
  path: string,
  wrapperLength?: number,
  sources?: { source: string },
  excludePath?: (path: string) => boolean
): RuntimeConverter
