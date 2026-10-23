import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import type { Model } from "@opencode/schema/model"

/**
 * OpenCode plugin that filters the model catalog to show only free (0 cost) models.
 * A model is considered free if its cost array is empty or all cost entries
 * have input === 0 and output === 0. Cache costs are ignored.
 */
export const FreeModelFilterPlugin = define({
  id: "opencode.free-model-filter",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.model.transform((editor) => {
      for (const model of editor.list()) {
        if (!isFree(model)) {
          editor.remove(model.providerID, model.id)
        }
      }
    })
  }),
})

/**
 * Determines if a model is free (zero cost).
 * @param model - The model to check
 * @returns true if the model has no cost or all cost entries are zero for input/output
 */
function isFree(model: Model.MutableInfo): boolean {
  const costs = model.cost
  if (costs.length === 0) return true

  return costs.every(
    (cost) => cost.input === 0 && cost.output === 0,
  )
}

export { isFree }