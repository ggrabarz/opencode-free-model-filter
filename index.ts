/**
 * Server entrypoint.
 *
 * OpenCode's local plugin loader resolves a plugin directory to `<dir>/index`
 * (and `<dir>/server`) before consulting package.json exports, so the server
 * half must live at the package root. The TUI half is resolved as `<dir>/tui`.
 */
export { default } from "./src/index.ts"
