import { defineConfig } from 'eslint/config'
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import promise from 'eslint-plugin-promise'
import prettierRecommended from 'eslint-plugin-prettier/recommended'

// Every Node-side JS/MJS file shares the existing Node project: tsconfig.json
// now checks JS (checkJs) and includes all of src/test/types, so the typed
// rule sets apply to the whole test tree, not an enumerated subset.
const helperFiles = [
  'test/**/*.mjs',
  'test/measurement/fixtures/fixture-src.js',
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
