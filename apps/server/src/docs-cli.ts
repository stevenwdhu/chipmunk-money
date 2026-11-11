import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { TOOLS } from '@chipmunk/mcp'
import { createApi } from './app'
import { apiReference, mcpReference, withReference } from './docs'
import { openStorage } from './storage'

/** `pnpm docs:update`: writes the reference parts of docs/api.md and docs/mcp.md from the code. */
const root = path.resolve(import.meta.dirname, '../../..')
const storage = openStorage({ dataDir: null })
const { specs } = createApi(storage)
storage.close()
for (const [file, reference] of [
  ['docs/api.md', apiReference(specs)],
  ['docs/mcp.md', mcpReference(TOOLS)],
] as const) {
  const full = path.join(root, file)
  const before = readFileSync(full, 'utf8')
  const after = withReference(before, reference)
  if (after !== before) writeFileSync(full, after)
  console.log(`${file}: ${after === before ? 'up to date' : 'updated'}`)
}
