import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// Typed linting through the TypeScript project service, so every rule that needs type information runs
// against the same tsconfig.json that `tsc --noEmit -p .` checks.
export default defineConfig(...tseslint.configs.recommendedTypeChecked, {
  languageOptions: {
    parserOptions: {
      projectService: true,
      tsconfigRootDir: import.meta.dirname,
    },
  },
});
