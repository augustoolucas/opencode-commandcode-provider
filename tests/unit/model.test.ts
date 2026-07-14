import { expect, test, beforeAll, afterAll } from "bun:test"
import { CommandCodeLanguageModel } from "../../src/model.js"
import { mockFetchTrack, mockFetchError, mockFetchStream, mockFetchRetrySequence, makeCallOptions } from "../helpers/mocks.js"

const MODEL_ID = "test-model"
const API_KEY = "sk-test-key"

function makeModel(baseURL?: string) {
  return new CommandCodeLanguageModel(MODEL_ID, {
    apiKey: API_KEY,
    baseURL,
  })
}

let originalEnv: Record<string, string | undefined> = {}
beforeAll(() => {
  originalEnv.COMMANDCODE_API_KEY = process.env.COMMANDCODE_API_KEY
  delete process.env.COMMANDCODE_API_KEY
})
afterAll(() => {
  if (originalEnv.COMMANDCODE_API_KEY) process.env.COMMANDCODE_API_KEY = originalEnv.COMMANDCODE_API_KEY
})

test("provider and modelId are correct", () => {
  const model = makeModel()
  expect(model.provider).toBe("commandcode")
  expect(model.modelId).toBe(MODEL_ID)
  expect(model.specificationVersion).toBe("v3")
})

test("doStream sends correct headers", async () => {
  const { calls, restore, respondWith } = mockFetchTrack()
  respondWith({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"start"}\n\n'))
        controller.close()
      },
    }),
  })

  const model = makeModel()
  await model.doStream(makeCallOptions())
  restore()

  expect(calls).toHaveLength(1)
  const headers = calls[0].options.headers as Record<string, string>
  expect(headers["Authorization"]).toBe("Bearer sk-test-key")
  expect(headers["Content-Type"]).toBe("application/json")
  expect(headers["x-command-code-version"]).toBe("0.26.20")
  expect(headers["x-cli-environment"]).toBe("production")
  expect(headers["x-project-slug"]).toBe("opencode")
})

test("doStream sends request body with model and messages", async () => {
  const { calls, restore, respondWith } = mockFetchTrack()
  respondWith({
    ok: true,
    status: 200,
    headers: new Headers(),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"start"}\n\n'))
        controller.close()
      },
    }),
  })

  const model = makeModel()
  await model.doStream(makeCallOptions({ prompt: [{ role: "user", content: "hi" }] }))
  restore()

  const body = JSON.parse(calls[0].options.body as string)
  expect(body.params.model).toBe(MODEL_ID)
  expect(body.params.messages).toHaveLength(1)
  expect(body.params.messages[0].content).toBe("hi")
})

test("doStream uses correct URL", async () => {
  const { calls, restore, respondWith } = mockFetchTrack()
  respondWith({
    ok: true,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"start"}\n\n'))
        controller.close()
      },
    }),
  })

  const model = makeModel()
  await model.doStream(makeCallOptions())
  restore()

  expect(calls[0].url).toBe("https://api.commandcode.ai/alpha/generate")
})

test("doStream uses custom baseURL when provided", async () => {
  const { calls, restore, respondWith } = mockFetchTrack()
  respondWith({
    ok: true,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"start"}\n\n'))
        controller.close()
      },
    }),
  })

  const model = makeModel("https://custom.example.com")
  await model.doStream(makeCallOptions())
  restore()

  expect(calls[0].url).toBe("https://custom.example.com/alpha/generate")
})

test("doStream throws descriptive error on non-OK response", async () => {
  const { restore } = mockFetchError(401, "Unauthorized", JSON.stringify({
    error: { message: "Invalid API key" },
  }))
  const model = makeModel()
  expect(model.doStream(makeCallOptions())).rejects.toThrow("Invalid API key")
  restore()
})

test("doStream throws on HTTP error without JSON body", { timeout: 30000 }, async () => {
  // 500 is retryable — return it for all 4 attempts (1 initial + 3 retries)
  const { restore } = mockFetchRetrySequence([
    { ok: false, status: 500, statusText: "Internal Server Error", errorBody: "" },
    { ok: false, status: 500, statusText: "Internal Server Error", errorBody: "" },
    { ok: false, status: 500, statusText: "Internal Server Error", errorBody: "" },
    { ok: false, status: 500, statusText: "Internal Server Error", errorBody: "" },
  ])
  const model = makeModel()
  expect(model.doStream(makeCallOptions())).rejects.toThrow("Command Code API error: 500 Internal Server Error")
  restore()
})

test("doStream throws when response body is null", async () => {
  const { restore: r1 } = mockFetchError(200, "OK")
  const track = mockFetchTrack()
  track.respondWith({ ok: true, body: null })
  const model = makeModel()
  expect(model.doStream(makeCallOptions())).rejects.toThrow("Command Code API returned no body")
  track.restore()
  r1()
})

