const ALLOWED_ORIGIN = "https://f4rhan77.github.io";
const SUPABASE_URL = "https://hrtbmmahyxrwppynbrvr.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_v3hYBvWWXkmBltBt_JcWlg_Yjn61UY8";

function corsHeadersFor(origin) {
  return {
    "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "null",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Expose-Headers": "X-Image-Author, X-Image-License, X-Image-Source, X-Image-Provider",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

async function authenticateRequest(request) {
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return null;
  try {
    const response = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: {
        "apikey": SUPABASE_PUBLISHABLE_KEY,
        "Authorization": authorization
      }
    });
    if (!response.ok) return null;
    const user = await response.json();
    return user && typeof user.id === "string" ? user : null;
  } catch {
    return null;
  }
}

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

async function fetchImageBytes(url) {
  try {
    const parsed=new URL(url);
    const host=parsed.hostname.toLowerCase();
    if (!(host==="upload.wikimedia.org" || host==="images.openverse.org")) return null;
    const response=await fetch(parsed.toString(),{headers:{"User-Agent":"NEXUSAI/1.0 (educational presentation image search)"}});
    if(!response.ok) return null;
    const type=(response.headers.get("Content-Type") || "").split(";")[0].toLowerCase();
    if(!["image/jpeg","image/png"].includes(type)) return null;
    const length=Number(response.headers.get("Content-Length") || 0);
    if(length>8_000_000) return null;
    const bytes=await response.arrayBuffer();
    if(bytes.byteLength>8_000_000) return null;
    return {bytes,type};
  } catch { return null; }
}

async function findRealPhoto(query) {
  const terms=String(query || "").replace(/[^a-z0-9 -]/gi," ").replace(/\s+/g," ").trim().slice(0,120);
  if(!terms) return null;
  try {
    const endpoint="https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch="+encodeURIComponent(terms)+"&gsrnamespace=6&gsrlimit=8&prop=imageinfo&iiprop=url%7Cextmetadata&iiurlwidth=1400&format=json&origin=*";
    const response=await fetch(endpoint,{headers:{"User-Agent":"NEXUSAI/1.0 (educational presentation image search)"}});
    if(response.ok) {
      const data=await response.json();
      const pages=Object.values(data.query?.pages || {});
      for(const page of pages) {
        const info=page.imageinfo?.[0]; if(!info) continue;
        const found=await fetchImageBytes(info.thumburl || info.url);
        if(!found) continue;
        const meta=info.extmetadata || {};
        return {...found,author:String(meta.Artist?.value || "Wikimedia contributor").replace(/<[^>]*>/g,"").slice(0,180),license:String(meta.LicenseShortName?.value || "Wikimedia Commons license").replace(/<[^>]*>/g,"").slice(0,80),source:info.descriptionurl || "",provider:"Wikimedia Commons"};
      }
    }
  } catch {}
  try {
    const endpoint="https://api.openverse.org/v1/images/?q="+encodeURIComponent(terms)+"&page_size=12&extension=jpg%2Cpng&mature=false";
    const response=await fetch(endpoint);
    if(response.ok) {
      const data=await response.json();
      const results=Array.isArray(data.results)?data.results:[];
      for(const item of results) {
        const found=await fetchImageBytes(item.thumbnail || item.url);
        if(!found) continue;
        return {...found,author:String(item.creator || "Unknown creator").slice(0,180),license:String(item.license || "Creative Commons").slice(0,80),source:item.foreign_landing_url || item.detail_url || "",provider:"Openverse"};
      }
    }
  } catch {}
  return null;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const corsHeaders = corsHeadersFor(origin);
    if (origin && origin !== ALLOWED_ORIGIN) {
      return new Response("Origin not allowed", { status: 403, headers: corsHeaders });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const requestUrl = new URL(request.url);
    if (request.method === "GET" && requestUrl.pathname === "/image-search") {
      const ip = request.headers.get("CF-Connecting-IP");
      const query = requestUrl.searchParams.get("q") || "";
      if (!ip || !query.trim() || query.length > 120) {
        return new Response("Invalid image search request", { status: 400, headers: corsHeaders });
      }
      const user = await authenticateRequest(request);
      if (!user) return new Response("Authentication required", { status: 401, headers: corsHeaders });
      if (!env.MY_RATE_LIMITER) return new Response("Service temporarily unavailable", { status: 503, headers: corsHeaders });
      const rate = await env.MY_RATE_LIMITER.limit({ key: "image:" + ip });
      if (!rate.success) return new Response("Too many image requests. Try again later.", { status: 429, headers: { ...corsHeaders, "Retry-After": "60" } });
      const image = await findRealPhoto(query);
      if (!image) {
        return new Response("No suitable real photo found", { status: 404, headers: corsHeaders });
      }
      return new Response(image.bytes, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": image.type,
          "Cache-Control": "public, max-age=86400",
          "X-Image-Author": image.author,
          "X-Image-License": image.license,
          "X-Image-Source": image.source,
          "X-Image-Provider": image.provider
        }
      });
    }

    if (request.method !== "POST") {
      return Response.json(
        { error: "Method not allowed" },
        { status: 405, headers: corsHeaders }
      );
    }

    const user = await authenticateRequest(request);
    if (!user) {
      return Response.json({ error: "Please sign in to use NEXUS AI." }, { status: 401, headers: corsHeaders });
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

      const stream = await env.AI.run(MODEL, {
        messages,
        max_tokens: 2048,
        stream: true
      });

      return new Response(stream, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no"
        }
      });
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
