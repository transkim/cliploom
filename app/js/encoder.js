/*
 * MP4 export on the device: WebCodecs + mp4-muxer (vendor/mp4-muxer.js, MIT).
 * Frames are drawn one by one, so export never drops frames on slow devices.
 * H.264 when available, VP9 inside MP4 otherwise; AAC audio when available, Opus otherwise.
 */
(function (root) {
  const VIDEO = [
    ['avc1.640028', 'avc'], ['avc1.4d0028', 'avc'], ['avc1.42e028', 'avc'], ['avc1.42001f', 'avc'],
    ['vp09.00.40.08', 'vp9'], ['vp09.00.10.08', 'vp9'],
  ];

  async function pickVideo(width, height, fps) {
    if (!root.VideoEncoder) return null;
    for (const [codec, mux] of VIDEO) {
      for (const hw of ['prefer-hardware', 'no-preference', 'prefer-software']) {
        const cfg = { codec, width, height, bitrate: Math.round(width * height * fps * 0.14), framerate: fps, hardwareAcceleration: hw };
        if (mux === 'avc') cfg.avc = { format: 'avc' };
        try { const r = await VideoEncoder.isConfigSupported(cfg); if (r.supported) return { cfg: r.config, mux }; } catch (_) { /* next */ }
      }
    }
    return null;
  }

  async function pickAudio(sampleRate, channels) {
    if (!root.AudioEncoder) return null;
    for (const [codec, mux] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
      const cfg = { codec, sampleRate, numberOfChannels: channels, bitrate: 192000 };
      try { const r = await AudioEncoder.isConfigSupported(cfg); if (r.supported) return { cfg: r.config, mux }; } catch (_) { /* next */ }
    }
    return null;
  }

  const even = (n) => Math.max(2, Math.round(n / 2) * 2);

  const Encoder = {
    async supported() { return !!(await pickVideo(720, 1280, 30)); },

    /** encode({ width, height, fps, frames, draw: async (i) => canvas, audio: AudioBuffer|null, onProgress, isCancelled }) -> Blob */
    async encode(o) {
      const Mx = root.Mp4Muxer;
      const width = even(o.width), height = even(o.height), fps = o.fps || 30;
      const v = await pickVideo(width, height, fps);
      if (!v || !Mx) throw new Error('Video export is not available on this device (no WebCodecs encoder).');
      const ch = o.audio ? Math.min(2, o.audio.numberOfChannels) : 0;
      const a = o.audio ? await pickAudio(o.audio.sampleRate, ch) : null;

      const target = new Mx.ArrayBufferTarget();
      const muxer = new Mx.Muxer({
        target, fastStart: 'in-memory', firstTimestampBehavior: 'offset',
        video: { codec: v.mux, width, height, frameRate: fps },
        audio: a ? { codec: a.mux, sampleRate: o.audio.sampleRate, numberOfChannels: ch } : undefined,
      });
      let failure = null;
      const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => { failure = e; } });
      venc.configure(v.cfg);
      const us = 1e6 / fps;
      for (let i = 0; i < o.frames; i++) {
        if (failure) throw failure;
        if (o.isCancelled && o.isCancelled()) { try { venc.close(); } catch (_) { /* closed */ } throw new Error('Export cancelled'); }
        const cv = await o.draw(i);
        const frame = new VideoFrame(cv, { timestamp: Math.round(i * us), duration: Math.round(us) });
        venc.encode(frame, { keyFrame: i % (fps * 2) === 0 });
        frame.close();
        while (venc.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 4));
        if (o.onProgress && i % 3 === 0) o.onProgress((i + 1) / o.frames * (a ? 0.95 : 1));
      }
      await venc.flush(); venc.close();

      if (a) {
        const ab = o.audio; const sr = ab.sampleRate;
        const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => { failure = e; } });
        aenc.configure(a.cfg);
        const total = Math.min(ab.length, Math.round(o.frames / fps * sr));
        const chans = Array.from({ length: ch }, (_, c) => ab.getChannelData(c));
        const block = 4800;
        for (let off = 0; off < total; off += block) {
          const n = Math.min(block, total - off);
          const planar = new Float32Array(n * ch);
          for (let c = 0; c < ch; c++) planar.set(chans[c].subarray(off, off + n), c * n);
          const d = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round(off / sr * 1e6), data: planar });
          aenc.encode(d); d.close();
        }
        await aenc.flush(); aenc.close();
        if (failure) throw failure;
      }
      muxer.finalize();
      if (o.onProgress) o.onProgress(1);
      return new Blob([target.buffer], { type: 'video/mp4' });
    },
  };
  root.Encoder = Encoder;
})(window);
