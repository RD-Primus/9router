import { describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
  }),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { addBufferToUsage } = await import("../../open-sse/utils/usageTracking.js");
const { saveRequestUsage, saveRequestDetail, appendRequestLog } = await import("@/lib/usageDb.js");
const { responsesBodyToOpenAI } = await import("../../open-sse/translator/response/openai-responses.js");
const { openaiToOpenAIResponsesRequest } = await import("../../open-sse/translator/request/openai-responses.js");

const responseBody = {
  id: "resp_meta_fixture", object: "response", created_at: 1700000000,
  model: "muse-spark-1.3", status: "completed",
  output: [{ id: "msg_meta_fixture", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "Hello from Meta", annotations: [] }] }],
  usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
};

function responsesSSE({ done = false, framed = true } = {}) {
  const events = [
    { type: "response.created", response: { ...responseBody, status: "in_progress", output: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hello from Meta" },
    { type: "response.output_item.done", output_index: 0, item: responseBody.output[0] },
    { type: "response.completed", response: responseBody },
  ];
  return events.map(event => `${framed ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join("")
    + (done ? "data: [DONE]\n\n" : "");
}

async function request({ stream, provider = "openai-compatible-responses-meta-test", model = "muse-spark-1.3", raw = responsesSSE(), contentType = "text/event-stream", onRequestSuccess, sourceFormat = FORMATS.OPENAI }) {
  executeMock.mockResolvedValueOnce({
    response: new Response(raw, { headers: { "content-type": contentType } }),
    url: "https://example.invalid/v1/responses", headers: {}, transformedBody: null,
  });
  return handleChatCore({
    body: { model: `${provider}/${model}`, stream, max_tokens: 16, messages: [{ role: "user", content: "hi" }] },
    modelInfo: { provider, model },
    credentials: { providerSpecificData: { apiType: "responses", baseUrl: "https://example.invalid/v1" } },
    sourceFormatOverride: sourceFormat,
    connectionId: "responses-transport-fixture",
    onRequestSuccess,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
  });
}

describe("custom Responses transport through real chatCore and response handlers", () => {
  it("uses Muse's declared Responses URL and nested thinking on the actual request path", async () => {
    await request({ stream: false, provider: "muse", model: "muse-spark-1.3-contributor(xhigh)" });
    const sent = executeMock.mock.calls.at(-1)[0];
    expect(sent.body.input).toBeInstanceOf(Array);
    expect(sent.body.messages).toBeUndefined();
    expect(sent.body.reasoning.effort).toBe("xhigh");
    expect(sent.body.reasoning_effort).toBeUndefined();
    expect(new DefaultExecutor("muse").buildUrl(sent.model, sent.stream, 0, sent.credentials)).toBe("https://api.meta.ai/v1/responses");
  });

  it("continues to force upstream streaming for Codex JSON clients", async () => {
    await request({ stream: false, provider: "codex", model: "gpt-5.5" });
    const sent = executeMock.mock.calls.at(-1)[0];
    expect(sent.stream).toBe(true);
    expect(sent.body.stream).toBe(true);
  });

  it.each([false, true])("preserves the selected stream flag for already-native input (stream=%s)", stream => {
    expect(openaiToOpenAIResponsesRequest("test", { input: "hi" }, stream, {}).stream).toBe(stream);
  });

  it.each([
    { ...responseBody, status: "failed", error: { code: "server_error", message: "Generation failed" }, output: [] },
    { ...responseBody, status: "failed", error: null, output: [] },
    { ...responseBody, error: { code: "server_error", message: "Generation failed" } },
  ])("does not turn a failed Responses envelope into a successful Chat completion ($status, $error)", failed => {
    expect(responsesBodyToOpenAI(failed)).toEqual(failed);
    expect(responsesBodyToOpenAI(failed).choices).toBeUndefined();
  });

  it.each([false, true])("preserves Responses refusal text on the Chat message (mixed text=%s)", async mixed => {
    const refusal = "I cannot help with that request.";
    const content = [
      ...(mixed ? [{ type: "output_text", text: "Safety note: " }] : []),
      { type: "refusal", refusal: "I cannot help " },
      { type: "refusal", refusal: "with that request." },
    ];
    const result = await request({ stream: false, raw: JSON.stringify({ ...responseBody,
      output: [{ type: "message", role: "assistant", content }] }), contentType: "application/json" });
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.choices[0].message.refusal).toBe(refusal);
    expect(json.choices[0].message.content).toBe(mixed ? "Safety note: " : "");
  });

  it.each([false, true])("keeps Responses refusal visible for a Claude client (mixed text=%s)", async mixed => {
    const refusal = "I cannot help with that request.";
    const result = await request({ stream: false, sourceFormat: FORMATS.CLAUDE,
      raw: JSON.stringify({ ...responseBody, output: [{ type: "message", role: "assistant", content: [
        ...(mixed ? [{ type: "output_text", text: "Safety note: " }] : []),
        { type: "refusal", refusal },
      ] }] }), contentType: "application/json" });
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.type).toBe("message");
    expect(json.content).toEqual([
      ...(mixed ? [{ type: "text", text: "Safety note: " }] : []),
      { type: "text", text: refusal },
    ]);
  });

  it("maps Responses tools, reasoning, token details and incomplete status without losing data", () => {
    const json = responsesBodyToOpenAI({ ...responseBody, status: "incomplete",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "Thinking" }] },
        ...responseBody.output,
        { type: "function_call", call_id: "call_1", name: "read", arguments: { path: "/tmp/test" } },
        { type: "custom_tool_call", call_id: "call_2", name: "exec", input: "pwd" },
      ],
      usage: { ...responseBody.usage, input_tokens_details: { cached_tokens: 8 }, output_tokens_details: { reasoning_tokens: 2 } },
    });
    expect(json.choices[0].message.reasoning_content).toBe("Thinking");
    expect(json.choices[0].message.tool_calls).toMatchObject([
      { id: "call_1", function: { name: "read", arguments: '{"path":"/tmp/test"}' } },
      { id: "call_2", function: { name: "exec", arguments: '{"input":"pwd"}' } },
    ]);
    expect(json.choices[0].finish_reason).toBe("tool_calls");
    expect(json.usage).toEqual({ prompt_tokens: 12, completion_tokens: 4, total_tokens: 16,
      prompt_tokens_details: { cached_tokens: 8 }, completion_tokens_details: { reasoning_tokens: 2 } });
    expect(responsesBodyToOpenAI({ status: "incomplete" }).choices[0].finish_reason).toBe("length");
  });
  it("preserves the selected non-stream mode on the Responses request wire", async () => {
    await request({ stream: false });
    const sent = executeMock.mock.calls.at(-1)[0];
    expect(sent.stream).toBe(false);
    expect(sent.body.stream).toBe(false);
  });
  it("converts genuine Responses JSON to chat text and usage", async () => {
    const result = await request({ stream: false, raw: JSON.stringify(responseBody), contentType: "application/json" });
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("Hello from Meta");
    // The JSON handler intentionally applies the existing router usage buffer.
    expect(json.usage).toEqual(addBufferToUsage({ prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }));
  });

  it.each([
    { status: "failed", error: { code: "server_error", message: "Meta generation failed" }, expected: "Meta generation failed" },
    { status: "failed", error: null, expected: "Upstream Responses request failed" },
    { status: "completed", error: { code: "server_error", message: "Meta returned an error" }, expected: "Meta returned an error" },
  ])("rejects HTTP 200 Responses failure before health success or usage ($status, $error)", async ({ expected, ...failure }) => {
    vi.clearAllMocks();
    const onRequestSuccess = vi.fn();
    const result = await request({ stream: false, onRequestSuccess,
      raw: JSON.stringify({ ...responseBody, ...failure, output: [] }), contentType: "application/json" });
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.response.status).toBe(502);
    expect((await result.response.json()).error.message).toBe(expected);
    expect(onRequestSuccess).not.toHaveBeenCalled();
    expect(saveRequestUsage).not.toHaveBeenCalled();
    expect(saveRequestDetail).not.toHaveBeenCalled();
    expect(appendRequestLog).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED 502" }));
    expect(appendRequestLog).not.toHaveBeenCalledWith(expect.objectContaining({ status: "200 OK" }));
  });

  it("decodes custom Responses SSE even when the upstream omits content-type", async () => {
    const result = await request({ stream: false, contentType: "" });
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.choices[0].message.content).toBe("Hello from Meta");
  });

  it("uses the terminal Responses snapshot when item-done events are omitted", async () => {
    const raw = `data: ${JSON.stringify({ type: "response.completed", response: responseBody })}\n\n`;
    const result = await request({ stream: false, raw });
    const json = await result.response.json();
    expect(json.id).toBe(responseBody.id);
    expect(json.choices[0].message.content).toBe("Hello from Meta");
    expect(json.usage).toMatchObject({ prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 });
  });

  it.each([true, false])("converts unexpected Responses SSE for a non-stream chat client (event framing=%s)", async framed => {
    const result = await request({ stream: false, raw: responsesSSE({ framed }) });
    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toContain("application/json");
    const json = await result.response.json();
    expect(json.choices[0].message.content).toBe("Hello from Meta");
    expect(json.usage).toMatchObject({ prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 });
  });

  it("emits the final chat chunk before DONE when upstream omits response.completed", async () => {
    const raw = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}\n\ndata: [DONE]\n\n`;
    const result = await request({ stream: true, raw });
    const output = await result.response.text();
    expect(output).toContain('"finish_reason":"stop"');
    expect(output.indexOf('"finish_reason":"stop"')).toBeLessThan(output.indexOf("data: [DONE]"));
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it.each([false, true])("terminates translated chat SSE exactly once (upstream DONE=%s)", async done => {
    const result = await request({ stream: true, raw: responsesSSE({ done }) });
    expect(result.success).toBe(true);
    const output = await result.response.text();
    expect(output).toContain('"content":"Hello from Meta"');
    expect(output).toContain('"finish_reason":"stop"');
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(output.trim().endsWith("data: [DONE]")).toBe(true);
  });
});
