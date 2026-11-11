/*
 * Sound sources that need no network: ZIP reading (TikTok "Download your data"),
 * finding your own posts in that export, and WAV encoding of extracted audio.
 * Pure functions, also used by the Node tests.
 */
(function (root) {
  // ---------- ZIP (stored + deflate), enough for TikTok's export ----------
  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** readZip(ArrayBuffer|Uint8Array) -> [{ name, size, read: async () => Uint8Array }] */
  function readZip(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('This is not a ZIP file.');
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const out = [];
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true);
      const csize = dv.getUint32(off + 20, true);
      const usize = dv.getUint32(off + 24, true);
      const nlen = dv.getUint16(off + 28, true), xlen = dv.getUint16(off + 30, true), clen = dv.getUint16(off + 32, true);
      const local = dv.getUint32(off + 42, true);
      const name = dec.decode(u8.subarray(off + 46, off + 46 + nlen));
      off += 46 + nlen + xlen + clen;
      if (name.endsWith('/')) continue;
      out.push({
        name, size: usize,
        async read() {
          const ln = dv.getUint16(local + 26, true), lx = dv.getUint16(local + 28, true);
          const data = u8.subarray(local + 30 + ln + lx, local + 30 + ln + lx + csize);
          if (method === 0) return data.slice();
          if (method === 8) return inflateRaw(data);
          throw new Error('Unsupported ZIP compression in ' + name);
        },
      });
    }
    return out;
  }

  // ---------- TikTok export ----------
  const LINK_KEYS = ['Link', 'link', 'VideoLink', 'Url', 'url', 'URL'];
  const DATE_KEYS = ['Date', 'date', 'CreateTime', 'Time'];

  function pick(o, keys) { for (const k of keys) if (o[k] != null && o[k] !== '') return o[k]; return null; }

  /**
   * Walk TikTok's JSON (any version of the layout) and pull out lists of items with links.
   * Returns { posts: [...], sounds: [...], other: [...] }, each item { date, link, title, sound, likes, group }.
   */
  function parseTikTok(json) {
    const res = { posts: [], sounds: [], other: [] };
    const seen = new Set();
    function visit(node, path) {
      if (Array.isArray(node)) {
        const items = node.filter((x) => x && typeof x === 'object' && !Array.isArray(x) && pick(x, LINK_KEYS));
        if (items.length) {
          const p = path.join(' > ');
          const group = /sound|music/i.test(p) ? 'sounds' : /(^|>\s*)(video|post)s?\b|videolist|my ?videos|posts/i.test(p) && !/like|favou?rite|watch|share|browsing|repost/i.test(p) ? 'posts' : 'other';
          for (const x of items) {
            const link = String(pick(x, LINK_KEYS));
            const key = group + '|' + link;
            if (seen.has(key)) continue;
            seen.add(key);
            res[group].push({
              date: pick(x, DATE_KEYS) || '', link,
              title: x.Title || x.title || x.Description || x.Desc || '',
              sound: x.Sound || x.SoundName || x.Music || '',
              likes: x.Likes != null ? String(x.Likes) : '',
              group: p,
            });
          }
        }
        node.forEach((x, i) => { if (x && typeof x === 'object') visit(x, path.concat(String(i))); });
        return;
      }
      if (node && typeof node === 'object') for (const k of Object.keys(node)) if (node[k] && typeof node[k] === 'object') visit(node[k], path.concat(k));
    }
    visit(json, []);
    const byDate = (a, b) => String(b.date).localeCompare(String(a.date));
    res.posts.sort(byDate); res.sounds.sort(byDate); res.other.sort(byDate);
    return res;
  }

  /** TikTok export as a File/Blob (ZIP or JSON) -> parsed result. */
  async function readTikTokExport(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let text = null;
    if (buf[0] === 0x50 && buf[1] === 0x4b) {
      const entries = readZip(buf);
      const jsonEntry = entries.find((e) => /user_data.*\.json$/i.test(e.name)) || entries.find((e) => /\.json$/i.test(e.name));
      if (!jsonEntry) {
        const txt = entries.filter((e) => /\.txt$/i.test(e.name));
        if (txt.length) throw new Error('This export is in TXT format. Ask TikTok again and choose the JSON file format.');
        throw new Error('No JSON file was found in this ZIP.');
      }
      text = new TextDecoder().decode(await jsonEntry.read());
    } else text = new TextDecoder().decode(buf);
    let json;
    try { json = JSON.parse(text.replace(/^﻿/, '')); } catch (_) { throw new Error('This file is not TikTok JSON data.'); }
    return parseTikTok(json);
  }

  /** "2024-03-02 18:20:11" from a TikTok file name or date -> short label */
  function niceDate(d) {
    const m = String(d || '').match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return String(d || '');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return (+m[3]) + ' ' + months[+m[2] - 1] + ' ' + m[1];
  }

  // ---------- WAV ----------
  /** encodeWav({ sampleRate, channels: [Float32Array, ...] }) -> Uint8Array (16-bit PCM) */
  function encodeWav(o) {
    const ch = o.channels.length, n = o.channels[0].length, sr = o.sampleRate;
    const buf = new ArrayBuffer(44 + n * ch * 2);
    const v = new DataView(buf);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * ch * 2, true);
    let off = 44;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ch; c++) {
        const s = Math.max(-1, Math.min(1, o.channels[c][i]));
        v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true); off += 2;
      }
    }
    return new Uint8Array(buf);
  }

  /** Peaks for a waveform drawing: n buckets of max |sample| (0..1). */
  function peaks(channel, n) {
    const out = new Float32Array(n);
    const step = Math.max(1, Math.floor(channel.length / n));
    for (let i = 0; i < n; i++) {
      let m = 0;
      const a = i * step, b = Math.min(channel.length, a + step);
      for (let j = a; j < b; j += 4) { const x = Math.abs(channel[j]); if (x > m) m = x; }
      out[i] = m;
    }
    return out;
  }

  /** Royalty-free places to find music. Each has its own licence; the app shows the note. */
  const LIBRARIES = [
    { name: 'YouTube Audio Library', url: 'https://studio.youtube.com/channel/UC/music', note: 'Free music and effects. Some tracks ask you to credit the artist.' },
    { name: 'Pixabay Music', url: 'https://pixabay.com/music/', note: 'Free to use under the Pixabay Content License, no credit needed.' },
    { name: 'Pixabay Sound Effects', url: 'https://pixabay.com/sound-effects/', note: 'Short effects under the Pixabay Content License.' },
    { name: 'Free Music Archive', url: 'https://freemusicarchive.org/', note: 'Creative Commons music. Check each track\'s licence (some are non-commercial).' },
    { name: 'Freesound', url: 'https://freesound.org/', note: 'Creative Commons sound effects. CC-BY needs credit.' },
    { name: 'Incompetech', url: 'https://incompetech.com/music/royalty-free/music.html', note: 'Kevin MacLeod music under CC-BY 4.0 (credit the artist).' },
  ];

  const Sources = { readZip, parseTikTok, readTikTokExport, niceDate, encodeWav, peaks, LIBRARIES };
  if (typeof module === 'object' && module.exports) module.exports = Sources;
  else root.Sources = Sources;
})(typeof window !== 'undefined' ? window : globalThis);
