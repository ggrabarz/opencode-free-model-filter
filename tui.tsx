/**
 * TUI half of the free-model filter.
 *
 * Ctrl+L inside the built-in "Select model" dialog toggles the catalog between
 * the free-only and paid-only buckets. The dialog itself is not replaced: the
 * server half filters the catalog and publishes `model.updated`, so the real
 * picker (search, favorites, variants, provider grouping) keeps working.
 *
 * The binding lives in keymap mode `modal`, which OpenCode's dialog stack
 * activates, so Ctrl+L keeps its normal meaning outside dialogs. The layer is
 * additionally limited to a focused list-filter input so Ctrl+L stays inert in
 * alert/confirm/prompt dialogs.
 */

import { Plugin } from "@opencode/plugin/tui"
import type { FilterMode } from "./src/classify.ts"
import { FreeModelFilterRpc } from "./src/rpc.ts"

interface FilterContext {
  readonly location?: { readonly directory: string; readonly workspaceID?: string }
  readonly client: {
    rpc: (definition: typeof FreeModelFilterRpc) => {
      toggle: (input: Record<string, never>, options?: { location?: unknown }) => Promise<{ mode: FilterMode }>
      setMode: (input: { mode: FilterMode }, options?: { location?: unknown }) => Promise<{ mode: FilterMode }>
      getMode: (input: Record<string, never>, options?: { location?: unknown }) => Promise<{ mode: FilterMode }>
    }
  }
  readonly renderer: { currentFocusedRenderable: unknown }
  readonly keymap: {
    commands: () => readonly { readonly id?: string }[]
    layer: (factory: () => {
      mode?: string
      enabled?: boolean | (() => boolean)
      commands: readonly {
        id?: string
        title?: string
        description?: string
        group?: string
        bind?: false | string
        run: () => void | Promise<void>
      }[]
    }) => void
  }
  readonly ui: {
    toast: {
      show: (options: {
        message: string
        title?: string
        variant?: "info" | "success" | "warning" | "error"
        duration?: number
      }) => void
    }
  }
}

function isListDialogFocused(ctx: FilterContext): boolean {
  // DialogSelect marks its search input with this trait; the model picker is a
  // DialogSelect. Other dialogs (alerts, prompts, confirms) are unaffected.
  const focused = ctx.renderer.currentFocusedRenderable as { traits?: { status?: unknown } } | null | undefined
  return focused?.traits?.status === "FILTER"
}

/**
 * The trait above identifies every list dialog, so the command additionally
 * checks for a command only the model dialog registers. Reading the command
 * list from the layer's `enabled` predicate disrupts normal key dispatch, so
 * this check runs only when Ctrl+L itself is pressed.
 */
function isModelDialog(ctx: FilterContext): boolean {
  try {
    return ctx.keymap.commands().some((command) => command.id === "model.dialog.provider")
  } catch {
    return true
  }
}

function messageFor(mode: FilterMode): string {
  if (mode === "paid") return "Showing paid models only — Ctrl+L for free models"
  if (mode === "all") return "Showing all models — Ctrl+L for paid models"
  return "Showing free models only — Ctrl+L for paid models"
}

export default Plugin.define({
  id: "free-model-filter",
  async setup(ctx) {
    const rpc = ctx.client.rpc(FreeModelFilterRpc)

    async function toggle() {
      if (!isModelDialog(ctx as unknown as FilterContext)) return
      try {
        const result = (await rpc.toggle({}, { location: ctx.location })) as { mode: FilterMode }
        ctx.ui.toast.show({ message: messageFor(result.mode), variant: "info", duration: 2500 })
      } catch (error) {
        const message =
          error && typeof error === "object" && "message" in error
            ? String((error as { message: unknown }).message)
            : String(error)
        ctx.ui.toast.show({ title: "Model filter", message, variant: "error", duration: 5000 })
      }
    }

    ctx.keymap.layer(() => ({
      mode: "modal",
      enabled: () => isListDialogFocused(ctx as unknown as FilterContext),
      commands: [
        {
          id: "model.free-filter.toggle",
          title: "Toggle free/paid models",
          description: "Switch the model picker between free-only and paid-only models",
          group: "Model",
          bind: "ctrl+l",
          run: toggle,
        },
      ],
    }))
  },
})

