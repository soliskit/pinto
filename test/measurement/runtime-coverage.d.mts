import type {
  FileCoverageData,
  FunctionMapping,
  CoverageSummary
} from 'istanbul-lib-coverage'

// Counts and names are not certified by the raw-data conversion boundary.
// Keep those payload fields unknown, including values retained after merging.
export type RuntimeCoverageData = Omit<
  FileCoverageData,
  'fnMap' | 's' | 'f' | 'b'
> & {
  fnMap: Record<string, Omit<FunctionMapping, 'name'> & { name: unknown }>
  s: Record<string, unknown>
  f: Record<string, unknown>
  b: Record<string, unknown[]>
}

export interface RuntimeFileCoverage {
  data: RuntimeCoverageData
  getLineCoverage(): Partial<Record<number, unknown>>
  toSummary(): CoverageSummary
}
export interface RuntimeCoverageMap {
  merge(map: Record<string, RuntimeCoverageData | undefined>): void
  fileCoverageFor(path: string): RuntimeFileCoverage
}
export declare const libCoverage: {
  createFileCoverage: (
    coverage: string | RuntimeCoverageData | undefined
  ) => RuntimeFileCoverage
  createCoverageMap: (
    map?: Record<string, RuntimeCoverageData | undefined>
  ) => RuntimeCoverageMap
}
export declare function isFiniteNonnegative(value: unknown): value is number
export declare function isPositive(value: unknown): boolean
