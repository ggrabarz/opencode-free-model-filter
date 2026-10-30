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
 * Liveness (opt-in, `options.liveness: true`): each provider's `/models` endpoint
 * is queried (cached, ~5 min TTL) and configured entries absent from the live list
 * are disabled too. Fetch failures are treated as "unknown" so transient outages
 * never wipe a provider. It is off by default because the plugin's own reload
 * cycle plus a catalog that keeps changing is what took the background service
 * down on 2026-10-30: `model.reload()` publishes `model.updated`, the subscription
 * reacts to `model.updated`, and every liveness result changed the catalog again,
 * so the cycle never quenched and the event loop starved (HTTP endpoints stopped
 * answering within 15 s). Three rules keep the cycle bounded, all of them in
 * `setup` below:
 *
 *  1. a rebuild that produces exactly the catalog the last reload published must
 *     not reload (`catalogSignature`),
 *  2. fetches are never started from inside the transform - the transform runs
 *     during a catalog rebuild, so its side effects are deferred,
 *  3. a relocation cap stops reacting to `model.updated` if the plugin relocated
 *     more than `RELOCATE_LIMIT` times inside `RELOCATE_WINDOW_MS`.
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
// Failsafe for the reload cycle: if the plugin had to relocate this many times
// inside the window, something on the box keeps rebuilding the catalog and the
// plugin stops reacting to `model.updated` instead of starving the host.
const RELOCATE_LIMIT = 8
const RELOCATE_WINDOW_MS = 10_000

/** Liveness is opt-in; the default is the network-free v2.0.0 behaviour. */
export function livenessEnabled(options: Readonly<Record<string, unknown>> | undefined): boolean {
  return options?.liveness === true
}

/**
 * The catalog a rebuild produced: the enabled model ids, ordered. Two rebuilds
 * with the same signature mean nothing changed, and reloading on equality is
 * what turns `model.updated` -> `model.reload()` -> `model.updated` into a loop.
 */
export function catalogSignature(ids: readonly string[], disabled: ReadonlySet<string>): string {
  return ids.filter((id) => !disabled.has(id)).sort().join(",")
}

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
    const liveness = livenessEnabled(ctx.options)

    // Cached live id sets per provider. null = fetched but unusable/failed.
    const liveRaw = new Map<string, Set<string> | null>()
    const endpoints = new Map<string, string>()
    const fetching = new Set<string>()
    // Signature published by the last reload, and the signature the transform is
    // producing right now. `relocate` compares them.
    let published = ""
    let produced = ""
    let relocationStorm = false
    let relocating = false
    let relocations = 0
    let windowStart = 0

    async function refreshProvider(providerID: string, baseURL: string) {
      endpoints.set(providerID, baseURL)
      if (fetching.has(providerID)) return
      fetching.add(providerID)
      try {
        const ids = await fetchLiveIds(baseURL)
        const prev = liveRaw.get(providerID)
        liveRaw.set(providerID, ids)
        // A new live set changes which models are stale, so the catalog has to be
        // rebuilt - coalesced, and never from inside the transform.
        if (ids !== prev) queueRelocate()
      } finally {
        fetching.delete(providerID)
      }
    }

    // One relocation per burst: fetches and late registrations tend to land together.
    let queued = false
    function queueRelocate() {
      if (queued) return
      queued = true
      const timer = setTimeout(() => {
        queued = false
        void relocate()
      }, 250)
      timer.unref?.()
    }

    function scheduleFetches() {
      if (!liveness) return
      for (const [providerID, baseURL] of [...endpoints]) {
        if (!liveRaw.has(providerID) && !fetching.has(providerID)) void refreshProvider(providerID, baseURL)
      }
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

      // Only note the endpoints here; the transform runs in the middle of a catalog
      // rebuild, so starting fetches from it re-enters the host while it is building.
      for (const [providerID] of byProvider) {
        if (endpoints.has(providerID)) continue
        const provider = editor.provider.get(providerID)?.provider
        const baseURL = (provider?.settings?.baseURL ?? models.find((m) => m.providerID === providerID)?.settings?.baseURL) as unknown
        if (typeof baseURL === "string") endpoints.set(providerID, baseURL)
      }
      const seenFetch = endpoints.size
      if (liveness && seenFetch > 0) queueMicrotask(scheduleFetches)

      const disabled = new Set<string>()
      for (const model of models) {
        const provider = editor.provider.get(model.providerID)?.provider
        const free = isFreeModel(model, provider, { freeProviders })

        const raw = liveRaw.get(model.providerID)
        const configured = byProvider.get(model.providerID) ?? []
        const stale = liveness && isStale(model.id, raw ?? null, configured)

        if (stale || !isVisible(mode, free)) {
          disabled.add(`${model.providerID}/${model.id}`)
          editor.update(model.providerID, model.id, (draft) => {
            draft.enabled = false
          })
        }
      }

      produced = catalogSignature(models.map((m) => `${m.providerID}/${m.id}`), disabled)
    }

    let transform = await ctx.model.transform(apply)
    // The registration itself publishes the first catalog; treat it as published
    // so the first `model.updated` we react to is a real change.
    published = produced

    // Transforms replay in registration order. Plugins that load after this one
    // (e.g. dynamic catalog builders) register later and would re-enable models
    // we disable, leaking free models into the paid-only bucket. Re-registering
    // moves our transform to the end of the replay order, so it always sees the
    // final catalog.
    async function relocate() {
      if (relocating || relocationStorm) return
      relocating = true
      try {
        const previous = transform
        transform = await ctx.model.transform(apply)
        await previous?.dispose?.()
        // The quench: this rebuild produced the catalog the last reload already
        // published, so reloading would publish `model.updated` for nothing and
        // this subscription would reload again - a self-sustaining cycle.
        if (produced === published) return
        published = produced
        const now = Date.now()
        if (now - windowStart > RELOCATE_WINDOW_MS) {
          windowStart = now
          relocations = 0
        }
        relocations += 1
        if (relocations > RELOCATE_LIMIT) {
          // Something on this box rebuilds the catalog continuously; stop reacting
          // rather than starve the host. Mode changes and liveness refreshes still
          // rebuild the catalog, they just do not relocate the transform.
          relocationStorm = true
          return
        }
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

    // Periodic refresh, only when liveness is on.
    const interval = liveness
      ? setInterval(async () => {
          const targets = [...endpoints.entries()]
          await Promise.allSettled(
            targets.map(async ([providerID, url]) => {
              const ids = await fetchLiveIds(url)
              const prev = liveRaw.get(providerID)
              if (ids !== prev) liveRaw.set(providerID, ids)
            }),
          )
          // One rebuild for the whole sweep, coalesced through the same path a
          // fetch uses, so a refresh cannot start its own reload cycle.
          queueRelocate()
        }, LIVE_TTL_MS)
      : undefined
    if (liveness) queueMicrotask(scheduleFetches)

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
      // The subscription loop only ends when its signal aborts; without this a
      // disposed plugin keeps consuming `model.updated` forever.
      abort.abort()
      if (interval !== undefined) clearInterval(interval)
      await rpc?.dispose?.()
      await transform?.dispose?.()
    }
  },
}
// done