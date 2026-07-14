import { expect, test, beforeAll, beforeEach, afterEach } from "bun:test"
import { mockFetch, mockFetchTrack, withFakeConfig, withMissingModels, withCorruptModels, withLocalModels } from "../helpers/mocks.ts"
import bundledModels from "../../models.json" with { type: "json" }

type PluginResult = {
  config: (config: Record<string, unknown>) => Promise<void>
  auth: {
    provider: string
    methods: Array<{
      type: string
      label: string
      authorize: (inputs: Record<string, unknown> | undefined) => Promise<{ type: string; key?: string }>
    }>
    loader: (getAuth: () => Promise<{ type: string; key?: string } | null>) => Promise<Record<string, unknown>>
  }
}

type PluginModule = { default: () => Promise<PluginResult> }

let pluginFn: PluginModule["default"]

beforeAll(async () => {
  const mod = await import("../../plugin.ts")
  pluginFn = mod.default
})

test("plugin returns correct provider name", async () => {
  const plugin = await pluginFn()
  expect(plugin.auth.provider).toBe("commandcode")
})

test("authorize returns success with valid key", async () => {
  const plugin = await pluginFn()
  const result = await plugin.auth.methods[0].authorize({ key: "sk-valid-key" })
  expect(result.type).toBe("success")
  expect((result as Record<string, unknown>).key).toBe("sk-valid-key")
})

test("authorize returns failed with empty key", async () => {
  const plugin = await pluginFn()
  const result = await plugin.auth.methods[0].authorize({ key: "   " })
  expect(result.type).toBe("failed")
})

test("authorize returns failed with undefined key", async () => {
  const plugin = await pluginFn()
  const result = await plugin.auth.methods[0].authorize({ key: undefined })
  expect(result.type).toBe("failed")
})

test("authorize returns failed with missing inputs", async () => {
  const plugin = await pluginFn()
  const result = await plugin.auth.methods[0].authorize(undefined)
  expect(result.type).toBe("failed")
})

test("authorize handles non-string key", async () => {
  const plugin = await pluginFn()
  const result = await plugin.auth.methods[0].authorize({ key: 123 as unknown as string })
  expect(result.type).toBe("failed")
})

test("loader returns apiKey on successful auth", async () => {
  const plugin = await pluginFn()
  const result = await plugin.auth.loader(async () => ({
    type: "api",
    key: "sk-loaded-key",
  }))
  expect(result).toEqual({ apiKey: "sk-loaded-key" })
})

test("loader returns empty object on null auth", async () => {
  const plugin = await pluginFn()
  const result = await plugin.auth.loader(async () => null)
  expect(result).toEqual({})
})

test("loader returns empty object on wrong auth type", async () => {
  const plugin = await pluginFn()
  const result = await plugin.auth.loader(async () => ({
    type: "oauth",
    key: "some-token",
  } as Record<string, unknown>))
  expect(result).toEqual({})
})

test("loader returns empty object when getAuth throws", async () => {
  const plugin = await pluginFn()
  const result = await plugin.auth.loader(async () => {
    throw new Error("auth failed")
  })
  expect(result).toEqual({})
})

test("config hook registers provider with npm and models", async () => {
  const plugin = await pluginFn()
  const config: Record<string, unknown> = {
    provider: { commandcode: {} },
  }
  await plugin.config(config)

  const cc = (config.provider as Record<string, Record<string, unknown>>).commandcode
  expect(cc.npm).toBe("commandcode-go-opencode-provider")
  expect(cc.name).toBe("Command Code")
  expect(cc.env).toEqual(["COMMANDCODE_API_KEY"])
  expect(cc.models).toBeDefined()
  const models = cc.models as Record<string, unknown>
  expect(Object.keys(models).length).toBeGreaterThan(0)
})

