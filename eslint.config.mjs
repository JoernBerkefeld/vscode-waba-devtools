import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import eslintPluginUnicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import jsdoc from 'eslint-plugin-jsdoc';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: [
            '**/node_modules/**',
            'dist/**',
            'out/**',
            '**/coverage/**',
            'scripts/**',
            '**/*.vsix',
        ],
    },
    eslint.configs.recommended,
    eslintPluginPrettierRecommended,
    jsdoc.configs['flat/recommended'],
    eslintPluginUnicorn.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            globals: {
                ...globals.nodeBuiltin,
            },
        },
        rules: {
            'no-console': 'warn',
            'unicorn/better-regex': 'off',
            'unicorn/catch-error-name': ['error', { name: 'ex' }],
            'unicorn/explicit-length-check': 'off',
            'unicorn/filename-case': 'off',
            'unicorn/no-array-callback-reference': 'off',
            'unicorn/no-array-reduce': 'off',
            'unicorn/no-asterisk-prefix-in-documentation-comments': 'off',
            'unicorn/no-await-expression-member': 'off',
            'unicorn/no-empty-file': 'off',
            'unicorn/no-hex-escape': 'off',
            'unicorn/no-nested-ternary': 'off',
            'unicorn/no-null': 'off',
            'unicorn/no-static-only-class': 'off',
            'unicorn/no-unused-properties': 'warn',
            'unicorn/numeric-separators-style': 'off',
            'unicorn/prefer-array-some': 'off',
            'unicorn/prefer-module': 'off',
            'unicorn/prefer-set-has': 'off',
            'unicorn/prefer-spread': 'off',
            'unicorn/prefer-string-replace-all': 'error',
            'unicorn/prevent-abbreviations': 'off',
            'jsdoc/require-jsdoc': 'off',
            'jsdoc/require-param-type': 'off',
        },
    },
    {
        // VS Code loads --extensionTestsPath with require(): this file is CommonJS by design.
        files: ['test-fixtures/host-smoke/**/*.js'],
        languageOptions: {
            sourceType: 'commonjs',
            globals: { ...globals.commonjs },
        },
        rules: {
            '@typescript-eslint/no-require-imports': 'off',
        },
    },
);
