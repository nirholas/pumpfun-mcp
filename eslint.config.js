import js from '@eslint/js';
import globals from 'globals';

export default [
	{ ignores: ['node_modules/', 'docs/'] },
	js.configs.recommended,
	{
		files: ['**/*.js', '**/*.mjs'],
		languageOptions: {
			ecmaVersion: 2023,
			sourceType: 'module',
			globals: { ...globals.node },
		},
		rules: {
			eqeqeq: ['error', 'always'],
			'no-var': 'error',
			'prefer-const': 'error',
			'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
		},
	},
];
