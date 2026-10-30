/**
 * Server half of the free-model filter.
 *
 * The built-in "Select model" dialog has no plugin hook for its list, so the
 * catalog itself is filtered: a replayable `model.transform` disables
 * (`enabled = false`) every model that does not belong to the active bucket.
 * Disabling is used instead of `remove` because transforms are replayed from
 * the untouched catalog on every reload, which makes the mode reversible.
 *
 * Free is the default. A location-scoped RPC lets the TUI half toggle between
 * the free-only and paid-only buckets at runtime; `model.reload()` publishes
 * `model.updated`, so every open model picker refreshes in place.
 *
 * Liveness: each provider's `/models` endpoint is queried (cached, ~5 min TTL)
 * and configured entries absent from the live list are disabled too. Fetch
 * failures are treated as "unknown" so transient outages never wipe a provider.
 *
 * No `@opencode/*` imports here: locally discovered server plugins are not
 * given those peer dependencies. The exported object matches the V2 plugin
 * definition shape (`{ id, setup }`) accepted by the promise loader.
 */
import { isFreeModel, isVisible, normalizeMode, type FilterMode } from "./classify"
import { FreeModelFilterRpc } from "./rpc"

interface PluginContext {
  readonly options?: Readonly<Record<string, unknown>>
  readonly model: {
    transform: (callback: (editor: ModelEditor) => void) => Promise<{ dispose?: () => Promise<void> | void }>
    reload: () => Promise<void>
  }
  readonly rpc: {
    register: (
      definition: typeof FreeModelFilterRpc,
      handlers: Record<string, (input: any) => Promise<unknown> | unknown>,
    ) => Promise<{ dispose?: () => Promise<void> | void }>
  }
  // `model.updated` is published by `model.reload()`; subscribing lets the filter
  // re-apply after another plugin rebuilds the catalog. Declared here because this
  // file imports no `@opencode/*` runtime packages - the interface is the whole
  // host surface the plugin touches, so a host that stops publishing the event
  // shows up as a type error instead of a silently dead subscription.
  readonly event: {
    subscribe: (input: { signal?: AbortSignal }) => AsyncIterable<unknown>
  }
}

interface ModelEditor {
  list: () => readonly ModelRecord[]
  update: (providerID: string, modelID: string, update: (model: { enabled?: boolean }) => void) => void
  provider: {
    get: (providerID: string) => { provider?: ProviderRecord } | undefined
  }
}

interface ModelRecord {
  readonly id: string
  readonly providerID: string
  readonly name?: string
  readonly enabled?: boolean
  readonly cost?: readonly { input?: number | null; output?: number | null }[] | null
  readonly settings?: { baseURL?: unknown } | null
}

interface ProviderRecord {
  readonly id?: string
  readonly name?: string
  readonly settings?: { baseURL?: unknown } | null
}

const LIVE_TTL_MS = 5 * 60 * 1000
const FETCH_TIMEOUT_MS = 5000

function freeProvidersFromOptions(options: Readonly<Record<string, unknown>> | undefined) {
  const value = options?.freeProviders
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

async function fetchLiveIds(baseURL: string): Promise<Set<string> | null> {
  const url = baseURL.replace(/\/+$/, "") + "/models"
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "opencode-free-model-filter/1.0", "Accept": "application/json" },
      signal: controller.signal,
    })
    if (!res.ok) return null
    const data = (await res.json()) as { data?: Array<{ id?: unknown }> }
    const ids = new Set<string>()
    for (const m of data?.data ?? []) {
      if (typeof m?.id === "string") ids.add(m.id)
    }
    return ids.size > 0 ? ids : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export function isStale(modelId: string, liveIds: Set<string> | null, configuredIds: readonly string[]): boolean {
  if (!liveIds || liveIds.size === 0) return false
  const overlap = configuredIds.filter((id) => liveIds.has(id)).length
  if (overlap === 0) return false
  return !liveIds.has(modelId)
}

