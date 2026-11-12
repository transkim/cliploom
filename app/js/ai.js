/*
 * AI with the user's own keys: Claude (Anthropic), ChatGPT (OpenAI) and Gemini (Google).
 * Keys are typed in AI settings and kept in this device's storage only.
 *
 * Endpoints, model ids and request shapes were checked against each provider's docs on 2026-11-12:
 *  - Claude: Messages API (text only; Claude does not make pictures, video or speech).
 *  - OpenAI: chat completions, images/generations (gpt-image-2.6), audio/speech, audio/transcriptions (whisper-1).
 *    OpenAI removed the Sora video API on 2026-09-24, so video comes from Gemini.
 *  - Gemini: Interactions API (text, Nano Banana images, Omni Flash video, TTS, audio understanding).
 * Model ids move fast, so every one can be changed in AI settings.
 */
(function (root) {
  const Store = root.Store, Platform = root.Platform;

  const PROVIDERS = {
    claude: { name: 'Claude', by: 'Anthropic', keyUrl: 'https://platform.claude.com/settings/keys', can: ['text'] },
    openai: { name: 'ChatGPT', by: 'OpenAI', keyUrl: 'https://platform.openai.com/api-keys', can: ['text', 'image', 'speech', 'transcribe'] },
    gemini: { name: 'Gemini', by: 'Google', keyUrl: 'https://aistudio.google.com/apikey', can: ['text', 'image', 'video', 'speech', 'transcribe'] },
  };
  const DEFAULT_MODELS = {
    'claude.text': 'claude-opus-5-5',
    'openai.text': 'gpt-6-luna', 'openai.image': 'gpt-image-2.6-flare', 'openai.speech': 'gpt-4o-mini-tts', 'openai.transcribe': 'whisper-1',
    'gemini.text': 'gemini-3.8-flash', 'gemini.image': 'gemini-nano-banana-2.1', 'gemini.video': 'gemini-omni-1.1-flash',
    'gemini.speech': 'gemini-3.8-flash-tts', 'gemini.transcribe': 'gemini-3.8-flash',
  };
  const VOICES = {
    openai: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse', 'marin', 'cedar'],
    gemini: ['Kore', 'Puck', 'Charon', 'Zephyr', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'],
  };
  const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
  const GEMINI_REV = '2026-05-20';

  let cfg = null;
  async function settings() {
    if (!cfg) cfg = (await Store.getKV('ai').catch(() => null)) || { keys: {}, models: {}, pick: {} };
    cfg.keys = cfg.keys || {}; cfg.models = cfg.models || {}; cfg.pick = cfg.pick || {};
    return cfg;
  }
  async function save(next) { cfg = Object.assign(await settings(), next); await Store.setKV('ai', cfg); return cfg; }
  const model = (prov, task) => (cfg && cfg.models[prov + '.' + task]) || DEFAULT_MODELS[prov + '.' + task];
  function key(prov) {
    const k = cfg && cfg.keys[prov];
    if (!k) throw new Error('Add your ' + PROVIDERS[prov].name + ' key in AI settings first.');
    return k;
  }
  /** Providers that have a key and can do this task, in a stable order. */
  async function ready(task) { await settings(); return Object.keys(PROVIDERS).filter((p) => PROVIDERS[p].can.includes(task) && cfg.keys[p]); }
  /** The provider the user last used for a task (if it still has a key), else the first ready one. */
  async function preferred(task) { const r = await ready(task); return r.includes(cfg.pick[task]) ? cfg.pick[task] : r[0] || null; }
  async function remember(task, prov) { await settings(); cfg.pick[task] = prov; await Store.setKV('ai', cfg); }

  function errText(r, who) {
    const d = r.data;
    const m = d && ((d.error && (d.error.message || d.error)) || d.message);
    if (r.status === 401 || r.status === 403) return who + ' did not accept the key (' + r.status + '). Check it in AI settings.' + (m ? ' ' + m : '');
    if (r.status === 429) return who + ' says you are over your limit or out of credit (429).' + (m ? ' ' + m : '');
    return who + ' error ' + r.status + (m ? ': ' + (typeof m === 'string' ? m : JSON.stringify(m)) : r.text ? ': ' + r.text.slice(0, 200) : '');
  }
  async function call(who, req) {
    const r = await Platform.http(req);
    if (!r.ok) throw new Error(errText(r, who));
    return r;
  }
  function b64ToBlob(b64, type) {
    const bin = atob(b64); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: type || '' });
  }
  function blobToB64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Pull JSON out of a model reply (handles ```json fences and chatter around it). */
  function parseJson(text) {
    const t = String(text || '').trim();
    try { return JSON.parse(t); } catch (_) { /* look inside */ }
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) { try { return JSON.parse(fence[1]); } catch (_) { /* go on */ } }
    const a = t.search(/[[{]/);
    if (a >= 0) {
      const close = t[a] === '[' ? ']' : '}';
      const b = t.lastIndexOf(close);
      if (b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (_) { /* give up */ } }
    }
    throw new Error('The AI answer was not in the expected format. Try again.');
  }

  // ---------- Gemini Interactions API ----------
  const gHeaders = () => ({ 'x-goog-api-key': key('gemini'), 'Api-Revision': GEMINI_REV });
  async function geminiInteract(body, onWait) {
    let r = await call('Gemini', { url: GEMINI + '/interactions', json: body, headers: gHeaders() });
    let d = r.data || {};
    // long jobs can come back unfinished: poll until done
    for (let i = 0; d.id && d.status && /progress|queued|running|pending/i.test(d.status) && i < 180; i++) {
      if (onWait) onWait(i);
      await sleep(5000);
      r = await call('Gemini', { url: GEMINI + '/' + (String(d.id).startsWith('interactions/') ? d.id : 'interactions/' + d.id), headers: gHeaders() });
      d = r.data || {};
    }
    if (d.status && /fail|cancel/i.test(d.status)) throw new Error('Gemini could not finish: ' + ((d.error && d.error.message) || d.status));
    return d;
  }
  function geminiBlocks(d, type) {
    const out = [];
    for (const s of d.steps || []) if (s.type === 'model_output') for (const c of s.content || []) if (c.type === type) out.push(c);
    return out;
  }
  function geminiText(d) {
    const t = geminiBlocks(d, 'text').map((c) => c.text).join('');
    if (t) return t;
    if (typeof d.output_text === 'string') return d.output_text;
    throw new Error('Gemini sent an empty answer. Try again, or rephrase.');
  }
  async function geminiMedia(d, type, mime) {
    const b = geminiBlocks(d, type).pop();
    if (!b) throw new Error('Gemini did not return a ' + type + '. It may have declined the prompt; try rewording it.');
    if (b.data) return b64ToBlob(b.data, b.mime_type || mime);
    if (b.uri) {
      const id = String(b.uri).split('/').pop();
      for (let i = 0; i < 60; i++) {
        const f = await call('Gemini', { url: GEMINI + '/files/' + id, headers: gHeaders() });
        if (!f.data || !f.data.state || f.data.state === 'ACTIVE') break;
        if (f.data.state === 'FAILED') throw new Error('Gemini could not prepare the file.');
        await sleep(3000);
      }
      const r = await call('Gemini', { url: GEMINI + '/files/' + id + ':download?alt=media', headers: gHeaders(), binary: true });
      return r.blob.type ? r.blob : new Blob([r.blob], { type: mime });
    }
    throw new Error('Gemini returned no data.');
  }

  // ---------- text ----------
  /** text(provider, prompt, { system, json }) -> string (or parsed JSON when json: true) */
  async function text(prov, prompt, o) {
    o = o || {};
    await settings();
    const system = (o.system || '') + (o.json ? '\nReply with JSON only, no other text.' : '');
    let out;
    if (prov === 'claude') {
      const r = await call('Claude', {
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          'x-api-key': key('claude'), 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true',
          'anthropic-beta': 'server-side-fallback-2026-07-01',
        },
        json: {
          model: model('claude', 'text'), max_tokens: 16000,
          output_config: { effort: 'low' },
          fallbacks: 'default',
          system: system.trim() || undefined,
          messages: [{ role: 'user', content: prompt }],
        },
      });
      const d = r.data || {};
      if (d.stop_reason === 'refusal') throw new Error('Claude declined this request. Try rewording it.');
      out = (d.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    } else if (prov === 'openai') {
      const msgs = [];
      if (system.trim()) msgs.push({ role: 'system', content: system.trim() });
      msgs.push({ role: 'user', content: prompt });
      const r = await call('ChatGPT', { url: 'https://api.openai.com/v1/chat/completions', headers: { Authorization: 'Bearer ' + key('openai') }, json: { model: model('openai', 'text'), messages: msgs } });
      const c = r.data && r.data.choices && r.data.choices[0];
      out = (c && c.message && c.message.content) || '';
    } else if (prov === 'gemini') {
      const body = { model: model('gemini', 'text'), input: prompt };
      if (system.trim()) body.system_instruction = system.trim();
      if (o.json) body.response_format = { type: 'text', mime_type: 'application/json' };
      out = geminiText(await geminiInteract(body));
    } else throw new Error('Pick an AI first.');
    if (!out) throw new Error('The AI sent an empty answer. Try again.');
    return o.json ? parseJson(out) : out.trim();
  }

  // ---------- pictures ----------
  /** OpenAI image sizes: both sides divisible by 16, ratio within 1:3..3:1. */
  const OPENAI_SIZE = { '9:16': '1024x1824', '16:9': '1824x1024', '1:1': '1024x1024', '4:5': '1024x1280', '3:4': '1024x1360', '21:9': '2048x880' };
  async function image(prov, prompt, o) {
    o = o || {};
    await settings();
    if (prov === 'openai') {
      const r = await call('ChatGPT', {
        url: 'https://api.openai.com/v1/images/generations', headers: { Authorization: 'Bearer ' + key('openai') },
        json: { model: model('openai', 'image'), prompt, size: OPENAI_SIZE[o.aspect] || '1024x1024', quality: o.quality || 'medium', n: 1 },
      });
      const im = r.data && r.data.data && r.data.data[0];
      if (!im || !im.b64_json) throw new Error('ChatGPT returned no picture.');
      return b64ToBlob(im.b64_json, 'image/png');
    }
    if (prov === 'gemini') {
      const input = [{ type: 'text', text: prompt + (o.aspect ? ' (aspect ratio ' + o.aspect + ')' : '') }];
      if (o.image) input.push({ type: 'image', mime_type: o.image.type || 'image/jpeg', data: await blobToB64(o.image) });
      const fmt = { type: 'image', image_size: '1K' };
      if (o.aspect) fmt.aspect_ratio = o.aspect;
      let d;
      try { d = await geminiInteract({ model: model('gemini', 'image'), input, response_format: fmt }); } catch (e) {
        if (!/aspect/i.test(e.message)) throw e;
        delete fmt.aspect_ratio; // this model does not offer that shape: ask in words instead
        d = await geminiInteract({ model: model('gemini', 'image'), input, response_format: fmt });
      }
      return geminiMedia(d, 'image', 'image/png');
    }
    throw new Error(PROVIDERS[prov] ? PROVIDERS[prov].name + ' does not make pictures. Pick ChatGPT or Gemini.' : 'Pick an AI first.');
  }

  // ---------- video ----------
  /** video('gemini', prompt, { aspect '9:16'|'16:9', resolution, image (Blob, first frame), onWait }) -> Blob (mp4) */
  async function video(prov, prompt, o) {
    o = o || {};
    await settings();
    if (prov !== 'gemini') throw new Error('Only Gemini makes video right now (OpenAI shut down its Sora video API in September 2026).');
    const input = o.image ? [{ type: 'text', text: prompt }, { type: 'image', mime_type: o.image.type || 'image/jpeg', data: await blobToB64(o.image) }] : prompt;
    const d = await geminiInteract({
      model: model('gemini', 'video'), input,
      response_format: { type: 'video', aspect_ratio: o.aspect === '16:9' ? '16:9' : '9:16', resolution: o.resolution || '720p' },
    }, o.onWait);
    return geminiMedia(d, 'video', 'video/mp4');
  }

  // ---------- speech ----------
  async function speech(prov, words, o) {
    o = o || {};
    await settings();
    if (prov === 'openai') {
      const body = { model: model('openai', 'speech'), input: String(words).slice(0, 4096), voice: o.voice || 'coral', response_format: 'mp3' };
      if (o.style && !/^tts-1/.test(body.model)) body.instructions = o.style;
      const r = await call('ChatGPT', { url: 'https://api.openai.com/v1/audio/speech', headers: { Authorization: 'Bearer ' + key('openai') }, json: body, binary: true });
      return r.blob.type ? r.blob : new Blob([r.blob], { type: 'audio/mpeg' });
    }
    if (prov === 'gemini') {
      const block = { type: 'text', text: String(words) };
      if (o.style) block.annotations = [{ type: 'speech_metadata', style: o.style }];
      const d = await geminiInteract({
        model: model('gemini', 'speech'),
        input: [{ type: 'user_input', content: [block] }],
        response_format: { type: 'audio', mime_type: 'audio/wav' },
        generation_config: { speech_config: [{ voice: o.voice || 'Kore' }] },
      });
      return geminiMedia(d, 'audio', 'audio/wav');
    }
    throw new Error(PROVIDERS[prov] ? PROVIDERS[prov].name + ' does not make voices. Pick ChatGPT or Gemini.' : 'Pick an AI first.');
  }

  // ---------- speech to text ----------
  /** transcribe(provider, wavBlob, { language }) -> [{ start, end, text }] in seconds */
  async function transcribe(prov, wav, o) {
    o = o || {};
    await settings();
    if (prov === 'openai') {
      const fd = new FormData();
      fd.append('file', wav, 'audio.wav');
      fd.append('model', model('openai', 'transcribe'));
      fd.append('response_format', 'verbose_json');
      fd.append('timestamp_granularities[]', 'segment');
      if (o.language) fd.append('language', o.language);
      const r = await call('ChatGPT', { url: 'https://api.openai.com/v1/audio/transcriptions', headers: { Authorization: 'Bearer ' + key('openai') }, form: fd });
      const segs = (r.data && r.data.segments) || [];
      if (!segs.length && r.data && r.data.text) return [{ start: 0, end: (r.data.duration || 3), text: r.data.text }];
      return segs.map((s) => ({ start: +s.start || 0, end: +s.end || 0, text: String(s.text || '').trim() })).filter((s) => s.text);
    }
    if (prov === 'gemini') {
      const ask = 'Transcribe the speech in this audio as short caption lines of at most about 8 words each. '
        + 'Give each line its start and end time in seconds from the beginning of the audio (decimals allowed). '
        + (o.language ? 'The speech is in ' + o.language + '. ' : 'Keep the language that is spoken. ')
        + 'Return a JSON array like [{"start":0.0,"end":1.8,"text":"..."}]. If nobody speaks, return [].';
      const d = await geminiInteract({
        model: model('gemini', 'transcribe'),
        input: [{ type: 'text', text: ask }, { type: 'audio', mime_type: 'audio/wav', data: await blobToB64(wav) }],
        response_format: {
          type: 'text', mime_type: 'application/json',
          schema: { type: 'array', items: { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' }, text: { type: 'string' } }, required: ['start', 'end', 'text'] } },
        },
      });
      const arr = parseJson(geminiText(d));
      return (Array.isArray(arr) ? arr : []).map((s) => ({ start: +s.start || 0, end: +s.end || 0, text: String(s.text || '').trim() })).filter((s) => s.text);
    }
    throw new Error(PROVIDERS[prov] ? PROVIDERS[prov].name + ' cannot listen to audio. Pick ChatGPT or Gemini.' : 'Pick an AI first.');
  }

  /** Quick key check with the cheapest call each provider has. */
  async function test(prov) {
    const reply = await text(prov, 'Reply with the single word: ready');
    return reply.slice(0, 40);
  }

  root.AI = { PROVIDERS, DEFAULT_MODELS, VOICES, settings, save, ready, preferred, remember, text, image, video, speech, transcribe, test, parseJson, model };
})(window);
