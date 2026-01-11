import js from '@eslint/js';
import globals from 'globals';
import jsdoc from 'eslint-plugin-jsdoc';

export default [
    {
        ignores: [
            '**/node_modules/**',
            '**/dist/**',
            '**/.git/**',
            'public/lib/**',
            'backups/**',
            'data/**',
            'cache/**',
            'src/tokenizers/**',
            'docker/**',
            'plugins/**',
            '**/*.min.js',
            'public/scripts/extensions/quick-reply/lib/**',
            'public/scripts/extensions/tts/lib/**',
        ],
    },
    js.configs.recommended,
    {
        plugins: {
            jsdoc,
        },
        languageOptions: {
            ecmaVersion: 'latest',
        },
        rules: {
            'jsdoc/no-undefined-types': ['warn', { disableReporting: true, markVariablesAsUsed: true }],
            'no-unused-vars': ['error', { args: 'none' }],
            'no-control-regex': 'off',
            'no-constant-condition': ['error', { checkLoops: false }],
            'require-yield': 'off',
            'quotes': ['error', 'single'],
            'semi': ['error', 'always'],
            'indent': ['error', 4, { SwitchCase: 1, FunctionDeclaration: { parameters: 'first' } }],
            'comma-dangle': ['error', 'always-multiline'],
            'eol-last': ['error', 'always'],
            'no-trailing-spaces': 'error',
            'object-curly-spacing': ['error', 'always'],
            'space-infix-ops': 'error',
            'no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
            'no-cond-assign': 'error',
            'no-unneeded-ternary': 'error',
            'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true }],
            'no-async-promise-executor': 'off',
            'no-inner-declarations': 'off',
        },
    },
    {
        files: ['src/**/*.js', './*.js', 'plugins/**/*.js'],
        languageOptions: {
            sourceType: 'module',
            globals: {
                ...globals.node,
                globalThis: 'readonly',
                Deno: 'readonly',
            },
        },
    },
    {
        files: ['*.cjs'],
        languageOptions: {
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
            },
        },
    },
    {
        files: ['src/**/*.mjs'],
        languageOptions: {
            sourceType: 'module',
            globals: {
                ...globals.node,
            },
        },
    },
    {
        files: ['public/**/*.js'],
        languageOptions: {
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.jquery,
                globalThis: 'readonly',
                ePub: 'readonly',
                pdfjsLib: 'readonly',
                toastr: 'readonly',
                SillyTavern: 'readonly',
                RoutTavern: 'readonly',
            },
        },
    },
];
