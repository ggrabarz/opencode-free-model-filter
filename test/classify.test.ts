import { describe, expect, test } from "bun:test"
import { isFreeModel, isLocalBaseURL, isVisible, normalizeMode } from "../src/classify"

const free = { input: 0, output: 0, cache: { read: 0, write: 0 } }
const paid = { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }

describe("explicit cost", () => {
  test("explicit all-zero cost is free", () => {
    expect(isFreeModel({ id: "m", cost: [free] })).toBe(true)
  })

  test("any non-zero entry is paid", () => {
    expect(isFreeModel({ id: "m", cost: [free, paid] })).toBe(false)
  })

  test("missing input/output in an entry is not free", () => {
    expect(isFreeModel({ id: "m", cost: [{ output: 0 }] })).toBe(false)
  })

  test("cache costs are ignored", () => {
    expect(
      isFreeModel({
        id: "m",
        cost: [{ input: 0, output: 0, cache: { read: 1, write: 2 } }],
      }),
    ).toBe(true)
  })

  test("an explicit paid cost wins over a free-sounding name", () => {
    expect(isFreeModel({ id: "m", name: "Totally Free (free)", cost: [paid] }, { id: "freellmapi" })).toBe(false)
  })
})

describe("empty or missing cost", () => {
  test("local base URL on the model is free", () => {
    expect(isFreeModel({ id: "m", cost: [], settings: { baseURL: "http://127.0.0.1:31415/v1" } })).toBe(true)
  })

  test("local base URL on the provider is free", () => {
    expect(
      isFreeModel({ id: "m", cost: [] }, { id: "drv", settings: { baseURL: "http://192.168.1.8:8080/v1" } }),
    ).toBe(true)
  })

  test("known-free provider id is free", () => {
    expect(isFreeModel({ id: "m", cost: [] }, { id: "logfare", name: "LogFare" })).toBe(true)
  })

  test("provider name containing free is free", () => {
    expect(isFreeModel({ id: "m", cost: [] }, { id: "x", name: "Some Free Gateway" })).toBe(true)
  })

  test("unknown remote provider with empty cost is paid", () => {
    expect(
      isFreeModel({ id: "m", cost: [] }, { id: "xkiro", name: "xKiro", settings: { baseURL: "https://api.xkiro.com/v1" } }),
    ).toBe(false)
  })

  test("missing cost on an unknown provider is paid", () => {
    expect(isFreeModel({ id: "m" }, { id: "unknown", name: "Unknown" })).toBe(false)
  })

  test("option adds a free provider", () => {
    const model = { id: "m", cost: [] }
    const provider = { id: "my-gateway", name: "My Gateway" }
    expect(isFreeModel(model, provider)).toBe(false)
    expect(isFreeModel(model, provider, { freeProviders: ["my-gateway"] })).toBe(true)
  })

  test("env adds a free provider", () => {
    const previous = process.env.OPENCODE_FREE_MODEL_FILTER_PROVIDERS
    process.env.OPENCODE_FREE_MODEL_FILTER_PROVIDERS = "env-gateway"
    try {
      expect(isFreeModel({ id: "m", cost: [] }, { id: "env-gateway" })).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_FREE_MODEL_FILTER_PROVIDERS
      else process.env.OPENCODE_FREE_MODEL_FILTER_PROVIDERS = previous
    }
  })
})

describe("free markers", () => {
  test(":free suffix", () => {
    expect(isFreeModel({ id: "nvidia/nemotron:free", cost: [] })).toBe(true)
  })

  test("-free suffix", () => {
    expect(isFreeModel({ id: "deepseek-v4.1-flash-free", cost: [] })).toBe(true)
  })

  test("(free) in the name", () => {
    expect(isFreeModel({ id: "x", name: "Flint (free)", cost: [] })).toBe(true)
  })

  test("the word free in the name", () => {
    expect(isFreeModel({ id: "openrouter/free", name: "Free Models Router", cost: [] })).toBe(true)
  })

  test("free marker does not override an explicit price", () => {
    expect(isFreeModel({ id: "x:free", name: "Premium (free)", cost: [paid] })).toBe(false)
  })
})

describe("auto routers", () => {
  test("free auto router with explicit zero cost is free", () => {
    expect(
      isFreeModel(
        { id: "openrouter/free", name: "Free Models Router", cost: [free] },
        { id: "openrouter", settings: { baseURL: "https://openrouter.ai/api/v1" } },
      ),
    ).toBe(true)
  })

  test("paid auto router with explicit cost is paid", () => {
    expect(
      isFreeModel(
        { id: "openrouter/auto", name: "Auto Router", cost: [paid] },
        { id: "openrouter", settings: { baseURL: "https://openrouter.ai/api/v1" } },
      ),
    ).toBe(false)
  })

  test("free local auto router with empty cost is free", () => {
    expect(
      isFreeModel(
        { id: "auto", name: "Auto (router picks the best available model)", cost: [] },
        { id: "freellmapi", settings: { baseURL: "http://127.0.0.1:31415/v1" } },
      ),
    ).toBe(true)
  })
})

describe("local URLs", () => {
  test.each([
    "http://localhost:8080/v1",
    "http://127.0.0.1:1234/v1",
    "http://[::1]:1234/v1",
    "http://0.0.0.0:1234",
    "http://10.1.2.3:1234",
    "http://172.16.4.2:1234",
    "http://172.31.255.1:1234",
    "http://192.168.0.9:1234",
    "http://169.254.1.1:1234",
    "http://host.docker.internal:1234",
    "localhost:1234/v1",
  ])("%s is local", (url) => {
    expect(isLocalBaseURL(url)).toBe(true)
  })

  test.each(["https://openrouter.ai/api/v1", "http://172.32.0.1:1234", "http://8.8.8.8", "not a url"])(
    "%s is not local",
    (url) => {
      expect(isLocalBaseURL(url)).toBe(false)
    },
  )
})

describe("mode", () => {
  test("free mode only shows free models", () => {
    expect(isVisible("free", true)).toBe(true)
    expect(isVisible("free", false)).toBe(false)
  })

  test("paid mode only shows paid models", () => {
    expect(isVisible("paid", true)).toBe(false)
    expect(isVisible("paid", false)).toBe(true)
  })

  test("all mode shows everything", () => {
    expect(isVisible("all", true)).toBe(true)
    expect(isVisible("all", false)).toBe(true)
  })

  test("normalizeMode rejects unknown values", () => {
    expect(normalizeMode("paid")).toBe("paid")
    expect(normalizeMode("nonsense")).toBe("free")
    expect(normalizeMode(undefined, "all")).toBe("all")
  })
})
