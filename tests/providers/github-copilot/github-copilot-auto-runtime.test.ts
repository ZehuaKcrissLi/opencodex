import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAccountSet, saveCredential, setActiveAccount } from "../../../src/oauth/store";
import { handleResponses } from "../../../src/server/responses";
import { saveConfig } from "../../../src/config";
import { clearGenericFailoverHealth } from "../../../src/oauth/generic-account-failover";
import { clearCopilotAutoModelsForTests } from "../../../src/providers/github-copilot-auto";
import { fetchProviderModels } from "../../../src/codex/catalog/provider-models";
import { filterCatalogVisibleModels } from "../../../src/codex/catalog/model-visibility";
import type { OcxConfig } from "../../../src/types";
import { acquireOwnedSpendHome } from "../../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const previousFetch = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
let home: string;
let release: (() => void) | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-copilot-auto-"));
  process.env.OPENCODEX_HOME = home;
  clearCopilotAutoModelsForTests();
  clearGenericFailoverHealth();
  release = acquireOwnedSpendHome();
});
afterEach(() => {
  release?.();
  globalThis.fetch = previousFetch;
  clearGenericFailoverHealth();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});
function request(input: unknown, stream = true): Request {
  return new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "github-copilot/auto", input, stream,
      tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: { name: { type: "string" } } } }] }) });
}
async function accounts() {
  for (const account of ["a", "b"]) await saveCredential("github-copilot", {
    access: `synthetic-access-${account}`, refresh: `synthetic-refresh-${account}`, expires: Date.now() + 3_600_000,
    accountId: account, apiBaseUrl: `https://${account}.githubcopilot.com`, source: "oauth",
  });
  const rows = getAccountSet("github-copilot")!.accounts;
  const a = rows.find(row => row.credential.accountId === "a")!.id;
  const b = rows.find(row => row.credential.accountId === "b")!.id;
  await setActiveAccount("github-copilot", a);
  return { a, b };
}
function fixture(options: { rotate?: boolean; tool?: boolean; key?: boolean; refusal?: number } = {}) {
  const sent: Array<{ host: string; path: string; token: string | null; body: any }> = [];
  let inferenceCount = 0;
  const executor = (async (url, init) => {
    const destination = new URL(String(url));
    const account = new Headers(init?.headers).get("authorization")?.endsWith("-b") ? "b" : "a";
    const model = account === "a" ? "gpt-4o" : "gpt-5.4";
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    expect(headers.get("authorization")).toBe(`Bearer synthetic-access-${account}`);
    sent.push({ host: destination.host, path: destination.pathname, token: headers.get("copilot-session-token"), body });
    if (destination.pathname === "/models") return Response.json({ data: [{ id: model, model_picker_enabled: false,
      supported_endpoints: [account === "a" ? "/chat/completions" : "/responses"] }] });
    if (destination.pathname === "/models/session") return Response.json({ session_token: `synthetic-session-${account}`, available_models: [model] });
    if (destination.pathname === "/models/session/intent") return Response.json({ candidate_models: [model] });
    expect(body.model).toBe(model);
    expect(headers.get("copilot-session-token")).toBe(`synthetic-session-${account}`);
    inferenceCount++;
    if (options.rotate && inferenceCount === 1) return Response.json({ error: { message: "limited" } }, { status: options.refusal ?? 429, headers: { "retry-after": "1" } });
    if (destination.pathname === "/responses") return Response.json({ id: "resp-fixture", model, object: "response", status: "completed",
      output: [{ id: "msg-fixture", type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 2, output_tokens: 1 } });
    const tool = options.tool && inferenceCount === 1;
    const delta = tool ? { tool_calls: [{ index: 0, id: "call_lookup", type: "function", function: { name: "lookup", arguments: '{"name":"file"}' } }] } : { content: "ok" };
    return new Response(`data: ${JSON.stringify({ id: "chat-fixture", model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "chat-fixture", model, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const config: OcxConfig = { port: 0, defaultProvider: "github-copilot", providers: { "github-copilot": {
    adapter: "openai-chat", authMode: options.key ? "key" : "oauth",
    ...(options.key ? { apiKey: "synthetic-access-a", apiKeyPool: [{ id: "a", key: "synthetic-access-a" }, { id: "b", key: "synthetic-access-b" }] } : {}), baseUrl: "https://api.githubcopilot.com", models: ["gpt-4o"],
    defaultModel: "gpt-4o", selectedModels: ["gpt-4o"], copilotModelSelection: "auto", fetch: executor,
  } }, oauthAccountFailover: { enabled: true } } as OcxConfig;
  if (options.key) globalThis.fetch = executor;
  return { config, sent };
}
describe("Copilot Auto through the Responses pipeline", () => {
  test.each([401, 429])("key pool %s rotation reacquires a new session and endpoint", async status => {
    const { config, sent } = fixture({ key: true, rotate: true, refusal: status });
    await saveConfig(config);
    const response = await handleResponses(request("hello", false), config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    const result = JSON.parse(await response.text());
    expect(result.status).toBe("completed");
    const inference = sent.filter(call => ["/chat/completions", "/responses"].includes(call.path));
    expect(inference.map(call => [call.path, call.body.model, call.token])).toEqual([
      ["/chat/completions", "gpt-4o", "synthetic-session-a"],
      ["/responses", "gpt-5.4", "synthetic-session-b"],
    ]);
  });

  test("Auto-only catalog survives saved manual allowlists and explicit provider disable still wins", async () => {
    const { config } = fixture();
    const models = await fetchProviderModels("github-copilot", config.providers["github-copilot"]!, 1000);
    expect(filterCatalogVisibleModels(models, config).map(model => model.id)).toEqual(["auto"]);
    config.providers["github-copilot"]!.disabled = true;
    expect(filterCatalogVisibleModels(models, config)).toEqual([]);
  });
  test("streamed function calls and their result history use existing Chat adapter", async () => {
    await accounts();
    const { config, sent } = fixture({ tool: true });
    const first = await handleResponses(request("look up file"), config, { model: "", provider: "" });
    expect(first.status).toBe(200);
    const stream = await first.text();
    expect(stream).toContain("response.function_call_arguments.done");
    expect(stream).toContain("call_lookup");
    const second = await handleResponses(request([
      { role: "user", content: "look up file" },
      { type: "function_call", call_id: "call_lookup", name: "lookup", arguments: '{"name":"file"}' },
      { type: "function_call_output", call_id: "call_lookup", output: "found" },
    ]), config, { model: "", provider: "" });
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("ok");
    const inference = sent.filter(call => call.path === "/chat/completions");
    expect(inference).toHaveLength(2);
    expect(inference[1]!.body.messages.some((message: any) => message.role === "tool" && message.tool_call_id === "call_lookup" && message.content === "found")).toBe(true);
    expect(sent.filter(call => call.path === "/models/session")).toHaveLength(2);
  });
  test("429 rotation reacquires account-bound Auto session and switches to Responses wire", async () => {
    await accounts();
    const { config, sent } = fixture({ rotate: true });
    await saveConfig(config);
    const response = await handleResponses(request("hello", false), config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    const resultText = await response.text();
    expect(JSON.parse(resultText).status).toBe("completed");
    expect(JSON.parse(resultText).output[0].content[0].text).toBe("ok");
    const inference = sent.filter(call => ["/chat/completions", "/responses"].includes(call.path));
    expect(inference.map(call => [call.host, call.path, call.body.model, call.token])).toEqual([
      ["a.githubcopilot.com", "/chat/completions", "gpt-4o", "synthetic-session-a"],
      ["b.githubcopilot.com", "/responses", "gpt-5.4", "synthetic-session-b"],
    ]);
    expect(sent.filter(call => call.path === "/models/session").map(call => call.host)).toEqual(["a.githubcopilot.com", "b.githubcopilot.com"]);
  });
});
