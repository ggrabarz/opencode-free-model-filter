/**
 * Fixture plugin that registers an extra model *after* the free-model-filter
 * transform has run (plugin dirs load alphabetically, so this one loads last).
 * This mirrors how `freellmapi-models` grows the catalog after the filter and
 * proves the filter's bucketing covers late-registered models, too.
 */
export default {
  id: "zlate-models",
  async setup(ctx: any) {
    await ctx.model.transform((editor: any) => {
      editor.update("fixture-zero", "late-added", (draft: any) => {
        draft.name = "Late Added Model"
        draft.cost = [{ input: 0, output: 0 }]
        draft.capabilities = { ...(draft.capabilities ?? {}), tools: false, input: ["text"], output: ["text"] }
      })
    })
  },
}
