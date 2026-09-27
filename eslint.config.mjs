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
