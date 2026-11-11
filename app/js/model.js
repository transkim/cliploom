/*
 * Project model: plain data plus pure functions, so it can be tested in Node.
 *
 * project = {
 *   id, name, ratio, fps, bg: { mode: 'blur'|'color', color },
 *   video:    [clip]     main track, clips play one after another
 *   overlays: [overlay]  text and stickers, free placement in time
 *   audio:    [sound]    music, effects, voice; free placement, several lanes
 * }
 * clip    = { id, mediaId, kind: 'video'|'image', in, out, speed, volume, filter, adjust, fit, zoom, x, y, transition }
 * overlay = { id, start, dur, text, font, size, color, stroke, box, x, y, anim, align }
 * sound   = { id, mediaId, name, start, in, out, volume, fadeIn, fadeOut, lane }
 */
(function (root) {
  const RATIOS = {
    '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080], '4:5': [1080, 1350], '3:4': [1080, 1440], '21:9': [1920, 822],
  };
  const MIN = 0.1;

  let seq = 0;
  function uid(prefix) {
    seq = (seq + 1) % 1e6;
    return (prefix || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + seq.toString(36);
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const round = (v) => Math.round(v * 1000) / 1000;

  function newProject(name, ratio) {
    return {
      id: uid('p'), name: name || 'Untitled', ratio: RATIOS[ratio] ? ratio : '9:16', fps: 30,
      bg: { mode: 'blur', color: '#000000' },
      video: [], overlays: [], audio: [], created: Date.now(), updated: Date.now(),
    };
  }

  function size(p, maxSide) {
    const [w, h] = RATIOS[p.ratio] || RATIOS['9:16'];
    const s = maxSide ? Math.min(1, maxSide / Math.max(w, h)) : 1;
    return { w: Math.round(w * s / 2) * 2, h: Math.round(h * s / 2) * 2 };
  }

  function clipDur(c) { return Math.max(MIN, (c.out - c.in) / (c.speed || 1)); }
  function soundDur(s) { return Math.max(MIN, s.out - s.in); }

  /** Main track with start/end on the timeline. */
  function layout(p) {
    let t = 0;
    return p.video.map((c, i) => { const d = clipDur(c); const r = { clip: c, index: i, start: t, end: t + d }; t += d; return r; });
  }

  function videoEnd(p) { return p.video.reduce((a, c) => a + clipDur(c), 0); }

  function duration(p) {
    let d = videoEnd(p);
    for (const o of p.overlays) d = Math.max(d, o.start + o.dur);
    for (const s of p.audio) d = Math.max(d, s.start + soundDur(s));
    return d;
  }

  /** Transition length actually used at the cut after clip i (never more than ~half of either clip). */
  function transDur(p, i) {
    const a = p.video[i], b = p.video[i + 1];
    if (!a || !b || !a.transition || a.transition.type === 'none') return 0;
    return Math.min(a.transition.dur || 0.5, clipDur(a) / 2, clipDur(b) / 2);
  }

  /**
   * What the main track shows at time t:
   * [{ clip, time (source seconds), alpha/mix info }] — one entry normally, two inside a transition.
   */
  function videoAt(p, t) {
    const L = layout(p);
    if (!L.length) return [];
    const i = L.findIndex((r) => t < r.end);
    if (i < 0) return [];
    const r = L[i];
    const src = (rr, tt) => clamp(rr.clip.in + (tt - rr.start) * (rr.clip.speed || 1), rr.clip.in, rr.clip.out - 0.001);
    const out = [{ clip: r.clip, index: i, time: src(r, t), local: t - r.start }];
    // inside the transition window around the cut after i, or the one before i
    const dNext = transDur(p, i);
    if (dNext && t > r.end - dNext / 2 && L[i + 1]) {
      const n = L[i + 1];
      const prog = (t - (r.end - dNext / 2)) / dNext;
      return [{ clip: r.clip, index: i, time: src(r, t), local: t - r.start }, { clip: n.clip, index: i + 1, time: src(n, t), local: t - n.start, incoming: true, progress: prog, type: r.clip.transition.type }];
    }
    const dPrev = i > 0 ? transDur(p, i - 1) : 0;
    if (dPrev && t < r.start + dPrev / 2) {
      const pr = L[i - 1];
      const prog = (t - (r.start - dPrev / 2)) / dPrev;
      return [{ clip: pr.clip, index: i - 1, time: src(pr, t), local: t - pr.start }, { clip: r.clip, index: i, time: src(r, t), local: t - r.start, incoming: true, progress: prog, type: pr.clip.transition.type }];
    }
    return out;
  }

  function find(p, id) {
    for (const k of ['video', 'overlays', 'audio']) {
      const i = p[k].findIndex((x) => x.id === id);
      if (i >= 0) return { list: k, index: i, item: p[k][i] };
    }
    return null;
  }

  function makeClip(media, opts) {
    const isImg = media.kind === 'image';
    const dur = isImg ? 3 : Math.max(MIN, media.duration || 3);
    return Object.assign({
      id: uid('c'), mediaId: media.id, kind: isImg ? 'image' : 'video', in: 0, out: round(dur),
      speed: 1, volume: 1, filter: 'none', adjust: { b: 0, c: 0, s: 0, w: 0 }, fit: 'fit', zoom: 1, x: 0, y: 0,
      rotate: 0, kenburns: isImg, transition: { type: 'none', dur: 0.5 }, mediaDur: isImg ? 0 : dur,
    }, opts || {});
  }

  function makeSound(media, start, opts) {
    const dur = Math.max(MIN, media.duration || 1);
    return Object.assign({
      id: uid('a'), mediaId: media.id, name: media.name || 'Sound', start: round(Math.max(0, start || 0)),
      in: 0, out: round(dur), volume: 1, fadeIn: 0, fadeOut: 0, lane: 0, mediaDur: dur,
    }, opts || {});
  }

  function makeText(start, opts) {
    return Object.assign({
      id: uid('t'), start: round(Math.max(0, start || 0)), dur: 3, text: 'Your text', font: 'Poppins', weight: 800, size: 0.07,
      color: '#ffffff', stroke: '#000000', strokeW: 0.12, box: '', x: 0.5, y: 0.5, anim: 'pop', align: 'center',
    }, opts || {});
  }

  /** Split the item under time t. Returns the new right-hand item's id or null. */
  function split(p, id, t) {
    const f = find(p, id);
    if (!f) return null;
    const it = f.item;
    if (f.list === 'video') {
      const r = layout(p)[f.index];
      if (t <= r.start + MIN || t >= r.end - MIN) return null;
      const cut = round(it.in + (t - r.start) * (it.speed || 1));
      const right = JSON.parse(JSON.stringify(it));
      right.id = uid('c'); right.in = cut;
      it.out = cut; it.transition = { type: 'none', dur: (it.transition && it.transition.dur) || 0.5 };
      p.video.splice(f.index + 1, 0, right);
      return right.id;
    }
    if (f.list === 'audio') {
      if (t <= it.start + MIN || t >= it.start + soundDur(it) - MIN) return null;
      const cut = round(it.in + (t - it.start));
      const right = Object.assign({}, it, { id: uid('a'), in: cut, start: round(t), fadeIn: 0 });
      it.out = cut; it.fadeOut = 0;
      p.audio.splice(f.index + 1, 0, right);
      return right.id;
    }
    if (t <= it.start + MIN || t >= it.start + it.dur - MIN) return null;
    const right = Object.assign({}, it, { id: uid('t'), start: round(t), dur: round(it.start + it.dur - t) });
    it.dur = round(t - it.start);
    p.overlays.splice(f.index + 1, 0, right);
    return right.id;
  }

  function remove(p, id) {
    const f = find(p, id);
    if (!f) return false;
    p[f.list].splice(f.index, 1);
    return true;
  }

  function duplicate(p, id) {
    const f = find(p, id);
    if (!f) return null;
    const copy = JSON.parse(JSON.stringify(f.item));
    copy.id = uid(f.list === 'video' ? 'c' : f.list === 'audio' ? 'a' : 't');
    if (f.list === 'audio') copy.start = round(f.item.start + soundDur(f.item));
    if (f.list === 'overlays') copy.start = round(f.item.start + f.item.dur);
    p[f.list].splice(f.index + 1, 0, copy);
    return copy.id;
  }

  function moveVideo(p, id, toIndex) {
    const i = p.video.findIndex((c) => c.id === id);
    if (i < 0) return;
    const [c] = p.video.splice(i, 1);
    p.video.splice(clamp(toIndex, 0, p.video.length), 0, c);
  }

  /** Trim an edge. edge 'start'|'end', delta in timeline seconds. */
  function trim(p, id, edge, delta) {
    const f = find(p, id);
    if (!f) return;
    const it = f.item;
    if (f.list === 'video') {
      const sp = it.speed || 1;
      const max = it.kind === 'image' ? 3600 : (it.mediaDur || it.out);
      if (edge === 'start') it.in = round(clamp(it.in + delta * sp, it.kind === 'image' ? 0 : 0, it.out - MIN * sp));
      else it.out = round(clamp(it.out + delta * sp, it.in + MIN * sp, max));
      if (it.kind === 'image') { it.out = round(it.out - it.in); it.in = 0; }
    } else if (f.list === 'audio') {
      const max = it.mediaDur || it.out;
      if (edge === 'start') {
        const d = clamp(delta, -it.in, soundDur(it) - MIN);
        const d2 = Math.max(d, -it.start);
        it.in = round(it.in + d2); it.start = round(it.start + d2);
      } else it.out = round(clamp(it.out + delta, it.in + MIN, max));
    } else if (edge === 'start') {
      const d = clamp(delta, -it.start, it.dur - MIN);
      it.start = round(it.start + d); it.dur = round(it.dur - d);
    } else it.dur = round(Math.max(MIN, it.dur + delta));
  }

  /** Move video clip audio onto its own sound item; the clip is muted. */
  function detachAudio(p, id, media) {
    const f = find(p, id);
    if (!f || f.list !== 'video' || f.item.kind !== 'video') return null;
    const r = layout(p)[f.index];
    const c = f.item;
    if ((c.speed || 1) !== 1) return null;
    const s = makeSound(media, r.start, { in: c.in, out: c.out, volume: c.volume, lane: freeLane(p, r.start, r.end) });
    c.volume = 0;
    p.audio.push(s);
    return s.id;
  }

  function freeLane(p, a, b) {
    for (let lane = 0; lane < 8; lane++) {
      const busy = p.audio.some((s) => s.lane === lane && s.start < b && s.start + soundDur(s) > a);
      if (!busy) return lane;
    }
    return 0;
  }

  /** Where every sound plays: [{ mediaId, when, offset, dur, rate, volume, fadeIn, fadeOut }] in timeline seconds. */
  function audioSchedule(p, mediaHasAudio) {
    const out = [];
    for (const r of layout(p)) {
      const c = r.clip;
      if (c.kind !== 'video' || !(c.volume > 0)) continue;
      if (mediaHasAudio && !mediaHasAudio(c.mediaId)) continue;
      out.push({ mediaId: c.mediaId, when: r.start, offset: c.in, dur: r.end - r.start, rate: c.speed || 1, volume: c.volume, fadeIn: 0, fadeOut: 0 });
    }
    for (const s of p.audio) {
      if (!(s.volume > 0)) continue;
      out.push({ mediaId: s.mediaId, when: s.start, offset: s.in, dur: soundDur(s), rate: 1, volume: s.volume, fadeIn: s.fadeIn || 0, fadeOut: s.fadeOut || 0 });
    }
    return out;
  }

  function fmt(t) {
    t = Math.max(0, t || 0);
    const m = Math.floor(t / 60), s = Math.floor(t % 60), f = Math.floor((t * 10) % 10);
    return m + ':' + String(s).padStart(2, '0') + '.' + f;
  }

  const Model = {
    RATIOS, uid, clamp, newProject, size, clipDur, soundDur, layout, videoEnd, duration, transDur, videoAt,
    find, makeClip, makeSound, makeText, split, remove, duplicate, moveVideo, trim, detachAudio, freeLane, audioSchedule, fmt,
  };
  if (typeof module === 'object' && module.exports) module.exports = Model;
  else root.Model = Model;
})(typeof window !== 'undefined' ? window : globalThis);
