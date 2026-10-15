(function () {
  const statusUrl = '/api/ai/status';
  const generateUrl = '/api/ai/generate';
  const WORKER_HEADER = 'x-lakshmi-ai';

  const NOT_WORKER_MESSAGE =
    'This page is not being served by the Cloudflare Worker, so the AI endpoint does not exist here. ' +
    'Run "npx wrangler deploy" (or "npx wrangler dev") and open that Worker URL.';
  const BLOCKED_MESSAGE =
    'The AI request was blocked (HTTP 403) before it reached the Worker. Open the editor from your deployed ' +
    'Cloudflare Worker URL and make sure no Access policy, WAF rule or bot protection blocks /api/*.';

  // Errors written by worker.js always carry the X-Lakshmi-AI header and a JSON "error" string.
  // Anything else came from the hosting layer, so it gets a diagnosis instead of a bare status code.
  async function describeFailure(response) {
    const text = await response.text().catch(() => '');
    let message = '';
    try {
      const body = JSON.parse(text);
      if (body && typeof body.error === 'string') message = body.error;
    } catch {
      // Non-JSON body: typically an HTML error page from the host or a proxy.
    }
    if (message && response.headers.has(WORKER_HEADER)) return message;
    if (response.status === 403) return BLOCKED_MESSAGE;
    if ([404, 405, 501].includes(response.status)) return NOT_WORKER_MESSAGE;
    return message || `AI service returned HTTP ${response.status}.`;
  }

  async function request(url, options = {}) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 120000);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: { Accept: 'application/json, image/jpeg', ...options.headers }
      });
      if (!response.ok) throw new Error(await describeFailure(response));
      return response;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('AI request timed out. Please try again.');
      if (error instanceof TypeError) {
        throw new Error('Could not reach the AI service. Start the Cloudflare Worker or check your connection.');
      }
      throw error;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  window.AIClient = Object.freeze({
    async getStatus() {
      const response = await request(statusUrl, { cache: 'no-store' });
      let data;
      try {
        data = await response.json();
      } catch {
        // A static host answering 200 with index.html lands here.
        throw new Error(NOT_WORKER_MESSAGE);
      }
      if (!response.headers.has(WORKER_HEADER)) throw new Error(NOT_WORKER_MESSAGE);
      if (!data.available && typeof data.reason === 'string') throw new Error(data.reason);
      return data;
    },
    async generate(prompt) {
      const response = await request(generateUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt })
      });
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.toLowerCase().startsWith('image/jpeg')) {
        throw new Error('AI service returned an unsupported image format.');
      }
      return response.blob();
    }
  });
})();