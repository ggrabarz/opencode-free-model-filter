/**
 * Free/paid model classification.
 *
 * The rule is intentionally explicit and conservative: a model is only shown
 * in the default (free) list when the catalog actually says it is free.
 *
 * 1. An explicit cost array with at least one entry wins over everything else.
 *    Every entry must have `input === 0` and `output === 0` for the model to be
 *    free. Cache costs are ignored (OpenCode does the same).
 * 2. An empty or missing cost array is only treated as free when the provider
 *    is known to be free:
 *      - a local/private base URL (localhost, 127.0.0.0/8, RFC1918, etc.),
 *      - a provider id/name listed in `freeProviders` (or containing "free"),
 *      - a provider id/name containing "free".
 *    Otherwise the cost is unknown, and unknown is treated as paid.
 * 3. A model id ending in `:free`/`-free`, or a name containing "(free)" or the
 *    word "free", is free when the cost is empty/unknown.
 *
 * Auto routers are not special-cased: they are classified from their own
 * entry in the catalog, so a free auto router (`openrouter/openrouter/free`,
 * `freellmapi/auto`) lands in the free list and a paid auto router
 * (`openrouter/openrouter/auto`) lands in the paid list.
 */

export type FilterMode = "free" | "paid" | "all"

export interface CostEntry {
  readonly input?: number | null
  readonly output?: number | null
  readonly [key: string]: unknown
}

export interface ClassifiableModel {
  readonly id: string
  readonly name?: string
  readonly providerID?: string
  readonly cost?: readonly CostEntry[] | null
  readonly settings?: { readonly baseURL?: unknown } | null
}

export interface ClassifiableProvider {
  readonly id?: string
  readonly name?: string
  readonly settings?: { readonly baseURL?: unknown } | null
}

export interface ClassifyOptions {
  /** Additional provider ids that are free even when their models omit cost. */
  readonly freeProviders?: readonly string[]
}

/** Providers that serve free inference but omit `cost` in their catalogs. */
export const DEFAULT_FREE_PROVIDERS = ["freellmapi", "freellmapi-anthropic", "logfare"] as const

export function normalizeMode(value: unknown, fallback: FilterMode = "free"): FilterMode {
  if (value === "free" || value === "paid" || value === "all") return value
  return fallback
}

function configurableFreeProviders(options?: ClassifyOptions): readonly string[] {
  const fromEnv = (process.env.OPENCODE_FREE_MODEL_FILTER_PROVIDERS ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
  return [...DEFAULT_FREE_PROVIDERS, ...(options?.freeProviders ?? []), ...fromEnv].map((item) => item.toLowerCase())
}

export function isLocalBaseURL(value: unknown): boolean {
  if (typeof value !== "string" || value.trim().length === 0) return false
  let url: URL
  try {
    url = new URL(value.includes("://") ? value : `http://${value}`)
  } catch {
    return false
  }
  return isPrivateHost(url.hostname)
}

function isPrivateHost(input: string): boolean {
  const host = input.toLowerCase().replace(/^\[/, "").replace(/\]$/, "")
  if (host === "localhost" || host.endsWith(".localhost")) return true
  if (host === "::1" || host === "0.0.0.0" || host === "host.docker.internal") return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return false
  const a = Number(match[1])
  const b = Number(match[2])
  return (
    a === 10 ||
    a === 127 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254)
  )
}

export function isFreeProvider(provider: ClassifiableProvider | undefined, options?: ClassifyOptions): boolean {
  if (!provider) return false
  const configured = configurableFreeProviders(options)
  const ids = [provider.id, provider.name].flatMap((value) => (typeof value === "string" ? [value.toLowerCase()] : []))
  return ids.some((value) => configured.includes(value) || value.includes("free"))
}

export function isFreeModel(
  model: ClassifiableModel,
  provider?: ClassifiableProvider,
  options?: ClassifyOptions,
): boolean {
  const cost = model.cost
  if (Array.isArray(cost) && cost.length > 0) {
    return cost.every((entry) => entry?.input === 0 && entry?.output === 0)
  }

  if (hasFreeMarker(model)) return true
  if (isFreeProvider(provider, options)) return true
  if (isLocalBaseURL(model.settings?.baseURL)) return true
  if (isLocalBaseURL(provider?.settings?.baseURL)) return true
  return false
}

function hasFreeMarker(model: ClassifiableModel): boolean {
  const id = model.id.toLowerCase()
  const name = (model.name ?? "").toLowerCase()
  return id.endsWith(":free") || id.endsWith("-free") || name.includes("(free)") || /\bfree\b/.test(name)
}

/** Whether a model belongs in the list for the given mode. */
export function isVisible(mode: FilterMode, free: boolean): boolean {
  if (mode === "all") return true
  return mode === "free" ? free : !free
}
