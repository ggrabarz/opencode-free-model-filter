import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export const REPO = path.resolve(import.meta.dir, "../..")
export const FIXTURE_CONFIG = path.join(REPO, "test", "fixture", "providers.json")

export const FREE_FIXTURE_IDS = [
  "fixture-free/auto",
  "fixture-free/gpt-5-mini",
  "fixture-zero/free-chat",
  "fixture-zero/free-router",
]

export const PAID_FIXTURE_IDS = ["fixture-paid/auto", "fixture-paid/chat"]

export const FREE_FIXTURE_NAMES = [
  "Free Auto Router",
  "GPT-5 Mini",
  "Zero Cost Chat",
  "Zero Cost Router",
]

export const PAID_FIXTURE_NAMES = ["Paid Auto Router", "Paid Chat"]

export interface OpencodeBinary {
  readonly file: string
  readonly prefix: readonly string[]
}

/** Locates the installed OpenCode CLI; the npm shim is a .cmd, so fall back to cmd.exe. */
export function resolveOpencode(): OpencodeBinary | undefined {
  const configured = process.env.OPENCODE_BIN
  if (configured) return { file: configured, prefix: [] }
  const shim = Bun.which("opencode")
  if (!shim) return undefined
  const exe = path.join(path.dirname(shim), "node_modules", "@opencode", "cli", "bin", "opencode.exe")
  if (existsSync(exe)) return { file: exe, prefix: [] }
  return { file: "cmd.exe", prefix: ["/c", shim] }
}

export interface Isolated {
  readonly root: string
  readonly configDir: string
  readonly project: string
  readonly env: NodeJS.ProcessEnv
  dispose(): Promise<void>
}

/**
 * Creates an isolated OpenCode home: a temp config dir (no user plugins), a
 * temp project whose only plugin is this repository (via a directory junction),
 * and temp XDG roots so the test cannot read or write the user's live state.
 */
export async function createIsolated(): Promise<Isolated> {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-free-filter-e2e-"))
  const configDir = path.join(root, "config")
  const project = path.join(root, "project")
  const plugin = path.join(project, ".opencode", "plugins", "free-model-filter")
  const home = path.join(root, "home")
  await mkdir(configDir, { recursive: true })
  await mkdir(path.dirname(plugin), { recursive: true })
  await mkdir(home, { recursive: true })
  await mkdir(path.join(root, "data"), { recursive: true })
  await mkdir(path.join(root, "cache"), { recursive: true })
  await mkdir(path.join(root, "state"), { recursive: true })
  await writeFile(path.join(configDir, "opencode.json"), "{}")
  await writeFile(path.join(configDir, "cli.json"), "{}")
  await copyFile(FIXTURE_CONFIG, path.join(project, "opencode.json"))
  await symlink(REPO, plugin, "junction")

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCODE_CONFIG_DIR: configDir,
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    OPENCODE_TEST_HOME: home,
    HOME: home,
    USERPROFILE: process.env.USERPROFILE,
  }

  return {
    root,
    configDir,
    project,
    env,
    async dispose() {
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          await rm(root, { recursive: true, force: true })
          return
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt === 9) throw error
          await Bun.sleep(300)
        }
      }
    },
  }
}