export default {
  id: "free-model-filter",
  async setup(ctx: PluginContext) {
    let mode: FilterMode = normalizeMode(ctx.options?.defaultMode ?? ctx.options?.mode)
    const freeProviders = freeProvidersFromOptions(ctx.options)

    // Cached live id sets per provider. null = fetched but unusable/failed.
    const liveRaw = new Map<string, Set<string> | null>()
    const endpoints = new Map<string, string>()
    const fetching = new Set<string>()
    let changedSinceReload = false

    async function refreshProvider(providerID: string, baseURL: string) {
      endpoints.set(providerID, baseURL)
      if (fetching.has(providerID)) return
      fetching.add(providerID)
      const ids = await fetchLiveIds(baseURL)
      fetching.delete(providerID)
      const prev = liveRaw.get(providerID)
      // Only treat as usable if at least one configured id overlaps (sanity guard).
      liveRaw.set(providerID, ids)
      if (ids !== prev) changedSinceReload = true
    }

    const apply = (editor: ModelEditor) => {
      const models = editor.list()

      // Group configured ids by provider for the overlap guard.
      const byProvider = new Map<string, string[]>()
      for (const m of models) {
        const arr = byProvider.get(m.providerID) ?? []
        arr.push(m.id)
        byProvider.set(m.providerID, arr)
      }

      // Kick off fetches for any provider we haven't seen yet.
      for (const [pid] of byProvider) {
        const provider = editor.provider.get(pid)?.provider
        const baseURL = (provider?.settings?.baseURL ?? models.find((m) => m.providerID === pid)?.settings?.baseURL) as unknown
        if (typeof baseURL === "string" && !endpoints.has(pid)) {
          refreshProvider(pid, baseURL) // fire-and-forget
        }
      }

      for (const model of models) {
        const provider = editor.provider.get(model.providerID)?.provider
        const free = isFreeModel(model, provider, { freeProviders })

        const raw = liveRaw.get(model.providerID)
        const configured = byProvider.get(model.providerID) ?? []
        const stale = isStale(model.id, raw ?? null, configured)

        if (stale || !isVisible(mode, free)) {
          editor.update(model.providerID, model.id, (draft) => {
            draft.enabled = false
          })
        }
      }
    }

    let transform = await ctx.model.transform(apply)

    // Transforms replay in registration order. Plugins that load after this one
    // (e.g. dynamic catalog builders) register later and would re-enable models
    // we disable, leaking free models into the paid-only bucket. Re-registering
    // moves our transform to the end of the replay order, so it always sees the
    // final catalog. Triggered on every model update so late registrations are
    // covered too; it is a no-op once ours is already last (the rebuild then
    // produces identical data and publishes nothing).
    let relocating = false
    async function relocate() {
      if (relocating) return
      relocating = true
      try {
        const previous = transform
        transform = await ctx.model.transform(apply)
        await previous?.dispose?.()
        await ctx.model.reload()
      } catch {
        // A failed relocation leaves the previous registration in place; the
        // next model update retries.
      } finally {
        relocating = false
      }
    }

    const abort = new AbortController()
    const events = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal } as never)) {
          if ((event as { type?: string })?.type === "model.updated") await relocate()
        }
      } catch {}
    })()

    // Periodic refresh.
    const interval = setInterval(async () => {
      const targets = [...endpoints.entries()]
      let anyChanged = false
      await Promise.allSettled(
        targets.map(async ([pid, url]) => {
          const ids = await fetchLiveIds(url)
          const prev = liveRaw.get(pid)
          if (ids !== prev) {
            liveRaw.set(pid, ids)
            anyChanged = true
          }
        }),
      )
      if (anyChanged) {
        try {
          await ctx.model.reload()
        } catch {}
      }
    }, LIVE_TTL_MS)

    const rpc = await ctx.rpc.register(FreeModelFilterRpc, {
      getMode: async () => ({ mode }),
      setMode: async (input: { mode?: unknown }) => {
        mode = normalizeMode(input?.mode, mode)
        await ctx.model.reload()
        return { mode }
      },
      toggle: async () => {
        mode = mode === "paid" ? "free" : "paid"
        await ctx.model.reload()
        return { mode }
      },
    })

    return async () => {
      clearInterval(interval)
      await rpc?.dispose?.()
      await transform?.dispose?.()
    }
  },
}
// done