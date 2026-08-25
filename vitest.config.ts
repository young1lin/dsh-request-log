import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Specs exercise the source directly; *.client.spec.ts would be the jsdom browser lane.
    include: ['tests/**/*.spec.ts'],
  },
})