test("config hook does not overwrite existing npm field", async () => {
  const plugin = await pluginFn()
  const config: Record<string, unknown> = {
    provider: { commandcode: { npm: "custom-package" } },
  }
  await plugin.config(config)

  const cc = (config.provider as Record<string, Record<string, unknown>>).commandcode
  expect(cc.npm).toBe("custom-package")
})

test("config hook does not overwrite existing models", async () => {
  const plugin = await pluginFn()
  const config: Record<string, unknown> = {
    provider: { commandcode: { models: { "my-model": { id: "my-model" } } } },
  }
  await plugin.config(config)

  const cc = (config.provider as Record<string, Record<string, unknown>>).commandcode
  const models = cc.models as Record<string, unknown>
  expect(Object.keys(models)).toEqual(["my-model"])
})

test("config hook creates provider block if missing", async () => {
  const plugin = await pluginFn()
  const config: Record<string, unknown> = {}
  await plugin.config(config)

  expect(config.provider).toBeDefined()
  const cc = (config.provider as Record<string, Record<string, unknown>>).commandcode
  expect(cc).toBeDefined()
  expect(cc.npm).toBe("commandcode-go-opencode-provider")
})

// --- mergeModels integration tests (via config hook) ---

const sampleModel = (overrides: Record<string, unknown> = {}) => ({
  id: "test/model-a",
  name: "Model A",
  tier: "premium",
  reasoning: false,
  tool_call: true,
  cost: { input: 1, output: 2 },
  limit: { context: 100000, output: 8192 },
  ...overrides,
})

async function getMergedModels(
  localModels: Array<Record<string, unknown>>,
  apiModels: Array<Record<string, unknown>>,
): Promise<Record<string, Record<string, unknown>>> {
  let result!: Record<string, Record<string, unknown>>
  await withLocalModels(localModels, async () => {
    const tracker = mockFetchTrack()
    tracker.respondWith({ json: () => Promise.resolve({ data: apiModels }) })
    try {
      const plugin = await pluginFn()
      const config: Record<string, unknown> = { provider: { commandcode: {} } }
      await plugin.config(config)
      const cc = (config.provider as Record<string, Record<string, unknown>>).commandcode
      result = cc.models as Record<string, Record<string, unknown>>
    } finally {
      tracker.restore()
    }
  })
  return result
}

test("config hook preserves local entry when API returns empty list", async () => {
  process.env.COMMANDCODE_API_KEY = "sk-test"
  const models = await getMergedModels([sampleModel()], [])
  expect(Object.keys(models)).toHaveLength(1)
  expect(models["model-a"]).toBeDefined()
})

test("config hook updates context from API for known models", async () => {
  process.env.COMMANDCODE_API_KEY = "sk-test"
  const models = await getMergedModels(
    [sampleModel()],
    [{ id: "test/model-a", context_length: 200000 }],
  )
  expect(models["model-a"].limit.context).toBe(200000)
  expect(models["model-a"].limit.output).toBe(8192)
})

test("config hook keeps local context when API has no context_length", async () => {
  process.env.COMMANDCODE_API_KEY = "sk-test"
  const models = await getMergedModels(
    [sampleModel({ limit: { context: 150000, output: 4096 } })],
    [{ id: "test/model-a" }],
  )
  expect(models["model-a"].limit.context).toBe(150000)
})

test("config hook adds new API-only models with defaults", async () => {
  process.env.COMMANDCODE_API_KEY = "sk-test"
  const models = await getMergedModels(
    [sampleModel()],
    [{ id: "new-provider/new-model", context_length: 500000 }],
  )
  expect(Object.keys(models)).toHaveLength(2)
  const newModel = models["new-model"]
  expect(newModel).toBeDefined()
  expect(newModel.name).toBe("new-model")
  expect(newModel.reasoning).toBe(true)
  // Pricing is unknown for API-only models, so it stays zeroed rather than fabricated.
  expect((newModel.cost as Record<string, number>).input).toBe(0)
  expect((newModel.cost as Record<string, number>).output).toBe(0)
  expect(newModel.limit.context).toBe(500000)
  expect(newModel.limit.output).toBe(131072)
})

