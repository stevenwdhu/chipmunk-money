import { defineConfig } from 'drizzle-kit'

// The one database (data/chipmunk.db). The views and triggers are added by hand to the baseline's SQL.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
})
