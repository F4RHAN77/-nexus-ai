
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const MODEL = "@cf/google/gemma-4-26b-a4b-it";

export default {
  async fetch(request, env) {

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    if (request.method !== "POST") {
      return Response.json(
        { error: "Method not allowed" },
        { status: 405, headers: corsHeaders }
      );
    }

    try {
      // Rate limiting
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

      // Check AI binding
      if (!env.AI) {
        throw new Error("AI binding is not configured");
      }

      // Read request
      const body = await request.json();
      const message = body.message;

      if (typeof message !== "string" || !message.trim()) {
        return Response.json(
          { error: "Please enter a message" },
          { status: 400, headers: corsHeaders }
        );
      }

      if (message.length > 6000) {
        return Response.json(
          { error: "Message is too long" },
          { status: 400, headers: corsHeaders }
        );
      }

      // Conversation history support
      const history = Array.isArray(body.history)
        ? body.history
        : [];

      const validHistory = history
        .filter(item =>
          item &&
          ["user", "assistant"].includes(item.role) &&
          typeof item.content === "string" &&
          item.content.trim()
        )
        .slice(-15)
        .map(item => ({
          role: item.role,
          content: item.content.slice(0, 6000)
        }));

      // Avoid duplicating the latest user message
      const lastMessage = validHistory[validHistory.length - 1];

      if (
        !lastMessage ||
        lastMessage.role !== "user" ||
        lastMessage.content !== message
      ) {
        validHistory.push({
          role: "user",
          content: message.trim()
        });
      }

      const messages = [
        {
          role: "system",
          content:
            "You are NEXUS AI, a helpful, intelligent and friendly AI assistant. " +
            "Answer clearly and accurately. Remember the conversation context. " +
            "Use headings, bullet points and code blocks when useful. " +
            "For programming questions, provide working and understandable code. " +
            "If you are unsure about something, say so honestly."
        },
        ...validHistory
      ];

      // Generate AI response
      const result = await env.AI.run(MODEL, {
        messages,
        max_tokens: 2048
      });

      const reply =
        result.choices?.[0]?.message?.content ||
        result.response ||
        "No response generated.";

      return Response.json(
        { reply },
        { headers: corsHeaders }
      );

    } catch (error) {
      return Response.json(
        {
          error: "AI service error",
          details: error.message
        },
        {
          status: 500,
          headers: corsHeaders
        }
      );
    }
  }
};
