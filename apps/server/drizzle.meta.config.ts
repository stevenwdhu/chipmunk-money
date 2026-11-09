import { defineConfig } from 'drizzle-kit'

// Schema of data/meta.db: the list of ledgers and app-wide settings.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/meta-schema.ts',
  out: './drizzle/meta',
})
