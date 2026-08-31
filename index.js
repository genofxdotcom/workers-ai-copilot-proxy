export default {
  async fetch(request, env) {
    // 1. Only handle POST requests (standard for Chat Completions)
    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method not allowed. Send a POST request." }),
        { status: 405, headers: { "Content-Type": "application/json" } }
      );
    }

    try {
      const body = await request.json();

      // 2. Extract requested model dynamically from payload
      const modelId = body.model;
      if (!modelId) {
        return new Response(
          JSON.stringify({ error: "Missing 'model' field in JSON body." }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      // 3. Clean payload: Remove parameters that cause Error 7003 on Workers AI
      delete body.tools;
      delete body.tool_choice;
      delete body.presence_penalty;
      delete body.frequency_penalty;
      delete body.user;
      delete body.logit_bias;

      // 4. Construct target Cloudflare Workers AI REST API URL
      const accountId = env.CLOUDFLARE_ACCOUNT_ID || "5b49642f856e69ac463af10e6da43323";
      const targetUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;

      // 5. Use TOKEN from environment (fallback to Authorization header if set)
      const token = env.TOKEN || request.headers.get("Authorization")?.replace("Bearer ", "");
      if (!token) {
        return new Response(
          JSON.stringify({ error: "API Token missing. Set TOKEN environment secret in Worker." }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }

      // 6. Forward sanitized payload to Cloudflare Workers AI
      const cfResponse = await fetch(targetUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });

      // 7. Return exact response stream/json back to Copilot
      return new Response(cfResponse.body, {
        status: cfResponse.status,
        headers: {
          "Content-Type": cfResponse.headers.get("Content-Type") || "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "Proxy execution failed", details: err.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }
};
