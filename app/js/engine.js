/*
 * Engine: draws the project at any time on a canvas, plays it back in real time
 * (video elements for pictures, Web Audio for every sound) and exports it frame by frame.
 */
(function (root) {
  const M = root.Model;

  const FILTERS = {
    none: { name: 'None', css: '' },
    vivid: { name: 'Vivid', css: 'saturate(1.45) contrast(1.08)' },
    warm: { name: 'Warm', css: 'sepia(0.22) saturate(1.25) hue-rotate(-8deg)' },
    cool: { name: 'Cool', css: 'saturate(1.1) hue-rotate(12deg) brightness(1.03)' },
    golden: { name: 'Golden', css: 'sepia(0.35) saturate(1.5) brightness(1.05) contrast(1.05)' },
    fresh: { name: 'Fresh', css: 'brightness(1.08) saturate(1.25) contrast(0.95)' },
    vintage: { name: 'Vintage', css: 'sepia(0.5) contrast(0.9) brightness(1.05) saturate(0.85)' },
    fade: { name: 'Faded', css: 'contrast(0.82) brightness(1.1) saturate(0.75)' },
    drama: { name: 'Drama', css: 'contrast(1.35) saturate(1.15) brightness(0.92)' },
    mono: { name: 'Mono', css: 'grayscale(1) contrast(1.1)' },
    noir: { name: 'Noir', css: 'grayscale(1) contrast(1.55) brightness(0.88)' },
    retro: { name: 'Retro', css: 'sepia(0.3) hue-rotate(-22deg) saturate(1.6) contrast(1.05)' },
    dream: { name: 'Dreamy', css: 'brightness(1.1) saturate(1.3) contrast(0.92) blur(0.5px)' },
    night: { name: 'Night', css: 'hue-rotate(190deg) saturate(0.6) brightness(0.85) contrast(1.2)' },
  };

  const FONTS = {
    Poppins: '"Poppins", system-ui, sans-serif', Anton: '"Anton", Impact, sans-serif', Bebas: '"Bebas Neue", Impact, sans-serif',
    Marker: '"Permanent Marker", cursive', Pacifico: '"Pacifico", cursive', Playfair: '"Playfair Display", Georgia, serif', Mono: '"Roboto Mono", monospace',
  };

  function filterCss(c) {
    const a = c.adjust || {};
    let s = (FILTERS[c.filter] || FILTERS.none).css;
    if (a.b) s += ' brightness(' + (1 + a.b / 200) + ')';
    if (a.c) s += ' contrast(' + (1 + a.c / 100) + ')';
    if (a.s) s += ' saturate(' + (1 + a.s / 100) + ')';
    if (a.w > 0) s += ' sepia(' + (a.w / 220) + ')';
    if (a.w < 0) s += ' hue-rotate(' + (-a.w / 6) + 'deg)';
    return s.trim() || 'none';
  }

  function seek(v, t) {
    return new Promise((resolve) => {
      if (v.readyState >= 2 && Math.abs(v.currentTime - t) < 0.002) return resolve();
      let done = false;
      const fin = () => { if (done) return; done = true; v.removeEventListener('seeked', fin); resolve(); };
      v.addEventListener('seeked', fin);
      v.currentTime = t;
      setTimeout(fin, 2500);
    });
  }

  function layer(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

  class Engine {
    constructor(canvas) {
      this.canvas = canvas;
      this.media = new Map(); // id -> { id, kind, blob, url, duration, w, h, el, buffer, bufferP }
      this.videos = new Map(); // clipId -> HTMLVideoElement (one per clip so transitions can show two)
      this.project = null;
      this.time = 0;
      this.playing = false;
      this.boxes = [];
      this.onTime = null;
      this.onEnd = null;
      this.layers = null;
    }

    setProject(p) { this.project = p; }

    async addMedia(rec) {
      if (this.media.has(rec.id)) return this.media.get(rec.id);
      const m = Object.assign({}, rec, { url: URL.createObjectURL(rec.blob) });
      this.media.set(rec.id, m);
      if (m.kind === 'image') {
        m.el = new Image();
        m.el.src = m.url;
        await m.el.decode().catch(() => {});
      }
      return m;
    }

    /** Decoded audio (for video and audio media); null when the file has no sound. */
    buffer(id) {
      const m = this.media.get(id);
      if (!m || m.kind === 'image') return Promise.resolve(null);
      if (!m.bufferP) {
        m.bufferP = (async () => {
          try {
            const ctx = new OfflineAudioContext(2, 1, 48000);
            m.buffer = await ctx.decodeAudioData(await m.blob.arrayBuffer());
          } catch (_) { m.buffer = null; }
          return m.buffer;
        })();
      }
      return m.bufferP;
    }

    async loadAllAudio() {
      const ids = new Set();
      for (const c of this.project.video) if (c.kind === 'video' && c.volume > 0) ids.add(c.mediaId);
      for (const s of this.project.audio) ids.add(s.mediaId);
      await Promise.all([...ids].map((id) => this.buffer(id)));
    }

    video(clip) {
      let v = this.videos.get(clip.id);
      const m = this.media.get(clip.mediaId);
      if (!m) return null;
      if (!v || v.dataset.media !== clip.mediaId) {
        if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
        v = document.createElement('video');
        v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
        v.dataset.media = clip.mediaId;
        v.src = m.url;
        this.videos.set(clip.id, v);
      }
      return v;
    }

    /** Drop players for clips that no longer exist. */
    prune() {
      const ids = new Set(this.project.video.map((c) => c.id));
      for (const [id, v] of this.videos) if (!ids.has(id)) { v.pause(); v.removeAttribute('src'); v.load(); this.videos.delete(id); }
    }

    async source(entry, exact) {
      const c = entry.clip;
      const m = this.media.get(c.mediaId);
      if (!m) return null;
      if (m.kind === 'image') return { el: m.el, w: m.el.naturalWidth, h: m.el.naturalHeight };
      const v = this.video(c);
      if (v.readyState < 1) await new Promise((r) => { v.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 4000); });
      if (exact) await seek(v, entry.time);
      if (v.readyState < 2) return null;
      return { el: v, w: v.videoWidth, h: v.videoHeight };
    }

    drawClip(ctx, src, c, W, H, local) {
      const p = this.project;
      ctx.save();
      ctx.fillStyle = (p.bg && p.bg.color) || '#000';
      ctx.fillRect(0, 0, W, H);
      if (!src || !src.w) { ctx.restore(); return; }
      const fitS = Math.min(W / src.w, H / src.h), fillS = Math.max(W / src.w, H / src.h);
      if (c.fit !== 'fill' && p.bg && p.bg.mode === 'blur' && Math.abs(fitS - fillS) > 0.01) {
        ctx.filter = 'blur(' + Math.round(Math.max(W, H) / 40) + 'px) brightness(0.7)';
        const bw = src.w * fillS * 1.1, bh = src.h * fillS * 1.1;
        ctx.drawImage(src.el, (W - bw) / 2, (H - bh) / 2, bw, bh);
        ctx.filter = 'none';
      }
      let s = (c.fit === 'fill' ? fillS : fitS) * (c.zoom || 1);
      if (c.kind === 'image' && c.kenburns) s *= 1 + 0.12 * Math.min(1, local / Math.max(0.1, M.clipDur(c)));
      const dw = src.w * s, dh = src.h * s;
      ctx.translate(W / 2 + (c.x || 0) * W, H / 2 + (c.y || 0) * H);
      if (c.rotate) ctx.rotate(c.rotate * Math.PI / 180);
      if (c.flip) ctx.scale(-1, 1);
      ctx.filter = filterCss(c);
      ctx.drawImage(src.el, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
    }

    drawText(ctx, o, local, W, H, hit) {
      const base = Math.min(W, H);
      const size = Math.max(8, o.size * base);
      const font = (o.weight || 700) + ' ' + size + 'px ' + (FONTS[o.font] || FONTS.Poppins);
      const inT = Math.min(0.45, o.dur / 3), outT = Math.min(0.3, o.dur / 4);
      const pin = Math.min(1, local / inT), pout = Math.min(1, (o.dur - local) / outT);
      let alpha = 1, scale = 1, dy = 0, text = String(o.text || '');
      const ease = (x) => 1 - Math.pow(1 - x, 3);
      switch (o.anim) {
        case 'fade': alpha = Math.min(pin, pout); break;
        case 'pop': scale = pin < 1 ? 0.4 + 0.6 * ease(pin) + Math.sin(pin * Math.PI) * 0.15 : 1; alpha = Math.min(1, pin * 3) * pout; break;
        case 'slide': dy = (1 - ease(pin)) * size * 1.5; alpha = pin * pout; break;
        case 'bounce': dy = -Math.abs(Math.sin(local * 5)) * size * 0.25 * Math.max(0, 1 - local / 3); break;
        case 'zoom': scale = 1 + local / o.dur * 0.25; alpha = Math.min(pin, pout); break;
        case 'type': { const n = Math.ceil(text.length * Math.min(1, local / Math.max(0.3, Math.min(o.dur * 0.6, text.length * 0.06)))); text = text.slice(0, n); break; }
        default: break;
      }
      ctx.save();
      ctx.font = font;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      const lines = [];
      const maxW = W * 0.86;
      for (const para of text.split('\n')) {
        let line = '';
        for (const word of para.split(' ')) {
          const test = line ? line + ' ' + word : word;
          if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = word; } else line = test;
        }
        lines.push(line);
      }
      const lh = size * 1.18;
      const widths = lines.map((l) => ctx.measureText(l).width);
      const bw = Math.max(1, ...widths), bh = lh * lines.length;
      const cx = o.x * W, cy = o.y * H + dy;
      ctx.translate(cx, cy);
      ctx.scale(scale, scale);
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      if (o.box) {
        ctx.fillStyle = o.box;
        const pad = size * 0.3;
        const r = size * 0.25;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(-bw / 2 - pad, -bh / 2 - pad * 0.6, bw + pad * 2, bh + pad * 1.2, r); else ctx.rect(-bw / 2 - pad, -bh / 2 - pad * 0.6, bw + pad * 2, bh + pad * 1.2);
        ctx.fill();
      }
      lines.forEach((l, i) => {
        const y = -bh / 2 + lh * (i + 0.5);
        if (o.stroke && o.strokeW > 0) {
          ctx.lineJoin = 'round'; ctx.miterLimit = 2;
          ctx.lineWidth = size * o.strokeW; ctx.strokeStyle = o.stroke;
          ctx.strokeText(l, 0, y);
        }
        if (o.glow) { ctx.shadowColor = o.glow; ctx.shadowBlur = size * 0.45; }
        else if (o.shadow) { ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = size * 0.2; ctx.shadowOffsetY = size * 0.06; }
        ctx.fillStyle = o.color || '#fff';
        ctx.fillText(l, 0, y);
        ctx.shadowColor = 'transparent';
      });
      ctx.restore();
      if (hit) hit.push({ id: o.id, x: (cx - bw / 2 * scale) / W, y: (cy - bh / 2 * scale) / H, w: bw * scale / W, h: bh * scale / H });
    }

    /** Draw time t onto target (default: the preview canvas). exact = wait for seeks. */
    async drawAt(t, exact, target) {
      const p = this.project;
      const cv = target || this.canvas;
      const W = cv.width, H = cv.height;
      const ctx = cv.getContext('2d');
      const entries = M.videoAt(p, t);
      const srcs = await Promise.all(entries.map((e) => this.source(e, exact)));
      if (!this.layers || this.layers[0].width !== W || this.layers[0].height !== H) this.layers = [layer(W, H), layer(W, H)];
      ctx.save();
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      if (entries.length === 1) this.drawClip(ctx, srcs[0], entries[0].clip, W, H, entries[0].local);
      else if (entries.length === 2) {
        const [A, B] = this.layers;
        this.drawClip(A.getContext('2d'), srcs[0], entries[0].clip, W, H, entries[0].local);
        this.drawClip(B.getContext('2d'), srcs[1], entries[1].clip, W, H, entries[1].local);
        const pr = Math.max(0, Math.min(1, entries[1].progress));
        const type = entries[1].type;
        if (type === 'black' || type === 'white') {
          ctx.drawImage(pr < 0.5 ? A : B, 0, 0);
          ctx.globalAlpha = pr < 0.5 ? pr * 2 : (1 - pr) * 2;
          ctx.fillStyle = type === 'white' ? '#fff' : '#000';
          ctx.fillRect(0, 0, W, H);
        } else if (type === 'slide' || type === 'push') {
          const e = pr * pr * (3 - 2 * pr);
          ctx.drawImage(A, type === 'push' ? -e * W : 0, 0);
          ctx.drawImage(B, (1 - e) * W, 0);
        } else if (type === 'up') {
          const e = pr * pr * (3 - 2 * pr);
          ctx.drawImage(A, 0, -e * H); ctx.drawImage(B, 0, (1 - e) * H);
        } else if (type === 'wipe') {
          ctx.drawImage(A, 0, 0);
          ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W * pr, H); ctx.clip(); ctx.drawImage(B, 0, 0); ctx.restore();
        } else if (type === 'circle') {
          ctx.drawImage(A, 0, 0);
          ctx.save(); ctx.beginPath(); ctx.arc(W / 2, H / 2, Math.hypot(W, H) / 2 * pr, 0, Math.PI * 2); ctx.clip(); ctx.drawImage(B, 0, 0); ctx.restore();
        } else if (type === 'zoom') {
          const s = 1 + pr * 0.6;
          ctx.save(); ctx.globalAlpha = 1 - pr; ctx.translate(W / 2, H / 2); ctx.scale(s, s); ctx.drawImage(A, -W / 2, -H / 2); ctx.restore();
          ctx.globalAlpha = pr; ctx.drawImage(B, 0, 0);
        } else if (type === 'blur') {
          ctx.filter = 'blur(' + Math.round(Math.sin(pr * Math.PI) * W / 40) + 'px)';
          ctx.drawImage(A, 0, 0); ctx.globalAlpha = pr; ctx.drawImage(B, 0, 0); ctx.filter = 'none';
        } else {
          ctx.drawImage(A, 0, 0); ctx.globalAlpha = pr; ctx.drawImage(B, 0, 0);
        }
        ctx.globalAlpha = 1;
      }
      ctx.restore();
      const hit = target ? null : [];
      for (const o of p.overlays) if (t >= o.start && t < o.start + o.dur) this.drawText(ctx, o, t - o.start, W, H, hit);
      if (hit) this.boxes = hit;
    }

    // ---------- playback ----------
    scheduleAudio(ctx, dest, from, startAt) {
      const nodes = [];
      for (const s of M.audioSchedule(this.project)) {
        const m = this.media.get(s.mediaId);
        const buf = m && m.buffer;
        if (!buf) continue;
        const end = s.when + s.dur;
        if (end <= from) continue;
        const skip = Math.max(0, from - s.when);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = s.rate;
        const g = ctx.createGain();
        const t0 = startAt + Math.max(0, s.when - from);
        const tEnd = startAt + (end - from);
        g.gain.setValueAtTime(s.volume, t0);
        if (s.fadeIn > 0 && skip < s.fadeIn) { g.gain.setValueAtTime(s.volume * skip / s.fadeIn, t0); g.gain.linearRampToValueAtTime(s.volume, t0 + (s.fadeIn - skip)); }
        if (s.fadeOut > 0) { const fs = Math.max(t0, tEnd - s.fadeOut); g.gain.setValueAtTime(s.volume, fs); g.gain.linearRampToValueAtTime(0.0001, tEnd); }
        src.connect(g).connect(dest);
        const offset = s.offset + skip * s.rate;
        const len = (s.dur - skip) * s.rate;
        if (offset >= buf.duration) continue;
        src.start(t0, offset, Math.min(len, buf.duration - offset));
        nodes.push(src);
      }
      return nodes;
    }

    async play() {
      if (this.playing) return;
      const dur = M.duration(this.project);
      if (dur <= 0) return;
      if (this.time >= dur - 0.05) this.time = 0;
      await this.loadAllAudio();
      if (!this.actx) this.actx = new AudioContext({ latencyHint: 'interactive' });
      if (this.actx.state === 'suspended') await this.actx.resume();
      this.playing = true;
      const from = this.time;
      const a0 = this.actx.currentTime + 0.08;
      this.nodes = this.scheduleAudio(this.actx, this.actx.destination, from, a0);
      const tick = () => {
        if (!this.playing) return;
        const t = from + Math.max(0, this.actx.currentTime - a0);
        if (t >= dur) { this.pause(); this.time = dur; this.drawAt(dur - 0.01, true); if (this.onEnd) this.onEnd(); return; }
        this.time = t;
        this.syncVideos(t);
        this.drawAt(t, false);
        if (this.onTime) this.onTime(t);
        this.raf = requestAnimationFrame(tick);
      };
      this.syncVideos(from, true);
      this.raf = requestAnimationFrame(tick);
    }

    syncVideos(t, force) {
      const active = new Set();
      for (const e of M.videoAt(this.project, t)) {
        if (e.clip.kind !== 'video') continue;
        const v = this.video(e.clip);
        if (!v) continue;
        active.add(e.clip.id);
        const rate = e.clip.speed || 1;
        if (v.playbackRate !== rate) v.playbackRate = rate;
        if (force || v.paused || Math.abs(v.currentTime - e.time) > 0.3) { v.currentTime = e.time; }
        if (v.paused) v.play().catch(() => {});
      }
      // warm up the next clip so it starts without a black frame
      const L = M.layout(this.project);
      const nx = L.find((r) => r.start > t && r.start - t < 1.2 && r.clip.kind === 'video');
      if (nx && !active.has(nx.clip.id)) { const v = this.video(nx.clip); if (v && v.paused && Math.abs(v.currentTime - nx.clip.in) > 0.05) v.currentTime = nx.clip.in; }
      for (const [id, v] of this.videos) if (!active.has(id) && !v.paused) v.pause();
    }

    pause() {
      this.playing = false;
      cancelAnimationFrame(this.raf);
      for (const n of this.nodes || []) { try { n.stop(); } catch (_) { /* done */ } }
      this.nodes = [];
      for (const v of this.videos.values()) v.pause();
    }

    async seekTo(t) {
      const was = this.playing;
      if (was) this.pause();
      this.time = Math.max(0, t);
      await this.drawAt(this.time, true);
      if (this.onTime) this.onTime(this.time);
      if (was) this.play();
    }

    // ---------- export ----------
    async mixdown(sampleRate) {
      await this.loadAllAudio();
      const dur = M.duration(this.project);
      const sr = sampleRate || 48000;
      const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(dur * sr)), sr);
      const n = this.scheduleAudio(ctx, ctx.destination, 0, 0);
      if (!n.length) return null;
      return ctx.startRendering();
    }

    /** export({ maxSide, fps, onProgress, isCancelled }) -> Blob */
    async exportVideo(o) {
      const p = this.project;
      const { w, h } = M.size(p, o.maxSide || 1080);
      const fps = o.fps || p.fps || 30;
      const dur = M.duration(p);
      if (dur <= 0) throw new Error('Add a clip first.');
      this.pause();
      if (o.onProgress) o.onProgress(0, 'Mixing sound…');
      const audio = await this.mixdown(48000);
      const cv = layer(w, h);
      const frames = Math.max(1, Math.ceil(dur * fps));
      const blob = await root.Encoder.encode({
        width: w, height: h, fps, frames, audio,
        isCancelled: o.isCancelled,
        draw: async (i) => { await this.drawAt(Math.min(dur - 0.001, i / fps), true, cv); return cv; },
        onProgress: (x) => o.onProgress && o.onProgress(x, 'Rendering…'),
      });
      return blob;
    }
  }

  Engine.FILTERS = FILTERS;
  Engine.FONTS = FONTS;
  Engine.filterCss = filterCss;
  root.Engine = Engine;
})(window);
