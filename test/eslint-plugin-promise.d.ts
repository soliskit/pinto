declare module 'eslint-plugin-promise' {
  import type { ESLint, Linter } from 'eslint'

  interface PromisePlugin extends ESLint.Plugin {
    rules: NonNullable<ESLint.Plugin['rules']>
    rulesConfig: Record<string, 0 | 1 | 2>
    configs: {
      recommended: Linter.LegacyConfig
      'flat/recommended': Linter.Config
    }
  }

  const plugin: PromisePlugin
  export = plugin
}
