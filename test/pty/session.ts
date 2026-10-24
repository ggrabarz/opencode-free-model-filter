import * as pty from "@lydell/node-pty"
import { Terminal } from "@xterm/headless"

export interface PtySession {
  /** Current screen contents, one line per row, trailing whitespace trimmed. */
  screen(): string
  /** Waits until the screen satisfies the predicate, or returns false on timeout. */
  waitFor(predicate: (screen: string) => boolean, timeout?: number): Promise<boolean>
  /** Waits for a substring on screen. */
  waitForText(needle: string, timeout?: number): Promise<boolean>
  write(text: string): void
  press(key: KeyName | string): void
  /** Raw output received so far (useful in failure messages). */
  raw(): string
  kill(): Promise<void>
}

export type KeyName =
  | "enter"
  | "escape"
  | "tab"
  | "backspace"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "ctrl+l"
  | "ctrl+u"
  | "ctrl+a"
  | "ctrl+p"

const KEYS: Record<KeyName, string> = {
  enter: "\r",
  escape: "\x1b",
  tab: "\t",
  backspace: "\x7f",
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  "ctrl+l": "\x0c",
  "ctrl+u": "\x15",
  "ctrl+a": "\x01",
  "ctrl+p": "\x10",
}

export interface StartOptions {
  file: string
  args?: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  cols?: number
  rows?: number
}

export function startPty(options: StartOptions): PtySession {
  const cols = options.cols ?? 120
  const rows = options.rows ?? 40
  const terminal = new Terminal({ cols, rows, allowProposedApi: true })
  const proc = pty.spawn(options.file, options.args ?? [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: options.cwd,
    env: { ...options.env, TERM: "xterm-256color" },
  })
  let output = ""
  let exited = false
  const exit = Promise.withResolvers<number>()
  proc.onData((data) => {
    output += data
    terminal.write(data)
  })
  proc.onExit(({ exitCode }) => {
    exited = true
    exit.resolve(exitCode)
  })

  function screen() {
    const lines: string[] = []
    const buffer = terminal.buffer.active
    for (let index = 0; index < buffer.length; index++) {
      lines.push((buffer.getLine(index)?.translateToString(true) ?? "").trimEnd())
    }
    return lines.join("\n")
  }

  async function waitFor(predicate: (value: string) => boolean, timeout = 20_000) {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (exited) return predicate(screen())
      if (predicate(screen())) return true
      await Bun.sleep(100)
    }
    return false
  }

  return {
    screen,
    waitFor,
    waitForText: (needle, timeout) => waitFor((value) => value.includes(needle), timeout),
    write(text) {
      if (!exited) proc.write(text)
    },
    press(key) {
      const value = (KEYS as Record<string, string>)[key]
      if (!value) throw new Error(`unknown key: ${key}`)
      if (!exited) proc.write(value)
    },
    raw: () => output,
    async kill() {
      if (exited) return
      proc.kill()
      await Promise.race([exit.promise, Bun.sleep(3000)])
    },
  }
}
