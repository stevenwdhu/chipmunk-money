import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import OpenAI from 'openai'
import { z } from 'zod'
import { aiProviderInfo } from '@chipmunk/shared'
import { CHATGPT_API, chatgptAccessToken, USAGE_URL } from '../services/chatgpt'
import type { MetaStore } from '../services/context'
import type { StoredAiConfig } from '../services/settings'
import { SYSTEM_PROMPT, userPrompt } from './prompt'
import type { LlmCategoryRequest, ProviderCallResult } from './types'

const TIMEOUT_MS = 20_000

/** One question to a model, answered as JSON of a known shape (structured output where it's supported). */
export interface StructuredCall<T> {
  system: string
  user: string
  /** The answer's name, for providers that ask for one. */
  name: string
  /** The shape asked for (structured output). */
  schema: z.ZodType<T>
  /** The same shape as JSON Schema, for OpenAI-style providers. */
  jsonSchema: Record<string, unknown>
  /** How an answer is checked (looser than `schema` for servers in plain JSON mode). Default: `schema`. */
  parse?: z.ZodType<T>
  /** What the answer looks like, said in words, for servers without structured output. */
  shape: string
  /** Said when the answer doesn't fit. */
  invalid: string
  /** Tokens it may answer with. */
  maxTokens?: number
  /** Allowed to take longer than a quick answer (a batch of many). */
  timeoutMs?: number
}
export interface StructuredResult<T> {
  data: T
  inputTokens: number | null
  outputTokens: number | null
}

function check<T>(call: StructuredCall<T>, text: string): T {
  let json: unknown
  try {
    json = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''))
  } catch {
    throw new Error('The model did not return valid JSON')
  }
  const parsed = (call.parse ?? call.schema).safeParse(json)
  if (!parsed.success) throw new Error(call.invalid)
  return parsed.data
}

export async function structuredAnthropic<T>(cfg: StoredAiConfig, call: StructuredCall<T>): Promise<StructuredResult<T>> {
  const client = new Anthropic({
    ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
    timeout: call.timeoutMs ?? TIMEOUT_MS,
    maxRetries: 1,
  })
  const format = zodOutputFormat(call.schema as never)
  const base = {
    model: cfg.model,
    max_tokens: call.maxTokens ?? 4096,
    system: call.system,
    messages: [{ role: 'user' as const, content: call.user }],
  }

  let response
  try {
    // These need little reasoning; low effort keeps them fast and cheap.
    response = await client.messages.parse({ ...base, output_config: { effort: 'low', format } })
  } catch (err) {
    // Some models (e.g. Haiku 4.5) don't accept `effort`; retry without it.
    if (err instanceof Anthropic.BadRequestError && /effort/i.test(err.message)) {
      response = await client.messages.parse({ ...base, output_config: { format } })
    } else {
      throw err
    }
  }

  if (response.stop_reason === 'refusal') throw new Error('The model declined to answer')
  if (response.stop_reason === 'max_tokens') throw new Error('The model ran out of output tokens')
  const parsed = response.parsed_output as T | null
  if (!parsed) throw new Error('The model returned no structured output')
  return { data: parsed, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }
}

/**
 * What each server and model turned out to support (the step down from structured output, and
 * whether it takes the thinking setting), so it's asked that way from then on rather than refused
 * each time. Kept until the server restarts.
 */
const learned = new Map<string, { step: number; noThinking: boolean }>()

/** Servers you run yourself (Ollama, LM Studio, vLLM), at a URL of your own. */
const selfHosted = (cfg: StoredAiConfig) => cfg.kind === 'openai-compatible' || cfg.kind === 'local'

/**
 * Where an OpenAI-style provider is: fixed for the named ones, your URL for "OpenAI-compatible" (or
 * OpenAI's, for settings saved before that URL was required), and Ollama at localhost:11434 unless you
 * gave another (this app in Docker reaches it at host.docker.internal, say).
 */
export function endpointFor(cfg: StoredAiConfig): string {
  const fixed = aiProviderInfo(cfg.kind).baseUrl
  if (selfHosted(cfg)) return cfg.baseUrl ?? fixed ?? 'https://api.openai.com/v1'
  return fixed ?? cfg.baseUrl ?? 'https://api.openai.com/v1'
}

