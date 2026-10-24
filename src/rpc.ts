/**
 * RPC contract shared by the server half and the TUI half.
 *
 * These are plain JSON Schema objects on purpose: locally discovered server
 * plugins cannot resolve `@opencode/*` bare imports (the loader only injects
 * peer dependencies for packaged plugins), so this module must stay dependency
 * free. `Rpc.define` is typed identity, so the object shape is all that matters.
 */

const modeSchema = {
  type: "string",
  enum: ["free", "paid", "all"],
} as const

const modeOutput = {
  type: "object",
  properties: { mode: modeSchema },
  required: ["mode"],
  additionalProperties: false,
} as const

const emptyInput = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const

export const FreeModelFilterRpc = {
  id: "free-model-filter",
  methods: {
    getMode: {
      input: emptyInput,
      output: modeOutput,
    },
    setMode: {
      input: {
        type: "object",
        properties: { mode: modeSchema },
        required: ["mode"],
        additionalProperties: false,
      },
      output: modeOutput,
    },
    toggle: {
      input: emptyInput,
      output: modeOutput,
    },
  },
  events: {},
} as const

export type FreeModelFilterRpc = typeof FreeModelFilterRpc
