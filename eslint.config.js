import eslint from '@eslint/js';
import pluginVue from 'eslint-plugin-vue';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'apps/web/legacy/upstream/**',
      'apps/web/.generated/**',
      'apps/web/index.html',
      'apps/mobile/android/**',
      'apps/mobile/ios/**',
      'apps/harmony/.hvigor/**',
      'apps/harmony/oh_modules/**',
      'apps/harmony/entry/build/**',
      'apps/harmony/entry/src/main/resources/rawfile/**',
      'apps/desktop/src-tauri/target/**',
      'apps/desktop/src-tauri/gen/schemas/**',
      'apps/desktop/src-tauri/generated/**',
      'SillyTavern-1.18.0/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['apps/web/**/*.{ts,vue}', 'packages/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
      },
    },
    rules: {
      'vue/max-attributes-per-line': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/singleline-html-element-content-newline': 'off',
    },
  },
  {
    files: ['**/*.config.{js,ts}', '**/scripts/**/*.mjs', 'apps/remote-server/nodejs/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
);
