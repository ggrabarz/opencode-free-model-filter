import { describe, expect, test } from "bun:test"
import { isStale } from "../src/index"

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
// done