export async function structuredOpenAI<T>(cfg: StoredAiConfig, call: StructuredCall<T>): Promise<StructuredResult<T>> {
  const client = new OpenAI({
    apiKey: cfg.apiKey || 'not-needed', // local servers such as Ollama ignore the key
    baseURL: endpointFor(cfg),
    timeout: call.timeoutMs ?? TIMEOUT_MS,
    maxRetries: 1,
  })
  const messages = [
    { role: 'system' as const, content: `${call.system}\nRespond with JSON: ${call.shape}.` },
    { role: 'user' as const, content: call.user },
  ]

  // Each step down asks for less, for servers that can't do the one before: the schema, plain JSON
  // mode, then only the words in the system prompt (Ollama with some models answers 501 to both modes).
  const formats: Array<OpenAI.ChatCompletionCreateParams['response_format']> = [
    { type: 'json_schema', json_schema: { name: call.name, schema: call.jsonSchema, strict: true } },
    { type: 'json_object' },
    undefined,
  ]
  // A server you run (Ollama) may think before answering unless told not to, which is slow, and these
  // answers need no reasoning. A server that refuses the setting is asked again without it.
  const key = `${endpointFor(cfg)} ${cfg.model}`
  let { step, noThinking } = learned.get(key) ?? { step: 0, noThinking: selfHosted(cfg) }
  let completion
  for (;;) {
    try {
      completion = await client.chat.completions.create({
        model: cfg.model,
        messages,
        ...(formats[step] ? { response_format: formats[step] } : {}),
        ...(noThinking ? { reasoning_effort: 'none' as const } : {}),
      })
      learned.set(key, { step, noThinking })
      break
    } catch (err) {
      const unsupported = err instanceof OpenAI.APIError && (err.status === 400 || err.status === 422 || err.status === 501)
      if (!unsupported) throw err
      if (noThinking && /reason|think/i.test(err.message)) noThinking = false
      else if (step < formats.length - 1) step++
      else throw err
    }
  }

  const content = completion.choices[0]?.message?.content
  if (!content) throw new Error('The model returned an empty response')
  return { data: check(call, content), inputTokens: completion.usage?.prompt_tokens ?? null, outputTokens: completion.usage?.completion_tokens ?? null }
}

/** What a ChatGPT plan error means for you, by its code (developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery). */
const PLAN_ERRORS: Record<string, string> = {
  subscription_sharing_usage_limit_exceeded: `You've reached a usage limit for ChatGPT plan requests. Check your usage at ${USAGE_URL.replace('https://', '')}. New requests are paused until then.`,
  subscription_sharing_user_not_eligible: 'This ChatGPT account can’t use its plan in other apps.',
  subscription_sharing_usage_unavailable: 'ChatGPT is temporarily unavailable. It’s tried again with the next transactions.',
  subscription_sharing_user_unavailable: 'ChatGPT is temporarily unavailable. It’s tried again with the next transactions.',
  subscription_sharing_invalid_user: 'Your ChatGPT connection is no longer valid. Sign in again in App settings → AI.',
}

/**
 * ChatGPT plan: OpenAI's Responses API with the signed-in account's token. It must stream and not be
 * stored, and the answer counts only once `response.completed` arrives. Settings it doesn't support
 * for a model (structured output, reasoning effort) are dropped and asked again.
 */
