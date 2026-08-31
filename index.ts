export interface Env {
  AI: Ai;
}

const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    // Only allow POST to /v1/chat/completions or root path
    const url = new URL(request.url);
    if (request.method !== "POST" || (!url.pathname.endsWith("/v1/chat/completions") && url.pathname !== "/")) {
      return new Response(JSON.stringify({ error: "Not Found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const body: any = await request.json();

      // Normalize model name or fallback to a standard supported model
      let model = body.model || DEFAULT_MODEL;
      if (model.startsWith("gpt-") || model.startsWith("copilot-")) {
        model = DEFAULT_MODEL;
      }

      // Map incoming OpenAI messages into Workers AI standard format
      const messages = (body.messages || []).map((msg: any) => ({
        role: msg.role,
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      }));

      const isStream = Boolean(body.stream);

      // Handle Streaming Requests (SSE)
      if (isStream) {
        const aiStream = await env.AI.run(model, {
          messages,
          stream: true,
          max_tokens: body.max_tokens || body.max_completion_tokens || 2048,
          temperature: body.temperature ?? 0.7,
        });

        const id = `chatcmpl-${crypto.randomUUID()}`;
        const created = Math.floor(Date.now() / 1000);

        // Transform standard Workers AI SSE stream to strict OpenAI SSE chunks
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
                        model: body.model || "copilot-proxy-model",
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

            // Write final stream completion signals
            const finalChunk = {
              id,
              object: "chat.completion.chunk",
              created,
              model: body.model || "copilot-proxy-model",
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
            console.error("Stream transformation error:", err);
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

      // Handle Non-Streaming Requests
      const aiResponse: any = await env.AI.run(model, {
        messages,
        stream: false,
        max_tokens: body.max_tokens || 2048,
        temperature: body.temperature ?? 0.7,
      });

      const responseText = typeof aiResponse === "string" ? aiResponse : aiResponse.response || "";

      const openAiResponse = {
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model || "copilot-proxy-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: responseText,
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      };

      return new Response(JSON.stringify(openAiResponse), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch (err: any) {
      console.error("Worker Proxy Error:", err);
      return new Response(
        JSON.stringify({
          error: {
            message: err?.message || "Internal Server Error in Copilot Proxy",
            type: "server_error",
            code: 500,
          },
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }
  },
};
