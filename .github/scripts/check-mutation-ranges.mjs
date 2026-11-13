// Fail-closed slice-boundary check for line-range mutation slices.
//
// Ranges must be contiguous from line 1 and cover the whole file (the last
// range may use the 99999 sentinel). No mutated-node type may span a range
// boundary: Stryker silently skips a spanning node in every ranged run.
// Container types that no mutator targets may span because their children
// are still checked. Every range must contain at least one candidate mutable
// node (candidate presence is a static source check only - it is NOT proof of
// actual mutant generation; that is verified separately by comparing full
// mutant-report identities against an unranged instrumentation).
//
// JavaScript files are parsed with espree and checked against Salutant's
// original ESTree MAY_SPAN list, unchanged. TypeScript files are parsed with
// the repo's pinned `typescript` package and checked against the verified
// SyntaxKind mapping of that same list (TS-only type containers that emit no
// code are added; everything else stays fail-closed).
//
// Usage: node .github/scripts/check-mutation-ranges.mjs <file> <start-end>...
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(process.cwd() + '/package.json')
const espree = require('espree')

const [file, ...ranges] = process.argv.slice(2)
const fail = (msg) => {
  console.error(msg)
  process.exit(1)
}

const ESTREE_MAY_SPAN = new Set([
  'Program',
  'ImportDeclaration',
  'ExportNamedDeclaration',
  'ExportDefaultDeclaration',
  'ExportAllDeclaration',
  'ClassDeclaration',
  'ClassBody',
  'MethodDefinition',
  'PropertyDefinition',
  'StaticBlock',
  'FunctionDeclaration',
  'VariableDeclaration',
  'VariableDeclarator'
])

// SyntaxKind mapping of the ESTree list above:
//   Program -> SourceFile; ImportDeclaration -> ImportDeclaration;
//   ExportNamed/AllDeclaration -> ExportDeclaration (named/export-* forms only;
//     `export default <expr>` is ExportAssignment, which wraps a mutable
//     expression and stays fail-closed);
//   ClassDeclaration -> ClassDeclaration (TS has no ClassBody node);
//   MethodDefinition -> MethodDeclaration/Constructor/GetAccessor/SetAccessor;
//   PropertyDefinition -> PropertyDeclaration;
//   StaticBlock -> ClassStaticBlockDeclaration;
//   FunctionDeclaration -> FunctionDeclaration;
//   espree VariableDeclaration (the statement) -> VariableStatement +
//     VariableDeclarationList; espree VariableDeclarator -> VariableDeclaration.
// TS-only additions: InterfaceDeclaration and TypeAliasDeclaration emit no
// code and can carry no mutants. EnumDeclaration, ModuleDeclaration,
// ImportEqualsDeclaration and ExportAssignment all emit code and stay
// fail-closed, as does every other kind.
const TS_MAY_SPAN = new Set([
  'SourceFile',
  'ImportDeclaration',
  'ExportDeclaration',
  'ClassDeclaration',
  'MethodDeclaration',
  'Constructor',
  'GetAccessor',
  'SetAccessor',
  'PropertyDeclaration',
  'ClassStaticBlockDeclaration',
  'FunctionDeclaration',
  'VariableStatement',
  'VariableDeclarationList',
  'VariableDeclaration',
  'InterfaceDeclaration',
  'TypeAliasDeclaration'
])

const source = readFileSync(file, 'utf8')
const lineCount = source.split('\n').length - (source.endsWith('\n') ? 1 : 0)
const boundaries = []
const rangeList = []
let expectStart = 1
for (const r of ranges) {
  const m = /^(\d+)-(\d+)$/.exec(r)
  if (!m) fail(`Bad range "${r}"`)
  const start = Number(m[1])
  const end = Number(m[2])
  if (start !== expectStart) fail(`Range gap or overlap at ${start} (expected ${expectStart})`)
  if (start > lineCount) fail(`Range ${r} starts past end of file (${lineCount} lines)`)
  if (end !== 99999 && end > lineCount) fail(`Range ${r} ends past end of file`)
  if (end !== 99999) boundaries.push(end)
  rangeList.push([start, Math.min(end, lineCount)])
  expectStart = end + 1
}
if (lineCount >= expectStart) {
  fail(`Tail uncovered: file has ${lineCount} lines but ranges stop at ${expectStart - 1}`)
}

const bad = []
const candidates = rangeList.map(() => 0)

function visit(type, startLine, endLine, maySpan, isCandidate) {
  if (!maySpan.has(type)) {
    for (const b of boundaries) {
      if (startLine <= b && endLine >= b + 1) {
        bad.push(`${type} lines ${startLine}-${endLine} spans boundary ${b}`)
      }
    }
    if (isCandidate) {
      for (let i = 0; i < rangeList.length; i++) {
        if (startLine >= rangeList[i][0] && endLine <= rangeList[i][1]) candidates[i]++
      }
    }
  }
}

if (file.endsWith('.ts')) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1
  // Both the instrumenter (via its Babel parse) and the TypeScript compiler
  // count physical lines from 1, so these line numbers are the same ones the
  // workflow ranges and the guard's boundaries use.
  ;(function walk(node) {
    const type = ts.SyntaxKind[node.kind]
    // Candidate predicate: expressions are what mutators target. Modifiers
    // and other keyword tokens are never candidates (and can never span a
    // boundary: they are single-line leaves).
    visit(type, lineOf(node.getStart(sf)), lineOf(node.getEnd()), TS_MAY_SPAN, ts.isExpression(node))
    node.forEachChild(walk)
  })(sf)
} else {
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module', loc: true })
  ;(function walk(node) {
    if (!node || typeof node.type !== 'string') return
    if (node.loc) {
      // Salutant's original predicate: every non-MAY_SPAN node counts as a
      // candidate; actual mutant generation is verified separately.
      visit(node.type, node.loc.start.line, node.loc.end.line, ESTREE_MAY_SPAN, true)
    }
    for (const key of Object.keys(node)) {
      const v = node[key]
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object' && key !== 'loc') walk(v)
    }
  })(ast)
}

if (bad.length) fail(bad.join('\n'))
for (let i = 0; i < rangeList.length; i++) {
  if (candidates[i] === 0) {
    fail(`Range ${rangeList[i][0]}-${rangeList[i][1]} contains no candidate mutable nodes (candidate-count check; actual mutant identity is verified separately against an unranged report)`)
  }
}
console.log(`OK ${file}: ${boundaries.length} boundaries, ranges contiguous, tail covered, every range has candidate nodes, no mutable node spans`)
