const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin"
};

const MODEL = "@cf/google/gemma-4-26b-a4b-it";
const MAX_BODY_BYTES = 2_700_000;

async function readJsonLimited(request) {
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    throw new Error("REQUEST_TOO_LARGE");
  }

  if (!request.body) {
    throw new Error("INVALID_JSON");
  }

  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;

      if (totalBytes > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error("REQUEST_TOO_LARGE");
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("INVALID_JSON");
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return Response.json(
        { error: "Method not allowed" },
        { status: 405, headers: corsHeaders }
      );
    }

    // Reject unexpected content types before spending AI or parsing resources.
    if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
      return Response.json(
        { error: "Content-Type must be application/json" },
        { status: 415, headers: corsHeaders }
      );
    }

    // Fail closed if the configured Cloudflare rate limiter is missing.
    if (!env.MY_RATE_LIMITER) {
      return Response.json(
        { error: "Service temporarily unavailable" },
        { status: 503, headers: corsHeaders }
      );
    }

    // Cloudflare supplies this header at its edge; do not trust client-provided X-Forwarded-For.
    const ip = request.headers.get("CF-Connecting-IP");
    if (!ip) {
      return Response.json(
        { error: "Request could not be verified" },
        { status: 403, headers: corsHeaders }
      );
    }

    try {
      const { success } = await env.MY_RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return Response.json(
          { error: "Too many requests. Please try again later." },
          {
            status: 429,
            headers: { ...corsHeaders, "Retry-After": "60" }
          }
        );
      }

      if (!env.AI) {
        return Response.json(
          { error: "AI service temporarily unavailable" },
          { status: 503, headers: corsHeaders }
        );
      }

      const body = await readJsonLimited(request);
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

      const history = Array.isArray(body.messages)
        ? body.messages
        : Array.isArray(body.history)
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

      const lastMessage = validHistory[validHistory.length - 1];
      if (
        !lastMessage ||
        lastMessage.role !== "user" ||
        lastMessage.content !== message
      ) {
        validHistory.push({ role: "user", content: message.trim() });
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

      const imageDataUrl = body.imageDataUrl;
      if (imageDataUrl !== undefined && imageDataUrl !== null) {
        if (
          typeof imageDataUrl !== "string" ||
          !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(imageDataUrl) ||
          imageDataUrl.length > 2_500_000
        ) {
          return Response.json(
            { error: "Invalid image or image is too large." },
            { status: 400, headers: corsHeaders }
          );
        }

        const lastUserIndex = messages.map(item => item.role).lastIndexOf("user");
        if (lastUserIndex < 0) {
          return Response.json(
            { error: "An image must be sent with a user message." },
            { status: 400, headers: corsHeaders }
          );
        }

        const imagePrompt = messages[lastUserIndex].content;
        messages[lastUserIndex] = {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
            { type: "text", text: imagePrompt }
          ]
        };
      }

      const result = await env.AI.run(MODEL, {
        messages,
        max_tokens: 2048
      });

      const reply =
        result.choices?.[0]?.message?.content ||
        result.response ||
        "No response generated.";

      return Response.json({ reply }, { headers: corsHeaders });
    } catch (error) {
      if (error.message === "REQUEST_TOO_LARGE") {
        return Response.json(
          { error: "Request is too large." },
          { status: 413, headers: corsHeaders }
        );
      }

      if (error.message === "INVALID_JSON") {
        return Response.json(
          { error: "Invalid JSON request." },
          { status: 400, headers: corsHeaders }
        );
      }

      // Keep internal exception details out of public API responses.
      return Response.json(
        { error: "AI service temporarily unavailable. Please try again." },
        { status: 503, headers: corsHeaders }
      );
    }
  }
};
