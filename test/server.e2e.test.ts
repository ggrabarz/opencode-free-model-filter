import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  FREE_FIXTURE_IDS,
  PAID_FIXTURE_IDS,
  createIsolated,
  resolveOpencode,
  type Isolated,
} from "./e2e/isolated"

const binary = resolveOpencode()
const skip = !binary

const PROVIDERS = JSON.parse(await readFile(new URL("./fixture/providers.json", import.meta.url), "utf8")) as {
  providers: Record<string, { name: string; settings?: { baseURL?: string } }>
}

interface Server {
  readonly base: string
  readonly password: string
  readonly stop: () => Promise<void>
  readonly stderr: () => string
}

async function startServer(iso: Isolated): Promise<Server> {
  if (!binary) throw new Error("opencode binary not found")
  const proc = Bun.spawn({
    cmd: [...binary.prefix, binary.file, "serve", "--hostname", "127.0.0.1", "--port", "0"],
    cwd: iso.project,
    env: iso.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const decoder = new TextDecoder()
  const reader = proc.stdout.getReader()
  let output = ""
  let port = 0
  let password = ""
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && (!port || !password)) {
    const { value, done } = await reader.read()
    if (done) break
    output += decoder.decode(value, { stream: true })
    const portMatch = /server listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output)
    const passwordMatch = /server password (\S+)/.exec(output)
    if (portMatch) port = Number(portMatch[1])
    if (passwordMatch) password = passwordMatch[1] ?? password
  }
  if (!port || !password) {
    proc.kill()
    throw new Error(`serve did not start:\n${output}\n${await new Response(proc.stderr).text()}`)
  }
  return {
    base: `http://127.0.0.1:${port}`,
    password,
    stderr: () => output,
    async stop() {
      proc.kill()
      await Promise.race([proc.exited, Bun.sleep(5000)])
    },
  }
}

function auth(server: Server) {
  return `Basic ${Buffer.from(`opencode:${server.password}`).toString("base64")}`
}

function location(project: string) {
  return new URLSearchParams({ "location[directory]": project }).toString()
}

async function listModels(server: Server, project: string) {
  const response = await fetch(`${server.base}/api/model?${location(project)}`, {
    headers: { Authorization: auth(server) },
  })
  const body = (await response.json()) as { data: any[] }
  expect(response.status).toBe(200)
  return body.data
}

async function callRpc(server: Server, project: string, method: string, input: unknown = {}) {
  const response = await fetch(`${server.base}/api/rpc/free-model-filter/${method}?${location(project)}`, {
    method: "POST",
    headers: {
      Authorization: auth(server),
      "content-type": "application/json",
    },
    body: JSON.stringify({ input }),
  })
  const body = (await response.json()) as { output?: { mode?: string }; message?: string }
  if (response.status !== 200) throw new Error(`rpc ${method} failed (${response.status}): ${JSON.stringify(body)}`)
  return body.output
}

async function waitForPlugin(server: Server, project: string, timeout = 60_000) {
  const url = `${server.base}/api/plugin?${location(project)}`
  const deadline = Date.now() + timeout
  let last: unknown
  while (Date.now() < deadline) {
    const response = await fetch(url, { headers: { Authorization: auth(server) } })
    if (response.ok) {
      const body = (await response.json()) as { data?: any[] }
      last = body.data
      const plugin = body.data?.find(
        (item) =>
          item.state?.status === "active" &&
          item.source?.type === "local" &&
          String(item.source.path ?? "").includes("free-model-filter"),
      )
      if (plugin) return plugin
    }
    await Bun.sleep(200)
  }
  throw new Error(`free-model-filter plugin did not activate: ${JSON.stringify(last)}`)
}

function fixtureIDs(models: readonly any[]) {
  return models
    .filter((model) => String(model.providerID).startsWith("fixture-"))
    .map((model) => `${model.providerID}/${model.id}`)
    .sort()
}

