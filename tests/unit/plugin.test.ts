import { expect, test, beforeAll, beforeEach, afterEach, spyOn } from "bun:test"
import * as fs from "fs"
import { mergeModels } from "../../plugin.ts"
import type { ModelEntry } from "../../plugin.ts"
import { mockFetch, mockFetchTrack } from "../helpers/mocks.ts"

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

// --- mergeModels unit tests (pure, no I/O) ---

const sampleModel = (overrides: Partial<ModelEntry> = {}): ModelEntry => ({
  id: "test/model-a",
  name: "Model A",
  tier: "premium",
  reasoning: false,
  tool_call: true,
  cost: { input: 1, output: 2 },
  limit: { context: 100000, output: 8192 },
  ...overrides,
})

test("mergeModels preserves local entry when API has no match", () => {
  const local = [sampleModel()]
  const result = mergeModels(local, [])
  expect(result).toHaveLength(1)
  expect(result[0].id).toBe("test/model-a")
})

test("mergeModels updates context from API for known models", () => {
  const local = [sampleModel({ id: "test/model-a" })]
  const result = mergeModels(local, [{ id: "test/model-a", context_length: 200000 }])
  expect(result[0].limit.context).toBe(200000)
  expect(result[0].limit.output).toBe(8192)
})

test("mergeModels keeps local context when API has no context_length", () => {
  const local = [sampleModel({ id: "test/model-a", limit: { context: 150000, output: 4096 } })]
  const result = mergeModels(local, [{ id: "test/model-a" }])
  expect(result[0].limit.context).toBe(150000)
})

test("mergeModels adds new API-only models with defaults", () => {
  const local = [sampleModel({ id: "test/model-a" })]
  const result = mergeModels(local, [{ id: "new-provider/new-model", context_length: 500000 }])
  expect(result).toHaveLength(2)
  const newModel = result.find((m) => m.id === "new-provider/new-model")!
  expect(newModel.name).toBe("new-model")
  expect(newModel.tier).toBe("open-source")
  expect(newModel.reasoning).toBe(false)
  expect(newModel.limit.context).toBe(500000)
  expect(newModel.limit.output).toBe(131072)
})

test("mergeModels uses default context when API model has none", () => {
  const result = mergeModels([], [{ id: "new/model" }])
  expect(result[0].limit.context).toBe(131072)
  expect(result[0].limit.output).toBe(131072)
})

test("mergeModels preserves curated fields for local entries", () => {
  const local = [sampleModel({
    id: "test/model-a",
    name: "Custom Name",
    tier: "premium",
    reasoning: true,
    cost: { input: 5, output: 25 },
  })]
  const result = mergeModels(local, [{ id: "test/model-a", context_length: 999 }])
  expect(result[0].name).toBe("Custom Name")
  expect(result[0].tier).toBe("premium")
  expect(result[0].reasoning).toBe(true)
  expect(result[0].cost.input).toBe(5)
})

// --- Config hook integration tests (with writeFileSync mocked) ---

let originalApiKey: string | undefined

beforeEach(() => {
  originalApiKey = process.env.COMMANDCODE_API_KEY
})

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.COMMANDCODE_API_KEY
  else process.env.COMMANDCODE_API_KEY = originalApiKey
})

test("config hook falls back to local when API key is missing", async () => {
  const spy = spyOn(fs, "writeFileSync").mockImplementation(() => undefined)
  delete process.env.COMMANDCODE_API_KEY

  try {
    const plugin = await pluginFn()
    const config: Record<string, unknown> = { provider: { commandcode: {} } }
    await plugin.config(config)

    const cc = (config.provider as Record<string, Record<string, unknown>>).commandcode
    const models = cc.models as Record<string, Record<string, unknown>>
    expect(Object.keys(models).length).toBeGreaterThan(0)
  } finally {
    spy.mockRestore()
  }
})

test("config hook does not write to disk when API response unparseable", async () => {
  const spy = spyOn(fs, "writeFileSync").mockImplementation(() => undefined)
  process.env.COMMANDCODE_API_KEY = "sk-test"
  const fetchSpy = mockFetch({ json: () => Promise.reject(new Error("network error")) })

  try {
    const plugin = await pluginFn()
    const config: Record<string, unknown> = { provider: { commandcode: {} } }
    await plugin.config(config)
    expect(spy).not.toHaveBeenCalled()
  } finally {
    spy.mockRestore()
    fetchSpy.restore()
  }
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
