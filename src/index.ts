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

function freeProvidersFromOptions(options: Readonly<Record<string, unknown>> | undefined) {
  const value = options?.freeProviders
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

export default {
  id: "free-model-filter",
  async setup(ctx: PluginContext) {
    let mode: FilterMode = normalizeMode(ctx.options?.defaultMode ?? ctx.options?.mode)
    const freeProviders = freeProvidersFromOptions(ctx.options)

    const transform = await ctx.model.transform((editor) => {
      for (const model of editor.list()) {
        const provider = editor.provider.get(model.providerID)?.provider
        const free = isFreeModel(model, provider, { freeProviders })
        if (isVisible(mode, free)) continue
        // Only ever disable. Re-enabling would fight a user's own model choice,
        // and a replay starts from the catalog's original `enabled` value.
        editor.update(model.providerID, model.id, (draft) => {
          draft.enabled = false
        })
      }
    })

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
      await rpc?.dispose?.()
      await transform?.dispose?.()
    }
  },
}
