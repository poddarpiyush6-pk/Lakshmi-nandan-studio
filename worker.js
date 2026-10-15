const MODEL = '@cf/black-forest-labs/flux-1-schnell';
const MAX_BODY_BYTES = 12288;
const MAX_PROMPT_LENGTH = 2048;

// X-Lakshmi-AI lets the browser tell Worker replies apart from errors injected by a host or firewall.
const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Lakshmi-AI': 'worker'
};

function jsonResponse(body, status = 200) {
  return Response.json(body, { status, headers: BASE_HEADERS });
}

function sameOrigin(request) {
  // Browsers set Sec-Fetch-Site themselves; it stays correct behind custom domains and proxies.
  const site = request.headers.get('Sec-Fetch-Site');
  if (site) return site === 'same-origin';
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function decodeBase64Image(encoded) {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/ai/status' && request.method === 'GET') {
      const missing = [];
      if (!env.AI || typeof env.AI.run !== 'function') missing.push('the Workers AI binding "AI"');
      if (!env.AI_RATE_LIMITER || typeof env.AI_RATE_LIMITER.limit !== 'function') {
        missing.push('the rate-limit binding "AI_RATE_LIMITER"');
      }
      return jsonResponse({
        available: missing.length === 0,
        model: MODEL,
        reason: missing.length ? `Worker is running but is missing ${missing.join(' and ')}. Add it in wrangler.toml and redeploy.` : undefined
      });
    }

    if (url.pathname === '/api/ai/generate') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Use POST to generate an image.' }, 405);
      }
      if (!sameOrigin(request)) {
        return jsonResponse({ error: 'Requests must come from this editor origin.' }, 403);
      }
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
        return jsonResponse({ error: 'Send a JSON request body.' }, 415);
      }
      const declaredLength = Number(request.headers.get('content-length') || 0);
      if (declaredLength > MAX_BODY_BYTES) {
        return jsonResponse({ error: 'Request body is too large.' }, 413);
      }
      if (!env.AI_RATE_LIMITER || typeof env.AI_RATE_LIMITER.limit !== 'function') {
        return jsonResponse({ error: 'AI rate limiting is not configured for this deployment.' }, 503);
      }
      const clientIp = request.headers.get('CF-Connecting-IP');
      if (!clientIp) {
        return jsonResponse({ error: 'Client address could not be verified.' }, 400);
      }
      let rateLimitResult;
      try {
        rateLimitResult = await env.AI_RATE_LIMITER.limit({ key: clientIp });
      } catch (error) {
        console.error('AI rate limiter is unavailable.', error);
        return jsonResponse({ error: 'AI rate limiting is temporarily unavailable.' }, 503);
      }
      const { success } = rateLimitResult;
      if (!success) {
        return new Response(JSON.stringify({ error: 'AI request limit reached. Please wait a minute and try again.' }), {
          status: 429,
          headers: { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '60' }
        });
      }
      if (!env.AI || typeof env.AI.run !== 'function') {
        return jsonResponse({ error: 'Workers AI is not bound to this deployment.' }, 503);
      }

      let payload;
      try {
        const body = await request.text();
        if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
          return jsonResponse({ error: 'Request body is too large.' }, 413);
        }
        payload = JSON.parse(body);
      } catch {
        return jsonResponse({ error: 'Request body must contain valid JSON.' }, 400);
      }

      const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
      if (!prompt || prompt.length > MAX_PROMPT_LENGTH) {
        return jsonResponse({ error: `Prompt must contain 1 to ${MAX_PROMPT_LENGTH} characters.` }, 400);
      }

      try {
        const result = await env.AI.run(MODEL, { prompt, steps: 4 });
        if (!result || typeof result.image !== 'string' || !result.image) {
          console.error('Workers AI returned no image for the configured text-to-image model.');
          return jsonResponse({ error: 'AI provider returned no image. Please try again.' }, 502);
        }
        const bytes = decodeBase64Image(result.image);
        return new Response(bytes, { headers: { ...BASE_HEADERS, 'Content-Type': 'image/jpeg' } });
      } catch (error) {
        console.error('Workers AI image generation failed.', error);
        return jsonResponse({ error: 'Cloudflare Workers AI could not complete the request.' }, 502);
      }
    }

    if (url.pathname.startsWith('/api/')) {
      return jsonResponse({ error: 'API endpoint not found.' }, 404);
    }
    if (!env.ASSETS) {
      return new Response('Static assets binding "ASSETS" is not configured.', { status: 500 });
    }
    const assetResponse = await env.ASSETS.fetch(request);
    const headers = new Headers(assetResponse.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    return new Response(assetResponse.body, {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers
    });
  }
};