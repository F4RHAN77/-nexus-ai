
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return Response.json(
        { error: "Method not allowed" },
        { status: 405, headers: corsHeaders }
      );
    }

    try {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";

const { success } = await env.MY_RATE_LIMITER.limit({
  key: ip
});

if (!success) {
  return Response.json(
    { error: "Too many requests. Please try again later." },
    { status: 429, headers: corsHeaders }
  );
}
     if (!env.AI) {
        throw new Error("AI binding is not configured");
      }

      const body = await request.json();
      const message = body.message;

      if (typeof message !== "string" || !message.trim()) {
        return Response.json(
          { error: "Please enter a message" },
          { status: 400, headers: corsHeaders }
        );
      }

      if (message.length > 3000) {
        return Response.json(
          { error: "Message is too long" },
          { status: 400, headers: corsHeaders }
        );
      }

      const result = await env.AI.run(
        "@cf/google/gemma-4-26b-a4b-it",
        {
          messages: [
            {
              role: "system",
              content: "You are NEXUS AI, a helpful and friendly AI assistant. Give clear and useful answers."
            },
            {
              role: "user",
              content: message.trim()
            }
          ],
          max_tokens: 2048
        }
      );

      return Response.json(
        { reply: result.choices?.[0]?.message?.content || result.response || "No response generated." },
        { headers: corsHeaders }
      );

    } catch (error) {
      return Response.json(
        { error: "AI service error", details: error.message },
        { status: 500, headers: corsHeaders }
      );
    }
  }
};