test("config hook uses the API-provided name for new models", async () => {
  process.env.COMMANDCODE_API_KEY = "sk-test"
  const models = await getMergedModels(
    [],
    [{ id: "xiaomi/mimo-v2.5-pro", name: "MiMo V2.5 Pro", context_length: 1000000 }],
  )
  expect(models["mimo-v2.5-pro"].name).toBe("MiMo V2.5 Pro")
})

test("config hook uses default context when API model has none", async () => {
  process.env.COMMANDCODE_API_KEY = "sk-test"
  const models = await getMergedModels(
    [],
    [{ id: "new/model" }],
  )
  expect(models["model"].limit.context).toBe(131072)
  expect(models["model"].limit.output).toBe(131072)
})

test("config hook preserves curated fields for local entries", async () => {
  process.env.COMMANDCODE_API_KEY = "sk-test"
  const models = await getMergedModels(
    [sampleModel({
      name: "Custom Name",
      tier: "premium",
      reasoning: true,
      cost: { input: 5, output: 25 },
    })],
    [{ id: "test/model-a", context_length: 999 }],
  )
  expect(models["model-a"].name).toBe("Custom Name")
  expect(models["model-a"].reasoning).toBe(true)
  expect(models["model-a"].cost.input).toBe(5)
})

// --- Config hook integration tests ---

let originalApiKey: string | undefined

beforeEach(() => {
  originalApiKey = process.env.COMMANDCODE_API_KEY
})

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.COMMANDCODE_API_KEY
  else process.env.COMMANDCODE_API_KEY = originalApiKey
})

test("config hook syncs without an API key and sends no auth header", async () => {
  delete process.env.COMMANDCODE_API_KEY
  const tracker = mockFetchTrack()
  tracker.respondWith({
    json: () => Promise.resolve({ data: [{ id: "new/api-only", context_length: 321000 }] }),
  })

  try {
    const plugin = await pluginFn()
    const config: Record<string, unknown> = { provider: { commandcode: {} } }
    await plugin.config(config)

    // The listing endpoint is public, so the fetch still happens — but with no token.
    expect(tracker.calls).toHaveLength(1)
    expect(tracker.calls[0].url).toBe("https://api.commandcode.ai/provider/v1/models")
    const headers = (tracker.calls[0].options.headers ?? {}) as Record<string, string>
    expect(headers["Authorization"]).toBeUndefined()

    const cc = (config.provider as Record<string, Record<string, unknown>>).commandcode
    const models = cc.models as Record<string, Record<string, unknown>>
    expect(Object.keys(models).length).toBeGreaterThan(0)
    // The API-only model was merged in despite having no credentials.
    expect(models["api-only"]).toBeDefined()
  } finally {
    tracker.restore()
  }
})

test("config hook uses bundled models on API error without merging", async () => {
  process.env.COMMANDCODE_API_KEY = "sk-test"
  const fetchSpy = mockFetch({ json: () => Promise.reject(new Error("network error")) })

  const plugin = await pluginFn()
  const config: Record<string, unknown> = { provider: { commandcode: {} } }
  await plugin.config(config)
  fetchSpy.restore()

  const cc = (config.provider as Record<string, Record<string, unknown>>).commandcode
  const models = cc.models as Record<string, Record<string, unknown>>
  // Bundled list should pass through unchanged when the API fails —
  // no API merge should add, drop, or overwrite entries.
  expect(Object.keys(models).length).toBe(bundledModels.length)
  for (const entry of bundledModels) {
    const slashIdx = entry.id.indexOf("/")
    const key = (slashIdx >= 0 ? entry.id.slice(slashIdx + 1) : entry.id).toLowerCase()
    const result = models[key] as Record<string, unknown> | undefined
    expect(result).toBeDefined()
    expect(result?.name).toBe(entry.name)
    expect(result?.reasoning).toBe(entry.reasoning)
    expect(result?.tool_call).toBe(entry.tool_call)
    expect(result?.limit).toEqual(entry.limit)
  }
})

