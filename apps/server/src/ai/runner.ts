import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { aiProviderInfo } from '@st/shared'
import { aiCalls } from '../db/schema'
import type { AppContext } from '../services/context'
import { aiConfig, type AiSlot, type StoredAiConfig } from '../services/settings'
import { callProvider, callStructured, type StructuredCall } from './providers'
import type { LlmCategorizer, LlmCategoryRequest, LlmCategoryResult } from './types'

function logCall(
  ctx: AppContext,
  entry: { slot: AiSlot; model: string; latencyMs: number; ok: boolean; error?: string; inputTokens?: number | null; outputTokens?: number | null },
) {
  ctx.db
    .insert(aiCalls)
    .values({
      slot: entry.slot,
      model: entry.model,
      latencyMs: entry.latencyMs,
      ok: entry.ok,
      error: entry.error?.slice(0, 500) ?? null,
      inputTokens: entry.inputTokens ?? null,
      outputTokens: entry.outputTokens ?? null,
    })
    .run()
}

/**
 * What an HTTP status from a provider means, for a provider at a URL you chose (OpenAI-compatible,
 * local). What it sent isn't repeated: it could be any server's reply, which would make this a way
 * to read them. A hosted provider at its own address says why itself (out of credit, say).
 */
const STATUS_REASONS: Record<number, string> = {
  400: 'The provider refused the request. Check the model name.',
  401: 'The provider refused the API key.',
  403: 'The API key isn’t allowed to use this.',
  404: 'Not found. Check the model name (and the URL, for an OpenAI-compatible server).',
  408: 'The provider took too long to answer.',
  413: 'The request was too big for the provider.',
  429: 'Too many requests, or the account is out of credit.',
}

/** Whether the provider is a hosted one at its own address, so what it says can be shown. */
function trustedProvider(cfg: Pick<StoredAiConfig, 'kind' | 'baseUrl'> | undefined): boolean {
  if (!cfg) return false
  const info = aiProviderInfo(cfg.kind)
  if (info.group !== 'hosted') return false
  if (!cfg.baseUrl) return true
  try {
    return info.baseUrl !== null && new URL(cfg.baseUrl).origin === new URL(info.baseUrl).origin
  } catch {
    return false
  }
}

/** A short, readable reason for a provider failure: the status and what it means. */
export function describeError(err: unknown, cfg?: Pick<StoredAiConfig, 'kind' | 'baseUrl'>): string {
  if (err instanceof Anthropic.APIConnectionError || err instanceof OpenAI.APIConnectionError) {
    return "Couldn't reach the provider. Check that it's running and reachable from this server (and the URL, for an OpenAI-compatible server)."
  }
  if (err instanceof Anthropic.APIError || err instanceof OpenAI.APIError) {
    if (!err.status) return 'The provider’s answer couldn’t be read.'
    if (trustedProvider(cfg)) {
      const body = err.error as { error?: { message?: string }; message?: string } | undefined
      const detail = body?.error?.message ?? body?.message
      if (detail) return `${err.status} · ${detail.slice(0, 300)}`
    }
    const reason = STATUS_REASONS[err.status] ?? (err.status >= 500 ? 'The provider had a problem on its side. Try again later.' : 'The provider refused the request.')
    return `${err.status} · ${reason}`
  }
  // A reply that isn't JSON (the message quotes the start of it).
  if (err instanceof SyntaxError) return 'The provider’s answer wasn’t JSON. Check the URL, for an OpenAI-compatible server.'
  return err instanceof Error ? err.message : String(err)
}

/** Calls one configured slot, logging the outcome. Throws on failure. */
export async function runSlot(ctx: AppContext, slot: AiSlot, req: LlmCategoryRequest): Promise<LlmCategoryResult> {
  const cfg = aiConfig(ctx.meta, slot)
  if (!cfg) throw new Error(`No ${slot} AI provider is configured`)
  const started = Date.now()
  try {
    const res = await callProvider(cfg, req, ctx.meta)
    logCall(ctx, {
      slot,
      model: cfg.model,
      latencyMs: Date.now() - started,
      ok: true,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
    })
    return { category: res.category, confidence: Math.max(0, Math.min(1, res.confidence)), agreesWithBank: res.agreesWithBank ?? false, slot, model: cfg.model }
  } catch (err) {
    const message = describeError(err, cfg)
    logCall(ctx, { slot, model: cfg.model, latencyMs: Date.now() - started, ok: false, error: message })
    throw new Error(message, { cause: err })
  }
}

/** Primary first; on any failure, the fallback; null when neither is configured or both fail. */
export function configuredCategorizer(ctx: AppContext): LlmCategorizer {
  return async (req) => {
    for (const slot of ['primary', 'fallback'] as const) {
      if (!aiConfig(ctx.meta, slot)) continue
      try {
        return await runSlot(ctx, slot, req)
      } catch {
        // try the next slot
      }
    }
    return null
  }
}

export function aiEnabled(ctx: AppContext): boolean {
  return !!(ctx.llm || aiConfig(ctx.meta, 'primary') || aiConfig(ctx.meta, 'fallback'))
}

/**
 * Asks the configured providers one question answered as JSON (the primary, then on any failure the
 * fallback), each call logged in this ledger's AI usage. Throws why the last one failed.
 */
export async function askStructured<T>(ctx: AppContext, call: StructuredCall<T>): Promise<{ data: T; model: string }> {
  let last: Error = new Error('No AI provider is set up. Add one in App settings → AI.')
  for (const slot of ['primary', 'fallback'] as const) {
    const cfg = aiConfig(ctx.meta, slot)
    if (!cfg) continue
    const started = Date.now()
    try {
      const res = await callStructured(cfg, call, ctx.meta)
      logCall(ctx, { slot, model: cfg.model, latencyMs: Date.now() - started, ok: true, inputTokens: res.inputTokens, outputTokens: res.outputTokens })
      return { data: res.data, model: cfg.model }
    } catch (err) {
      const message = describeError(err, cfg)
      logCall(ctx, { slot, model: cfg.model, latencyMs: Date.now() - started, ok: false, error: message })
      last = new Error(message, { cause: err })
    }
  }
  throw last
}
