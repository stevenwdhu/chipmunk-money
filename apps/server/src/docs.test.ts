import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TOOLS } from '@st/mcp'
import { createApi } from './app'
import { apiReference, mcpReference, withReference } from './docs'
import { testStorage } from './test/helpers'

const read = (file: string) => readFileSync(path.resolve(import.meta.dirname, '../../..', file), 'utf8')

describe('docs', () => {
  // When one fails: run `pnpm docs:update` and commit the docs it updates.
  it('list every API endpoint in docs/api.md as the code has them', () => {
    const doc = read('docs/api.md')
    expect(withReference(doc, apiReference(createApi(testStorage()).specs))).toBe(doc)
  })

  it('list every MCP tool and its arguments in docs/mcp.md as the code has them', () => {
    const doc = read('docs/mcp.md')
    expect(withReference(doc, mcpReference(TOOLS))).toBe(doc)
  })
})
