import { defineConfig } from 'drizzle-kit'

// Schema of each ledger file (data/ledgers/<id>.db). The app-wide database has its own config:
// drizzle.meta.config.ts.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle/ledger',
})
