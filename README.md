# opencode-free-model-filter

OpenCode plugin that filters the model catalog to show only free (0-cost) models from all providers.

## Installation

```bash
npm install @ggrabarz/opencode-free-model-filter
```

## Usage

Add to your `opencode.json`:

```json
{
  "plugins": ["@ggrabarz/opencode-free-model-filter"]
}
```

Or enable via CLI:

```bash
opencode plugin add @ggrabarz/opencode-free-model-filter
```

## How it works

The plugin registers a `model.transform` hook that iterates all available models and removes any model that has a non-zero input or output cost. Cache costs (read/write) are ignored.

A model is considered "free" if:
- Its `cost` array is empty, OR
- All cost entries have `input === 0` AND `output === 0`

## License

MIT