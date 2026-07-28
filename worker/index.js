export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

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
        const body = await request.text();
        let parsed;
        try { parsed = JSON.parse(body); } catch {
          return new Response('{"error":"Invalid JSON"}', { status: 400, headers: cors });
        }
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
        const body = await request.text();
        let parsed;
        try { parsed = JSON.parse(body); } catch {
          return new Response('{"error":"Invalid JSON"}', { status: 400, headers: cors });
        }
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
        const body = await request.json();
        const { compId = '', compartmentSpec = '', tools = [], userText = '' } = body;

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
        return new Response(
          JSON.stringify({ error: err.message ?? 'AI generation failed' }),
          { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } }
        );
      }
    }

    return new Response('{"error":"Not found"}', { status: 404, headers: cors });
  },
};
