const ALLOWED_ORIGINS = new Set([
  'https://l1.mbfdhub.com',
  'https://l1-compartment-builder.pages.dev',
  'http://127.0.0.1:4173',
  'http://localhost:4173',
]);
const MAX_STATE_BYTES = 1_000_000;
const MAX_IMAGES_BYTES = 12_000_000;
const MAX_AI_BYTES = 200_000;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isShortString = (value, max = 500) => typeof value === 'string' && value.length <= max;

export function getCorsHeaders(origin = '') {
  const isPagesPreview = /^https:\/\/[a-z0-9-]+\.l1-compartment-builder\.pages\.dev$/i.test(origin);
  const allowedOrigin = ALLOWED_ORIGINS.has(origin) || isPagesPreview ? origin : undefined;
  return {
    ...(allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin, Vary: 'Origin' } : {}),
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
}

export function validateStatePayload(payload) {
  if (!isObject(payload) || !isObject(payload.allocations)) {
    return { ok: false, error: 'allocations must be an object' };
  }
  for (const [compartment, slots] of Object.entries(payload.allocations)) {
    if (!isShortString(compartment, 50) || !Array.isArray(slots) || slots.length > 500) {
      return { ok: false, error: 'invalid compartment allocation' };
    }
    if (!slots.every(slot => isShortString(slot, 300))) {
      return { ok: false, error: 'invalid equipment name' };
    }
  }
  if (payload.customTools !== undefined && (
    !Array.isArray(payload.customTools) ||
    payload.customTools.length > 500 ||
    !payload.customTools.every(tool =>
      isObject(tool) &&
      isShortString(tool.name, 300) &&
      Number.isInteger(tool.qty) &&
      tool.qty >= 0 &&
      tool.qty <= 10_000 &&
      (tool.dimensions === undefined || isShortString(tool.dimensions, 500))
    )
  )) return { ok: false, error: 'invalid custom tools' };
  if (payload.customQtys !== undefined && (
    !isObject(payload.customQtys) ||
    !Object.entries(payload.customQtys).every(([name, qty]) =>
      isShortString(name, 300) &&
      Number.isInteger(qty) &&
      qty >= 0 &&
      qty <= 10_000
    )
  )) return { ok: false, error: 'invalid custom quantities' };
  if (payload.customDimensions !== undefined && (
    !isObject(payload.customDimensions) ||
    !Object.entries(payload.customDimensions).every(([name, dimensions]) =>
      isShortString(name, 300) && isShortString(dimensions, 500)
    )
  )) return { ok: false, error: 'invalid custom dimensions' };
  if (payload.bundles !== undefined) {
    if (!isObject(payload.bundles)) return { ok: false, error: 'bundles must be an object' };
    for (const [compartment, bundles] of Object.entries(payload.bundles)) {
      if (!isShortString(compartment, 50) || !Array.isArray(bundles) || bundles.length > 500) {
        return { ok: false, error: 'invalid bundle collection' };
      }
      const valid = bundles.every(bundle =>
        isObject(bundle) &&
        isShortString(bundle.id, 100) &&
        bundle.id.length > 0 &&
        isShortString(bundle.name, 300) &&
        bundle.name.length > 0 &&
        Number.isInteger(bundle.colorIdx) &&
        bundle.colorIdx >= 0 &&
        bundle.colorIdx <= 100 &&
        Array.isArray(bundle.slotIndices) &&
        bundle.slotIndices.length <= 500 &&
        bundle.slotIndices.every(index => Number.isInteger(index) && index >= 0 && index < 500)
      );
      if (!valid) return { ok: false, error: 'invalid bundle' };
    }
  }
  if (payload.removedItems !== undefined && (
    !Array.isArray(payload.removedItems) ||
    payload.removedItems.length > 500 ||
    !payload.removedItems.every(item => isShortString(item, 300))
  )) return { ok: false, error: 'invalid removed items' };
  return { ok: true };
}

export function validateImagesPayload(payload) {
  if (!isObject(payload) || !isObject(payload.uploadedImages) || !isObject(payload.featuredImages)) {
    return { ok: false, error: 'uploadedImages and featuredImages must be objects' };
  }
  for (const [compartment, images] of Object.entries(payload.uploadedImages)) {
    if (!isShortString(compartment, 50) || !Array.isArray(images) || images.length > 50) {
      return { ok: false, error: 'invalid image collection' };
    }
    for (const image of images) {
      if (
        !isObject(image) ||
        !isShortString(image.uid, 100) ||
        image.uid.length === 0 ||
        !isShortString(image.dataUrl, 5_000_000) ||
        !/^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/=]+$/i.test(image.dataUrl) ||
        (image.title !== undefined && !isShortString(image.title, 300)) ||
        (image.fileName !== undefined && !isShortString(image.fileName, 300))
      ) return { ok: false, error: 'invalid image' };
    }
  }
  for (const [compartment, featured] of Object.entries(payload.featuredImages)) {
    if (!isShortString(compartment, 50) || !isObject(featured)) {
      return { ok: false, error: 'invalid featured image' };
    }
    const validPreset = featured.kind === 'preset' &&
      isShortString(featured.src, 500) &&
      /^\/images\/[a-z0-9_.-]+\.(?:png|jpe?g|webp)$/i.test(featured.src);
    const validUpload = featured.kind === 'uploaded' &&
      isShortString(featured.uid, 100) &&
      featured.uid.length > 0;
    if (!validPreset && !validUpload) return { ok: false, error: 'invalid featured image' };
  }
  return { ok: true };
}

