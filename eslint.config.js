import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', 'dev/.next/**', 'dev/payload-types.ts', 'test-results/**'] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // Existing integration fixtures use flexible Payload adapter doubles.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/services/content.ts', 'src/services/validation.ts'],
    // These expressions intentionally reject unsafe control characters.
    rules: { 'no-control-regex': 'off' },
  },
)
