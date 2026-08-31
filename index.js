export default {
  async fetch(request, env) {
    // 1. Enforce POST request (standard OpenAI chat completions format)
    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method not allowed. Send a POST request." }),
        { status: 405, headers: { "Content-Type": "application/json" } }
      );
    }

    try {
      const body = await request.json();

      // 2. Extract requested model dynamically from VS Code Copilot's payload
      const modelId = body.model;
      if (!modelId) {
        return new Response(
          JSON.stringify({ error: "Missing 'model' field in JSON payload." }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      // 3. Extract and sanitize messages
      const messages = body.messages || [];

      // 4. Extract standard parameters if provided
      const max_tokens = body.max_tokens || body.max_completion_tokens || 2048;
      const temperature = body.temperature ?? 0.7;
      const stream = body.stream ?? false;

      // 5. Execute model natively via Cloudflare Workers AI Binding (env.AI)
      const aiResponse = await env.AI.run(modelId, {
        messages: messages,
        max_tokens: max_tokens,
        temperature: temperature,
        stream: stream
      });

      // 6. Handle streaming vs non-streaming response
      if (stream) {
        return new Response(aiResponse, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive"
          }
        });
      }

      // 7. Format non-streaming output to OpenAI ChatCompletion structure
      const responsePayload = {
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: aiResponse.response || aiResponse.text || ""
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };

      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    } catch (err) {
      return new Response(
        JSON.stringify({
          error: {
            message: `Workers AI Execution Error: ${err.message}`,
            type: "invalid_request_error",
            code: 7003
          }
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }
};
