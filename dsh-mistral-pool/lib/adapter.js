/**
 * Self-contained DSH `LlmAdapter` & model catalog for `dsh-mistral-pool`.
 *
 * Implements the DSH `LlmAdapter` contract using pure JS (zero `@deepseek-ai/dsh-llm`
 * import required at runtime), routing inference through `vibe-acp` in ACP mode
 * or `streamDirectResponses` in Direct mode, and serving an editable built-in
 * model catalog without requiring `llm-pi-ai` configuration.
 * @module dsh-mistral-pool/adapter
 */

export const DEFAULT_CONTEXT_WINDOW = 1_048_576
export const DEFAULT_MAX_TOKENS = 131_072

export const EFFORT_LABELS = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

export const DEFAULT_MODELS = [
  {
    id: 'zai-glm-5-3',
    name: 'GLM 5.3 (Mistral Hosted)',
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    input: ['text'],
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
    enabled: true,
  },
  {
    id: 'zai-glm-5-3-flash',
    name: 'GLM 5.3 Flash (Z.ai)',
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    input: ['text', 'image'],
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
    enabled: true,
  },
  {
    id: 'deepseek-v4-1-flash-1017',
    name: 'DeepSeek V4.1 Flash 1017',
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    input: ['text', 'image'],
    efforts: ['off', 'low', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
    enabled: true,
  },
  {
    id: 'mistral-large-4',
    name: 'Mistral Large 4',
    contextWindow: 1_048_576,
    maxTokens: 262_144,
    input: ['text', 'image'],
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    enabled: true,
  },
  {
    id: 'mistral-medium-latest',
    name: 'Mistral Medium 3.5',
    contextWindow: 262_144,
    maxTokens: 262_144,
    input: ['text', 'image'],
    efforts: ['off', 'high'],
    defaultEffort: 'high',
    enabled: true,
  },
  {
    id: 'mistral-small-latest',
    name: 'Mistral Small 4',
    contextWindow: 262_144,
    maxTokens: 256_000,
    input: ['text', 'image'],
    efforts: ['off', 'high'],
    defaultEffort: 'high',
    enabled: true,
  },
  {
    id: 'devstral-latest',
    name: 'Devstral 2',
    contextWindow: 262_144,
    maxTokens: 262_144,
    input: ['text'],
    efforts: [],
    enabled: true,
  },
  {
    id: 'codestral-latest',
    name: 'Codestral',
    contextWindow: 256_000,
    maxTokens: 8_192,
    input: ['text'],
    efforts: [],
    enabled: true,
  },
  {
    id: 'magistral-medium-latest',
    name: 'Magistral Medium',
    contextWindow: 262_144,
    maxTokens: 16_384,
    input: ['text', 'image'],
    efforts: ['off', 'high'],
    defaultEffort: 'high',
    enabled: true,
  },
]

/**
 * Built-in capability presets (longest prefix first) so any Mistral/Vibe model
 * added manually or discovered from `/v1/models` automatically receives
 * accurate context window, max output tokens, modalities, and reasoning levels.
 */
export const MODEL_PRESETS = [
  ['zai-glm-5-3-flash-vibe-free', { name: 'GLM 5.3 Flash (Vibe Free)', contextWindow: 262_144, maxTokens: 131_072, input: ['text', 'image'], efforts: ['low', 'high', 'max'], defaultEffort: 'high' }],
  ['zai-glm-5-3-flash', { name: 'GLM 5.3 Flash (Z.ai)', contextWindow: 1_048_576, maxTokens: 131_072, input: ['text', 'image'], efforts: ['low', 'high', 'max'], defaultEffort: 'high' }],
  ['zai-glm-5-3', { name: 'GLM 5.3 (Mistral Hosted)', contextWindow: 1_048_576, maxTokens: 131_072, input: ['text'], efforts: ['low', 'high', 'max'], defaultEffort: 'high' }],
  ['glm-5-3', { name: 'GLM 5.3 (Mistral Hosted)', contextWindow: 1_048_576, maxTokens: 131_072, input: ['text'], efforts: ['low', 'high', 'max'], defaultEffort: 'high' }],
  ['zai-glm-5-2', { name: 'GLM-5.2', contextWindow: 1_048_576, maxTokens: 131_072, input: ['text'], efforts: ['off', 'high', 'max'], defaultEffort: 'high' }],
  ['glm-5-2', { name: 'GLM-5.2', contextWindow: 1_048_576, maxTokens: 131_072, input: ['text'], efforts: ['off', 'high', 'max'], defaultEffort: 'high' }],
  ['deepseek-v4-1-flash', { name: 'DeepSeek V4.1 Flash 1017', contextWindow: 1_048_576, maxTokens: 131_072, input: ['text', 'image'], efforts: ['off', 'low', 'high', 'xhigh', 'max'], defaultEffort: 'high' }],
  ['mistral-large-4', { name: 'Mistral Large 4', contextWindow: 1_048_576, maxTokens: 262_144, input: ['text', 'image'], efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }],
  ['mistral-large-2512', { name: 'Mistral Large 3', contextWindow: 262_144, maxTokens: 262_144, input: ['text', 'image'], efforts: [] }],
  ['mistral-large-2411', { name: 'Mistral Large 2.1', contextWindow: 131_072, maxTokens: 16_384, input: ['text'], efforts: [] }],
  ['mistral-large-latest', { name: 'Mistral Large (latest)', contextWindow: 262_144, maxTokens: 262_144, input: ['text', 'image'], efforts: [] }],
  ['mistral-vibe-cli-latest', { name: 'Mistral Medium 3.5', contextWindow: 262_144, maxTokens: 131_072, input: ['text', 'image'], efforts: ['off', 'high'], defaultEffort: 'high' }],
  ['mistral-medium-2505', { name: 'Mistral Medium 3', contextWindow: 131_072, maxTokens: 131_072, input: ['text', 'image'], efforts: [] }],
  ['mistral-medium-2508', { name: 'Mistral Medium 3.1', contextWindow: 262_144, maxTokens: 262_144, input: ['text', 'image'], efforts: [] }],
  ['mistral-medium-latest', { name: 'Mistral Medium 3.5', contextWindow: 262_144, maxTokens: 262_144, input: ['text', 'image'], efforts: ['off', 'high'], defaultEffort: 'high' }],
  ['mistral-medium', { name: 'Mistral Medium 3.5', contextWindow: 262_144, maxTokens: 262_144, input: ['text', 'image'], efforts: ['off', 'high'], defaultEffort: 'high' }],
  ['mistral-small-2506', { name: 'Mistral Small 3.2', contextWindow: 128_000, maxTokens: 16_384, input: ['text', 'image'], efforts: [] }],
  ['mistral-small-latest', { name: 'Mistral Small 4', contextWindow: 262_144, maxTokens: 256_000, input: ['text', 'image'], efforts: ['off', 'high'], defaultEffort: 'high' }],
  ['mistral-small', { name: 'Mistral Small 4', contextWindow: 262_144, maxTokens: 256_000, input: ['text', 'image'], efforts: ['off', 'high'], defaultEffort: 'high' }],
  ['labs-devstral-small', { name: 'Devstral Small 2', contextWindow: 256_000, maxTokens: 256_000, input: ['text', 'image'], efforts: [] }],
  ['labs-leanstral', { name: 'Leanstral 1.5', contextWindow: 262_144, maxTokens: 128_000, input: ['text', 'image'], efforts: ['off', 'high'], defaultEffort: 'high' }],
  ['devstral-medium-2507', { name: 'Devstral Medium', contextWindow: 128_000, maxTokens: 128_000, input: ['text'], efforts: [] }],
  ['devstral-small', { name: 'Devstral Small', contextWindow: 128_000, maxTokens: 128_000, input: ['text'], efforts: [] }],
  ['devstral', { name: 'Devstral 2', contextWindow: 262_144, maxTokens: 262_144, input: ['text'], efforts: [] }],
  ['codestral', { name: 'Codestral', contextWindow: 256_000, maxTokens: 8_192, input: ['text'], efforts: [] }],
  ['magistral-medium', { name: 'Magistral Medium', contextWindow: 262_144, maxTokens: 16_384, input: ['text', 'image'], efforts: ['off', 'high'], defaultEffort: 'high' }],
  ['magistral', { name: 'Magistral', contextWindow: 262_144, maxTokens: 16_384, input: ['text', 'image'], efforts: ['off', 'high'], defaultEffort: 'high' }],
  ['pixtral-large', { name: 'Pixtral Large', contextWindow: 128_000, maxTokens: 128_000, input: ['text', 'image'], efforts: [] }],
  ['pixtral', { name: 'Pixtral 12B', contextWindow: 128_000, maxTokens: 128_000, input: ['text', 'image'], efforts: [] }],
  ['ministral-3b', { name: 'Ministral 3 3B', contextWindow: 131_072, maxTokens: 128_000, input: ['text', 'image'], efforts: [] }],
  ['ministral-8b-2512', { name: 'Ministral 3 8B', contextWindow: 262_144, maxTokens: 262_144, input: ['text', 'image'], efforts: [] }],
  ['ministral-14b-2512', { name: 'Ministral 3 14B', contextWindow: 262_144, maxTokens: 262_144, input: ['text', 'image'], efforts: [] }],
  ['ministral', { name: 'Ministral 3', contextWindow: 262_144, maxTokens: 128_000, input: ['text', 'image'], efforts: [] }],
  ['voxtral-small', { name: 'Voxtral Small', contextWindow: 32_768, maxTokens: 32_000, input: ['text'], efforts: [] }],
  ['open-mistral-nemo', { name: 'Open Mistral Nemo', contextWindow: 128_000, maxTokens: 128_000, input: ['text'], efforts: [] }],
  ['mistral-nemo', { name: 'Mistral Nemo', contextWindow: 128_000, maxTokens: 128_000, input: ['text'], efforts: [] }],
  ['open-mixtral-8x22b', { name: 'Mixtral 8x22B', contextWindow: 64_000, maxTokens: 64_000, input: ['text'], efforts: [] }],
  ['open-mixtral-8x7b', { name: 'Mixtral 8x7B', contextWindow: 32_000, maxTokens: 32_000, input: ['text'], efforts: [] }],
  ['open-mistral-7b', { name: 'Mistral 7B', contextWindow: 8_000, maxTokens: 8_000, input: ['text'], efforts: [] }],
]

/** Resolve built-in capability preset for a model id (exact match or prefix). */
export function presetForModel(id) {
  const raw = String(id ?? '').trim().toLowerCase()
  if (!raw) return null
  const tail = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw
  for (const [prefix, preset] of MODEL_PRESETS) {
    if (tail === prefix || tail.startsWith(prefix)) return preset
  }
  return null
}

const DIRECT_RETRY_POLICY = {
  mode: 'normal',
  maxRetries: 2,
  retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
  backoff: {
    initialDelayMs: 1_500,
    maxDelayMs: 12_000,
    jitterRatio: 0.15,
  },
}

/** Normalize one model entry from stored config or user input, applying built-in presets for omitted fields. */
export function normalizeModelEntry(raw) {
  const id = String(raw?.id ?? '').trim()
  if (!id) return null
  const preset = presetForModel(id)
  const name = String(raw?.name ?? '').trim() || preset?.name || id
  const contextWindow = Number.isFinite(Number(raw?.contextWindow)) && Number(raw.contextWindow) > 0
    ? Math.trunc(Number(raw.contextWindow))
    : (preset?.contextWindow ?? DEFAULT_CONTEXT_WINDOW)
  const maxTokens = Number.isFinite(Number(raw?.maxTokens)) && Number(raw.maxTokens) > 0
    ? Math.trunc(Number(raw.maxTokens))
    : (preset?.maxTokens ?? DEFAULT_MAX_TOKENS)
  const input = Array.isArray(raw?.input) && raw.input.length > 0
    ? raw.input.filter((item) => item === 'text' || item === 'image')
    : (preset?.input ? [...preset.input] : ['text', 'image'])
  const efforts = Array.isArray(raw?.efforts)
    ? raw.efforts.filter((item) => Object.prototype.hasOwnProperty.call(EFFORT_LABELS, item))
    : (preset?.efforts ? [...preset.efforts] : ['low', 'medium', 'high'])
  const defaultEffort = raw?.defaultEffort && efforts.includes(raw.defaultEffort)
    ? raw.defaultEffort
    : preset?.defaultEffort && efforts.includes(preset.defaultEffort)
      ? preset.defaultEffort
      : efforts.includes('high')
        ? 'high'
        : efforts[efforts.length - 1]
  return {
    id,
    name,
    contextWindow,
    maxTokens,
    input: input.length > 0 ? input : ['text'],
    efforts,
    ...(defaultEffort ? { defaultEffort } : {}),
    enabled: raw?.enabled !== false,
  }
}

/** Effective model catalog for a store (custom `store.models` or cloned `DEFAULT_MODELS`). */
export function effectiveModels(store) {
  if (Array.isArray(store?.models)) {
    return store.models.map(normalizeModelEntry).filter(Boolean)
  }
  return DEFAULT_MODELS.map((item) => ({
    ...item,
    input: [...item.input],
    efforts: [...item.efforts],
  }))
}

/**
 * Primary DSH `LlmAdapter` owned by `dsh-mistral-pool`.
 * Implements the full `LlmAdapter` surface (`providerInfo`, `listModels`,
 * `resolveModel`, `prepareCall`, `stream`, image hooks, retry policy).
 */
export class MistralAdapter {
  constructor(host) {
    this.host = host
  }

  providerInfo(provider) {
    return {
      id: provider,
      name: this.host.getDisplayName?.() || 'Mistral Vibe',
    }
  }

  providerRetryPolicy(_provider) {
    return DIRECT_RETRY_POLICY
  }

  imageRequestPricing(_provider, _model) {
    return undefined
  }

  imageRequestTarget(_provider, _model, image) {
    return {
      width: image.width,
      height: image.height,
      maxBytes: image.bytes,
    }
  }

  async listModels(provider) {
    const canImages = this.host.canReadImages?.() ?? true
    return this.host
      .getModels()
      .filter((m) => m.enabled !== false)
      .map((m) => ({
        provider,
        id: m.id,
        name: m.name || m.id,
        inputModalities: canImages ? [...m.input] : ['text'],
      }))
  }

  async resolveModel(provider, model) {
    const canImages = this.host.canReadImages?.() ?? true
    const list = this.host.getModels()
    const entry = list.find((m) => m.id === model)
      ?? DEFAULT_MODELS.find((m) => m.id === model)
      ?? normalizeModelEntry({ id: model })
    const efforts = Array.isArray(entry?.efforts) ? entry.efforts : []
    return {
      provider,
      id: model,
      name: entry?.name || model,
      inputModalities: canImages ? [...(entry?.input ?? ['text', 'image'])] : ['text'],
      context: { contextWindow: entry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: entry?.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(efforts.length > 0
        ? {
            reasoning: {
              efforts: efforts.map((id) => ({ id, name: EFFORT_LABELS[id] || id })),
              ...(entry?.defaultEffort ? { defaultEffort: entry.defaultEffort } : {}),
            },
          }
        : {}),
    }
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  stream(options) {
    if (this.host.getMode?.() === 'direct') {
      return this.host.streamDirect(options)
    }
    return this.host.streamAcp(options)
  }
}
