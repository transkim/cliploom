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

  // Video effects over the whole picture (names are our own).
  const EFFECTS = {
    shake: { name: 'Shake', group: 'Motion' }, pulse: { name: 'Beat zoom', group: 'Motion' }, spin: { name: 'Swing', group: 'Motion' },
    flash: { name: 'Flash', group: 'Light' }, leak: { name: 'Light leak', group: 'Light' }, sparkle: { name: 'Sparkles', group: 'Light' },
    glitch: { name: 'Glitch', group: 'Retro' }, rgb: { name: 'Color split', group: 'Retro' }, vhs: { name: 'VHS tape', group: 'Retro' }, grain: { name: 'Film grain', group: 'Retro' },
    vignette: { name: 'Vignette', group: 'Look' }, blur: { name: 'Dream blur', group: 'Look' }, bw: { name: 'Black and white', group: 'Look' }, mirror: { name: 'Mirror', group: 'Look' },
    open: { name: 'Fade in from black', group: 'Open & close' }, close: { name: 'Fade out to black', group: 'Open & close' }, bars: { name: 'Movie bars', group: 'Open & close' },
  };
  // small deterministic random so a frame always looks the same (preview = export)
  function rnd(n) { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); }

  function layer(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

  class Engine {
    constructor(canvas) {
      this.canvas = canvas;
      this.media = new Map(); // id -> { id, kind, blob, url, duration, w, h, el, buffer, bufferP }
      this.videos = new Map(); // clipId -> HTMLVideoElement (one per clip so transitions can show two)
      this.sounds = new Map(); // soundId -> HTMLAudioElement (preview only; export decodes)
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
      for (const l of this.project.pip || []) if (l.kind === 'video' && l.volume > 0) ids.add(l.mediaId);
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
      const ids = new Set(this.project.video.map((c) => c.id).concat((this.project.pip || []).map((l) => l.id)));
      for (const [id, v] of this.videos) if (!ids.has(id)) { v.pause(); v.removeAttribute('src'); v.load(); this.videos.delete(id); }
      const sids = new Set(this.project.audio.map((s) => s.id));
      for (const [id, a] of this.sounds) if (!sids.has(id)) { a.pause(); this.sounds.delete(id); }
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
      ctx.fillStyle = (p.bg && p.bg.mode !== 'blur' && p.bg.color) || '#000';
      ctx.fillRect(0, 0, W, H);
      const bgm = p.bg && p.bg.mode === 'image' && this.media.get(p.bg.mediaId);
      if (bgm && bgm.el && bgm.el.naturalWidth) {
        const bw = bgm.el.naturalWidth, bh = bgm.el.naturalHeight, bs = Math.max(W / bw, H / bh);
        ctx.drawImage(bgm.el, (W - bw * bs) / 2, (H - bh * bs) / 2, bw * bs, bh * bs);
      }
      if (!src || !src.w) { ctx.restore(); return; }
      const fitS = Math.min(W / src.w, H / src.h), fillS = Math.max(W / src.w, H / src.h);
      if (c.fit !== 'fill' && p.bg && p.bg.mode === 'blur' && Math.abs(fitS - fillS) > 0.01) {
        // cheap blur that phones can do every frame: shrink to a few pixels, stretch back up
        const tw = 24, th = Math.max(1, Math.round(24 * H / W));
        if (!this.tiny) this.tiny = layer(tw, th);
        if (this.tiny.width !== tw || this.tiny.height !== th) { this.tiny.width = tw; this.tiny.height = th; }
        const tc = this.tiny.getContext('2d');
        const ts = Math.max(tw / src.w, th / src.h) * 1.1;
        tc.drawImage(src.el, (tw - src.w * ts) / 2, (th - src.h * ts) / 2, src.w * ts, src.h * ts);
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(this.tiny, 0, 0, W, H);
        ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(0, 0, W, H);
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

    drawLayer(ctx, src, l, W, H, local, hit) {
      if (!src || !src.w) return;
      const fitS = Math.min(W / src.w, H / src.h) * (l.scale || 0.45);
      const ease = (x) => 1 - Math.pow(1 - x, 3);
      const inA = Math.min(1, local / 0.3);
      let a = l.opacity == null ? 1 : l.opacity, sc = 1;
      if (l.anim === 'fade') a *= inA;
      if (l.anim === 'pop') sc = 0.6 + 0.4 * ease(inA);
      let bob = 0, tilt = 0;
      if (l.anim === 'talk') { // a talking photo: gentle nod and breathing while the voice plays
        sc = (0.7 + 0.3 * ease(inA)) * (1 + 0.025 * Math.abs(Math.sin(local * 8.5)) + 0.01 * Math.sin(local * 1.7));
        bob = Math.sin(local * 4.2) * H * 0.004; tilt = Math.sin(local * 1.3) * 0.03;
      }
      const dw = src.w * fitS * sc, dh = src.h * fitS * sc;
      const cx = W / 2 + (l.x || 0) * W, cy = H / 2 + (l.y || 0) * H + bob;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, a));
      if (l.blend && l.blend !== 'normal') ctx.globalCompositeOperation = l.blend;
      ctx.translate(cx, cy);
      if (l.rotate || tilt) ctx.rotate((l.rotate || 0) * Math.PI / 180 + tilt);
      if (l.round > 0 || l.shape === 'circle') {
        ctx.beginPath();
        if (l.shape === 'circle') ctx.ellipse(0, 0, Math.min(dw, dh) / 2, Math.min(dw, dh) / 2, 0, 0, Math.PI * 2);
        else if (ctx.roundRect) ctx.roundRect(-dw / 2, -dh / 2, dw, dh, Math.min(dw, dh) * l.round); else ctx.rect(-dw / 2, -dh / 2, dw, dh);
        ctx.clip();
      }
      ctx.filter = filterCss(l);
      if (l.shape === 'circle') { const d = Math.min(dw, dh), s2 = Math.max(d / src.w, d / src.h); ctx.drawImage(src.el, -src.w * s2 / 2, -src.h * s2 / 2, src.w * s2, src.h * s2); }
      else ctx.drawImage(src.el, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
      if (l.border) {
        ctx.save(); ctx.translate(cx, cy); if (l.rotate) ctx.rotate(l.rotate * Math.PI / 180);
        ctx.strokeStyle = l.border; ctx.lineWidth = Math.max(2, W / 200); ctx.beginPath();
        if (l.shape === 'circle') ctx.arc(0, 0, Math.min(dw, dh) / 2, 0, Math.PI * 2);
        else if (ctx.roundRect) ctx.roundRect(-dw / 2, -dh / 2, dw, dh, Math.min(dw, dh) * (l.round || 0)); else ctx.rect(-dw / 2, -dh / 2, dw, dh);
        ctx.stroke(); ctx.restore();
      }
      if (hit) hit.push({ id: l.id, x: (cx - dw / 2) / W, y: (cy - dh / 2) / H, w: dw / W, h: dh / H });
    }

    /** One video effect over the frame already on ctx. local = seconds into the effect. */
    applyEffect(ctx, cv, e, local, W, H) {
      const k = e.strength == null ? 1 : e.strength;
      const prog = Math.min(1, local / Math.max(0.1, e.dur));
      const fr = Math.floor(local * 30) + (e.seed || 0);
      if (!this.fx || this.fx.width !== W || this.fx.height !== H) this.fx = layer(W, H);
      const copy = () => { const c = this.fx.getContext('2d'); c.globalCompositeOperation = 'copy'; c.drawImage(cv, 0, 0); c.globalCompositeOperation = 'source-over'; return this.fx; };
      ctx.save();
      switch (e.type) {
        case 'shake': {
          const f = copy(); const a = W * 0.02 * k;
          ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
          ctx.translate(W / 2 + (rnd(fr) - 0.5) * 2 * a, H / 2 + (rnd(fr + 7) - 0.5) * 2 * a); ctx.scale(1.06, 1.06);
          ctx.drawImage(f, -W / 2, -H / 2); break;
        }
        case 'pulse': {
          const f = copy(); const beat = Math.pow(1 - ((local * 2) % 1), 3);
          const s2 = 1 + 0.08 * k * beat;
          ctx.translate(W / 2, H / 2); ctx.scale(s2, s2); ctx.drawImage(f, -W / 2, -H / 2); break;
        }
        case 'spin': {
          const f = copy(); const ang = Math.sin(local * 3) * 0.06 * k;
          ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
          ctx.translate(W / 2, H / 2); ctx.rotate(ang); ctx.scale(1.12, 1.12); ctx.drawImage(f, -W / 2, -H / 2); break;
        }
        case 'flash': {
          ctx.globalAlpha = 0.75 * k * Math.pow(1 - ((local * 2) % 1), 4);
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); break;
        }
        case 'leak': {
          const x = W * (0.2 + 0.6 * (0.5 + 0.5 * Math.sin(local * 0.9))), y = H * (0.3 + 0.3 * Math.sin(local * 0.6 + 1));
          const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(W, H) * 0.7);
          g.addColorStop(0, 'rgba(255,170,60,' + 0.55 * k + ')'); g.addColorStop(0.5, 'rgba(255,60,90,' + 0.25 * k + ')'); g.addColorStop(1, 'rgba(255,60,90,0)');
          ctx.globalCompositeOperation = 'screen'; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); break;
        }
        case 'sparkle': {
          ctx.globalCompositeOperation = 'lighter';
          const n = Math.round(26 * k), base = Math.min(W, H);
          for (let i = 0; i < n; i++) {
            const life = (local * 0.8 + rnd(i * 3)) % 1, tw = Math.sin(life * Math.PI);
            const x = rnd(i * 5 + Math.floor(local * 0.8 + rnd(i * 3))) * W, y = rnd(i * 11 + Math.floor(local * 0.8 + rnd(i * 3))) * H;
            const r = base * (0.008 + 0.018 * rnd(i)) * tw;
            ctx.fillStyle = 'rgba(255,250,220,' + (0.9 * tw) + ')';
            ctx.beginPath(); ctx.moveTo(x, y - r * 3); ctx.lineTo(x + r * 0.5, y - r * 0.5); ctx.lineTo(x + r * 3, y); ctx.lineTo(x + r * 0.5, y + r * 0.5);
            ctx.lineTo(x, y + r * 3); ctx.lineTo(x - r * 0.5, y + r * 0.5); ctx.lineTo(x - r * 3, y); ctx.lineTo(x - r * 0.5, y - r * 0.5); ctx.fill();
          }
          break;
        }
        case 'glitch': {
          if (rnd(Math.floor(local * 8)) > 0.45 || k > 1.4) {
            const f = copy(); const n = 6 + Math.floor(rnd(fr) * 6);
            for (let i = 0; i < n; i++) {
              const y = rnd(fr * 3 + i) * H, hh = H * (0.01 + rnd(fr + i * 9) * 0.06), dx = (rnd(fr + i) - 0.5) * W * 0.12 * k;
              ctx.drawImage(f, 0, y, W, hh, dx, y, W, hh);
            }
            ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = 0.5; ctx.drawImage(f, W * 0.012 * k, 0);
          }
          break;
        }
        case 'rgb': {
          const f = copy(); const d = W * 0.008 * k * (1 + Math.sin(local * 6));
          if (!this.fx2 || this.fx2.width !== W || this.fx2.height !== H) this.fx2 = layer(W, H);
          const c2 = this.fx2.getContext('2d');
          ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
          ctx.globalCompositeOperation = 'lighter';
          for (const [col, dx] of [['#f00', -d], ['#0ff', d]]) {
            c2.globalCompositeOperation = 'copy'; c2.drawImage(f, 0, 0);
            c2.globalCompositeOperation = 'multiply'; c2.fillStyle = col; c2.fillRect(0, 0, W, H);
            ctx.drawImage(this.fx2, dx, 0);
          }
          c2.globalCompositeOperation = 'source-over';
          break;
        }
        case 'vhs': {
          const f = copy();
          ctx.globalAlpha = 0.35; ctx.globalCompositeOperation = 'screen'; ctx.drawImage(f, W * 0.006, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
          ctx.fillStyle = 'rgba(0,0,0,' + 0.18 * k + ')';
          const step = Math.max(3, Math.round(H / 240));
          for (let y = 0; y < H; y += step * 2) ctx.fillRect(0, y, W, step);
          const by = ((local * 0.25) % 1) * H;
          ctx.drawImage(f, 0, by, W, H * 0.03, W * 0.02 * k, by, W, H * 0.03);
          ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(0, by, W, H * 0.03);
          break;
        }
        case 'grain': {
          if (!this.noise) {
            this.noise = layer(256, 256);
            const nc = this.noise.getContext('2d'), id = nc.createImageData(256, 256);
            for (let i = 0; i < id.data.length; i += 4) { const v = Math.random() * 255; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; }
            nc.putImageData(id, 0, 0);
          }
          ctx.globalAlpha = 0.16 * k; ctx.globalCompositeOperation = 'overlay';
          const ox = Math.floor(rnd(fr) * 256), oy = Math.floor(rnd(fr + 3) * 256);
          const scl = Math.max(1, Math.round(W / 720));
          for (let y = -oy * scl; y < H; y += 256 * scl) for (let x = -ox * scl; x < W; x += 256 * scl) ctx.drawImage(this.noise, x, y, 256 * scl, 256 * scl);
          break;
        }
        case 'vignette': {
          const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) / 2);
          g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,' + Math.min(0.95, 0.7 * k) + ')');
          ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); break;
        }
        case 'blur': {
          const f = copy(); ctx.filter = 'blur(' + Math.round(W / 90 * k) + 'px) brightness(1.08)';
          ctx.globalAlpha = 0.85; ctx.drawImage(f, 0, 0); break;
        }
        case 'bw': {
          const f = copy(); ctx.filter = 'grayscale(1) contrast(1.15)'; ctx.globalAlpha = Math.min(1, k); ctx.drawImage(f, 0, 0); break;
        }
        case 'mirror': {
          const f = copy(); ctx.translate(W, 0); ctx.scale(-1, 1); ctx.drawImage(f, W / 2, 0, W / 2, H, W / 2, 0, W / 2, H); break;
        }
        case 'open': { ctx.globalAlpha = 1 - prog; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); break; }
        case 'close': { ctx.globalAlpha = prog; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); break; }
        case 'bars': {
          const bh = H * 0.11 * Math.min(1, local / 0.5) * Math.min(1, k + 0.2);
          ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, bh); ctx.fillRect(0, H - bh, W, bh); break;
        }
        default: break;
      }
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
      // overlay layers (picture in picture), lower lanes first
      const pips = (p.pip || []).filter((l) => t >= l.start && t < l.start + M.clipDur(l)).sort((a, b) => (a.lane || 0) - (b.lane || 0));
      if (pips.length) {
        const ps = await Promise.all(pips.map((l) => this.source({ clip: l, time: Math.min(l.out - 0.001, l.in + (t - l.start) * (l.speed || 1)) }, exact)));
        const pb = target ? null : [];
        pips.forEach((l, i) => this.drawLayer(ctx, ps[i], l, W, H, t - l.start, pb));
        if (pb) this.pipBoxes = pb;
      } else if (!target) this.pipBoxes = [];
      for (const e of p.effects || []) if (t >= e.start && t < e.start + e.dur) this.applyEffect(ctx, cv, e, t - e.start, W, H);
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

    /** Route a media element's sound through Web Audio so volume can go above 100% and fade. */
    gainFor(el) {
      if (!el._gain) {
        try {
          const src = this.actx.createMediaElementSource(el);
          el._gain = this.actx.createGain();
          src.connect(el._gain).connect(this.actx.destination);
        } catch (_) { el._gain = { gain: { value: 1 }, fake: true }; }
      }
      return el._gain;
    }
    setVolume(el, v) {
      const g = this.gainFor(el);
      if (g.fake) { el.volume = Math.max(0, Math.min(1, v)); return; }
      el.volume = 1;
      g.gain.value = Math.max(0, v);
    }

    sound(s) {
      let a = this.sounds.get(s.id);
      const m = this.media.get(s.mediaId);
      if (!m) return null;
      if (!a || a.dataset.media !== s.mediaId) {
        if (a) { a.pause(); a.removeAttribute('src'); a.load(); }
        a = document.createElement('audio');
        a.preload = 'auto'; a.dataset.media = s.mediaId; a.src = m.url;
        this.sounds.set(s.id, a);
      }
      return a;
    }

    /**
     * Real-time preview. Starts at once (nothing is decoded first): pictures and sound come from
     * <video>/<audio> elements. The clock follows the playing video, so a slow seek on a phone
     * makes the preview wait instead of seeking over and over.
     */
    async play() {
      if (this.playing) return;
      const dur = M.duration(this.project);
      if (dur <= 0) return;
      if (this.time >= dur - 0.05) this.time = 0;
      if (!this.actx) this.actx = new AudioContext({ latencyHint: 'interactive' });
      if (this.actx.state === 'suspended') this.actx.resume().catch(() => {});
      this.playing = true;
      let t = this.time, last = performance.now();
      this.started = new Set();
      const tick = () => {
        if (!this.playing) return;
        const now = performance.now();
        const wall = Math.min(0.1, (now - last) / 1000);
        last = now;
        const main = this.syncMedia(t);
        if (main) {
          const v = main.v, c = main.e.clip;
          const clipStart = t - main.e.local;
          if (v.ended || v.currentTime >= c.out - 0.04) t += wall; // clip finished: move on
          else if (!v.paused && !v.seeking && v.readyState >= 2) {
            const vt = clipStart + (v.currentTime - c.in) / (c.speed || 1);
            t = Math.max(t, Math.min(vt, t + 0.25));
          } // else: still loading/seeking, hold the clock
        } else t += wall;
        if (t >= dur) { this.pause(); this.time = dur; this.drawAt(dur - 0.01, true); if (this.onEnd) this.onEnd(); return; }
        this.time = t;
        this.drawAt(t, false);
        if (this.onTime) this.onTime(t);
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }

    /** Start/stop/steer every media element for time t. Returns the video that drives the clock. */
    syncMedia(t) {
      const p = this.project;
      const active = new Set();
      let main = null;
      for (const e of M.videoAt(p, t)) {
        if (e.clip.kind !== 'video') continue;
        const v = this.video(e.clip);
        if (!v) continue;
        active.add(e.clip.id);
        const rate = e.clip.speed || 1;
        if (v.playbackRate !== rate) v.playbackRate = rate;
        const inside = e.local >= 0 && e.local < M.clipDur(e.clip);
        if (!this.started.has(e.clip.id)) {
          this.started.add(e.clip.id);
          if (Math.abs(v.currentTime - e.time) > 0.05) v.currentTime = e.time;
        } else if (!inside && !v.seeking && Math.abs(v.currentTime - e.time) > 0.6) v.currentTime = e.time;
        const vol = e.clip.volume > 0 ? e.clip.volume : 0;
        v.muted = vol === 0;
        if (vol) this.setVolume(v, vol);
        if (v.paused && !v.ended && v.currentTime < e.clip.out - 0.04) v.play().catch(() => {});
        if (inside && !main) main = { e, v };
      }
      for (const l of p.pip || []) {
        if (l.kind !== 'video' || t < l.start || t >= l.start + M.clipDur(l)) continue;
        const v = this.video(l);
        if (!v) continue;
        active.add(l.id);
        const want = l.in + (t - l.start) * (l.speed || 1);
        if (v.playbackRate !== (l.speed || 1)) v.playbackRate = l.speed || 1;
        if (!this.started.has(l.id)) { this.started.add(l.id); if (Math.abs(v.currentTime - want) > 0.05) v.currentTime = want; }
        else if (!v.seeking && Math.abs(v.currentTime - want) > 0.6) v.currentTime = want;
        const vol = l.volume > 0 ? l.volume : 0;
        v.muted = vol === 0;
        if (vol) this.setVolume(v, vol);
        if (v.paused && !v.ended && v.currentTime < l.out - 0.04) v.play().catch(() => {});
      }
      for (const [id, v] of this.videos) if (!active.has(id)) { if (!v.paused) v.pause(); this.started.delete(id); }
      // warm up the next clip so it starts without a black frame
      const nx = M.layout(p).find((r) => r.start > t && r.start - t < 1.5 && r.clip.kind === 'video');
      if (nx && !active.has(nx.clip.id)) { const v = this.video(nx.clip); if (v && v.paused && !v.seeking && Math.abs(v.currentTime - nx.clip.in) > 0.05) v.currentTime = nx.clip.in; }

      const on = new Set();
      for (const s of p.audio) {
        const d = M.soundDur(s);
        if (t < s.start || t >= s.start + d || !(s.volume > 0)) continue;
        const a = this.sound(s);
        if (!a) continue;
        on.add(s.id);
        const want = s.in + (t - s.start);
        if (a.paused || Math.abs(a.currentTime - want) > 0.3) { if (!a.seeking) a.currentTime = want; }
        let g = s.volume;
        if (s.fadeIn > 0 && t - s.start < s.fadeIn) g *= (t - s.start) / s.fadeIn;
        if (s.fadeOut > 0 && s.start + d - t < s.fadeOut) g *= (s.start + d - t) / s.fadeOut;
        this.setVolume(a, g);
        if (a.paused) a.play().catch(() => {});
      }
      for (const [id, a] of this.sounds) if (!on.has(id) && !a.paused) a.pause();
      return main;
    }

    pause() {
      this.playing = false;
      cancelAnimationFrame(this.raf);
      for (const n of this.nodes || []) { try { n.stop(); } catch (_) { /* done */ } }
      this.nodes = [];
      for (const v of this.videos.values()) { v.pause(); v.muted = true; }
      for (const a of this.sounds.values()) a.pause();
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
      if (o.onProgress) o.onProgress(0, 'Preparing sound…');
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
  Engine.EFFECTS = EFFECTS;
  Engine.filterCss = filterCss;
  root.Engine = Engine;
})(window);
