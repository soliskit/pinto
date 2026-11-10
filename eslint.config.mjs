import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import promise from 'eslint-plugin-promise'
import prettierRecommended from 'eslint-plugin-prettier/recommended'

export default tseslint.config(
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
    extends: [
      tseslint.configs.recommendedTypeChecked,
      tseslint.configs.strictTypeChecked
    ],
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
    extends: [tseslint.configs.recommendedTypeChecked],
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
