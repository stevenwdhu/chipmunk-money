import { useRoute, useRouter } from 'vue-router'

/** Reading and replacing a page's URL query, for state that should survive reloads and links. */
export function useQueryState() {
  const route = useRoute()
  const router = useRouter()
  const q = (k: string) => (typeof route.query[k] === 'string' ? (route.query[k] as string) : undefined)
  /** Replaces these keys (undefined drops one). */
  function setQuery(patch: Record<string, string | undefined>) {
    const query = { ...route.query, ...patch }
    // Nothing changes: no navigation, as one to the same place still scrolls to the top (and would
    // stop a scroll to a transaction, say).
    if (router.resolve({ query }).fullPath === route.fullPath) return
    router.replace({ query })
  }
  return { q, setQuery }
}
