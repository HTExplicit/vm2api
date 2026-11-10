import type { QueryClient } from '@tanstack/react-query'
import { onPanelSessionChange } from './session'

/** Queries are scoped to the current login and backend, including in-flight work. */
export function bindSessionQueryCache(queryClient: QueryClient) {
  return onPanelSessionChange(() => {
    // clear() destroys and cancels old queries, so late responses cannot refill
    // their entries after the next account has signed in.
    queryClient.clear()
  })
}
