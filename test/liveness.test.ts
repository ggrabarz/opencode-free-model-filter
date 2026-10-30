import { describe, expect, test } from "bun:test"
import { catalogSignature, isStale, livenessEnabled } from "../src/index"

describe("isStale", () => {
  test("no live set => never stale", () => {
    expect(isStale("a", null, ["a", "b"])).toBe(false)
  })
  test("empty live set => never stale", () => {
    expect(isStale("a", new Set(), ["a", "b"])).toBe(false)
  })
  test("zero overlap => never stale (guard)", () => {
    expect(isStale("a", new Set(["x", "y"]), ["a", "b"])).toBe(false)
  })
  test("present in live set => not stale", () => {
    expect(isStale("a", new Set(["a", "b"]), ["a", "b"])).toBe(false)
  })
  test("absent with overlap => stale", () => {
    expect(isStale("ghost", new Set(["a", "b"]), ["a", "ghost"])).toBe(true)
  })
})

describe("livenessEnabled", () => {
  // Liveness is the part that made the plugin rebuild the catalog from a
  // `model.updated` handler. Off by default means the shipped behaviour is the
  // network-free v2.0.0 one, and a box that cannot reach a provider's /models
  // endpoint does not pay for it at activation.
  test("off by default", () => {
    expect(livenessEnabled(undefined)).toBe(false)
    expect(livenessEnabled({})).toBe(false)
    expect(livenessEnabled({ freeProviders: ["x"] })).toBe(false)
  })
  test("only exactly true turns it on", () => {
    expect(livenessEnabled({ liveness: true })).toBe(true)
    expect(livenessEnabled({ liveness: "true" })).toBe(false)
    expect(livenessEnabled({ liveness: 1 })).toBe(false)
  })
})

describe("catalogSignature", () => {
  // Two rebuilds with the same signature must not reload: `model.reload()`
  // publishes `model.updated`, which is what the plugin subscribes to, so
  // reloading on equality is a cycle, not a refresh.
  test("equal catalog => equal signature", () => {
    const a = catalogSignature(["p/a", "p/b"], /* no disables */ new Set())
    const b = catalogSignature(["p/a", "p/b"], new Set())
    expect(a).toBe(b)
  })
  test("input order does not matter", () => {
    expect(catalogSignature(["p/b", "p/a"], new Set())).toBe(catalogSignature(["p/a", "p/b"], new Set()))
  })
  test("a newly disabled model changes the signature", () => {
    const before = catalogSignature(["p/a", "p/b"], new Set())
    const after = catalogSignature(["p/a", "p/b"], new Set(["p/b"]))
    expect(before).not.toBe(after)
  })
  test("the same model set with the same disables is stable across rebuilds", () => {
    const ids = ["p/a", "p/b", "q/c"]
    const disabled = new Set(["q/c"])
    expect(catalogSignature(ids, disabled)).toBe(catalogSignature(ids, disabled))
  })
})
// done