import { defineConfig } from 'eslint/config'
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import promise from 'eslint-plugin-promise'
import prettierRecommended from 'eslint-plugin-prettier/recommended'

// Files in the helper block below that share the existing Node project.
const helperFiles = [
  'test/default-port-client.helper.mjs',
  'test/default-port-https-client.helper.mjs',
  'test/default-port-server.helper.mjs',
  'test/measurement/stopwithtimeout.mjs',
  'test/measurement/filelists.mjs',
  'test/measurement/server-preload.mjs',
  'test/measurement/fixtures/screen-stage-controls.mjs',
  'test/measurement/fixtures/fixture-src.js',
  'test/measurement/fixtures/run-fixtures.mjs',
  'test/measurement/fixtures/take-screen-controls.mjs',
  'test/measurement/v8merge.mjs',
  'test/measurement/runtime-coverage.mjs',
  'test/measurement/runtime-converter.mjs',
  'test/measurement/fixtures/screen-stage.mjs',
  'test/measurement/node-source-identity.mjs',
  'test/measurement/validate.mjs',
  'test/measurement/checks.mjs',
  'test/ws-frame-parser.mjs',
  'test/measurement/stop-measured-server.mjs',
  'test/measurement/fixtures/source-contract.mjs',
  'test/measurement/fixtures/identity-and-stop.mjs',
  'test/measurement/fixtures/source-stage-controls.mjs',
  'test/measurement/fixtures/source-stage.mjs',
  'test/measurement/fixtures/take-stage-controls.mjs',
  'test/measurement/fixtures/controlled-preload.mjs',
  'eslint.config.mjs'
]

export default defineConfig(
  { ignores: ['node_modules/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  promise.configs['flat/recommended'],
  prettierRecommended,
  {
    // All TypeScript, tests included, with the full type-aware rule sets.
    // types/ is excluded here: it joins the explicit-project block below,
    // and 'project' cannot be combined with this block's projectService.
    files: ['**/*.{ts,mts,cts}'],
    ignores: ['types/**'],
    // tseslint.config gave every extended entry this block's files, which
    // keeps the JS-applicable parts of the presets. defineConfig intersects
    // instead, so each entry is given the block's files here to match.
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.strictTypeChecked
    ].map((config) => ({ ...config, files: ['**/*.{ts,mts,cts}'] })),
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: true }
    }
  },
  {
    // Browser JS, type-checked against tsconfig.client.json. The project
    // service only discovers files included by a standard-named tsconfig.json,
    // so the client config is pointed at explicitly; types/ joins this block
    // because client-globals.d.ts is only reachable through that tsconfig.
    files: ['public/**/*.js', 'types/**/*.ts'],
    // tseslint.config gave every extended entry this block's files, which
    // keeps the JS-applicable parts of the presets. defineConfig intersects
    // instead, so each entry is given the block's files here to match.
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.strictTypeChecked
    ].map((config) => ({
      ...config,
      files: ['public/**/*.js', 'types/**/*.ts']
    })),
    languageOptions: {
      globals: { ...globals.browser, Peer: 'readonly', io: 'readonly' },
      parserOptions: {
        project: ['./tsconfig.client.json'],
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  {
    // JS files no tsconfig covers get untyped rules only. Scoped by directory
    // on purpose: a broad '**/*.js' block here would override the public
    // block above, because in flat config later blocks win.
    files: ['*.js', '*.mjs', 'scripts/**/*.js'],
    extends: [tseslint.configs.disableTypeChecked]
  },
  {
    // Selected test helpers share the existing Node project.
    files: helperFiles,
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.strictTypeChecked
    ].map((config) => ({ ...config, files: helperFiles })),
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  {
    languageOptions: {
      globals: { ...globals.node }
    },
    linterOptions: {
      reportUnusedDisableDirectives: true
    }
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser, Peer: 'readonly', io: 'readonly' }
    }
  }
)
