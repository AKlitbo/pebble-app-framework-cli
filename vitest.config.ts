/**
 * Vitest config.
 *
 * Every spec runs under node against fixture trees in a temp folder. Git and npm go through a fake
 * runner, so the default run never touches the network or a real framework clone.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
  },
});
