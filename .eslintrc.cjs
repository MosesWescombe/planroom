/** ESLint for the server, the shared contract and the React page. Carried over from scopious-platform's web config. */
module.exports = {
    root: true,
    env: { browser: true, es6: true, jest: true },
    parser: '@typescript-eslint/parser',
    parserOptions: { ecmaVersion: 11, ecmaFeatures: { jsx: true, arrowFunctions: true, spread: true } },
    plugins: ['react', '@typescript-eslint', 'import'],
    extends: [
        'eslint:recommended',
        'plugin:react/recommended',
        'plugin:@typescript-eslint/recommended',
        'plugin:react-hooks/recommended',
        'plugin:import/typescript',
        'prettier'
    ],
    settings: { react: { pragma: 'React', version: 'detect' } },
    rules: {
        'no-console': 'off',
        'no-await-in-loop': 'off',
        'no-unused-vars': 'off',
        'object-curly-spacing': ['error', 'always'],
        'no-restricted-syntax': [
            'error',
            {
                selector: 'ForInStatement',
                message:
                    'for..in loops iterate over the entire prototype chain, which is virtually never what you want. Use Object.{keys,values,entries}, and iterate over the resulting array.'
            },
            {
                selector: 'LabeledStatement',
                message: 'Labels are a form of GOTO; using them makes code confusing and hard to maintain and understand.'
            },
            {
                selector: 'WithStatement',
                message: '`with` is disallowed in strict mode because it makes code impossible to predict and optimize.'
            }
        ],
        'import/first': 'error',
        'import/order': ['error', { groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'] }],
        'react/prop-types': 'off',
        'react/react-in-jsx-scope': 'off',
        'react/no-unknown-property': 'warn',
        'react/no-array-index-key': 'off',
        'react/jsx-no-constructed-context-values': 'error',
        'react/jsx-filename-extension': [1, { extensions: ['.ts', '.tsx'] }],
        'react/no-danger': 'error',
        'react/no-multi-comp': ['error', { ignoreStateless: true }],
        'react/sort-comp': 'error',
        'react/jsx-no-useless-fragment': 'error',
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-empty-object-type': 'off',
        '@typescript-eslint/no-unused-vars': [
            'error',
            { vars: 'all', args: 'after-used', ignoreRestSiblings: true, caughtErrors: 'none' }
        ],
        '@typescript-eslint/no-unused-expressions': [
            'error',
            { allowShortCircuit: true, allowTernary: true, allowTaggedTemplates: true }
        ]
    },
    overrides: [
        { files: ['*.test.ts', '*.test.tsx'], rules: { '@typescript-eslint/no-unused-expressions': 'off' } },
        { files: ['src/server/**/*.ts', 'src/shared/**/*.ts'], env: { node: true, browser: false } }
    ]
};