export async function structuredChatGPT<T>(cfg: StoredAiConfig, call: StructuredCall<T>, meta: MetaStore): Promise<StructuredResult<T>> {
  const client = new OpenAI({
    apiKey: await chatgptAccessToken(meta),
    baseURL: CHATGPT_API,
    timeout: call.timeoutMs ?? TIMEOUT_MS,
    maxRetries: 0,
    ...(meta.fetch ? { fetch: meta.fetch } : {}),
  })
  const body: Record<string, unknown> = {
    model: cfg.model,
    instructions: `${call.system}\nRespond with JSON: ${call.shape}.`,
    input: [{ role: 'user', content: call.user }],
    store: false,
    stream: true,
    text: { format: { type: 'json_schema', name: call.name, schema: call.jsonSchema, strict: true } },
    // These need little reasoning.
    reasoning: { effort: 'low' },
  }

  let text = ''
  let usage: { input_tokens?: number; output_tokens?: number } | undefined
  for (let attempt = 0; ; attempt++) {
    try {
      text = ''
      const stream = (await client.responses.create(body as never)) as unknown as AsyncIterable<{
        type: string
        delta?: string
        response?: { usage?: typeof usage; error?: { code?: string; message?: string } | null; incomplete_details?: { reason?: string } | null }
        code?: string
        message?: string
      }>
      let completed = false
      for await (const event of stream) {
        if (event.type === 'response.output_text.delta') text += event.delta ?? ''
        else if (event.type === 'response.completed') {
          completed = true
          usage = event.response?.usage
        } else if (event.type === 'response.failed') {
          const code = event.response?.error?.code ?? ''
          throw new Error(PLAN_ERRORS[code] ?? event.response?.error?.message ?? 'ChatGPT couldn’t answer.')
        } else if (event.type === 'response.incomplete') {
          throw new Error(`ChatGPT stopped before answering (${event.response?.incomplete_details?.reason ?? 'incomplete'}).`)
        } else if (event.type === 'error') {
          throw new Error(PLAN_ERRORS[event.code ?? ''] ?? event.message ?? 'ChatGPT couldn’t answer.')
        }
      }
      if (!completed) throw new Error('ChatGPT’s answer was cut off.')
      break
    } catch (err) {
      if (!(err instanceof OpenAI.APIError)) throw err
      const e = err.error as { code?: string; param?: string; message?: string; detail?: string } | undefined
      const param = e?.param ?? err.param ?? ''
      // A setting this model doesn't take: ask again without it.
      if (err.status === 400 && attempt < 2 && param.startsWith('reasoning') && body.reasoning) {
        delete body.reasoning
        continue
      }
      if (err.status === 400 && attempt < 2 && param.startsWith('text') && body.text) {
        delete body.text
        continue
      }
      const code = e?.code ?? err.code ?? ''
      if (PLAN_ERRORS[code]) throw new Error(PLAN_ERRORS[code])
      if (err.status === 401) throw new Error(PLAN_ERRORS.subscription_sharing_invalid_user)
      throw err
    }
  }
  return { data: check(call, text), inputTokens: usage?.input_tokens ?? null, outputTokens: usage?.output_tokens ?? null }
}

/** Asks a configured provider one question, answered as JSON of a known shape. */
export function callStructured<T>(cfg: StoredAiConfig, call: StructuredCall<T>, meta: MetaStore): Promise<StructuredResult<T>> {
  const protocol = aiProviderInfo(cfg.kind).protocol
  if (protocol === 'anthropic') return structuredAnthropic(cfg, call)
  if (protocol === 'chatgpt') return structuredChatGPT(cfg, call, meta)
  return structuredOpenAI(cfg, call)
}

// Categorizing a transaction ------------------------------------------------------------------

function resultSchema(names: string[]) {
  return z.object({
    category: z.enum(names as [string, ...string[]]),
    confidence: z.number(),
    agreesWithBank: z.boolean(),
  })
}

/**
 * The list's name for what a model answered. Without structured output, a model may answer as the
 * list is written ("Income › Salary (income)", see `userPrompt`), or in other letter case.
 */
export function categoryNamed(names: readonly string[], answer: string): string {
  if (names.includes(answer)) return answer
  const same = (x: string) => names.find((n) => n.toLowerCase() === x.trim().toLowerCase())
  const tail = answer.split('›').pop() ?? ''
  // The list's notes after a name, taken off last, so a name that ends in brackets still matches as it is.
  const unnoted = (x: string) => x.replace(/\s*\((?:income|not spending or income[^)]*)\)\s*$/i, '')
  return same(answer) ?? same(tail) ?? same(unnoted(tail)) ?? answer
}

/** A transaction's category, from one configured provider. */
export async function callProvider(cfg: StoredAiConfig, req: LlmCategoryRequest, meta: MetaStore): Promise<ProviderCallResult> {
  const names = req.categories.map((c) => c.name)
  const res = await callStructured(
    cfg,
    {
      system: SYSTEM_PROMPT,
      user: userPrompt(req),
      name: 'category',
      schema: resultSchema(names),
      // Servers without structured output may leave out agreesWithBank, or name the category's group too.
      parse: resultSchema(names).extend({
        category: z.string().transform((x) => categoryNamed(names, x)).pipe(z.enum(names as [string, ...string[]])),
        agreesWithBank: z.boolean().optional(),
      }) as never,
      jsonSchema: {
        type: 'object',
        properties: { category: { type: 'string', enum: names }, confidence: { type: 'number' }, agreesWithBank: { type: 'boolean' } },
        required: ['category', 'confidence', 'agreesWithBank'],
        additionalProperties: false,
      },
      shape: '{"category": string, "confidence": number, "agreesWithBank": boolean}',
      invalid: 'The model picked a category that is not in the list',
    },
    meta,
  )
  return { ...res.data, agreesWithBank: res.data.agreesWithBank ?? false, inputTokens: res.inputTokens, outputTokens: res.outputTokens }
}