describe.skipIf(skip)("server catalog filtering", () => {
  let iso: Isolated
  let server: Server

  beforeAll(async () => {
    iso = await createIsolated()
    server = await startServer(iso)
    const plugin = await waitForPlugin(server, iso.project)
    if (Bun.env.DEBUG_E2E) console.error("plugin", JSON.stringify(plugin))
  })

  afterAll(async () => {
    await server?.stop()
    await iso?.dispose()
  })

  test("the real model.list endpoint only exposes free models by default", async () => {
    const models = await listModels(server, iso.project)
    if (Bun.env.DEBUG_E2E) console.error("models", fixtureIDs(models))
    expect(fixtureIDs(models)).toEqual([...FREE_FIXTURE_IDS].sort())
    const paid = models.filter((model) => PAID_FIXTURE_IDS.some((id) => id === `${model.providerID}/${model.id}`))
    expect(paid).toEqual([])

    // And the same input, classified independently, agrees.
    const { isFreeModel } = await import("../src/classify")
    for (const model of models) {
      const provider = PROVIDERS.providers[model.providerID]
      expect({ id: `${model.providerID}/${model.id}`, free: isFreeModel(model, provider) }).toEqual({
        id: `${model.providerID}/${model.id}`,
        free: true,
      })
    }
  })

  test("toggle switches the same endpoint to paid-only and emits model.updated", async () => {
    const controller = new AbortController()
    const events: any[] = []
    const response = await fetch(`${server.base}/api/event?${location(iso.project)}`, {
      headers: { Authorization: auth(server) },
      signal: controller.signal,
    })
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const consuming = (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) return
          buffer += decoder.decode(value, { stream: true })
          let index: number
          while ((index = buffer.indexOf("\n\n")) >= 0) {
            const chunk = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            for (const line of chunk.split("\n")) {
              if (!line.startsWith("data: ")) continue
              try {
                events.push(JSON.parse(line.slice("data: ".length)))
              } catch {}
            }
          }
        }
      } catch {}
    })()

    const toggled = await callRpc(server, iso.project, "toggle")
    expect(toggled).toEqual({ mode: "paid" })

    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && !events.some((event) => event.type === "model.updated")) await Bun.sleep(100)
    controller.abort()
    await consuming
    expect(events.some((event) => event.type === "model.updated")).toBe(true)

    const models = await listModels(server, iso.project)
    expect(fixtureIDs(models)).toEqual([...PAID_FIXTURE_IDS].sort())

    const { isFreeModel } = await import("../src/classify")
    for (const model of models) {
      const provider = PROVIDERS.providers[model.providerID]
      expect(isFreeModel(model, provider)).toBe(false)
    }
  })

  test("setMode/getMode and toggling back restore the free catalog exactly", async () => {
    expect(await callRpc(server, iso.project, "getMode")).toEqual({ mode: "paid" })
    expect(await callRpc(server, iso.project, "setMode", { mode: "free" })).toEqual({ mode: "free" })
    expect(fixtureIDs(await listModels(server, iso.project))).toEqual([...FREE_FIXTURE_IDS].sort())
    expect(await callRpc(server, iso.project, "toggle")).toEqual({ mode: "paid" })
    expect(await callRpc(server, iso.project, "toggle")).toEqual({ mode: "free" })
    expect(fixtureIDs(await listModels(server, iso.project))).toEqual([...FREE_FIXTURE_IDS].sort())
  })
})

/**
 * Mirrors how `freellmapi-models` grows the catalog in the wild: a second
 * local plugin (named to load after the filter) registers an extra free model
 * through its own model transform. The filter must bucket that model too, so
 * it never appears in the paid-only view.
 */
const LATE_MODEL_PLUGIN = `
export default {
  id: "zlate-models",
  async setup(ctx) {
    await ctx.model.transform((editor) => {
      editor.update("fixture-zero", "late-added", (draft) => {
        draft.name = "Late Added Chat"
        draft.cost = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]
        draft.capabilities = { ...(draft.capabilities ?? {}), tools: false, input: ["text"], output: ["text"] }
      })
    })
  },
}
`

describe.skipIf(skip)("catalog filtering covers models registered by later plugins", () => {
  let iso: Isolated
  let server: Server

  beforeAll(async () => {
    iso = await createIsolated()
    const dir = path.join(iso.project, ".opencode", "plugins", "zlate-models")
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, "index.ts"), LATE_MODEL_PLUGIN)
    server = await startServer(iso)
    await waitForPlugin(server, iso.project)
  })

  afterAll(async () => {
    await server?.stop()
    await iso?.dispose()
  })

  test("the free view includes the late-registered free model", async () => {
    const ids = await eventually(
      async () => fixtureIDs(await listModels(server, iso.project)),
      (v) => v.includes("fixture-zero/late-added"),
    )
    expect(ids).toContain("fixture-zero/late-added")
  })

  test("the paid view excludes the late-registered free model", async () => {
    await callRpc(server, iso.project, "setMode", { mode: "paid" })
    const ids = await eventually(
      async () => fixtureIDs(await listModels(server, iso.project)),
      (v) => v.length > 0,
    )
    expect(ids).not.toContain("fixture-zero/late-added")
    expect(ids).toEqual([...PAID_FIXTURE_IDS].sort())
    await callRpc(server, iso.project, "setMode", { mode: "free" })
  })
})

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T | undefined
  while (Date.now() < deadline) {
    last = await read()
    if (done(last)) return last
    await Bun.sleep(250)
  }
  return last as T
}