test("doStream streams returned parts", async () => {
  const { restore } = mockFetchStream([
    'data: {"type":"start"}\n\n',
    'data: {"type":"text-delta","id":"t1","delta":"hello"}\n\n',
  ])
  const model = makeModel()
  const result = await model.doStream(makeCallOptions())
  const reader = result.stream.getReader()
  const parts: any[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  reader.releaseLock()
  restore()

  expect(parts).toHaveLength(2)
  expect(parts[0].type).toBe("stream-start")
  expect(parts[1].type).toBe("text-delta")
})

test("doGenerate returns complete response", async () => {
  const { restore } = mockFetchStream([
    'data: {"type":"start"}\n\n',
    'data: {"type":"text-delta","id":"t1","delta":"Hello "}\n\n',
    'data: {"type":"text-delta","id":"t1","delta":"world"}\n\n',
    'data: {"type":"finish-step","finishReason":"stop","usage":{"inputTokens":5,"outputTokens":10}}\n\n',
  ])
  const model = makeModel()
  const result = await model.doGenerate(makeCallOptions())
  restore()

  expect(result.content).toHaveLength(1)
  expect(result.content[0]).toMatchObject({ type: "text", text: "Hello world" })
  expect(result.finishReason.unified).toBe("stop")
  expect(result.finishReason.raw).toBe("stop")
  expect(result.usage.inputTokens.total).toBe(5)
  expect(result.usage.outputTokens.total).toBe(10)
})

test("doGenerate includes reasoning before text", async () => {
  const { restore } = mockFetchStream([
    'data: {"type":"start"}\n\n',
    'data: {"type":"reasoning-delta","id":"r1","text":"think"}\n\n',
    'data: {"type":"text-delta","id":"t1","delta":"answer"}\n\n',
    'data: {"type":"finish-step","finishReason":"stop","usage":{"inputTokens":1,"outputTokens":1}}\n\n',
  ])
  const model = makeModel()
  const result = await model.doGenerate(makeCallOptions())
  restore()

  expect(result.content).toHaveLength(2)
  expect(result.content[0]).toMatchObject({ type: "reasoning", text: "think" })
  expect(result.content[1]).toMatchObject({ type: "text", text: "answer" })
})

test("doGenerate handles tool calls", async () => {
  const { restore } = mockFetchStream([
    'data: {"type":"start"}\n\n',
    'data: {"type":"text-delta","id":"t1","delta":"Let me run..."}\n\n',
    `data: ${JSON.stringify({ type: "tool-call", toolCallId: "tc1", toolName: "bash", input: { cmd: "ls" } })}\n\n`,
    'data: {"type":"finish-step","finishReason":"tool_calls","usage":{"inputTokens":5,"outputTokens":3}}\n\n',
  ])
  const model = makeModel()
  const result = await model.doGenerate(makeCallOptions())
  restore()

  expect(result.content).toHaveLength(2)
  expect(result.content[0]).toMatchObject({ type: "text", text: "Let me run..." })
  expect(result.content[1]).toMatchObject({ type: "tool-call", toolCallId: "tc1", toolName: "bash" })
  expect(result.finishReason.unified).toBe("tool-calls")
})

test("doStream includes model ID in error messages", async () => {
  const { restore } = mockFetchError(400, "Bad Request", JSON.stringify({
    error: { message: "Something broke" },
  }))
  const model = makeModel()
  try {
    await model.doStream(makeCallOptions())
    expect.unreachable("Should have thrown")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    expect(msg).toContain("[model=test-model]")
  }
  restore()
})

// --- Retry/Backoff tests ---

test("fetchWithRetry retries on HTTP 500 then succeeds", { timeout: 15000 }, async () => {
  const encoder = new TextEncoder()
  const successBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"start"}\n\n'))
      controller.close()
    },
  })
  const { calls, restore } = mockFetchRetrySequence([
    { ok: false, status: 500, statusText: "Internal Server Error", errorBody: '{"error":{"message":"server oops"}}' },
    { ok: true, status: 200, body: successBody },
  ])
  const model = makeModel()
  const result = await model.doStream(makeCallOptions())
  restore()

  // Should have made 2 fetch calls (1 failed + 1 success)
  expect(calls).toHaveLength(2)
  // Result should have a valid stream
  expect(result.stream).toBeDefined()
  const reader = result.stream.getReader()
  const { done } = await reader.read()
  expect(done).toBe(false)
  reader.releaseLock()
})

