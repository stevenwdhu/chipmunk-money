import { z } from 'zod'
import type { ApiScope } from '@st/shared'
import type { ToolDef } from '@st/mcp'
import { TAGS } from './api/openapi'
import type { RouteSpec } from './api/router'

/**
 * The reference parts of docs/api.md and docs/mcp.md, made from the code: every API endpoint, and
 * every MCP tool with its arguments. `pnpm docs:update` writes them between the files' markers, and a test
 * fails when they're out of date.
 */

export const START = '<!-- reference:start (made by `pnpm docs:update` from the code: edit the code, not this) -->'
export const END = '<!-- reference:end -->'

/** The document with its reference part replaced. */
export function withReference(doc: string, reference: string): string {
  const from = doc.indexOf(START)
  const to = doc.indexOf(END)
  if (from < 0 || to < from) throw new Error(`The document needs ${START} and ${END} around its reference`)
  return `${doc.slice(0, from + START.length)}\n\n${reference.trim()}\n\n${doc.slice(to)}`
}

/** A table cell: one line, its pipes escaped. */
const cell = (text: string) => text.replace(/\s*\n+\s*/g, ' ').replace(/\|/g, '\\|').trim()
const SCOPES: Record<ApiScope, string> = { read: 'read', write: 'write', admin: 'admin' }

/** Every endpoint, by section: method, path, what it does and the scope a key needs. */
export function apiReference(specs: RouteSpec[]): string {
  const out: string[] = []
  for (const tag of TAGS) {
    const routes = specs.filter((s) => s.tag === tag.name)
    if (!routes.length) continue
    out.push(`### ${tag.name}`, '', tag.description, '', '| Method | Path | What it does | Scope |', '|---|---|---|---|')
    for (const r of routes) {
      const path = r.path.replace(/:(\w+)/g, '{$1}')
      const dry = r.dryRun ? ' Accepts `?dryRun=true`.' : ''
      out.push(`| ${r.method.toUpperCase()} | \`${path}\` | ${cell(r.summary)}.${dry} | ${SCOPES[r.scope]} |`)
    }
    out.push('')
  }
  const missing = specs.filter((s) => !TAGS.some((t) => t.name === s.tag))
  if (missing.length) throw new Error(`Routes in no section of the docs: ${missing.map((s) => s.path).join(', ')}`)
  return out.join('\n')
}

type JsonSchema = { type?: string | string[]; enum?: unknown[]; const?: unknown; items?: JsonSchema; anyOf?: JsonSchema[]; description?: string; default?: unknown; properties?: Record<string, JsonSchema>; required?: string[] }

/** A JSON schema's type in a few words: `string`, `number`, `"a" \| "b"`, `string[]`, `object`. */
function typeOf(s: JsonSchema): string {
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(' \\| ')
  if (s.const !== undefined) return JSON.stringify(s.const)
  if (s.anyOf) return [...new Set(s.anyOf.map(typeOf))].join(' or ')
  if (s.type === 'array') return `${s.items ? typeOf(s.items) : 'any'}[]`
  if (Array.isArray(s.type)) return s.type.join(' or ')
  if (s.type === 'integer') return 'number'
  return s.type ?? 'any'
}

const SCOPE_TITLES: Record<ApiScope, string> = {
  read: 'Read (a *Read only* key)',
  write: 'Write (a *Read and write* key)',
  admin: 'Full access (a *Full access* key)',
}

/** Every tool, by the access it needs: what it does, and its arguments. */
export function mcpReference(tools: ToolDef[]): string {
  const out: string[] = []
  for (const scope of ['read', 'write', 'admin'] as const) {
    const list = tools.filter((t) => t.scope === scope)
    if (!list.length) continue
    out.push(`### ${SCOPE_TITLES[scope]}`, '')
    for (const t of list) {
      out.push(`#### \`${t.name}\``, '', `**${t.title}.** ${t.description.trim()}`, '')
      const schema = z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any' }) as JsonSchema
      const args = Object.entries(schema.properties ?? {})
      if (!args.length) {
        out.push('No arguments.', '')
        continue
      }
      out.push('| Argument | Type | | What it is |', '|---|---|---|---|')
      for (const [name, s] of args) {
        const required = schema.required?.includes(name) && s.default === undefined ? 'required' : 'optional'
        const fallback = s.default !== undefined ? ` Default: \`${JSON.stringify(s.default)}\`.` : ''
        out.push(`| \`${name}\` | ${cell(typeOf(s))} | ${required} | ${cell(`${s.description ?? ''}${fallback}`)} |`)
      }
      out.push('')
    }
  }
  return out.join('\n')
}