async function readJson(request, maxBytes) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > maxBytes) throw new Error('PAYLOAD_TOO_LARGE');
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error('PAYLOAD_TOO_LARGE');
  try {
    return { text, parsed: JSON.parse(text) };
  } catch {
    throw new Error('INVALID_JSON');
  }
}

const jsonResponse = (body, status, headers) => new Response(JSON.stringify(body), {
  status,
  headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
});

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') ?? '';
    const cors = getCorsHeaders(origin);
    const isMutation = ['PUT', 'POST', 'PATCH', 'DELETE'].includes(request.method);
    if ((origin && !cors['Access-Control-Allow-Origin']) || (isMutation && !cors['Access-Control-Allow-Origin'])) {
      return jsonResponse({ error: 'Origin not allowed' }, 403, cors);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    // ── /state — main allocation state ──────────────────────────────────────
    if (url.pathname === '/state') {
      if (request.method === 'GET') {
        const val = await env.L1_STATE.get('allocations', { type: 'text' });
        return new Response(val ?? 'null', {
          headers: {
            ...cors,
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          },
        });
      }

      if (request.method === 'PUT') {
        let body;
        try { body = await readJson(request, MAX_STATE_BYTES); } catch (error) {
          return jsonResponse(
            { error: error.message === 'PAYLOAD_TOO_LARGE' ? 'Payload too large' : 'Invalid JSON' },
            error.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400,
            cors,
          );
        }
        const { parsed } = body;
        const validation = validateStatePayload(parsed);
        if (!validation.ok) return jsonResponse({ error: validation.error }, 400, cors);
        // Stamp with a server-side timestamp so all clients share the same clock
        const serverTs = Date.now();
        parsed._serverTs = serverTs;
        await env.L1_STATE.put('allocations', JSON.stringify(parsed));
        return new Response(JSON.stringify({ ok: true, _serverTs: serverTs }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
    }

    // ── /images — uploaded & featured image sync ─────────────────────────────
    if (url.pathname === '/images') {
      if (request.method === 'GET') {
        const val = await env.L1_STATE.get('images', { type: 'text' });
        return new Response(val ?? 'null', {
          headers: {
            ...cors,
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          },
        });
      }

      if (request.method === 'PUT') {
        let body;
        try { body = await readJson(request, MAX_IMAGES_BYTES); } catch (error) {
          return jsonResponse(
            { error: error.message === 'PAYLOAD_TOO_LARGE' ? 'Payload too large' : 'Invalid JSON' },
            error.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400,
            cors,
          );
        }
        const { parsed } = body;
        const validation = validateImagesPayload(parsed);
        if (!validation.ok) return jsonResponse({ error: validation.error }, 400, cors);
        const serverTs = Date.now();
        parsed._serverTs = serverTs;
        await env.L1_STATE.put('images', JSON.stringify(parsed));
        return new Response(JSON.stringify({ ok: true, _serverTs: serverTs }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
    }

    // ── /generate-image — AI image generation ───────────────────────────────
    if (url.pathname === '/generate-image' && request.method === 'POST') {
      try {
        const { parsed: body } = await readJson(request, MAX_AI_BYTES);
        const { compId = '', compartmentSpec = '', tools = [], userText = '' } = body;
        if (
          !isShortString(compId, 50) ||
          !isShortString(compartmentSpec, 2_000) ||
          !isShortString(userText, 1_000) ||
          !Array.isArray(tools) ||
          tools.length > 200 ||
          !tools.every(tool =>
            isObject(tool) &&
            isShortString(tool.name, 300) &&
            tool.name.length > 0 &&
            Number.isInteger(tool.qty) &&
            tool.qty >= 0 &&
            tool.qty <= 10_000 &&
            (tool.dims === undefined || isShortString(tool.dims, 500)) &&
            (tool.visual === undefined || isShortString(tool.visual, 1_000))
          )
        ) return jsonResponse({ error: 'Invalid generation request' }, 400, cors);

        const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
        const windowKey = `ai-rate:${clientIp}:${Math.floor(Date.now() / 3_600_000)}`;
        const used = Number(await env.L1_STATE.get(windowKey) || 0);
        if (used >= 5) return jsonResponse({ error: 'AI generation limit reached. Try again later.' }, 429, cors);
        await env.L1_STATE.put(windowKey, String(used + 1), { expirationTtl: 3_700 });

        // Build tool description list
        const toolLines = tools.map(t => {
          const parts = [`${t.qty}x ${t.name}`];
          if (t.dims) parts.push(`(${t.dims})`);
          if (t.visual) parts.push(`[${t.visual}]`);
          return parts.join(' ');
        });
        const toolsText = toolLines.length > 0
          ? toolLines.join('; ')
          : 'empty compartment, no tools';

        // ── Step 1: Llama engineers a Flux-2-dev prompt ──────────────────────
        const systemPrompt = `You are a specialist prompt engineer for FLUX.2 [dev], a state-of-the-art photorealistic image generation model. Your ONLY output is a single image generation prompt — no preamble, no quotes, no markdown, no bullet points. Raw prompt text only.

SCENE: The open interior of a Pierce fire apparatus compartment, viewed straight-on from outside the vehicle. This is a professional fire department equipment photograph — NOT a retail store, NOT a warehouse shelf, NOT a grocery store. Emergency vehicle storage compartment only.

MANDATORY VISUAL ELEMENTS — describe all of these naturally:
- Vivid fire-engine red powder-coated steel frame surrounding the compartment opening
- Matte black aluminum roll-up door side rails with visible track grooves on both sides
- Light gray Zolatone speckled spray-textured interior walls, ceiling, and floor (multi-tone gray speckle texture, not flat paint)
- Brushed aluminum shelf brackets, tray slide rails, and yellow webbing retention straps
- Overhead LED strip lighting casting warm light inside
- Professional studio photography lighting from the front
- All tools physically mounted on brackets, hanging from hooks, resting on shelves, or secured in trays — nothing floating

STYLE: Photorealistic product visualization, 8K detail, sharp focus, ray-traced reflections, HDR lighting, physically based rendering. Style of Pierce Manufacturing apparatus brochure photography.

HARD LIMIT: Under 900 characters total. One paragraph only. Start with the scene subject.`;

        const userPrompt = `COMPARTMENT: ${compId} — ${compartmentSpec}

TOOLS INSIDE: ${toolsText}

${userText ? `OPERATOR INSTRUCTIONS (high priority — follow exactly): ${userText}` : ''}

Write the Flux image prompt now.`;

        const llmResult = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fast', {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt },
          ],
          max_tokens: 350,
        });

        const MAX_PROMPT = 900;
        const fallback = `Photorealistic Pierce fire apparatus ${compId} compartment interior, open compartment viewed straight-on, vivid red powder-coated steel door frame, matte black roll-up door rails, light gray Zolatone speckled textured walls ceiling and floor, brushed aluminum shelf brackets and tray rails with yellow retention straps, fire department emergency equipment mounted on brackets and shelves, overhead LED strip lighting, professional studio photography lighting, 8K detail, sharp focus, physically based rendering, ray-traced reflections, HDR`;
        const rawPrompt = (llmResult.response ?? '').trim();
        const visualPrompt = (rawPrompt.length > 30 ? rawPrompt : fallback).slice(0, MAX_PROMPT);

        // ── Step 2: FLUX.2 [dev] ─────────────────────────────────────────────
        const form = new FormData();
        form.append('prompt', visualPrompt);
        form.append('width', '1024');
        form.append('height', '1024');
        form.append('steps', '25');

        const formResponse = new Response(form);
        const imgResult = await env.AI.run('@cf/black-forest-labs/flux-2-dev', {
          multipart: {
            body: formResponse.body,
            contentType: formResponse.headers.get('content-type'),
          },
        });

        if (!imgResult) throw new Error('FLUX.2 dev returned no output');

        let base64;
        if (typeof imgResult.image === 'string' && imgResult.image.length > 0) {
          base64 = imgResult.image;
        } else if (imgResult instanceof ArrayBuffer && imgResult.byteLength > 0) {
          const bytes = new Uint8Array(imgResult);
          let binary = '';
          for (let i = 0; i < bytes.length; i += 8192) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          }
          base64 = btoa(binary);
        } else {
          const ab = await new Response(imgResult).arrayBuffer();
          if (!ab || ab.byteLength === 0) throw new Error('FLUX.2 dev returned empty image data');
          const bytes = new Uint8Array(ab);
          let binary = '';
          for (let i = 0; i < bytes.length; i += 8192) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          }
          base64 = btoa(binary);
        }

        return new Response(
          JSON.stringify({ dataUrl: `data:image/png;base64,${base64}`, prompt: visualPrompt }),
          { headers: { ...cors, 'Content-Type': 'application/json' } }
        );
      } catch (err) {
        const status = err?.message === 'PAYLOAD_TOO_LARGE' ? 413 : err?.message === 'INVALID_JSON' ? 400 : 500;
        return new Response(
          JSON.stringify({ error: status === 500 ? 'AI generation failed' : status === 413 ? 'Payload too large' : 'Invalid JSON' }),
          { status, headers: { ...cors, 'Content-Type': 'application/json' } }
        );
      }
    }

    return new Response('{"error":"Not found"}', { status: 404, headers: cors });
  },
};
