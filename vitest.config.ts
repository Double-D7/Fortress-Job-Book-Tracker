import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // The digest module is shared with the Supabase Edge Function, so
      // it lives beside the function rather than under src/. Same file,
      // two runtimes — see the header comment in digest.ts.
      '@shared': fileURLToPath(
        new URL('./supabase/functions/_shared', import.meta.url)),
    },
  },
  test: { environment: 'node', include: ['src/test/**/*.test.ts'] },
})
