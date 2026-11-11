/*
 * Built-in sounds, made on the device from code (no samples), so they are
 * original and free to use anywhere. Each entry renders to an AudioBuffer.
 */
(function (root) {
  const SR = 44100;

  function noiseBuffer(ctx, sec) {
    const b = ctx.createBuffer(1, Math.ceil(sec * ctx.sampleRate), ctx.sampleRate);
    const d = b.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < d.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; d[i] = seed / 0x3fffffff - 1; }
    return b;
  }
  function env(g, t, a, peak, d, end) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(end || 0.0001, t + a + d);
  }
  function osc(ctx, type, f, t, dur, peak, dest, a) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t);
    env(g, t, a || 0.005, peak, dur);
    o.connect(g).connect(dest); o.start(t); o.stop(t + dur + 0.05);
    return o;
  }
  function noise(ctx, t, dur, peak, dest, filterType, f1, f2, a) {
    const s = ctx.createBufferSource(); s.buffer = noiseBuffer(ctx, dur + 0.1);
    const fl = ctx.createBiquadFilter(); fl.type = filterType || 'bandpass';
    fl.frequency.setValueAtTime(f1, t); if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t + dur);
    fl.Q.value = 0.9;
    const g = ctx.createGain(); env(g, t, a || 0.005, peak, dur);
    s.connect(fl).connect(g).connect(dest); s.start(t); s.stop(t + dur + 0.1);
  }
  function kick(ctx, t, dest, v) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    env(g, t, 0.002, v || 0.9, 0.35);
    o.connect(g).connect(dest); o.start(t); o.stop(t + 0.45);
  }
  function snare(ctx, t, dest, v) { noise(ctx, t, 0.18, v || 0.4, dest, 'highpass', 1800); osc(ctx, 'triangle', 190, t, 0.1, 0.25, dest); }
  function hat(ctx, t, dest, v) { noise(ctx, t, 0.05, v || 0.15, dest, 'highpass', 8000); }
  function clap(ctx, t, dest, v) { for (let i = 0; i < 3; i++) noise(ctx, t + i * 0.012, 0.12, (v || 0.5) * (i === 2 ? 1 : 0.6), dest, 'bandpass', 1500); }
  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
  function chord(ctx, notes, t, dur, dest, type, v) {
    for (const n of notes) {
      const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
      o.type = type || 'sawtooth'; o.frequency.value = midi(n); o.detune.value = (Math.random() - 0.5) * 12;
      f.type = 'lowpass'; f.frequency.value = 1400;
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v || 0.05, t + 0.08); g.gain.setValueAtTime(v || 0.05, t + dur - 0.15); g.gain.linearRampToValueAtTime(0.0001, t + dur);
      o.connect(f).connect(g).connect(dest); o.start(t); o.stop(t + dur + 0.05);
    }
  }
  function master(ctx, v) {
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 3;
    const g = ctx.createGain(); g.gain.value = v || 0.9;
    g.connect(comp).connect(ctx.destination);
    return g;
  }

  const SOUNDS = [
    { id: 'whoosh', name: 'Whoosh', group: 'Effects', dur: 0.8, make(c, d) { noise(c, 0, 0.75, 0.9, d, 'bandpass', 300, 4000, 0.3); } },
    { id: 'swipe', name: 'Swipe', group: 'Effects', dur: 0.35, make(c, d) { noise(c, 0, 0.3, 0.8, d, 'bandpass', 5000, 900, 0.05); } },
    { id: 'pop', name: 'Pop', group: 'Effects', dur: 0.25, make(c, d) { const o = osc(c, 'sine', 600, 0, 0.12, 0.9, d, 0.002); o.frequency.exponentialRampToValueAtTime(1500, 0.06); } },
    { id: 'click', name: 'Click', group: 'Effects', dur: 0.1, make(c, d) { noise(c, 0, 0.03, 0.9, d, 'highpass', 3000); osc(c, 'square', 2200, 0, 0.02, 0.2, d, 0.001); } },
    { id: 'ding', name: 'Ding', group: 'Effects', dur: 1.6, make(c, d) { [1, 2.76, 5.4].forEach((m, i) => osc(c, 'sine', 880 * m, 0, 1.5 / (i + 1), 0.5 / (i + 1), d, 0.003)); } },
    { id: 'chime', name: 'Notification chime', group: 'Effects', dur: 1.2, make(c, d) { [76, 83, 88].forEach((n, i) => osc(c, 'sine', midi(n), i * 0.12, 0.8, 0.35, d, 0.004)); } },
    { id: 'riser', name: 'Riser', group: 'Effects', dur: 2.6, make(c, d) { const o = c.createOscillator(), g = c.createGain(); o.type = 'sawtooth'; o.frequency.setValueAtTime(120, 0); o.frequency.exponentialRampToValueAtTime(1600, 2.5); g.gain.setValueAtTime(0.0001, 0); g.gain.exponentialRampToValueAtTime(0.25, 2.4); g.gain.linearRampToValueAtTime(0.0001, 2.55); o.connect(g).connect(d); o.start(0); o.stop(2.6); noise(c, 0, 2.5, 0.4, d, 'bandpass', 400, 9000, 2.3); } },
    { id: 'boom', name: 'Boom', group: 'Effects', dur: 2.2, make(c, d) { const o = osc(c, 'sine', 90, 0, 2, 1, d, 0.003); o.frequency.exponentialRampToValueAtTime(30, 1.8); noise(c, 0, 0.6, 0.5, d, 'lowpass', 900, 100); } },
    { id: 'clap', name: 'Clap', group: 'Effects', dur: 0.3, make(c, d) { clap(c, 0, d, 0.9); } },
    { id: 'shutter', name: 'Camera shutter', group: 'Effects', dur: 0.3, make(c, d) { noise(c, 0, 0.04, 0.9, d, 'highpass', 2500); noise(c, 0.09, 0.06, 0.7, d, 'bandpass', 1800); } },
    { id: 'type', name: 'Typing', group: 'Effects', dur: 2, make(c, d) { for (let i = 0; i < 14; i++) { const t = i * 0.13 + Math.random() * 0.04; noise(c, t, 0.025, 0.6, d, 'bandpass', 2500 + Math.random() * 1500); } } },
    { id: 'glitch', name: 'Glitch', group: 'Effects', dur: 0.6, make(c, d) { for (let i = 0; i < 8; i++) osc(c, 'square', 200 + Math.random() * 1800, i * 0.06, 0.05, 0.25, d, 0.001); } },
    { id: 'heartbeat', name: 'Heartbeat', group: 'Effects', dur: 2, make(c, d) { [0, 0.25, 1, 1.25].forEach((t, i) => kick(c, t, d, i % 2 ? 0.6 : 0.9)); } },
    {
      id: 'lofi', name: 'Lo-fi loop (8 bars)', group: 'Music', dur: 16, make(c, d) {
        const beat = 60 / 120 / 1; const prog = [[57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 65], [52, 55, 59, 62]];
        for (let bar = 0; bar < 8; bar++) {
          const t0 = bar * 4 * beat;
          chord(c, prog[bar % 4], t0, 4 * beat, d, 'triangle', 0.06);
          [0, 2.5].forEach((b) => kick(c, t0 + b * beat, d, 0.7));
          [1, 3].forEach((b) => snare(c, t0 + b * beat, d, 0.25));
          for (let h = 0; h < 8; h++) hat(c, t0 + h * beat / 2 + (h % 2 ? 0.03 : 0), d, 0.07);
        }
      },
    },
    {
      id: 'upbeat', name: 'Upbeat pop loop', group: 'Music', dur: 15, make(c, d) {
        const beat = 60 / 128; const prog = [[60, 64, 67], [57, 60, 64], [65, 69, 72], [67, 71, 74]];
        const bars = Math.floor(15 / (4 * beat));
        for (let bar = 0; bar < bars; bar++) {
          const t0 = bar * 4 * beat; const ch = prog[bar % 4];
          for (let b = 0; b < 4; b++) { kick(c, t0 + b * beat, d, 0.85); hat(c, t0 + b * beat + beat / 2, d, 0.12); }
          [1, 3].forEach((b) => clap(c, t0 + b * beat, d, 0.4));
          for (let s = 0; s < 8; s++) { osc(c, 'sawtooth', midi(ch[0] - 24), t0 + s * beat / 2, beat / 2 - 0.02, 0.18, d, 0.005); osc(c, 'square', midi(ch[s % 3] + 12), t0 + s * beat / 2, 0.12, 0.05, d, 0.003); }
        }
      },
    },
    {
      id: 'chill', name: 'Chill pad', group: 'Music', dur: 16, make(c, d) {
        const prog = [[50, 57, 62, 66], [47, 54, 59, 62], [43, 50, 55, 59], [45, 52, 57, 61]];
        prog.forEach((ch, i) => chord(c, ch, i * 4, 4.2, d, 'sine', 0.08));
        for (let i = 0; i < 16; i++) osc(c, 'sine', midi([74, 76, 78, 81][i % 4]), i + 0.5, 0.9, 0.06, d, 0.05);
      },
    },
    {
      id: 'epic', name: 'Cinematic drums', group: 'Music', dur: 12, make(c, d) {
        const beat = 0.6;
        for (let i = 0; i < 20; i++) { kick(c, i * beat, d, i % 4 === 0 ? 1 : 0.6); if (i % 2) { const o = osc(c, 'sine', 140, i * beat, 0.4, 0.5, d, 0.002); o.frequency.exponentialRampToValueAtTime(70, i * beat + 0.3); } }
        chord(c, [38, 45, 50], 0, 12, d, 'sawtooth', 0.05);
      },
    },
  ];

  const cache = {};
  async function render(id) {
    if (cache[id]) return cache[id];
    const s = SOUNDS.find((x) => x.id === id);
    if (!s) throw new Error('Unknown sound ' + id);
    const ctx = new OfflineAudioContext(2, Math.ceil(s.dur * SR), SR);
    s.make(ctx, master(ctx, s.group === 'Music' ? 0.8 : 0.9));
    cache[id] = await ctx.startRendering();
    return cache[id];
  }

  root.Synth = { SOUNDS, render };
})(window);