test("fetchWithRetry retries on HTTP 429 then succeeds", { timeout: 15000 }, async () => {
  const encoder = new TextEncoder()
  const successBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"start"}\n\n'))
      controller.close()
    },
  })
  const { calls, restore } = mockFetchRetrySequence([
    { ok: false, status: 429, statusText: "Too Many Requests", errorBody: '{"error":{"message":"rate limited"}}' },
    { ok: true, status: 200, body: successBody },
  ])
  const model = makeModel()
  const result = await model.doStream(makeCallOptions())
  restore()

  expect(calls).toHaveLength(2)
  expect(result.stream).toBeDefined()
})

test("fetchWithRetry fails fast on 401 (non-retryable)", async () => {
  const { calls, restore } = mockFetchRetrySequence([
    { ok: false, status: 401, statusText: "Unauthorized", errorBody: '{"error":{"message":"Invalid API key"}}' },
  ])
  const model = makeModel()
  try {
    await model.doStream(makeCallOptions())
    expect.unreachable("Should have thrown")
  } catch (err) {
    expect((err as Error).message).toContain("Invalid API key")
  }
  restore()

  // Should have made only 1 fetch call — no retries for 4xx
  expect(calls).toHaveLength(1)
})

test("fetchWithRetry fails fast on 403 (non-retryable)", async () => {
  const { calls, restore } = mockFetchRetrySequence([
    { ok: false, status: 403, statusText: "Forbidden", errorBody: '{"error":{"message":"Forbidden"}}' },
  ])
  const model = makeModel()
  expect(model.doStream(makeCallOptions())).rejects.toThrow("Forbidden")
  restore()
  expect(calls).toHaveLength(1)
})

test("fetchWithRetry respects max retries and throws last error", { timeout: 30000 }, async () => {
  const { calls, restore } = mockFetchRetrySequence([
    { ok: false, status: 500, statusText: "Server Error", errorBody: '{"error":{"message":"down"}}' },
    { ok: false, status: 500, statusText: "Server Error", errorBody: '{"error":{"message":"down"}}' },
    { ok: false, status: 500, statusText: "Server Error", errorBody: '{"error":{"message":"down"}}' },
    { ok: false, status: 500, statusText: "Server Error", errorBody: '{"error":{"message":"down"}}' },
  ])
  const model = makeModel()
  try {
    await model.doStream(makeCallOptions())
    expect.unreachable("Should have thrown")
  } catch (err) {
    expect((err as Error).message).toContain("down")
  }
  restore()

  // Should have made 4 fetch calls (1 initial + 3 retries)
  expect(calls).toHaveLength(4)
})

test("fetchWithRetry fails fast on quota/auth error patterns in body", async () => {
  const { calls, restore } = mockFetchRetrySequence([
    { ok: false, status: 400, statusText: "Bad Request", errorBody: '{"error":{"message":"insufficient credit balance"}}' },
  ])
  const model = makeModel()
  try {
    await model.doStream(makeCallOptions())
    expect.unreachable("Should have thrown")
  } catch (err) {
    expect((err as Error).message).toContain("insufficient credit")
  }
  restore()
  expect(calls).toHaveLength(1)
})

test("fetchWithRetry fails fast on validation_error", async () => {
  const { calls, restore } = mockFetchRetrySequence([
    { ok: false, status: 400, statusText: "Bad Request", errorBody: '{"type":"validation_error","message":"Invalid params"}' },
  ])
  const model = makeModel()
  expect(model.doStream(makeCallOptions())).rejects.toThrow("Invalid params")
  restore()
  expect(calls).toHaveLength(1)
})

test("fetchWithRetry retries network errors (fetch throws)", { timeout: 15000 }, async () => {
  const encoder = new TextEncoder()
  const original = globalThis.fetch
  let callCount = 0
  globalThis.fetch = ((async () => {
    callCount++
    if (callCount === 1) {
      throw new Error("fetch failed: ECONNRESET")
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"start"}\n\n'))
          controller.close()
        },
      }),
      text: () => Promise.resolve(""),
    } as Response
  }) as typeof globalThis.fetch)

  const model = makeModel()
  const result = await model.doStream(makeCallOptions())
  globalThis.fetch = original

  expect(callCount).toBe(2)
  expect(result.stream).toBeDefined()
})

test("doStream sends retry-specific log messages on 5xx", { timeout: 15000 }, async () => {
  const encoder = new TextEncoder()
  const successBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"start"}\n\n'))
      controller.close()
    },
  })
  const { restore } = mockFetchRetrySequence([
    { ok: false, status: 502, statusText: "Bad Gateway", errorBody: '{"error":{"message":"bad gateway"}}' },
    { ok: true, status: 200, body: successBody },
  ])

  const errors: string[] = []
  const origDebug = console.debug
  console.debug = (...args: any[]) => errors.push(args.join(" "))

  const model = makeModel()
  await model.doStream(makeCallOptions())

  console.debug = origDebug
  restore()

  expect(errors.some((e) => e.includes("[CC-Retry]") && e.includes("HTTP 502"))).toBe(true)
})
