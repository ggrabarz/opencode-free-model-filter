/**
 * End-to-end test against the real OpenCode TUI (v2.1.4) and a real private
 * server:
 *
 *   real binary -> isolated config/project -> this package as the only plugin
 *   -> real built-in "Select model" dialog -> real Ctrl+L key binding -> RPC
 *   -> server model transform -> model.updated -> dialog refresh
 *
 * The fixture config declares six models: two free local models (one of them a
 * free auto router), two explicitly zero-cost remote models (one a free router),
 * and two paid remote models (one a paid auto router). The test reads the screen
 * through a ConPTY-backed terminal emulator, so assertions are about what the
 * user actually sees.
 */
import { describe, expect, test } from "bun:test"
import {
  FREE_FIXTURE_NAMES,
  PAID_FIXTURE_NAMES,
  createIsolated,
  resolveOpencode,
  type Isolated,
} from "./e2e/isolated"
import { startPty, type PtySession } from "./pty/session"

const binary = resolveOpencode()
const skip = !binary

function expectVisible(screen: string, present: readonly string[], absent: readonly string[]) {
  for (const name of present) expect(screen).toContain(name)
  for (const name of absent) expect(screen).not.toContain(name)
}

async function waitToastGone(session: PtySession) {
  return session.waitFor(
    (screen) => !screen.includes("Showing paid") && !screen.includes("Showing free") && !screen.includes("Model filter"),
    15_000,
  )
}

async function toggle(session: PtySession, toast: string) {
  session.press("ctrl+l")
  const shown = await session.waitFor(
    (screen) => screen.includes(toast) || screen.includes("RPC is unavailable"),
    10_000,
  )
  expect(shown).toBe(true)
  expect(await waitToastGone(session)).toBe(true)
}

async function openModels(session: PtySession) {
  session.write("/models")
  await Bun.sleep(700)
  session.press("enter")
  expect(await session.waitForText("Select model", 20_000)).toBe(true)
  await Bun.sleep(400)
}

describe.skipIf(skip)("Select model dialog: free by default, Ctrl+L toggles paid", () => {
  test(
    "real TUI shows exactly the free bucket, toggles both ways, and selects a model",
    async () => {
      const iso: Isolated = await createIsolated()
      const session = startPty({
        file: binary!.file,
        args: [...binary!.prefix, "--standalone"],
        cwd: iso.project,
        env: iso.env,
        cols: 120,
        rows: 40,
      })
      try {
        expect(await session.waitForText("commands", 60_000)).toBe(true)
        await Bun.sleep(700)

        // Default: free only. The free auto router and the zero-cost router are
        // in; both paid models (including the paid auto router) are out.
        await openModels(session)
        session.write("Fixture")
        expect(await session.waitForText("Free Auto Router", 15_000)).toBe(true)
        await Bun.sleep(500)
        expectVisible(session.screen(), FREE_FIXTURE_NAMES, PAID_FIXTURE_NAMES)

        // Ctrl+L -> paid only, with the reply toast.
        await toggle(session, "Showing paid")
        expect(await session.waitForText("Paid Auto Router", 15_000)).toBe(true)
        await Bun.sleep(300)
        expectVisible(session.screen(), PAID_FIXTURE_NAMES, FREE_FIXTURE_NAMES)

        // Ctrl+L -> free only again.
        await toggle(session, "Showing free")
        expect(await session.waitForText("Zero Cost Router", 15_000)).toBe(true)
        await Bun.sleep(300)
        expectVisible(session.screen(), FREE_FIXTURE_NAMES, PAID_FIXTURE_NAMES)

        // The mode survives closing and reopening the dialog.
        await toggle(session, "Showing paid")
        expect(await session.waitForText("Paid Auto Router", 15_000)).toBe(true)
        session.press("escape")
        expect(await session.waitFor((screen) => !screen.includes("Select model"), 10_000)).toBe(true)
        await openModels(session)
        expect(await session.waitForText("Paid Auto Router", 10_000)).toBe(true)
        await Bun.sleep(400)
        expectVisible(session.screen(), PAID_FIXTURE_NAMES, FREE_FIXTURE_NAMES)

        // Ctrl+L outside a dialog is inert: the mode is still paid.
        session.press("escape")
        await session.waitFor((screen) => !screen.includes("Select model"), 10_000)
        session.press("ctrl+l")
        await Bun.sleep(1200)
        expect(session.screen()).not.toContain("Model filter")

        // Ctrl+L in a different list dialog must not change the model bucket.
        session.write("/sessions")
        await Bun.sleep(700)
        session.press("enter")
        expect(await session.waitForText("Sessions for project", 15_000)).toBe(true)
        session.press("ctrl+l")
        await Bun.sleep(1200)
        expect(session.screen()).not.toContain("Showing free")
        expect(session.screen()).not.toContain("Showing paid")
        session.press("escape")
        await session.waitFor((screen) => !screen.includes("Sessions for project"), 10_000)

        await openModels(session)
        expect(await session.waitForText("Paid Auto Router", 10_000)).toBe(true)
        expectVisible(session.screen(), PAID_FIXTURE_NAMES, FREE_FIXTURE_NAMES)

        // Back to free, then select a free model through the real picker.
        // Reopening the dialog resets its search, so narrow to the fixture
        // providers again before toggling.
        session.write("Fixture")
        expect(await session.waitForText("Paid Auto Router", 10_000)).toBe(true)
        await toggle(session, "Showing free")
        expect(await session.waitForText("Zero Cost Router", 15_000)).toBe(true)
        session.press("ctrl+u")
        await Bun.sleep(300)
        session.write("Zero Cost Chat")
        expect(await session.waitForText("Zero Cost Chat", 10_000)).toBe(true)
        await Bun.sleep(300)
        session.press("enter")

        // Models with variants open the variant picker; accept the default.
        const variant = await session.waitForText("Select variant", 4000)
        if (variant) {
          session.press("enter")
        }
        expect(await session.waitForText("Zero Cost Chat", 10_000)).toBe(true)
        expect(await session.waitFor((screen) => !screen.includes("Select model") && !screen.includes("Select variant"), 15_000)).toBe(true)

        const final = session.screen()
        expect(final).toContain("Zero Cost Chat")
        expect(final).not.toContain("RPC is unavailable")
        expect(final).not.toContain("plugin failed")
        expect(final).toContain("commands")
      } catch (error) {
        console.error("TUI screen at failure:\n" + session.screen())
        throw error
      } finally {
        await session.kill()
        await iso.dispose().catch((error) => console.error("cleanup failed", error))
      }
    },
    240_000,
  )
})