test("config hook throws actionable error when bundled models.json is missing", async () => {
  delete process.env.COMMANDCODE_API_KEY

  await withMissingModels(async () => {
    const plugin = await pluginFn()
    const config: Record<string, unknown> = { provider: { commandcode: {} } }
    await expect(plugin.config(config)).rejects.toThrow(
      /Bundled models.json missing or corrupt.*please reinstall commandcode-go-opencode-provider/,
    )
  })
})

test("config hook throws actionable error when bundled models.json is corrupt", async () => {
  delete process.env.COMMANDCODE_API_KEY

  await withCorruptModels(async () => {
    const plugin = await pluginFn()
    const config: Record<string, unknown> = { provider: { commandcode: {} } }
    await expect(plugin.config(config)).rejects.toThrow(
      /Bundled models.json missing or corrupt.*please reinstall commandcode-go-opencode-provider/,
    )
  })
})

test("config hook sends auth header to API", async () => {
  process.env.COMMANDCODE_API_KEY = "sk-my-key"
  const tracker = mockFetchTrack()

  try {
    const plugin = await pluginFn()
    const config: Record<string, unknown> = { provider: { commandcode: {} } }
    await plugin.config(config)

    expect(tracker.calls).toHaveLength(1)
    expect(tracker.calls[0].url).toBe("https://api.commandcode.ai/provider/v1/models")
    const headers = tracker.calls[0].options.headers as Record<string, string>
    expect(headers["Authorization"]).toBe("Bearer sk-my-key")
  } finally {
    tracker.restore()
  }
})

// --- Opt-out via config file ---

test("config hook skips API fetch when disableModelSync is true in config file", async () => {
  process.env.COMMANDCODE_API_KEY = "sk-test"

  await withFakeConfig(JSON.stringify({ disableModelSync: true }), async (tracker) => {
    const plugin = await pluginFn()
    const config: Record<string, unknown> = { provider: { commandcode: {} } }
    await plugin.config(config)

    expect(tracker.calls).toHaveLength(0)

    const cc = (config.provider as Record<string, Record<string, unknown>>).commandcode
    const models = cc.models as Record<string, Record<string, unknown>>
    expect(Object.keys(models).length).toBeGreaterThan(0)
  })
})

test("config hook falls through to API on corrupt config file", async () => {
  process.env.COMMANDCODE_API_KEY = "sk-test"

  await withFakeConfig("{ invalid json", async (tracker) => {
    const plugin = await pluginFn()
    const config: Record<string, unknown> = { provider: { commandcode: {} } }
    await plugin.config(config)

    // Fetch is called with the correct auth header — proves the request
    // was actually issued, not just that fetch() was attempted.
    expect(tracker.calls).toHaveLength(1)
    expect(tracker.calls[0].url).toBe("https://api.commandcode.ai/provider/v1/models")
    const headers = tracker.calls[0].options.headers as Record<string, string>
    expect(headers["Authorization"]).toBe("Bearer sk-test")
  })
})

test("config hook passes through variants for models that have them", async () => {
  process.env.COMMANDCODE_API_KEY = "sk-test"
  const models = await getMergedModels(
    [{
      ...sampleModel(),
      variants: { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } },
    }],
    [],
  )
  expect(models["model-a"].variants).toEqual({
    low: { reasoningEffort: "low" },
    high: { reasoningEffort: "high" },
  })
})

test("config hook does not set variants on models without them", async () => {
  process.env.COMMANDCODE_API_KEY = "sk-test"
  const models = await getMergedModels([sampleModel()], [])
  expect(models["model-a"].variants).toBeUndefined()
})
