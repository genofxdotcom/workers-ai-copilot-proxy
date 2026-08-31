export interface Env {
  AI: any;
}

// Fallback active models for 2026
const FALLBACK_FAST_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const FALLBACK_LARGE_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8";

const MAX_CONTEXT_CHARS = 24000;

/**
 * Resolves the requested model from Copilot to an active Cloudflare Workers AI model tag.
 */
function resolveModel(requestedModel: any): string {
  if (typeof requestedModel !== "string" || !requestedModel.trim()) {
    return FALLBACK_FAST_MODEL;
  }

  const model = requestedModel.trim();

  // If Copilot passes a standard Workers AI tag, use it directly
  if (model.startsWith("@cf/") || model.startsWith("@hf/")) {
    // Prevent using deprecated llama-3.1-8b base tag
    if (model === "@cf/meta/llama-3.1-8b-instruct") {
      return FALLBACK_FAST_MODEL;
    }
    return model;
  }

  // Map generic Copilot / OpenAI model names to Cloudflare equivalents
  if (model.includes("gpt-4") || model.includes("70b") || model.includes("claude")) {
    return FALLBACK_LARGE_MODEL;
  }

  return FALLBACK_FAST_MODEL;
}

function normalizeContent(content: any): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && item.text) return item.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    return JSON.stringify(content);
  }
  return String(content || "");
}

function normalizeRole(role: string): "system" | "user" | "assistant" {
  switch (role) {
    case "system":
    case "developer":
      return "system";
    case "assistant":
      return "assistant";
    default:
      return "user";
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    const url = new URL(request.url);
    if (request.method !== "POST" || (!url.pathname.endsWith("/v1/chat/completions") && url.pathname !== "/")) {
      return new Response(JSON.stringify({ error: "Not Found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const body: any = await request.json();

      // Dynamically select the model passed from Copilot body
      const selectedModel = resolveModel(body.model);
      const rawMessages = Array.isArray(body.messages) ? body.messages : [];

      // 1. Sanitize roles and enforce string-only content format for Workers AI
      const cleanedMessages = rawMessages
        .map((msg: any) => ({
          role: normalizeRole(msg.role),
          content: normalizeContent(msg.content),
        }))
        .filter((msg) => msg.content.trim().length > 0);

      // 2. Truncate historical messages to stay within payload limits
      let totalLength = 0;
      let finalMessages: Array<{ role: string; content: string }> = [];

      const systemMsg = cleanedMessages.find((m) => m.role === "system");
      if (systemMsg) {
        finalMessages.push(systemMsg);
        totalLength += systemMsg.content.length;
      }

      const history = cleanedMessages.filter((m) => m.role !== "system").reverse();
      const keptHistory = [];

      for (const msg of history) {
        if (totalLength + msg.content.length > MAX_CONTEXT_CHARS) {
          const remainingBudget = Math.max(1000, MAX_CONTEXT_CHARS - totalLength);
          if (remainingBudget > 500) {
            keptHistory.unshift({
              role: msg.role,
              content: msg.content.slice(-remainingBudget),
            });
          }
          break;
        }
        keptHistory.unshift(msg);
        totalLength += msg.content.length;
      }

      finalMessages = systemMsg ? [systemMsg, ...keptHistory] : keptHistory;

      if (finalMessages.length === 0) {
        finalMessages = [{ role: "user", content: "Hello" }];
      }

      const isStream = Boolean(body.stream);

      // 3. Streaming execution
      if (isStream) {
        let aiStream: any;
        try {
          aiStream = await env.AI.run(selectedModel, {
            messages: finalMessages,
            stream: true,
            max_tokens: 2048,
            temperature: body.temperature ?? 0.2,
          });
        } catch (aiErr: any) {
          console.error(`Workers AI Execution Error with model standard (${selectedModel}):`, aiErr);
          return new Response(
            JSON.stringify({
              error: {
                message: `Workers AI Execution Error [${selectedModel}]: ${aiErr.message || aiErr}`,
                type: "invalid_request_error",
                code: 400,
              },
            }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }

        const id = `chatcmpl-${crypto.randomUUID()}`;
        const created = Math.floor(Date.now() / 1000);

        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const reader = (aiStream as ReadableStream).getReader();
        const decoder = new TextDecoder();

        (async () => {
          let buffer = "";
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith(":")) continue;

                if (trimmed.startsWith("data: ")) {
                  const dataStr = trimmed.slice(6);
                  if (dataStr === "[DONE]") continue;

                  try {
                    const parsed = JSON.parse(dataStr);
                    const chunkText = parsed.response || parsed.delta?.content || "";

                    if (chunkText) {
                      const openAiChunk = {
                        id,
                        object: "chat.completion.chunk",
                        created,
                        model: selectedModel,
                        choices: [
                          {
                            index: 0,
                            delta: { content: chunkText },
                            finish_reason: null,
                          },
                        ],
                      };
                      await writer.write(new TextEncoder().encode(`data: ${JSON.stringify(openAiChunk)}\n\n`));
                    }
                  } catch {
                    // Ignore non-JSON payload fragments
                  }
                }
              }
            }

            const finalChunk = {
              id,
              object: "chat.completion.chunk",
              created,
              model: selectedModel,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: "stop",
                },
              ],
            };
            await writer.write(new TextEncoder().encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
            await writer.write(new TextEncoder().encode("data: [DONE]\n\n"));
          } catch (err: any) {
            console.error("Stream transformation failure:", err);
          } finally {
            await writer.close();
          }
        })();

        return new Response(readable, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      // 4. Non-Streaming execution
      const aiResponse: any = await env.AI.run(selectedModel, {
        messages: finalMessages,
        stream: false,
        max_tokens: 2048,
        temperature: body.temperature ?? 0.2,
      });

      const responseText = typeof aiResponse === "string" ? aiResponse : aiResponse.response || "";

      return new Response(
        JSON.stringify({
          id: `chatcmpl-${crypto.randomUUID()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: selectedModel,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: responseText },
              finish_reason: "stop",
            },
          ],
        }),
        { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    } catch (err: any) {
      console.error("Worker Proxy Error:", err);
      return new Response(
        JSON.stringify({
          error: {
            message: err.message || "Internal Server Error",
            type: "api_error",
            code: 500,
          },
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  },
};
