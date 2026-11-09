/**
 * Plaid Link: Plaid's own window for signing in to a bank. Its script loads from Plaid the first
 * time it's needed (https://plaid.com/docs/link/web/).
 */

interface PlaidHandler {
  open(): void
  destroy(): void
}
interface PlaidLinkError {
  error_type: string
  error_code: string
  error_message: string
  display_message: string | null
}
interface ExitMetadata {
  institution?: { name: string; institution_id: string } | null
  status?: string | null
  link_session_id?: string
  request_id?: string
}
/** What Link reports as you go; ERROR events carry the code behind its "Something went wrong". */
interface EventMetadata {
  error_type?: string | null
  error_code?: string | null
  error_message?: string | null
  institution_name?: string | null
  view_name?: string | null
  link_session_id?: string
  request_id?: string
}
interface PlaidGlobal {
  create(config: {
    token: string
    onSuccess: (publicToken: string, metadata: { institution?: { name: string; institution_id: string } | null }) => void
    onExit: (error: PlaidLinkError | null, metadata: ExitMetadata) => void
    onEvent?: (eventName: string, metadata: EventMetadata) => void
  }): PlaidHandler
}

/**
 * Link closed on an error. `details` names Plaid's error code, the bank and the Link session, which
 * Plaid's dashboard (Developers → Logs) can look up.
 */
export class PlaidLinkFailure extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly details: string,
  ) {
    super(message)
  }
}

declare global {
  interface Window {
    Plaid?: PlaidGlobal
  }
}

const SCRIPT = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js'
let loading: Promise<PlaidGlobal> | null = null

function load(): Promise<PlaidGlobal> {
  if (window.Plaid) return Promise.resolve(window.Plaid)
  loading ??= new Promise<PlaidGlobal>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SCRIPT
    script.async = true
    script.onload = () => (window.Plaid ? resolve(window.Plaid) : reject(new Error('Plaid Link didn’t load.')))
    script.onerror = () => {
      loading = null
      script.remove()
      reject(new Error('Couldn’t load Plaid Link. Check your connection and try again.'))
    }
    document.head.append(script)
  })
  return loading
}

/**
 * Opens Plaid Link with a link token from the server. Resolves with the public token once you've
 * signed in to a bank, or null if you close Link without finishing.
 */
export async function openPlaidLink(token: string): Promise<{ publicToken: string; institution: string | null } | null> {
  const Plaid = await load()
  return new Promise((resolve, reject) => {
    let institution: string | null = null
    const handler = Plaid.create({
      token,
      onSuccess: (publicToken, metadata) => {
        handler.destroy()
        resolve({ publicToken, institution: metadata.institution?.name ?? null })
      },
      onEvent: (name, metadata) => {
        institution = metadata.institution_name ?? institution
        if (name === 'ERROR') console.warn('[plaid] Link error', metadata)
      },
      onExit: (error, metadata) => {
        handler.destroy()
        if (!error) return resolve(null)
        console.warn('[plaid] Link closed on an error', error, metadata)
        const bank = metadata.institution?.name ?? institution
        const details = [
          `Plaid error ${error.error_code}${error.error_type ? ` (${error.error_type})` : ''}`,
          bank && `at ${bank}`,
          metadata.link_session_id && `Link session ${metadata.link_session_id}`,
        ]
        const message = error.display_message || error.error_message || 'Plaid Link closed with an error.'
        reject(new PlaidLinkFailure(message, error.error_code, details.filter(Boolean).join(' · ')))
      },
    })
    handler.open()
  })
}
