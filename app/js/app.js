/* Cliploom UI: projects, editor panels, timeline, inspector, sound import and export. */
(function () {
  const M = window.Model, S = window.Sources, Engine = window.Engine, Store = window.Store, Platform = window.Platform;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
    return el;
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const canvas = $('#pv');
  const engine = new Engine(canvas);
  const st = { project: null, sel: null, tab: 'media', pps: 60, hist: [], fut: [], media: [], drag: null, sheet: null };
  window.cliploom = { st, engine }; // handy for debugging

  let toastT = 0;
  function toast(msg, ms) {
    const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms || 2600);
  }
  function fail(e) { console.error(e); toast((e && e.message) || String(e), 4500); }

  // ---------------- modal ----------------
  function modal(build, onClose) {
    const m = $('#modal'), card = $('#modalCard');
    card.innerHTML = '';
    const close = () => { m.classList.add('hidden'); card.innerHTML = ''; st.modalClose = null; if (onClose) onClose(); };
    st.modalClose = close;
    build(card, close);
    m.classList.remove('hidden');
    m.onclick = (e) => { if (e.target === m) close(); };
    return close;
  }

  // ---------------- media library ----------------
  async function loadMedia() {
    st.media = (await Store.all('media')).sort((a, b) => b.created - a.created);
    st.media.filter((m) => m.kind === 'video' && !m.stripV).forEach(queueStrip);
  }
  function mediaById(id) { return st.media.find((m) => m.id === id); }

  function kindOf(file) {
    const t = file.type || '';
    if (t.startsWith('video/')) return 'video';
    if (t.startsWith('image/')) return 'image';
    if (t.startsWith('audio/')) return 'audio';
    const ext = (file.name || '').split('.').pop().toLowerCase();
    if (['mp4', 'mov', 'webm', 'mkv', 'm4v', '3gp', 'avi'].includes(ext)) return 'video';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp'].includes(ext)) return 'image';
    if (['mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac', 'weba'].includes(ext)) return 'audio';
    return '';
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** Wait until a seeked frame is really on screen (Android paints it a little later). */
  function nextFrame(v) {
    return new Promise((resolve) => {
      let done = false;
      const fin = () => { if (!done) { done = true; resolve(); } };
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => fin());
      setTimeout(fin, v.requestVideoFrameCallback ? 450 : 150);
    });
  }
  function looksBlack(ctx, w, h) {
    try {
      const d = ctx.getImageData(0, 0, w, h).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 64) sum += d[i] + d[i + 1] + d[i + 2];
      return sum / (d.length / 64) < 6;
    } catch (_) { return false; }
  }
  function seekV(v, t) {
    return new Promise((resolve) => {
      let done = false;
      const fin = () => { if (!done) { done = true; v.removeEventListener('seeked', fin); resolve(); } };
      v.addEventListener('seeked', fin);
      v.currentTime = t;
      setTimeout(fin, 4000);
    });
  }

  /** A row of small frames across the whole video, for the timeline (made in the background). */
  const stripQueue = [];
  let stripBusy = false;
  function queueStrip(rec) { if (rec.kind === 'video' && !rec.stripV && !stripQueue.includes(rec)) { stripQueue.push(rec); runStrips(); } }
  async function runStrips() {
    if (stripBusy) return;
    stripBusy = true;
    while (stripQueue.length) {
      const rec = stripQueue.shift();
      try { await makeStrip(rec); } catch (e) { console.warn('strip', e); }
    }
    stripBusy = false;
  }
  async function makeStrip(rec) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    const url = URL.createObjectURL(rec.blob);
    v.src = url;
    await new Promise((r) => { v.onloadeddata = r; v.onerror = r; setTimeout(r, 8000); });
    if (!v.videoWidth) { URL.revokeObjectURL(url); return; }
    const dur = rec.duration || v.duration || 1;
    const n = Math.max(4, Math.min(30, Math.ceil(dur / 1.5)));
    const H = 72, W = Math.max(40, Math.min(128, Math.round(H * v.videoWidth / v.videoHeight)));
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const frames = [];
    for (let i = 0; i < n; i++) {
      const t = Math.min(dur - 0.05, (i + 0.5) * dur / n);
      await seekV(v, t);
      await nextFrame(v);
      ctx.drawImage(v, 0, 0, W, H);
      if (looksBlack(ctx, W, H) && t > 0.3) { await sleep(250); ctx.drawImage(v, 0, 0, W, H); }
      frames.push(c.toDataURL('image/jpeg', 0.6));
    }
    v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url);
    rec.strip = frames; rec.stripV = 1;
    if (!rec.thumb || rec.thumbBlack) { rec.thumb = frames[Math.min(frames.length - 1, Math.floor(frames.length / 3))]; rec.thumbBlack = false; }
    await Store.put('media', rec).catch(() => {});
    if (st.project) { renderTimeline(); if (st.tab === 'media') renderTab(); }
  }

  function probeVideo(blob) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.muted = true; v.preload = 'auto'; v.playsInline = true;
      const url = URL.createObjectURL(blob);
      const done = (r) => { URL.revokeObjectURL(url); resolve(r); };
      v.onerror = () => done(null);
      v.onloadedmetadata = () => {
        let dur = v.duration;
        const grab = () => {
          const c = document.createElement('canvas');
          const s = 200 / Math.max(v.videoWidth || 1, v.videoHeight || 1);
          c.width = Math.max(1, Math.round(v.videoWidth * s)); c.height = Math.max(1, Math.round(v.videoHeight * s));
          const g = c.getContext('2d', { willReadFrequently: true });
          try { g.drawImage(v, 0, 0, c.width, c.height); } catch (_) { /* no frame */ }
          done({ thumbBlack: looksBlack(g, c.width, c.height), duration: dur, w: v.videoWidth, h: v.videoHeight, thumb: c.toDataURL('image/jpeg', 0.7) });
        };
        const go = () => { v.onseeked = () => { v.onseeked = null; nextFrame(v).then(grab); }; v.currentTime = Math.min(1, (dur || 1) / 3); };
        if (!isFinite(dur)) { // some webm files: find duration by seeking far
          v.ondurationchange = () => { if (isFinite(v.duration)) { dur = v.duration; v.ondurationchange = null; v.onseeked = null; go(); } };
          v.currentTime = 1e7;
          return;
        }
        go();
      };
      v.src = url;
      setTimeout(() => done(null), 15000);
    });
  }
  async function probeImage(blob) {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.src = url;
    try { await img.decode(); } catch (_) { URL.revokeObjectURL(url); return null; }
    const c = document.createElement('canvas');
    const s = 200 / Math.max(img.naturalWidth, img.naturalHeight);
    c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    return { w: img.naturalWidth, h: img.naturalHeight, thumb: c.toDataURL('image/jpeg', 0.75) };
  }
  async function decode(blob) {
    const ctx = new OfflineAudioContext(2, 1, 48000);
    return ctx.decodeAudioData(await blob.arrayBuffer());
  }
  function bufferPeaks(buf) { return Array.from(S.peaks(buf.getChannelData(0), Math.min(2000, Math.max(100, Math.round(buf.duration * 20)))), (x) => Math.round(x * 100) / 100); }
  function bufferToWav(buf) {
    const ch = Math.min(2, buf.numberOfChannels);
    return new Blob([S.encodeWav({ sampleRate: buf.sampleRate, channels: Array.from({ length: ch }, (_, i) => buf.getChannelData(i)) })], { type: 'audio/wav' });
  }

  async function saveMedia(rec) {
    rec.created = rec.created || Date.now();
    await Store.put('media', rec);
    st.media = st.media.filter((m) => m.id !== rec.id);
    st.media.unshift(rec);
    await engine.addMedia(rec);
    return rec;
  }

  async function importMedia(files) {
    const added = [];
    let i = 0;
    for (const f of files) {
      const kind = kindOf(f);
      i++;
      try {
        if (kind === 'video') {
          toast('Importing ' + (files.length > 1 ? i + ' of ' + files.length : f.name) + '…', 8000);
          const p = await probeVideo(f);
          if (!p) { toast('This device cannot play ' + f.name, 4000); continue; }
          const rec = await saveMedia({ id: M.uid('m'), name: f.name, kind, type: f.type, blob: f, duration: p.duration, w: p.w, h: p.h, thumb: p.thumb, thumbBlack: p.thumbBlack, source: 'import' });
          queueStrip(rec); added.push(rec);
        } else if (kind === 'image') {
          const p = await probeImage(f);
          if (!p) { toast('Cannot open ' + f.name, 4000); continue; }
          added.push(await saveMedia({ id: M.uid('m'), name: f.name, kind, type: f.type, blob: f, duration: 0, w: p.w, h: p.h, thumb: p.thumb, source: 'import' }));
        } else if (kind === 'audio') {
          await importSound(f, 'file');
        }
      } catch (e) { fail(e); }
    }
    $('#toast').classList.add('hidden');
    renderTab();
    return added;
  }

  /** After picking: the picked clips in a tray, an HD switch and "Add (n)". */
  async function importSheet(recs) {
    if (!recs.length || !st.project) return;
    let hd = st.project.hd !== false;
    const list = recs.slice();
    modal((c, close) => {
      const tray = h('div', { class: 'tray' });
      const addBtn = h('button', { class: 'btn primary big' });
      const hdBtn = h('button', { class: 'hd-toggle', role: 'switch' });
      const draw = () => {
        tray.innerHTML = '';
        list.forEach((m, k) => tray.append(h('div', { class: 'tray-item', style: { backgroundImage: m.thumb ? 'url(' + m.thumb + ')' : '' } },
          h('span', { class: 'd' }, m.kind === 'video' ? M.fmt(m.duration).replace(/\.\d$/, '') : 'Photo'),
          h('span', { class: 'n' }, String(k + 1)),
          h('button', { class: 'rm', 'aria-label': 'Remove', onclick: () => { list.splice(k, 1); draw(); } }, '−'))));
        addBtn.textContent = 'Add (' + list.length + ')';
        addBtn.disabled = !list.length;
        hdBtn.className = 'hd-toggle' + (hd ? ' on' : '');
        hdBtn.setAttribute('aria-checked', String(hd));
        hdBtn.innerHTML = '<i></i>HD';
      };
      hdBtn.onclick = () => { hd = !hd; draw(); };
      addBtn.onclick = async () => {
        close();
        if (st.project.hd !== hd) { st.project.hd = hd; sizeCanvas(); }
        for (const m of list) await addClip(m, true);
        st.sel = null; refresh();
        if (isPhone()) closeSheets();
        engine.seekTo(engine.time);
        toast(list.length === 1 ? 'Clip added' : list.length + ' clips added' + (hd ? ' in HD' : ''));
      };
      draw();
      c.append(h('h2', null, 'Add to your video'), h('p', { class: 'sub' }, 'Clips are added in this order after the playhead. Tap − to leave one out; it stays in Media.'),
        tray,
        h('p', { class: 'note' }, h('b', null, 'HD on: '), 'sharp 1080p preview and 1080p export. ', h('b', null, 'HD off: '), '720p, lighter and smoother on slower phones. Your original files are always kept as they are.'),
        h('div', { class: 'modal-foot', style: { alignItems: 'center' } }, hdBtn, h('div', { class: 'grow' }), h('button', { class: 'btn', onclick: close }, 'Keep in Media'), addBtn));
    });
  }

  /** Audio file -> sound in the library. */
  /** Length of a sound (or a video's sound) from its metadata only: fast even for big phone videos. */
  function probeAudio(blob) {
    return new Promise((resolve) => {
      const a = document.createElement('audio');
      a.preload = 'metadata';
      const url = URL.createObjectURL(blob);
      let done = false;
      const fin = (d) => { if (done) return; done = true; URL.revokeObjectURL(url); a.removeAttribute('src'); resolve(d); };
      a.onerror = () => fin(null);
      a.onloadedmetadata = () => {
        if (isFinite(a.duration) && a.duration > 0) return fin(a.duration);
        // recordings (webm) report no length until we seek to the end
        a.ondurationchange = () => { if (isFinite(a.duration) && a.duration > 0) fin(a.duration); };
        a.currentTime = 1e7;
      };
      a.src = url;
      setTimeout(() => fin(null), 15000);
    });
  }

  // Waveforms are drawn later, one file at a time, so importing never waits for a full decode.
  const peakQueue = [];
  let peakBusy = false;
  function queuePeaks(rec) { peakQueue.push(rec); runPeaks(); }
  async function runPeaks() {
    if (peakBusy) return;
    peakBusy = true;
    while (peakQueue.length) {
      const rec = peakQueue.shift();
      if (rec.blob.size > 150 * 1048576) continue;
      const buf = await decode(rec.blob).catch(() => null);
      if (!buf) { if (rec.fromVideo) toast('"' + rec.name + '" seems to have no sound', 4000); continue; }
      rec.peaks = bufferPeaks(buf);
      const m = engine.media.get(rec.id); if (m) { m.buffer = buf; m.bufferP = Promise.resolve(buf); }
      await Store.put('media', rec).catch(() => {});
      if (st.project && st.project.audio.some((x) => x.mediaId === rec.id)) renderTimeline();
      await new Promise((r) => setTimeout(r, 50));
    }
    peakBusy = false;
  }

  /** Audio file -> sound in the library (kept as it is, no conversion). */
  async function importSound(blob, source, name) {
    const dur = await probeAudio(blob);
    if (!dur) throw new Error('Cannot read the sound in ' + (name || blob.name || 'this file'));
    const rec = await saveMedia({ id: M.uid('s'), name: name || (blob.name || 'Sound').replace(/\.[^.]+$/, ''), kind: 'audio', type: blob.type || 'audio/*', blob, duration: dur, peaks: null, source });
    queuePeaks(rec);
    return rec;
  }

  /** Video file -> a sound in the library. The video file itself is kept and only its sound is used,
   *  so this is instant; "Save as WAV" converts when you ask for it. */
  async function extractSound(blob, source, name) {
    const dur = await probeAudio(blob);
    if (!dur) throw new Error((name || blob.name || 'This video') + ' cannot be read on this device.');
    const rec = await saveMedia({ id: M.uid('s'), name, kind: 'audio', type: blob.type || 'video/mp4', blob, duration: dur, peaks: null, source, fromVideo: true });
    queuePeaks(rec);
    return rec;
  }

  async function deleteMedia(m) {
    const used = await projectsUsing(m.id);
    if (used.length && !confirm('"' + m.name + '" is used in ' + used.length + ' project(s). Delete it anyway? Those clips will go blank.')) return;
    await Store.del('media', m.id);
    st.media = st.media.filter((x) => x.id !== m.id);
    renderTab();
  }
  async function projectsUsing(id) {
    const ps = await Store.all('projects');
    return ps.filter((p) => p.video.some((c) => c.mediaId === id) || p.audio.some((s) => s.mediaId === id) || (p.pip || []).some((l) => l.mediaId === id) || (p.bg && p.bg.mediaId === id));
  }

  // ---------------- projects ----------------
  async function renderHome() {
    const list = (await Store.all('projects')).sort((a, b) => b.updated - a.updated);
    const g = $('#projects'); g.innerHTML = '';
    $('#noProjects').classList.toggle('hidden', list.length > 0);
    for (const p of list) {
      const card = h('div', { class: 'proj' },
        h('button', { class: 'th', style: { backgroundImage: p.thumb ? 'url(' + p.thumb + ')' : '' }, 'aria-label': 'Open ' + p.name, onclick: () => openProject(p) }),
        h('div', { class: 'meta' }, h('b', null, p.name), h('small', null, p.ratio + ' · ' + M.fmt(M.duration(p)).replace(/\.\d$/, '') + ' · ' + new Date(p.updated).toLocaleDateString())),
        h('button', { class: 'more', title: 'More', onclick: (e) => { e.stopPropagation(); projectMenu(p); } }, '⋯'));
      g.append(card);
    }
  }
  function projectMenu(p) {
    modal((c, close) => {
      c.append(h('h2', null, p.name), h('p', { class: 'sub' }, 'Project'),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: async () => { const n = prompt('Rename project', p.name); if (n) { p.name = n.trim() || p.name; await Store.put('projects', p); close(); renderHome(); } } }, 'Rename'),
          h('button', { class: 'btn', onclick: async () => { const c2 = JSON.parse(JSON.stringify(p)); c2.id = M.uid('p'); c2.name = p.name + ' copy'; c2.updated = Date.now(); c2.thumb = p.thumb; await Store.put('projects', c2); close(); renderHome(); } }, 'Duplicate'),
          h('button', { class: 'btn danger', onclick: async () => { if (confirm('Delete "' + p.name + '"? Your imported media stays in the library.')) { await Store.del('projects', p.id); close(); renderHome(); } } }, 'Delete')),
        h('div', { class: 'modal-foot' }, h('button', { class: 'btn ghost', onclick: close }, 'Close')));
    });
  }
  function newProjectDialog() {
    let ratio = '9:16';
    modal((c, close) => {
      const grid = h('div', { class: 'ratio-grid' });
      const labels = { '9:16': 'TikTok, Reels, Shorts', '16:9': 'YouTube, TV', '1:1': 'Square posts', '4:5': 'Instagram feed', '3:4': 'Portrait', '21:9': 'Cinema' };
      for (const r of Object.keys(M.RATIOS)) {
        const [w, hh] = M.RATIOS[r]; const s = 40 / Math.max(w, hh);
        const b = h('button', { class: 'ratio' + (r === ratio ? ' on' : ''), onclick: () => { ratio = r; $$('.ratio', grid).forEach((x) => x.classList.toggle('on', x === b)); } },
          h('i', { style: { width: Math.round(w * s) + 'px', height: Math.round(hh * s) + 'px' } }), h('b', null, r), h('small', null, labels[r]));
        grid.append(b);
      }
      const name = h('input', { class: 'txt-in', value: 'My video ' + new Date().toLocaleDateString(), 'aria-label': 'Project name' });
      c.append(h('h2', null, 'New project'), h('p', { class: 'sub' }, 'Pick a shape. You can change it later.'), grid,
        h('div', { class: 'fld' }, h('label', null, 'Name'), name),
        h('div', { class: 'modal-foot' }, h('button', { class: 'btn ghost', onclick: close }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: async () => { const p = M.newProject(name.value.trim() || 'Untitled', ratio); await Store.put('projects', p); close(); openProject(p); } }, 'Create')));
    });
  }

  async function openProject(p) {
    M.ensure(p);
    st.project = p; st.sel = null; st.hist = []; st.fut = []; st.navSub = null;
    engine.pause();
    engine.setProject(p);
    for (const c of p.video) { const m = mediaById(c.mediaId); if (m) await engine.addMedia(m); }
    for (const s of p.audio) { const m = mediaById(s.mediaId); if (m) await engine.addMedia(m); }
    for (const l of p.pip) { const m = mediaById(l.mediaId); if (m) await engine.addMedia(m); }
    if (p.bg.mediaId) { const m = mediaById(p.bg.mediaId); if (m) await engine.addMedia(m); }
    $('#home').classList.add('hidden');
    $('#editor').classList.remove('hidden');
    $('#projName').value = p.name;
    sizeCanvas();
    engine.time = 0;
    setTab(st.tab, true);
    refresh();
    await engine.seekTo(0);
  }
  async function closeProject() {
    engine.pause();
    await saveNow();
    st.project = null;
    $('#editor').classList.add('hidden');
    $('#home').classList.remove('hidden');
    closeSheets();
    renderHome();
  }
  function sizeCanvas() {
    const small = window.innerWidth < 900;
    const hd = st.project.hd !== false;
    const { w, h: hh } = M.size(st.project, small ? (hd ? 1080 : 720) : (hd ? 1280 : 960));
    canvas.width = w; canvas.height = hh;
    fitCanvas();
  }
  function fitCanvas() {
    const wrap = $('#pvWrap');
    const W = wrap.clientWidth - 24, H = wrap.clientHeight - 24;
    if (W <= 0 || H <= 0) return;
    const s = Math.min(W / canvas.width, H / canvas.height);
    const cw = Math.floor(canvas.width * s), ch = Math.floor(canvas.height * s);
    Object.assign(canvas.style, { width: cw + 'px', height: ch + 'px', left: Math.round((wrap.clientWidth - cw) / 2) + 'px', top: Math.round((wrap.clientHeight - ch) / 2) + 'px' });
  }
  if (window.ResizeObserver) new ResizeObserver(fitCanvas).observe($('#pvWrap'));

  // ---------------- history & saving ----------------
  let saveT = 0, snapped = false;
  function snap() {
    if (snapped) return;
    st.hist.push(JSON.stringify(st.project));
    if (st.hist.length > 80) st.hist.shift();
    st.fut = [];
    snapped = true;
    setTimeout(() => { snapped = false; }, 0);
  }
  function edit(fn, soft) {
    snap();
    fn();
    refresh(soft);
  }
  function updateHdPill() { const b = $('#hdPill'); if (b && st.project) { const hd = st.project.hd !== false; b.textContent = hd ? '1080p HD' : '720p'; b.classList.toggle('on', hd); } }
  function refresh(soft) {
    const p = st.project;
    if (!p) return;
    updateHdPill();
    p.updated = Date.now();
    engine.prune();
    renderTimeline();
    if (!soft) renderInspector();
    if (st.tab === 'filters' && !soft) renderTab();
    $('#tDur').textContent = M.fmt(M.duration(p));
    $('#pvEmpty').classList.toggle('hidden', p.video.length > 0 || p.overlays.length > 0);
    $('#undo').disabled = !st.hist.length; $('#redo').disabled = !st.fut.length;
    if (!engine.playing) engine.drawAt(engine.time, true);
    clearTimeout(saveT); saveT = setTimeout(saveNow, 700);
  }
  async function saveNow() {
    clearTimeout(saveT);
    const p = st.project;
    if (!p) return;
    try {
      if (p.cover != null && p.thumb) throw 0; // a cover frame was picked: keep it
      const c = document.createElement('canvas');
      const s = 220 / Math.max(canvas.width, canvas.height);
      c.width = Math.round(canvas.width * s); c.height = Math.round(canvas.height * s);
      c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
      p.thumb = c.toDataURL('image/jpeg', 0.7);
    } catch (_) { /* tainted or empty */ }
    await Store.put('projects', p).catch(fail);
  }
  function undo(redo) {
    const from = redo ? st.fut : st.hist, to = redo ? st.hist : st.fut;
    if (!from.length) return;
    to.push(JSON.stringify(st.project));
    const p = JSON.parse(from.pop());
    Object.keys(st.project).forEach((k) => delete st.project[k]);
    Object.assign(st.project, p);
    if (st.sel && !M.find(st.project, st.sel)) st.sel = null;
    refresh();
  }

  // ---------------- selection ----------------
  function selected() { return st.sel ? M.find(st.project, st.sel) : null; }
  function select(id, openEdit) {
    st.sel = id;
    renderTimeline(); renderInspector();
    // keep the picked item in view (new rows such as effects can be below the fold)
    const el = id && $('.item[data-id="' + id + '"]');
    if (el) { const sc = $('#tlScroll'), r = el.getBoundingClientRect(), sr = sc.getBoundingClientRect(); if (r.bottom > sr.bottom - 4) sc.scrollTop += r.bottom - sr.bottom + 10; else if (r.top < sr.top + 30) sc.scrollTop -= sr.top + 30 - r.top; }
    if (st.tab === 'filters') renderTab();
    if (openEdit && isPhone() && id) openSheet('edit');
  }
  const isPhone = () => window.innerWidth <= 900;

  // ---------------- tabs and sheets ----------------
  function setTab(tab, quiet) {
    if (tab === 'edit') { openSheet('edit'); return; }
    st.tab = tab;
    $$('#libTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    renderTab();
    if (!quiet && isPhone()) openSheet('lib');
  }
  function openSheet(which) {
    st.sheet = which;
    $('#lib').classList.toggle('open', which === 'lib');
    $('#insp').classList.toggle('open', which === 'edit');

  }
  function closeSheets() { openSheet(null); }

  /** Open the Edit sheet and scroll to one control (phones). */
  function editAt(label) {
    openSheet('edit');
    setTimeout(() => {
      const f = $$('#inspBody .fld').find((x) => x.textContent.trim().startsWith(label));
      if (f) f.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 60);
  }
  function placeAddBtn() {
    const ab = $('#addClipBtn'), v2 = $('.track.video');
    if (ab) ab.style.display = st.project && st.project.video.length ? '' : 'none';
    if (ab && v2) ab.style.top =(v2.offsetTop - $('#tlScroll').scrollTop + v2.offsetHeight / 2) + 'px';
  }
  /** Pick the clip under the playhead (for Edit and Adjust with nothing selected). */
  function selectAtPlayhead(then) {
    const at = M.videoAt(st.project, engine.time)[0];
    if (!at) { toast('Add a video or photo first'); return; }
    select(at.clip.id);
    if (then) then();
  }
  function renderBottomNav() {
    const nav = $('#bottomNav');
    if (!nav) return;
    const f = selected();
    const T = (icon, label, fn, cls, badge) => h('button', { class: cls || '', onclick: fn, html: Icons.svg(icon, 26) + (badge ? '<em class="ai-badge">AI</em>' : '') + '<span>' + label + '</span>' });
    const sub = (name) => () => { st.navSub = name; renderBottomNav(); };
    const up = T('back', '', () => { st.navSub = null; renderBottomNav(); }, 'back');
    let tools;
    if (!f && st.navSub === 'generate') {
      tools = [up, T('image', 'AI image', () => imageDialog()), T('video', 'AI video', () => videoDialog()), T('chat', 'AI dialogue scene', () => dialogueDialog()),
        T('folder', 'Generated', () => generatedDialog()), T('gear', 'AI keys', () => aiSettingsDialog())];
    } else if (!f && st.navSub === 'audio') {
      tools = [up, T('audio', 'Sounds', () => setTab('sounds')), T('detach', 'From video', () => $('#fileVidAudio').click()), T('media', 'My TikTok', tiktokDialog),
        T('voice', 'Record', recordDialog), T('ai', 'AI voice', () => voiceDialog(), '', true)];
    } else if (!f && st.navSub === 'text') {
      tools = [up, T('plus', 'Add text', () => addText({})), T('text', 'Text styles', () => setTab('text')), T('captions', 'Auto captions', () => setTab('captions')),
        T('ai', 'AI writer', () => writerDialog(), '', true), T('sticker', 'Stickers', () => setTab('stickers'))];
    } else if (!f) {
      st.navSub = null;
      tools = [
        T('edit', 'Edit', () => selectAtPlayhead()), T('audio', 'Audio', sub('audio')), T('text', 'Text', sub('text')), T('effects', 'Effects', () => setTab('effects')),
        T('overlay', 'Overlay', () => setTab('overlay')), T('captions', 'Captions', () => setTab('captions')), T('filter', 'Filters', () => setTab('filters')),
        T('adjust', 'Adjust', () => selectAtPlayhead(() => editAt('Brightness'))), T('sticker', 'Stickers', () => setTab('stickers')),
        T('ai', 'Generate media', sub('generate'), 'gen', true), T('avatar', 'AI avatar', () => avatarDialog(), '', true),
        T('ratio', 'Aspect ratio', ratioDialog), T('background', 'Background', backgroundDialog), T('media', 'Media', () => setTab('media')), T('gear', 'AI keys', () => aiSettingsDialog()),
      ];
    } else {
      const back = T('back', '', () => select(null), 'back');
      if (f.list === 'video') {
        const v = f.item.kind === 'video';
        tools = [back, T('split', 'Split', () => act('split')), v ? T('speed', 'Speed', () => editAt('Speed')) : T('speed', 'Length', () => editAt('Length')),
          v ? T('volume', 'Volume', () => editAt('Volume')) : null, T('filter', 'Filters', () => setTab('filters')), T('adjust', 'Adjust', () => editAt('Brightness')),
          T('crop', 'Fit & zoom', () => editAt('Fit')), T('transition', 'Transition', () => editAt('Transition')), v ? T('detach', 'Extract audio', () => act('detach')) : null,
          T('overlay', 'To overlay', () => act('tooverlay')), T('copy', 'Copy', () => act('duplicate')), T('trash', 'Delete', () => act('delete'))].filter(Boolean);
      } else if (f.list === 'audio') {
        tools = [back, T('split', 'Split', () => act('split')), T('volume', 'Volume', () => editAt('Volume')), T('fade', 'Fade', () => editAt('Fade in')),
          T('copy', 'Copy', () => act('duplicate')), T('trash', 'Delete', () => act('delete'))];
      } else if (f.list === 'pip') {
        const v = f.item.kind === 'video';
        tools = [back, T('split', 'Split', () => act('split')), T('crop', 'Size', () => editAt('Size')), T('overlay', 'Shape', () => editAt('Shape')),
          T('fade', 'Opacity', () => editAt('Opacity')), T('effects', 'Blend', () => editAt('Blend')), v ? T('volume', 'Volume', () => editAt('Volume')) : null,
          T('filter', 'Filter', () => editAt('Filter')), T('adjust', 'Adjust', () => editAt('Brightness')), T('media', 'To main track', () => act('tomain')),
          T('copy', 'Copy', () => act('duplicate')), T('trash', 'Delete', () => act('delete'))].filter(Boolean);
      } else if (f.list === 'effects') {
        tools = [back, T('effects', 'Change', () => editAt('Effect')), T('adjust', 'Strength', () => editAt('Strength')), T('split', 'Split', () => act('split')),
          T('copy', 'Copy', () => act('duplicate')), T('trash', 'Delete', () => act('delete'))];
      } else {
        tools = [back, T('edit', 'Edit', () => editAt('Words')), T('text', 'Font', () => editAt('Font')), T('effects', 'Animation', () => editAt('Animation')),
          T('split', 'Split', () => act('split')), T('copy', 'Copy', () => act('duplicate')), T('trash', 'Delete', () => act('delete'))];
      }
    }
    const mode = (f ? f.list + ':' + f.item.id : '') + '|' + (st.navSub || '');
    nav.innerHTML = '';
    nav.classList.toggle('ctx', !!f || !!st.navSub);
    tools.forEach((t) => nav.append(t));
    if (nav.dataset.mode !== mode) { nav.dataset.mode = mode; nav.scrollLeft = 0; }
  }

  function renderTab() {
    const body = $('#tabBody');
    if (!body || !st.project) return;
    body.innerHTML = '';
    ({ media: tabMedia, sounds: tabSounds, text: tabText, stickers: tabStickers, filters: tabFilters, effects: tabEffects, overlay: tabOverlay, captions: tabCaptions, ai: tabAI })[st.tab](body);
  }

  // ---- Media tab ----
  function tabMedia(body) {
    body.append(h('button', { class: 'import', onclick: () => $('#fileMedia').click() }, '＋ Import videos and photos'));
    const vis = st.media.filter((m) => m.kind !== 'audio');
    const grid = h('div', { class: 'media-grid', style: { marginTop: '12px' } });
    for (const m of vis) {
      const tile = h('button', { class: 'mtile', title: m.name + ' — tap to add', style: { backgroundImage: m.thumb ? 'url(' + m.thumb + ')' : '' }, onclick: () => addClip(m) },
        h('span', { class: 'add' }, '＋'),
        m.kind === 'video' ? h('span', { class: 'd' }, M.fmt(m.duration).replace(/\.\d$/, '')) : h('span', { class: 'd' }, 'Photo'),
        h('span', { class: 'x', role: 'button', title: 'More', onclick: (e) => { e.stopPropagation(); mediaMenu(m); } }, '⋯'));
      grid.append(tile);
    }
    body.append(grid);
    if (!vis.length) body.append(h('p', { class: 'muted' }, 'Your videos and photos show up here. They stay on this device.'));
  }
  function mediaMenu(m) {
    modal((c, close) => {
      c.append(h('h2', null, m.name), h('p', { class: 'sub' }, (m.kind === 'video' ? 'Video · ' + M.fmt(m.duration) : 'Photo') + ' · ' + (m.w || '?') + '×' + (m.h || '?')),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', onclick: () => { close(); addClip(m); } }, 'Add to timeline'),
          m.kind === 'video' ? h('button', { class: 'btn', onclick: async () => { close(); try { toast('Taking the sound out…', 9000); const s = await extractSound(m.blob, 'extract', m.name.replace(/\.[^.]+$/, '') + ' (sound)'); toast('Saved "' + s.name + '" in Sounds'); } catch (e) { fail(e); } } }, 'Save its sound to Sounds') : null,
          h('button', { class: 'btn danger', onclick: () => { close(); deleteMedia(m); } }, 'Delete')),
        h('div', { class: 'modal-foot' }, h('button', { class: 'btn ghost', onclick: close }, 'Close')));
    });
  }
  async function addClip(m, quiet) {
    await engine.addMedia(m);
    const p = st.project;
    edit(() => {
      const c = M.makeClip(m);
      // insert after the clip under the playhead (or at the end)
      const L = M.layout(p);
      const at = L.findIndex((r) => engine.time >= r.start && engine.time < r.end);
      const idx = at < 0 ? p.video.length : at + 1;
      p.video.splice(idx, 0, c);
      st.sel = c.id;
      const start = M.layout(p)[idx].start;
      engine.time = start;
    });
    if (quiet) return;
    if (isPhone()) closeSheets();
    engine.seekTo(engine.time);
  }

  // ---- Sounds tab ----
  let previewAudio = null, previewId = null, previewNode = null;
  function stopPreview() {
    if (previewAudio) { previewAudio.pause(); URL.revokeObjectURL(previewAudio.src); previewAudio = null; }
    if (previewNode) { try { previewNode.stop(); } catch (_) { /* */ } previewNode = null; }
    previewId = null;
    $$('.snd .pp.on').forEach((b) => { b.classList.remove('on'); b.textContent = '▶'; });
  }
  function previewMedia(m, btn) {
    const same = previewId === m.id; stopPreview(); if (same) return;
    previewAudio = new Audio(URL.createObjectURL(m.blob)); previewAudio.play().catch(() => {});
    previewAudio.onended = stopPreview; previewId = m.id;
    btn.classList.add('on'); btn.textContent = '■';
  }
  async function previewBuiltin(s, btn) {
    const same = previewId === 'b:' + s.id; stopPreview(); if (same) return;
    const buf = await window.Synth.render(s.id);
    if (!engine.actx) engine.actx = new AudioContext();
    await engine.actx.resume();
    const n = engine.actx.createBufferSource(); n.buffer = buf; n.connect(engine.actx.destination); n.start();
    n.onended = () => { if (previewNode === n) stopPreview(); };
    previewNode = n; previewId = 'b:' + s.id;
    btn.classList.add('on'); btn.textContent = '■';
  }
  const SRC_LABEL = { tiktok: ['TikTok', 'tiktok'], recording: ['Voice', 'rec'], builtin: ['Built-in', 'builtin'], extract: ['From video', ''], file: ['File', ''], link: ['Link', ''] };

  function tabSounds(body) {
    body.append(
      h('div', { class: 'sec' }, h('h3', null, 'Bring in sounds'),
        h('div', { class: 'src-grid' },
          h('button', { class: 'src tiktok', onclick: tiktokDialog }, h('span', { class: 'ic' }, '♪'), h('span', null, h('b', null, 'My TikTok videos'), h('small', null, 'Sound from videos you posted'))),
          h('button', { class: 'src', onclick: () => $('#fileVidAudio').click() }, h('span', { class: 'ic' }, '🎞'), h('span', null, h('b', null, 'From a video'), h('small', null, 'Take the sound out of any video file'))),
          h('button', { class: 'src', onclick: () => $('#fileAudio').click() }, h('span', { class: 'ic' }, '🎵'), h('span', null, h('b', null, 'Audio file'), h('small', null, 'MP3, M4A, WAV, OGG…'))),
          h('button', { class: 'src', onclick: recordDialog }, h('span', { class: 'ic' }, '🎙'), h('span', null, h('b', null, 'Record voice'), h('small', null, 'Voice-over, also while watching'))),
          h('button', { class: 'src', onclick: linkDialog }, h('span', { class: 'ic' }, '🔗'), h('span', null, h('b', null, 'From a link'), h('small', null, 'Direct link to an audio or video file'))),
          h('button', { class: 'src', onclick: librariesDialog }, h('span', { class: 'ic' }, '🌐'), h('span', null, h('b', null, 'Free music sites'), h('small', null, 'Royalty-free libraries'))))));

    const mine = st.media.filter((m) => m.kind === 'audio' && m.source !== 'builtin' || m.kind === 'audio' && m.source === 'builtin' && false);
    const sec = h('div', { class: 'sec' }, h('h3', null, 'My sounds'));
    if (!mine.length) sec.append(h('p', { class: 'muted', style: { fontSize: '12.5px' } }, 'Sounds you bring in are kept here for every project.'));
    for (const m of mine) {
      const [lab, cls] = SRC_LABEL[m.source] || ['File', ''];
      const pp = h('button', { class: 'pp', 'aria-label': 'Preview', onclick: () => previewMedia(m, pp) }, '▶');
      sec.append(h('div', { class: 'snd' }, pp,
        h('div', { class: 'info' }, h('b', null, m.name), h('small', null, h('span', { class: 'badge ' + cls }, lab), M.fmt(m.duration))),
        h('button', { class: 'add', title: 'Add at playhead', onclick: () => addSound(m) }, '+'),
        h('button', { class: 'menu', title: 'More', onclick: () => soundMenu(m) }, '⋯')));
    }
    body.append(sec);

    for (const group of ['Effects', 'Music']) {
      const g = h('div', { class: 'sec' }, h('h3', null, 'Built-in ' + group.toLowerCase() + ' (free to use anywhere)'));
      for (const s of window.Synth.SOUNDS.filter((x) => x.group === group)) {
        const pp = h('button', { class: 'pp', 'aria-label': 'Preview', onclick: () => previewBuiltin(s, pp).catch(fail) }, '▶');
        g.append(h('div', { class: 'snd' }, pp,
          h('div', { class: 'info' }, h('b', null, s.name), h('small', null, h('span', { class: 'badge builtin' }, 'Built-in'), M.fmt(s.dur))),
          h('button', { class: 'add', title: 'Add at playhead', onclick: () => addBuiltin(s).catch(fail) }, '+')));
      }
      body.append(g);
    }
  }
  function soundMenu(m) {
    modal((c, close) => {
      const name = h('input', { class: 'txt-in', value: m.name });
      c.append(h('h2', null, 'Sound'), h('p', { class: 'sub' }, M.fmt(m.duration) + ' · ' + ((SRC_LABEL[m.source] || ['File'])[0])),
        h('div', { class: 'fld' }, h('label', null, 'Name'), name),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', onclick: () => { close(); addSound(m); } }, 'Add at playhead'),
          h('button', { class: 'btn', onclick: async () => { try { const buf = await decode(m.blob); toast(await Platform.save(bufferToWav(buf), safeName(m.name) + '.wav', { kind: 'audio' })); } catch (e) { fail(e); } } }, 'Save as WAV'),
          h('button', { class: 'btn danger', onclick: () => { close(); deleteMedia(m); } }, 'Delete')),
        h('div', { class: 'modal-foot' }, h('button', { class: 'btn ghost', onclick: close }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: async () => { m.name = name.value.trim() || m.name; await Store.put('media', m); close(); renderTab(); } }, 'Save')));
    });
  }
  const safeName = (s) => String(s || 'cliploom').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);

  async function addSound(m) {
    stopPreview();
    await engine.addMedia(m);
    const p = st.project;
    let id = null;
    edit(() => {
      const start = engine.time;
      const s = M.makeSound(m, start);
      s.lane = M.freeLane(p, start, start + M.soundDur(s));
      if (m.source === 'builtin' && m.duration < 3) s.fx = true;
      p.audio.push(s); id = s.id;
    });
    select(id);
    toast('Added "' + m.name + '"');
    if (isPhone()) closeSheets();
  }
  async function addBuiltin(s) {
    let m = mediaById('builtin-' + s.id);
    if (!m) {
      const buf = await window.Synth.render(s.id);
      m = await saveMedia({ id: 'builtin-' + s.id, name: s.name, kind: 'audio', type: 'audio/wav', blob: bufferToWav(buf), duration: buf.duration, peaks: bufferPeaks(buf), source: 'builtin' });
    }
    return addSound(m);
  }

  // ---- TikTok ----
  function tiktokDialog() {
    modal((c, close) => {
      const list = h('div', { class: 'list-box' });
      const status = h('p', { class: 'muted', style: { fontSize: '12.5px' } });
      const pickVideos = h('button', { class: 'btn primary', onclick: () => { st.tiktokPick = true; $('#fileVidAudio').click(); } }, 'Pick my saved TikTok videos');
      const pickExport = h('button', { class: 'btn', onclick: () => $('#fileTikTok').click() }, 'Open my TikTok data (ZIP or JSON)');
      st.tiktokList = (res) => renderTikTokExport(res, list, status);
      c.append(
        h('h2', null, 'Sounds from my TikTok'),
        h('p', { class: 'sub' }, 'Use the sound from videos you made. Each video becomes a sound in My sounds.'),
        h('ol', { class: 'steps' },
          h('li', null, h('b', null, 'Save your videos from TikTok. '), 'In the TikTok app, open one of your videos, tap ', h('b', null, 'Share'), ' (the arrow) and then ', h('b', null, 'Save video'), '. It goes to your gallery. On a computer, open your video on tiktok.com and use Download, or copy the files from your phone.'),
          h('li', null, h('b', null, 'Pick them here. '), 'You can pick many at once. Cliploom takes the sound out and keeps it.', h('div', { class: 'row', style: { marginTop: '8px' } }, pickVideos)),
          h('li', null, h('b', null, 'Lost track of your posts? '), 'In TikTok go to ', h('b', null, 'Profile › ☰ › Settings and privacy › Account › Download your data'), ', choose ', h('b', null, 'JSON'), ' and request it. When it is ready, download the ZIP and open it here to see all your posts with links. TikTok does not put the video files in that ZIP, so open each post and save it as in step 1.', h('div', { class: 'row', style: { marginTop: '8px' } }, pickExport))),
        h('p', { class: 'note warn' }, h('b', null, 'About TikTok music. '), 'If your video used a song from TikTok\'s sound library, that song is licensed for use inside TikTok only. Your own voice and sounds you made are yours to reuse; for songs, use the built-in music or a royalty-free site, or your post elsewhere may be muted or taken down.'),
        status, list,
        h('div', { class: 'modal-foot' }, h('button', { class: 'btn ghost', onclick: close }, 'Done')));
    }, () => { st.tiktokList = null; });
  }
  function renderTikTokExport(res, list, status) {
    list.innerHTML = '';
    const n = res.posts.length;
    status.textContent = n ? 'Found ' + n + ' of your posts' + (res.sounds.length ? ' and ' + res.sounds.length + ' favourite sounds.' : '.') : 'No posts were found in this file. Make sure you chose the JSON format.';
    const row = (x, kind) => h('div', { class: 'post' },
      h('div', { class: 'info' }, h('b', null, x.title || x.sound || (kind === 'sound' ? 'Favourite sound' : 'Post')), h('small', null, S.niceDate(x.date) + (x.likes ? ' · ' + x.likes + ' likes' : ''))),
      h('button', { class: 'btn sm', onclick: () => Platform.openExternal(x.link) }, 'Open'));
    for (const x of res.posts) list.append(row(x, 'post'));
    if (res.sounds.length) {
      list.append(h('p', { class: 'note', style: { marginTop: '10px' } }, 'Favourite sounds are other people\'s audio. Open them in TikTok to use them there; they are not downloaded here.'));
      for (const x of res.sounds.slice(0, 200)) list.append(row(x, 'sound'));
    }
  }

  async function onVideoAudioFiles(files) {
    const fromTikTok = !!st.tiktokPick; st.tiktokPick = false;
    let n = 0;
    for (const f of files) {
      try {
        toast('Adding the sound of ' + f.name + '…', 6000);
        const when = f.lastModified ? S.niceDate(new Date(f.lastModified).toISOString()) : '';
        const base = f.name.replace(/\.[^.]+$/, '');
        const name = fromTikTok ? 'TikTok sound' + (when ? ' · ' + when : '') + (/^[\w-]{1,24}$/.test(base) && !/^\d{6,}|^v\d/.test(base) ? ' · ' + base : '') : base;
        await extractSound(f, fromTikTok ? 'tiktok' : 'extract', name);
        n++;
      } catch (e) { fail(e); }
    }
    if (n) toast((n === 1 ? '1 sound' : n + ' sounds') + ' added to My sounds');
    if (st.modalClose && !fromTikTok) st.modalClose();
    if (st.tab !== 'sounds') setTab('sounds', true);
    renderTab();
  }

  // ---- record ----
  function recordDialog() {
    let rec = null, stream = null, chunks = [], t0 = 0, timer = 0, raf = 0, analyser = null, actx = null;
    const withVideo = h('input', { type: 'checkbox', id: 'recWith' });
    const time = h('div', { class: 'rec-time' }, '0:00.0');
    const meter = h('canvas', { width: 500, height: 60 });
    const btn = h('button', { class: 'rec-btn', 'aria-label': 'Record' });
    const info = h('p', { class: 'muted', style: { textAlign: 'center', fontSize: '12.5px' } }, 'Tap the red button to start.');
    const startAt = engine.time;
    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch (e) { info.textContent = 'Microphone not available: ' + (e.message || e.name) + '. Allow microphone access for Cliploom.'; return; }
      const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg', 'audio/mp4'].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
      rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      chunks = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = finish;
      actx = new AudioContext(); analyser = actx.createAnalyser(); analyser.fftSize = 512;
      actx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const g = meter.getContext('2d');
      const draw = () => {
        analyser.getByteTimeDomainData(data);
        let m = 0; for (const v of data) m = Math.max(m, Math.abs(v - 128));
        g.drawImage(meter, -4, 0); g.fillStyle = '#0c0e13'; g.fillRect(meter.width - 4, 0, 4, 60);
        const hh = Math.max(2, m / 128 * 60); g.fillStyle = '#ff6b81'; g.fillRect(meter.width - 4, 30 - hh / 2, 3, hh);
        raf = requestAnimationFrame(draw);
      };
      draw();
      rec.start(250); t0 = performance.now();
      timer = setInterval(() => { time.textContent = M.fmt((performance.now() - t0) / 1000); }, 100);
      btn.classList.add('on'); info.textContent = 'Recording… tap again to stop.';
      if (withVideo.checked) { await engine.seekTo(startAt); engine.play(); }
    }
    function stopAll() {
      clearInterval(timer); cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (actx) actx.close();
      if (engine.playing) engine.pause();
    }
    async function finish() {
      stopAll();
      const blob = new Blob(chunks, { type: (rec && rec.mimeType) || 'audio/webm' });
      try {
        const n = st.media.filter((m) => m.source === 'recording').length + 1;
        const m = await importSound(blob, 'recording', 'Voice ' + n);
        close();
        const p = st.project;
        let id;
        edit(() => { const s = M.makeSound(m, startAt); s.lane = M.freeLane(p, startAt, startAt + m.duration); p.audio.push(s); id = s.id; });
        await engine.addMedia(m);
        select(id);
        toast('Voice added to the timeline and My sounds');
      } catch (e) { fail(e); }
    }
    btn.onclick = () => { if (rec && rec.state === 'recording') rec.stop(); else start(); };
    const close = modal((c, cl) => {
      c.append(h('h2', null, 'Record voice'), h('p', { class: 'sub' }, 'Recorded at the playhead (' + M.fmt(startAt) + ').'),
        time, h('div', { class: 'rec-meter' }, meter), btn, info,
        h('label', { class: 'row', style: { justifyContent: 'center', fontSize: '13px' } }, withVideo, 'Play the video while I record (use headphones)'),
        h('div', { class: 'modal-foot' }, h('button', { class: 'btn ghost', onclick: cl }, 'Cancel')));
    }, () => { if (rec && rec.state === 'recording') { rec.onstop = null; rec.stop(); } stopAll(); });
  }

  // ---- link ----
  function linkDialog() {
    modal((c, close) => {
      const url = h('input', { class: 'txt-in', placeholder: 'https://…/song.mp3', type: 'url' });
      const go = h('button', { class: 'btn primary' }, 'Get sound');
      go.onclick = async () => {
        const u = url.value.trim();
        let host = '';
        try { host = new URL(u).hostname; } catch (_) { toast('Paste a full link'); return; }
        if (/(^|\.)(tiktok\.com|tiktokv\.com|youtube\.com|youtu\.be|spotify\.com|music\.apple\.com|instagram\.com|facebook\.com)$/i.test(host)) {
          toast('That is a page, not a sound file. Save the video from the app, then use "From a video" or "My TikTok videos".', 7000); return;
        }
        go.disabled = true; go.textContent = 'Downloading…';
        try {
          const blob = await Platform.fetchMedia(u);
          const nm = decodeURIComponent(u.split('/').pop().split('?')[0] || 'Sound').replace(/\.[^.]+$/, '') || 'Sound';
          const isVid = /^video\//.test(blob.type) || /\.(mp4|mov|webm|m4v)(\?|$)/i.test(u);
          const m = isVid ? await extractSound(blob, 'link', nm) : await importSound(blob, 'link', nm);
          close(); toast('Saved "' + m.name + '" in My sounds'); renderTab();
        } catch (e) { fail(e); go.disabled = false; go.textContent = 'Get sound'; }
      };
      c.append(h('h2', null, 'Sound from a link'), h('p', { class: 'sub' }, 'A direct link to an MP3, WAV, M4A or video file, for example from a royalty-free site or your own cloud storage.'),
        h('div', { class: 'fld' }, url),
        h('p', { class: 'note' }, 'Only use audio you have the rights to. Pages like TikTok or YouTube are not files; save the video first.'),
        h('div', { class: 'modal-foot' }, h('button', { class: 'btn ghost', onclick: close }, 'Cancel'), go));
    });
  }
  function librariesDialog() {
    modal((c, close) => {
      c.append(h('h2', null, 'Free music sites'), h('p', { class: 'sub' }, 'Download a track there, then add it with "Audio file". Check each track\'s licence.'));
      for (const l of S.LIBRARIES) {
        c.append(h('div', { class: 'post' }, h('div', { class: 'info' }, h('b', null, l.name), h('small', null, l.note)), h('button', { class: 'btn sm', onclick: () => Platform.openExternal(l.url) }, 'Open')));
      }
      c.append(h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: () => { close(); $('#fileAudio').click(); } }, 'Add an audio file'), h('button', { class: 'btn ghost', onclick: close }, 'Close')));
    });
  }

  // ---- Text tab ----
  const TEXT_STYLES = [
    { label: 'Classic', o: {} },
    { label: 'Yellow', o: { color: '#ffe14d' } },
    { label: 'White box', o: { color: '#111111', box: '#ffffff', strokeW: 0, weight: 800 } },
    { label: 'Dark box', o: { color: '#ffffff', box: '#000000b0', strokeW: 0, weight: 600 } },
    { label: 'Neon', o: { color: '#d9fff4', glow: '#3ce0b4', strokeW: 0 } },
    { label: 'Pink pop', o: { color: '#ffffff', stroke: '#ff2d7a', strokeW: 0.16 } },
    { label: 'TITLE', o: { font: 'Anton', weight: 400, size: 0.11, strokeW: 0.07 } },
    { label: 'BEBAS', o: { font: 'Bebas', weight: 400, size: 0.12, strokeW: 0, shadow: true } },
    { label: 'Marker', o: { font: 'Marker', weight: 400, color: '#fff', stroke: '#1d1d1d', strokeW: 0.1 } },
    { label: 'Script', o: { font: 'Pacifico', weight: 400, strokeW: 0, shadow: true, anim: 'fade' } },
    { label: 'Elegant', o: { font: 'Playfair', weight: 700, strokeW: 0, shadow: true, anim: 'fade' } },
    { label: 'Caption', o: { size: 0.05, y: 0.8, box: '#000000a0', strokeW: 0, weight: 600, anim: 'fade' } },
    { label: 'Typewriter', o: { font: 'Mono', weight: 500, anim: 'type', box: '#fffffff0', color: '#111111', strokeW: 0, size: 0.055 } },
  ];
  function tabText(body) {
    body.append(h('button', { class: 'import', onclick: () => addText({}) }, 'T＋ Add text'));
    const g = h('div', { class: 'style-grid', style: { marginTop: '12px' } });
    for (const s of TEXT_STYLES) {
      const o = Object.assign(M.makeText(0), s.o);
      const css = { fontFamily: Engine.FONTS[o.font], fontWeight: o.weight, color: o.color, background: o.box ? o.box : '#2a2f40' };
      if (o.strokeW) css.webkitTextStroke = '1.5px ' + o.stroke;
      if (o.glow) css.textShadow = '0 0 10px ' + o.glow;
      if (o.shadow) css.textShadow = '0 2px 6px #000';
      g.append(h('button', { class: 'style', style: css, onclick: () => addText(s.o) }, s.label === 'TITLE' || s.label === 'BEBAS' ? s.label : s.label));
    }
    body.append(h('div', { class: 'sec' }, g),
      h('p', { class: 'note' }, 'Drag text on the preview to move it. Change words, font, colour and animation in Edit.'));
  }
  function addText(opts, text) {
    let id;
    edit(() => { const o = M.makeText(engine.time, Object.assign({}, opts)); if (text) o.text = text; st.project.overlays.push(o); id = o.id; });
    select(id, true);
  }

  // ---- Stickers ----
  const STICKERS = '😂 😍 🔥 ✨ 💯 ❤️ 👍 🙏 😎 🥳 😭 😱 🤯 👀 💥 ⭐ 🎉 🎵 🎬 📍 ✅ ❌ ⚡ 🌙 ☀️ 🌈 🍕 ☕ 🚀 💪 👑 💎 🎁 📸 💬 ⬆️ ⬇️ ➡️ ⬅️ 🤲 🕌 📿 🌴 🦁'.split(' ');
  function tabStickers(body) {
    const g = h('div', { class: 'sticker-grid' });
    for (const e of STICKERS) g.append(h('button', { onclick: () => addText({ size: 0.16, strokeW: 0, anim: 'pop', weight: 400 }, e) }, e));
    body.append(g, h('p', { class: 'note', style: { marginTop: '12px' } }, 'Stickers work like text: drag them on the preview and set size and animation in Edit.'));
  }

  // ---- Filters ----
  function targetClip() {
    const f = selected();
    if (f && f.list === 'video') return f.item;
    const at = M.videoAt(st.project, engine.time)[0];
    return at ? at.clip : null;
  }
  function tabFilters(body) {
    const c = targetClip();
    if (!c) { body.append(h('p', { class: 'muted' }, 'Add a video or photo first, then pick a filter for it.')); return; }
    const m = mediaById(c.mediaId);
    const g = h('div', { class: 'filter-grid' });
    for (const k of Object.keys(Engine.FILTERS)) {
      g.append(h('button', { class: 'ftile' + (c.filter === k ? ' on' : ''), onclick: () => edit(() => { c.filter = k; }) },
        h('i', { style: { backgroundImage: m && m.thumb ? 'url(' + m.thumb + ')' : '', filter: Engine.FILTERS[k].css || 'none' } }), Engine.FILTERS[k].name));
    }
    body.append(h('div', { class: 'sec' }, h('h3', null, 'Filter for the selected clip'), g),
      h('button', { class: 'btn', onclick: () => edit(() => { st.project.video.forEach((x) => { x.filter = c.filter; x.adjust = Object.assign({}, c.adjust); }); toast('Applied to all clips'); }) }, 'Apply to all clips'));
  }

  // ---------------- effects ----------------
  function tabEffects(body) {
    const E = Engine.EFFECTS;
    const groups = {};
    for (const k of Object.keys(E)) (groups[E[k].group] = groups[E[k].group] || []).push(k);
    body.append(h('p', { class: 'note', style: { marginTop: 0 } }, 'Tap an effect to add it at the playhead. It gets its own row on the timeline: drag its ends to make it longer or shorter.'));
    for (const g of Object.keys(groups)) {
      const grid = h('div', { class: 'fx-grid' });
      for (const k of groups[g]) grid.append(h('button', { class: 'fx-tile fx-' + k, onclick: () => addEffect(k) }, h('i'), h('span', null, E[k].name)));
      body.append(h('div', { class: 'sec' }, h('h3', null, g), grid));
    }
  }
  function addEffect(type) {
    const p = st.project;
    if (!p.video.length && !p.pip.length) { toast('Add a video or photo first'); return; }
    let id;
    edit(() => {
      const start = type === 'close' ? Math.max(0, M.videoEnd(p) - 1.5) : engine.time;
      const e = M.makeEffect(type, start, { dur: type === 'open' || type === 'close' ? 1.5 : 2, seed: Math.floor(Math.random() * 1000) });
      e.lane = M.freeRow(p, 'effects', e.start, e.start + e.dur);
      p.effects.push(e); id = e.id;
    });
    select(id);
    if (isPhone()) closeSheets();
    engine.seekTo(M.find(p, id).item.start);
    toast((Engine.EFFECTS[type] || {}).name + ' added');
  }

  // ---------------- overlay (picture in picture) ----------------
  function tabOverlay(body) {
    body.append(h('button', { class: 'import', onclick: () => { st.importAs = 'overlay'; $('#fileMedia').click(); } }, '＋ Import a video or photo as overlay'),
      h('div', { class: 'row', style: { marginTop: '8px' } },
        h('button', { class: 'btn sm', onclick: () => imageDialog({ as: 'overlay' }) }, '✦ AI picture as overlay'),
        h('button', { class: 'btn sm', onclick: () => avatarDialog() }, '✦ AI avatar')),
      h('p', { class: 'note' }, 'An overlay sits on top of the main video: a reaction cam, a logo, a second angle. Tap one of your files below to add it at the playhead, then drag it on the preview.'));
    const vis = st.media.filter((m) => m.kind !== 'audio');
    const grid = h('div', { class: 'media-grid', style: { marginTop: '10px' } });
    for (const m of vis) {
      grid.append(h('button', { class: 'mtile', title: m.name + ' — add as overlay', style: { backgroundImage: m.thumb ? 'url(' + m.thumb + ')' : '' }, onclick: () => addLayer(m) },
        h('span', { class: 'add' }, '＋'), h('span', { class: 'd' }, m.kind === 'video' ? M.fmt(m.duration).replace(/\.\d$/, '') : m.source === 'ai' ? 'AI' : 'Photo')));
    }
    body.append(grid);
    if (!vis.length) body.append(h('p', { class: 'muted' }, 'Import a video or photo first.'));
  }
  async function addLayer(m, quiet, opts) {
    await engine.addMedia(m);
    const p = st.project;
    let id;
    edit(() => {
      const l = M.makeLayer(m, engine.time, opts);
      l.lane = M.freeRow(p, 'pip', l.start, l.start + M.clipDur(l));
      p.pip.push(l); id = l.id;
    });
    select(id);
    if (!quiet) { if (isPhone()) closeSheets(); toast('Overlay added. Drag it on the preview to move it.'); }
    return id;
  }

  // ---------------- aspect ratio, background, cover ----------------
  function ratioDialog() {
    const p = st.project;
    modal((c, close) => {
      const grid = h('div', { class: 'ratio-grid' });
      const labels = { '9:16': 'TikTok, Reels, Shorts', '16:9': 'YouTube, TV', '1:1': 'Square posts', '4:5': 'Instagram feed', '3:4': 'Portrait', '21:9': 'Cinema' };
      for (const r of Object.keys(M.RATIOS)) {
        const [w, hh] = M.RATIOS[r]; const sc = 40 / Math.max(w, hh);
        grid.append(h('button', { class: 'ratio' + (r === p.ratio ? ' on' : ''), onclick: () => { edit(() => { p.ratio = r; sizeCanvas(); }); close(); toast('Aspect ratio ' + r); } },
          h('i', { style: { width: Math.round(w * sc) + 'px', height: Math.round(hh * sc) + 'px' } }), h('b', null, r), h('small', null, labels[r])));
      }
      c.append(h('h2', null, 'Aspect ratio'), h('p', { class: 'sub' }, 'The shape of your video. Clips that do not fit get the background you pick under Background.'), grid,
        h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: () => { close(); backgroundDialog(); } }, 'Background…'), h('div', { class: 'grow' }), h('button', { class: 'btn ghost', onclick: close }, 'Close')));
    });
  }
  function backgroundDialog() {
    const p = st.project;
    modal((c, close) => {
      const pics = st.media.filter((m) => m.kind === 'image');
      const grid = h('div', { class: 'media-grid', style: { marginTop: '6px' } });
      for (const m of pics) grid.append(h('button', { class: 'mtile' + (p.bg.mediaId === m.id && p.bg.mode === 'image' ? ' on' : ''), style: { backgroundImage: m.thumb ? 'url(' + m.thumb + ')' : '' }, onclick: () => { setBgImage(m); close(); } }));
      const sw = h('div', { class: 'swatches' });
      for (const col of ['#000000', '#ffffff', '#111827', '#1f2937', '#3ce0b4', '#8b7bff', '#ff2d7a', '#ffe14d', '#4da3ff', '#ff9f43', '#1d8f5a', '#7c2d12']) {
        sw.append(h('button', { class: 'sw' + (p.bg.mode === 'color' && p.bg.color === col ? ' on' : ''), style: { background: col }, onclick: () => { edit(() => { p.bg.mode = 'color'; p.bg.color = col; }); close(); } }));
      }
      const pick = h('input', { type: 'color', value: (p.bg.color || '#000000').slice(0, 7) });
      pick.onchange = () => { edit(() => { p.bg.mode = 'color'; p.bg.color = pick.value; }); };
      sw.append(pick);
      c.append(h('h2', null, 'Background'), h('p', { class: 'sub' }, 'Shows behind clips that do not fill the frame (set a clip to Fit to see it).'),
        h('div', { class: 'row' },
          h('button', { class: 'btn' + (p.bg.mode === 'blur' ? ' primary' : ''), onclick: () => { edit(() => { p.bg.mode = 'blur'; }); close(); } }, 'Blur of the clip'),
          h('button', { class: 'btn', onclick: () => { close(); imageDialog({ as: 'background' }); } }, '✦ Make one with AI'),
          h('button', { class: 'btn', onclick: () => { st.bgPick = true; $('#fileBg').click(); close(); } }, 'Photo from device')),
        fld('Colour', sw),
        pics.length ? fld('Your pictures', grid) : null,
        h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: () => { edit(() => { p.video.forEach((x) => { x.fit = 'fit'; }); }); toast('All clips set to Fit'); } }, 'Fit all clips'), h('div', { class: 'grow' }), h('button', { class: 'btn ghost', onclick: close }, 'Close')));
    });
  }
  async function setBgImage(m) {
    await engine.addMedia(m);
    edit(() => { st.project.bg.mode = 'image'; st.project.bg.mediaId = m.id; });
    toast('Background set');
  }
  async function setCover() {
    const p = st.project;
    if (!p.video.length) { toast('Add a clip first'); return; }
    await engine.drawAt(engine.time, true);
    const c = document.createElement('canvas');
    const sc = 220 / Math.max(canvas.width, canvas.height);
    c.width = Math.round(canvas.width * sc); c.height = Math.round(canvas.height * sc);
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    edit(() => { p.cover = engine.time; p.thumb = c.toDataURL('image/jpeg', 0.75); });
    toast('Cover set to the frame at ' + M.fmt(engine.time));
  }

  // ---------------- AI: settings and helpers ----------------
  const AI = window.AI;
  function aiSettingsDialog(after) {
    modal(async (c, close) => {
      const cfg = await AI.settings();
      const inputs = {};
      const rows = [];
      for (const k of Object.keys(AI.PROVIDERS)) {
        const P = AI.PROVIDERS[k];
        const inp = h('input', { class: 'txt-in', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'Paste your ' + P.name + ' API key', 'aria-label': P.name + ' key' });
        inp.value = cfg.keys[k] || '';
        inputs[k] = inp;
        const out = h('small', { class: 'muted' });
        const can = P.can.map((x) => ({ text: 'writing', image: 'pictures', video: 'video', speech: 'voices', transcribe: 'captions' }[x])).join(', ');
        rows.push(h('div', { class: 'ai-key' },
          h('div', { class: 'ai-key-h' }, h('b', null, P.name), h('small', { class: 'muted' }, P.by + ' · ' + can)),
          h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, inp,
            h('button', { class: 'btn sm', onclick: () => { inp.type = inp.type === 'password' ? 'text' : 'password'; } }, '👁'),
            h('button', { class: 'btn sm', onclick: async () => {
              out.textContent = 'Checking…';
              const keep = cfg.keys[k];
              try { cfg.keys[k] = inp.value.trim(); const r = await AI.test(k); out.textContent = '✓ Works (' + r + ')'; } catch (e) { out.textContent = '✗ ' + e.message; } finally { cfg.keys[k] = keep; }
            } }, 'Test')),
          h('div', { class: 'row', style: { justifyContent: 'space-between' } }, out, h('button', { class: 'linkish', onclick: () => Platform.openExternal(P.keyUrl) }, 'Get a key ↗'))));
      }
      const models = h('details', { class: 'adv' }, h('summary', null, 'Model names (advanced)'));
      const mIn = {};
      for (const id of Object.keys(AI.DEFAULT_MODELS)) {
        const [prov, task] = id.split('.');
        const inp = h('input', { class: 'txt-in', placeholder: AI.DEFAULT_MODELS[id], spellcheck: 'false' });
        inp.value = cfg.models[id] || '';
        mIn[id] = inp;
        models.append(h('div', { class: 'fld' }, h('label', null, AI.PROVIDERS[prov].name + ' · ' + { text: 'writing', image: 'pictures', video: 'video', speech: 'voice', transcribe: 'captions' }[task]), inp));
      }
      models.append(h('p', { class: 'note' }, 'Leave empty to use the default. Providers rename models often; if one stops working, put the new name here.'));
      c.append(h('h2', null, 'AI keys'), h('p', { class: 'sub' }, 'Cliploom uses your own accounts. Each request goes from this device straight to the provider and is billed to you.'),
        ...rows, models,
        h('p', { class: 'note' }, 'Keys are saved on this device only and are never put in your projects or exports. ChatGPT makes pictures, voices and captions; Gemini makes pictures, video, voices and captions; Claude writes scripts, captions translations and prompts.'),
        h('div', { class: 'modal-foot' }, h('button', { class: 'btn ghost', onclick: close }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: async () => {
            const keys = {}; for (const k of Object.keys(inputs)) if (inputs[k].value.trim()) keys[k] = inputs[k].value.trim();
            const ms = {}; for (const id of Object.keys(mIn)) if (mIn[id].value.trim()) ms[id] = mIn[id].value.trim();
            await AI.save({ keys, models: ms });
            close(); toast('AI keys saved on this device');
            if (after) after();
          } }, 'Save')));
    });
  }
  /** Row of provider chips for a task; providers without a key open AI settings. */
  async function providerRow(task, onChange, reopen) {
    const box = h('div', { class: 'chips prov' });
    let cur = await AI.preferred(task);
    const all = Object.keys(AI.PROVIDERS);
    const ready = await AI.ready(task);
    for (const k of all) {
      const P = AI.PROVIDERS[k];
      const able = P.can.includes(task);
      const has = ready.includes(k);
      const b = h('button', { class: 'chip' + (k === cur ? ' on' : '') + (!able || !has ? ' off' : ''), title: !able ? P.name + ' cannot do this' : !has ? 'Add a ' + P.name + ' key' : P.name },
        P.name + (!able ? ' ✕' : !has ? ' +key' : ''));
      b.onclick = () => {
        if (!able) { toast(task === 'video' && k === 'openai' ? 'OpenAI shut down its Sora video API in September 2026. Use Gemini for video.' : P.name + ' cannot do this. ' + (task === 'image' || task === 'speech' || task === 'transcribe' ? 'Pick ChatGPT or Gemini.' : 'Pick Gemini.'), 4500); return; }
        if (!has) { aiSettingsDialog(reopen); return; }
        cur = k; $$('.chip', box).forEach((x) => x.classList.toggle('on', x === b)); AI.remember(task, k); if (onChange) onChange(k);
      };
      box.append(b);
    }
    return { el: box, get: () => cur };
  }
  /** Run an AI job with a busy button and a live elapsed time. */
  async function busy(btn, msg, label, fn) {
    const t0 = Date.now();
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = 'Working…';
    const tick = setInterval(() => { msg.textContent = label + ' ' + Math.round((Date.now() - t0) / 1000) + ' s'; }, 500);
    msg.textContent = label;
    try { return await fn(); } catch (e) { msg.textContent = '✗ ' + (e.message || e); throw e; } finally { clearInterval(tick); btn.disabled = false; btn.textContent = old; }
  }
  async function saveGenerated(blob, kind, name, prompt) {
    const base = { id: M.uid('m'), name, type: blob.type, blob, source: 'ai', prompt: String(prompt || '').slice(0, 500) };
    if (kind === 'image') {
      const pr = await probeImage(blob);
      if (!pr) throw new Error('The picture could not be opened.');
      return saveMedia(Object.assign(base, { kind: 'image', duration: 0, w: pr.w, h: pr.h, thumb: pr.thumb }));
    }
    if (kind === 'video') {
      const pr = await probeVideo(blob);
      if (!pr) throw new Error('This device cannot play the video that came back.');
      const rec = await saveMedia(Object.assign(base, { kind: 'video', duration: pr.duration, w: pr.w, h: pr.h, thumb: pr.thumb }));
      queueStrip(rec);
      return rec;
    }
    const dur = await probeAudio(blob);
    if (!dur) throw new Error('The voice that came back could not be read.');
    const rec = await saveMedia(Object.assign(base, { kind: 'audio', duration: dur, peaks: null }));
    queuePeaks(rec);
    return rec;
  }
  /** Buttons for a finished picture or video. */
  function useButtons(m, close, as) {
    const go = (fn) => async () => { close(); await fn(); if (isPhone()) closeSheets(); };
    return h('div', { class: 'row' },
      h('button', { class: 'btn' + (as === 'clip' || !as ? ' primary' : ''), onclick: go(() => addClip(m)) }, 'Add to timeline'),
      h('button', { class: 'btn' + (as === 'overlay' ? ' primary' : ''), onclick: go(() => addLayer(m)) }, 'Add as overlay'),
      m.kind === 'image' ? h('button', { class: 'btn' + (as === 'background' ? ' primary' : ''), onclick: go(() => setBgImage(m)) }, 'Use as background') : null,
      h('button', { class: 'btn ghost', onclick: close }, 'Keep in Generated'));
  }
  const STYLES = [['', 'None'], ['photo', 'Photo'], ['cinematic', 'Cinematic'], ['anime', 'Anime'], ['3d', '3D render'], ['illustration', 'Illustration'], ['neon', 'Neon'], ['watercolor', 'Watercolour']];
  const STYLE_WORDS = { photo: 'realistic photo, natural light, sharp detail', cinematic: 'cinematic film still, dramatic lighting, shallow depth of field', anime: 'anime style illustration', '3d': 'soft 3D render, clay style', illustration: 'flat vector illustration', neon: 'neon lights, vibrant night colors', watercolor: 'watercolor painting' };
  function aspectFor(task) {
    const r = st.project.ratio;
    if (task === 'video') return r === '16:9' || r === '21:9' ? '16:9' : '9:16';
    return r;
  }
  async function improvePrompt(ta, msg, kind) {
    const prov = await AI.preferred('text');
    if (!prov) { aiSettingsDialog(); return; }
    msg.textContent = 'Improving with ' + AI.PROVIDERS[prov].name + '…';
    try {
      ta.value = await AI.text(prov, 'Rewrite this idea as one clear, vivid prompt for an AI ' + kind + ' generator. Keep it under 80 words. Only give the prompt.\n\nIdea: ' + ta.value.trim());
      msg.textContent = 'Prompt improved by ' + AI.PROVIDERS[prov].name + '. Edit it if you like.';
    } catch (e) { msg.textContent = '✗ ' + e.message; }
  }

  // ---------------- AI image ----------------
  function imageDialog(o) {
    o = o || {};
    modal(async (c, close) => {
      const reopen = () => imageDialog(o);
      const prov = await providerRow('image', null, reopen);
      const ta = h('textarea', { rows: 3, placeholder: o.as === 'background' ? 'e.g. soft pastel gradient with light bokeh' : 'Describe the picture, e.g. a cosy coffee shop at sunset, rain on the window' });
      ta.value = o.prompt || '';
      let style = '';
      const styles = h('div', { class: 'chips' }, STYLES.map(([v, l]) => { const b = h('button', { class: 'chip' + (v === style ? ' on' : ''), onclick: () => { style = v; $$('.chip', styles).forEach((x) => x.classList.toggle('on', x === b)); } }, l); return b; }));
      const msg = h('p', { class: 'muted', style: { fontSize: '12.5px' } }, 'Shape ' + aspectFor('image') + ' (from your project).');
      const result = h('div', { class: 'gen-result' });
      const go = h('button', { class: 'btn primary' }, 'Generate');
      go.onclick = async () => {
        const pr = ta.value.trim();
        if (!pr) { toast('Describe the picture first'); return; }
        const pv = prov.get(); if (!pv) { aiSettingsDialog(reopen); return; }
        const full = pr + (style ? ', ' + STYLE_WORDS[style] : '') + (o.as === 'background' ? ', background with no text, no people in focus' : '');
        try {
          const blob = await busy(go, msg, AI.PROVIDERS[pv].name + ' is drawing…', () => AI.image(pv, full, { aspect: aspectFor('image') }));
          const m = await saveGenerated(blob, 'image', 'AI: ' + pr.slice(0, 40), full);
          msg.textContent = 'Done. Saved in Generated.';
          result.innerHTML = '';
          result.append(h('img', { src: m.thumb.replace('image/jpeg', 'image/jpeg'), alt: '' }), useButtons(m, close, o.as));
          if (o.as === 'background') { await setBgImage(m); msg.textContent = 'Done. Set as the background.'; }
        } catch (e) { fail(e); }
      };
      c.append(h('h2', null, '✦ AI image'), h('p', { class: 'sub' }, 'Make a picture with ChatGPT or Gemini.'),
        fld('Made by', prov.el), fld('Describe it', ta),
        h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => improvePrompt(ta, msg, 'image') }, '✦ Improve my prompt')),
        fld('Style', styles), msg, result,
        h('div', { class: 'modal-foot' }, h('button', { class: 'btn ghost', onclick: close }, 'Close'), go));
    });
  }

  // ---------------- AI video ----------------
  function videoDialog(o) {
    o = o || {};
    modal(async (c, close) => {
      const reopen = () => videoDialog(o);
      const prov = await providerRow('video', null, reopen);
      const ta = h('textarea', { rows: 3, placeholder: 'Describe the shot, e.g. slow drone shot over a misty forest at sunrise, birds flying' });
      ta.value = o.prompt || '';
      let res = '720p', startPic = o.image || null;
      const resChips = chipsLocal([['720p', '720p'], ['1080p', '1080p']], res, (v) => { res = v; });
      const pics = st.media.filter((m) => m.kind === 'image').slice(0, 24);
      const picRow = h('div', { class: 'pick-row' });
      const drawPics = () => {
        picRow.innerHTML = '';
        picRow.append(h('button', { class: 'pk none' + (!startPic ? ' on' : ''), onclick: () => { startPic = null; drawPics(); } }, 'None'));
        for (const m of pics) picRow.append(h('button', { class: 'pk' + (startPic === m ? ' on' : ''), style: { backgroundImage: 'url(' + m.thumb + ')' }, onclick: () => { startPic = m; drawPics(); } }));
      };
      drawPics();
      const msg = h('p', { class: 'muted', style: { fontSize: '12.5px' } }, 'Shape ' + aspectFor('video') + '. Video comes with sound. It usually takes one to a few minutes; keep Cliploom open.');
      const result = h('div', { class: 'gen-result' });
      const go = h('button', { class: 'btn primary' }, 'Generate video');
      go.onclick = async () => {
        const pr = ta.value.trim();
        if (!pr) { toast('Describe the video first'); return; }
        const pv = prov.get(); if (!pv) { aiSettingsDialog(reopen); return; }
        try {
          const blob = await busy(go, msg, 'Gemini is making your video…', () => AI.video(pv, pr, { aspect: aspectFor('video'), resolution: res, image: startPic ? startPic.blob : null }));
          const m = await saveGenerated(blob, 'video', 'AI video: ' + pr.slice(0, 36), pr);
          msg.textContent = 'Done (' + M.fmt(m.duration) + '). Saved in Generated.';
          result.innerHTML = '';
          result.append(h('video', { src: URL.createObjectURL(m.blob), controls: true, playsinline: true }), useButtons(m, close, o.as));
        } catch (e) { fail(e); }
      };
      c.append(h('h2', null, '✦ AI video'), h('p', { class: 'sub' }, 'Make a short clip from words, or bring a photo to life.'),
        fld('Made by', prov.el), fld('Describe it', ta),
        h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => improvePrompt(ta, msg, 'video') }, '✦ Improve my prompt')),
        pics.length ? fld('Start from a photo (optional)', picRow) : null,
        fld('Quality', resChips), msg, result,
        h('div', { class: 'modal-foot' }, h('button', { class: 'btn ghost', onclick: close }, 'Close'), go));
    });
  }
  function chipsLocal(opts, cur, set) {
    const box = h('div', { class: 'chips' });
    for (const [v, l] of opts) { const b = h('button', { class: 'chip' + (v === cur ? ' on' : ''), onclick: () => { set(v); $$('.chip', box).forEach((x) => x.classList.toggle('on', x === b)); } }, l); box.append(b); }
    return box;
  }
  function voiceSelect(prov, cur) {
    const sel = h('select', { 'aria-label': 'Voice' });
    const fill = (pv) => { sel.innerHTML = ''; for (const v of AI.VOICES[pv] || []) sel.append(h('option', { value: v, selected: v === cur }, v)); };
    fill(prov || 'openai');
    return { el: sel, fill, get: () => sel.value };
  }

  // ---------------- AI voice (text to speech) ----------------
  function voiceDialog(o) {
    o = o || {};
    modal(async (c, close) => {
      const reopen = () => voiceDialog(o);
      let vs;
      const prov = await providerRow('speech', (k) => vs.fill(k), reopen);
      vs = voiceSelect(prov.get() || 'openai');
      const ta = h('textarea', { rows: 4, placeholder: 'What should the voice say?' });
      ta.value = o.text || '';
      const style = h('input', { class: 'txt-in', placeholder: 'How it sounds (optional), e.g. warm and calm, excited, whisper' });
      const msg = h('p', { class: 'muted', style: { fontSize: '12.5px' } });
      const go = h('button', { class: 'btn primary' }, 'Make voice');
      go.onclick = async () => {
        const words = ta.value.trim();
        if (!words) { toast('Type what to say first'); return; }
        const pv = prov.get(); if (!pv) { aiSettingsDialog(reopen); return; }
        try {
          const blob = await busy(go, msg, AI.PROVIDERS[pv].name + ' is speaking…', () => AI.speech(pv, words, { voice: vs.get(), style: style.value.trim() }));
          const m = await saveGenerated(blob, 'audio', 'AI voice: ' + words.slice(0, 30), words);
          close();
          await addSound(m);
          if (o.caption !== false) addCaptionLines([{ start: M.find(st.project, st.sel).item.start, end: M.find(st.project, st.sel).item.start + m.duration, text: words }], true);
        } catch (e) { fail(e); }
      };
      c.append(h('h2', null, '✦ AI voice'), h('p', { class: 'sub' }, 'Type it and a voice reads it out. It goes on the timeline at the playhead, with captions.'),
        fld('Voice by', prov.el), fld('Words', ta), h('div', { class: 'two' }, fld('Voice', vs.el), fld('Style', style)), msg,
        h('div', { class: 'modal-foot' }, h('button', { class: 'btn ghost', onclick: close }, 'Close'), go));
    });
  }

  // ---------------- AI writer (titles and text) ----------------
  function writerDialog() {
    modal(async (c, close) => {
      const prov = await providerRow('text', null, writerDialog);
      const ta = h('textarea', { rows: 2, placeholder: 'What is the video about? e.g. my trip to Zanzibar, 3 tips for better sleep' });
      let kind = 'hook';
      const kinds = chipsLocal([['hook', 'Hook title'], ['tips', 'List of tips'], ['cta', 'Call to action'], ['caption', 'Post caption + hashtags']], kind, (v) => { kind = v; });
      const out = h('div', { class: 'list-box' });
      const msg = h('p', { class: 'muted', style: { fontSize: '12.5px' } });
      const go = h('button', { class: 'btn primary' }, 'Write');
      const ask = { hook: 'Write 5 short, punchy on-screen hook titles (max 8 words each)', tips: 'Write a list of 5 short on-screen tips (max 9 words each)', cta: 'Write 5 short on-screen calls to action (max 7 words each)', caption: 'Write 3 short social media post captions, each with 5 fitting hashtags' };
      go.onclick = async () => {
        if (!ta.value.trim()) { toast('Say what the video is about'); return; }
        const pv = prov.get(); if (!pv) { aiSettingsDialog(writerDialog); return; }
        try {
          const list = await busy(go, msg, AI.PROVIDERS[pv].name + ' is writing…', () => AI.text(pv, ask[kind] + ' for a short vertical video about: ' + ta.value.trim() + '. Use the same language as the topic. Return a JSON array of strings.', { json: true }));
          msg.textContent = 'Tap one to add it as text at the playhead' + (kind === 'caption' ? ' or copy it.' : '.');
          out.innerHTML = '';
          for (const line of (Array.isArray(list) ? list : []).map(String)) {
            out.append(h('div', { class: 'post' }, h('div', { class: 'info' }, h('b', { style: { whiteSpace: 'pre-wrap' } }, line)),
              h('button', { class: 'btn sm', onclick: () => { close(); addText({ y: kind === 'cta' ? 0.8 : 0.22, box: kind === 'hook' ? '#000000b0' : '' }, line); } }, 'Add'),
              h('button', { class: 'btn sm', onclick: () => { navigator.clipboard && navigator.clipboard.writeText(line); toast('Copied'); } }, 'Copy')));
          }
        } catch (e) { fail(e); }
      };
      c.append(h('h2', null, '✦ AI writer'), h('p', { class: 'sub' }, 'Titles, tips and post captions written by Claude, ChatGPT or Gemini.'),
        fld('Written by', prov.el), fld('Topic', ta), fld('What to write', kinds), msg, out,
        h('div', { class: 'modal-foot' }, h('button', { class: 'btn ghost', onclick: close }, 'Close'), go));
    });
  }

  // ---------------- AI dialogue scene ----------------
  function dialogueDialog() {
    modal(async (c, close) => {
      const writer = await providerRow('text', null, dialogueDialog);
      let vA, vB;
      const voice = await providerRow('speech', (k) => { vA.fill(k); vB.fill(k); }, dialogueDialog);
      const vp = voice.get() || 'openai';
      vA = voiceSelect(vp, vp === 'gemini' ? 'Puck' : 'ash'); vB = voiceSelect(vp, vp === 'gemini' ? 'Kore' : 'coral');
      const nameA = h('input', { class: 'txt-in', value: 'Sam' }), nameB = h('input', { class: 'txt-in', value: 'Mia' });
      const topic = h('textarea', { rows: 2, placeholder: 'What happens? e.g. two friends argue about pineapple on pizza' });
      let mood = 'funny', lines = 8, bg = 'none';
      const moods = chipsLocal([['funny', 'Funny'], ['dramatic', 'Dramatic'], ['wholesome', 'Wholesome'], ['spooky', 'Spooky'], ['explainer', 'Explainer']], mood, (v) => { mood = v; });
      const counts = chipsLocal([[6, '6 lines'], [8, '8 lines'], [12, '12 lines']], lines, (v) => { lines = v; });
      const bgs = chipsLocal([['none', 'Keep my video'], ['image', 'AI picture behind it'], ['video', 'AI video behind it']], bg, (v) => { bg = v; });
      const script = h('textarea', { rows: 8, placeholder: 'The script shows here. Each line: Name: words' });
      const msg = h('p', { class: 'muted', style: { fontSize: '12.5px' } });
      const write = h('button', { class: 'btn' }, '✦ Write script');
      const make = h('button', { class: 'btn primary' }, 'Make scene');
      write.onclick = async () => {
        const pv = writer.get(); if (!pv) { aiSettingsDialog(dialogueDialog); return; }
        if (!topic.value.trim()) { toast('Say what happens first'); return; }
        try {
          const arr = await busy(write, msg, AI.PROVIDERS[pv].name + ' is writing…', () => AI.text(pv,
            'Write a ' + mood + ' dialogue of exactly ' + lines + ' short lines between ' + nameA.value + ' and ' + nameB.value + ' for a vertical short video. Scene: ' + topic.value.trim()
            + '. Each line at most 20 words, natural spoken words, no stage directions. Use the language of the scene description. Return a JSON array of {"speaker": name, "line": words}.', { json: true }));
          script.value = (Array.isArray(arr) ? arr : []).map((x) => (x.speaker || '?') + ': ' + (x.line || '')).join('\n');
          msg.textContent = 'Edit the lines if you like, then tap Make scene.';
        } catch (e) { fail(e); }
      };
      make.onclick = async () => {
        const rows = script.value.split('\n').map((l) => l.match(/^\s*([^:]{1,30}):\s*(.+)$/)).filter(Boolean).map((m) => ({ who: m[1].trim(), line: m[2].trim() }));
        if (!rows.length) { toast('Write or paste a script first (Name: words)'); return; }
        const pv = voice.get(); if (!pv) { aiSettingsDialog(dialogueDialog); return; }
        const p = st.project;
        try {
          await busy(make, msg, 'Recording voices…', async () => {
            const voiceOf = (who) => (who.toLowerCase() === nameB.value.trim().toLowerCase() ? vB.get() : vA.get());
            let t = engine.time;
            const t0 = t;
            const made = [];
            for (let i = 0; i < rows.length; i++) {
              msg.textContent = 'Voice ' + (i + 1) + ' of ' + rows.length + '…';
              const blob = await AI.speech(pv, rows[i].line, { voice: voiceOf(rows[i].who) });
              const m = await saveGenerated(blob, 'audio', rows[i].who + ': ' + rows[i].line.slice(0, 28), rows[i].line);
              await engine.addMedia(m);
              made.push({ m, start: t, who: rows[i].who, line: rows[i].line });
              t += m.duration + 0.25;
            }
            let bgRec = null;
            if (bg !== 'none') {
              const desc = 'Background scene for a dialogue: ' + topic.value.trim() + '. No text, no captions.';
              if (bg === 'image') {
                const ip = await AI.preferred('image');
                if (ip) { msg.textContent = 'Drawing the background…'; bgRec = await saveGenerated(await AI.image(ip, desc, { aspect: aspectFor('image') }), 'image', 'AI scene: ' + topic.value.trim().slice(0, 30), desc); }
              } else if ((await AI.ready('video')).length) {
                msg.textContent = 'Making the background video (a few minutes)…';
                bgRec = await saveGenerated(await AI.video('gemini', desc + ' Ambient sound only, nobody speaks.', { aspect: aspectFor('video') }), 'video', 'AI scene: ' + topic.value.trim().slice(0, 30), desc);
              }
            }
            edit(() => {
              for (const x of made) {
                const s = M.makeSound(x.m, x.start);
                s.lane = M.freeLane(p, s.start, s.start + M.soundDur(s));
                p.audio.push(s);
                p.overlays.push(M.makeText(x.start, Object.assign({}, CAPTION_STYLE, { dur: Math.round(x.m.duration * 100) / 100, text: x.who + ': ' + x.line, caption: true })));
              }
              if (bgRec) {
                const total = t - t0;
                if (bgRec.kind === 'image') { const cl = M.makeClip(bgRec, { out: Math.round(total * 10) / 10, kenburns: true }); p.video.push(cl); } else {
                  // loop the background video under the whole scene
                  for (let left = total; left > 0.05; left -= bgRec.duration) p.video.push(M.makeClip(bgRec, { out: Math.min(bgRec.duration, Math.round(left * 100) / 100), volume: 0.3 }));
                }
              }
            });
            msg.textContent = 'Scene made: ' + rows.length + ' lines, ' + M.fmt(t - t0) + '.';
          });
          close();
          if (isPhone()) closeSheets();
          engine.seekTo(engine.time);
          toast('Dialogue scene added');
        } catch (e) { fail(e); }
      };
      c.append(h('h2', null, '✦ AI dialogue scene'), h('p', { class: 'sub' }, 'Two characters talk: the AI writes it, gives each one a voice and adds captions.'),
        fld('Scene', topic), h('div', { class: 'two' }, fld('Character 1', nameA), fld('Character 2', nameB)),
        fld('Mood', moods), fld('Length', counts), fld('Script written by', writer.el),
        h('div', { class: 'row' }, write), fld('Script', script),
        fld('Voices by', voice.el), h('div', { class: 'two' }, fld('Voice 1', vA.el), fld('Voice 2', vB.el)),
        fld('Picture', bgs), msg,
        h('div', { class: 'modal-foot' }, h('button', { class: 'btn ghost', onclick: close }, 'Close'), make));
    });
  }

  // ---------------- AI avatar ----------------
  function avatarDialog() {
    modal(async (c, close) => {
      const writer = await providerRow('text', null, avatarDialog);
      let vs;
      const voice = await providerRow('speech', (k) => vs.fill(k), avatarDialog);
      vs = voiceSelect(voice.get() || 'openai');
      let photo = null, mode = 'photo';
      const pics = st.media.filter((m) => m.kind === 'image');
      const picRow = h('div', { class: 'pick-row' });
      const drawPics = () => {
        picRow.innerHTML = '';
        picRow.append(h('button', { class: 'pk none', onclick: () => { st.avatarPick = (m) => { photo = m; pics.unshift(m); drawPics(); }; $('#fileBg').click(); } }, '＋ Photo'));
        for (const m of pics.slice(0, 30)) picRow.append(h('button', { class: 'pk' + (photo === m ? ' on' : ''), style: { backgroundImage: 'url(' + m.thumb + ')' }, onclick: () => { photo = m; drawPics(); } }));
      };
      drawPics();
      const look = h('input', { class: 'txt-in', placeholder: 'Or describe a new avatar, e.g. friendly cartoon fox host with headphones' });
      const words = h('textarea', { rows: 4, placeholder: 'What the avatar says' });
      const about = h('input', { class: 'txt-in', placeholder: 'Topic for the AI to write about (optional)' });
      const modes = chipsLocal([['photo', 'Talking photo (voice + motion)'], ['video', 'Real talking video (Gemini)']], mode, (v) => { mode = v; });
      const msg = h('p', { class: 'muted', style: { fontSize: '12.5px' } });
      const write = h('button', { class: 'btn sm' }, '✦ Write it for me');
      write.onclick = async () => {
        const pv = writer.get(); if (!pv) { aiSettingsDialog(avatarDialog); return; }
        if (!about.value.trim()) { toast('Type a topic first'); return; }
        try { words.value = await busy(write, msg, 'Writing…', () => AI.text(pv, 'Write what a presenter says to camera in a 15 to 25 second vertical video about: ' + about.value.trim() + '. Friendly, spoken style, no stage directions, same language as the topic. Only the words.')); msg.textContent = ''; } catch (e) { fail(e); }
      };
      const go = h('button', { class: 'btn primary' }, 'Make avatar');
      go.onclick = async () => {
        const say = words.value.trim();
        if (!say) { toast('Type what the avatar says'); return; }
        try {
          await busy(go, msg, 'Making your avatar…', async () => {
            let pic = photo;
            if (!pic && look.value.trim()) {
              const ip = await AI.preferred('image');
              if (!ip) throw new Error('Add a ChatGPT or Gemini key to draw an avatar, or pick a photo.');
              msg.textContent = 'Drawing the avatar…';
              const desc = 'Portrait of ' + look.value.trim() + ', facing the camera, head and shoulders, plain soft background';
              pic = await saveGenerated(await AI.image(ip, desc, { aspect: '1:1' }), 'image', 'AI avatar: ' + look.value.trim().slice(0, 30), desc);
            }
            if (!pic) throw new Error('Pick a photo or describe the avatar.');
            const start = engine.time;
            if (mode === 'video') {
              msg.textContent = 'Gemini is making the talking video (a few minutes)…';
              const blob = await AI.video('gemini', 'The person or character in this picture looks into the camera and speaks clearly and naturally, saying: "' + say + '". Steady camera, natural expressions, lips in sync with the words.', { aspect: aspectFor('video'), image: pic.blob });
              const m = await saveGenerated(blob, 'video', 'AI avatar video', say);
              await addLayer(m, true, { scale: 0.62, x: 0, y: 0.1, round: 0.06 });
            } else {
              const pv = voice.get(); if (!pv) throw new Error('Add a ChatGPT or Gemini key for the voice.');
              msg.textContent = 'Recording the voice…';
              const v = await saveGenerated(await AI.speech(pv, say, { voice: vs.get() }), 'audio', 'Avatar voice: ' + say.slice(0, 28), say);
              await engine.addMedia(v);
              await engine.addMedia(pic);
              let lid;
              edit(() => {
                const p = st.project;
                const l = M.makeLayer(pic, start, { out: Math.round(v.duration * 100) / 100, scale: 0.42, x: 0.22, y: -0.24, shape: 'circle', round: 0, border: '#ffffff', anim: 'talk', voiceId: v.id });
                l.lane = M.freeRow(p, 'pip', l.start, l.start + M.clipDur(l));
                p.pip.push(l); lid = l.id;
                const s = M.makeSound(v, start); s.lane = M.freeLane(p, start, start + M.soundDur(s)); p.audio.push(s);
                p.overlays.push(M.makeText(start, Object.assign({}, CAPTION_STYLE, { dur: Math.round(v.duration * 100) / 100, text: say, caption: true })));
              });
              st.sel = lid;
            }
          });
          close();
          if (isPhone()) closeSheets();
          refresh(); engine.seekTo(engine.time);
          toast('Avatar added');
        } catch (e) { fail(e); }
      };
      c.append(h('h2', null, '✦ AI avatar'), h('p', { class: 'sub' }, 'A presenter that talks to camera, from your photo or one the AI draws.'),
        fld('Face', picRow), look,
        fld('Words', words), h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, about, write),
        fld('Type', modes), fld('Voice by', voice.el), fld('Voice', vs.el), fld('Script written by', writer.el), msg,
        h('p', { class: 'note' }, 'Talking photo: the voice plays while the picture moves gently, in a circle you can drag. Real talking video: Gemini animates the face with lip sync and its own voice. Only use photos of people who agreed to it.'),
        h('div', { class: 'modal-foot' }, h('button', { class: 'btn ghost', onclick: close }, 'Close'), go));
    });
  }

  // ---------------- Generated ----------------
  function generatedDialog() {
    modal((c, close) => {
      const list = st.media.filter((m) => m.source === 'ai');
      const grid = h('div', { class: 'media-grid' });
      for (const m of list) {
        grid.append(h('button', { class: 'mtile' + (m.kind === 'audio' ? ' snd-tile' : ''), title: m.prompt || m.name, style: { backgroundImage: m.thumb ? 'url(' + m.thumb + ')' : '' }, onclick: () => {
          if (m.kind === 'audio') { close(); addSound(m); return; }
          modal((c2, close2) => {
            c2.append(h('h2', null, m.name), m.prompt ? h('p', { class: 'sub' }, m.prompt) : null,
              m.kind === 'video' ? h('video', { src: URL.createObjectURL(m.blob), controls: true, playsinline: true, class: 'gen-media' }) : h('img', { src: URL.createObjectURL(m.blob), class: 'gen-media', alt: '' }),
              useButtons(m, close2),
              h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => toast(await Platform.save(m.blob, safeName(m.name) + (m.kind === 'video' ? '.mp4' : '.png'), { kind: m.kind === 'video' ? 'video' : 'image' })) }, 'Save to device'),
                h('button', { class: 'btn danger', onclick: () => { close2(); deleteMedia(m); } }, 'Delete')));
          });
        } }, h('span', { class: 'd' }, m.kind === 'video' ? M.fmt(m.duration).replace(/\.\d$/, '') : m.kind === 'audio' ? '♪ ' + M.fmt(m.duration).replace(/\.\d$/, '') : 'Picture'),
        m.kind === 'audio' ? h('span', { class: 'snd-name' }, m.name) : null));
      }
      c.append(h('h2', null, 'Generated'), h('p', { class: 'sub' }, 'Everything you made with AI, kept on this device.'),
        list.length ? grid : h('p', { class: 'muted' }, 'Nothing yet. Try AI image, AI video or AI voice.'),
        h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: () => { close(); imageDialog(); } }, '✦ AI image'), h('button', { class: 'btn', onclick: () => { close(); videoDialog(); } }, '✦ AI video'), h('div', { class: 'grow' }), h('button', { class: 'btn ghost', onclick: close }, 'Close')));
    });
  }

  // ---------------- AI tab (desktop side panel and phone sheet) ----------------
  function tabAI(body) {
    const card = (icon, title, sub, fn) => h('button', { class: 'src ai-card', onclick: fn }, h('span', { class: 'ic', html: Icons.svg(icon, 22) }), h('span', null, h('b', null, title), h('small', null, sub)));
    body.append(h('div', { class: 'sec' }, h('h3', null, 'Generate media'),
      h('div', { class: 'src-grid' },
        card('image', 'AI image', 'ChatGPT or Gemini draws it', () => imageDialog()),
        card('video', 'AI video', 'Gemini makes a clip with sound', () => videoDialog()),
        card('chat', 'AI dialogue scene', 'Two voices, script and captions', () => dialogueDialog()),
        card('avatar', 'AI avatar', 'A presenter that talks to camera', () => avatarDialog()),
        card('voice', 'AI voice', 'Type it, hear it', () => voiceDialog()),
        card('text', 'AI writer', 'Hooks, tips, post captions', () => writerDialog()),
        card('captions', 'Auto captions', 'Words from the speech', () => setTab('captions')),
        card('folder', 'Generated', 'Everything you made with AI', () => generatedDialog()))),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => aiSettingsDialog(), html: Icons.svg('gear', 16) + ' AI keys' })));
    AI.settings().then((cfg) => {
      if (!Object.keys(cfg.keys).length) body.prepend(h('p', { class: 'note warn', style: { marginTop: 0 } }, 'Add your Claude, ChatGPT or Gemini key under AI keys to use these. Each provider bills your own account.'));
    });
  }

  // ---------------- captions ----------------
  const CAPTION_STYLE = { font: 'Poppins', weight: 800, size: 0.052, color: '#ffffff', stroke: '#000000', strokeW: 0.16, box: '', x: 0.5, y: 0.78, anim: 'pop', shadow: true };
  const CAPTION_LOOKS = [
    ['classic', 'Classic', {}],
    ['box', 'Black box', { strokeW: 0, box: '#000000c0', shadow: false }],
    ['yellow', 'Yellow pop', { color: '#ffe14d', anim: 'pop' }],
    ['bold', 'Big bold', { font: 'Anton', weight: 400, size: 0.07, strokeW: 0.1 }],
    ['clean', 'Clean', { strokeW: 0, shadow: true, font: 'Poppins', weight: 600, size: 0.045, anim: 'fade' }],
    ['type', 'Typewriter', { font: 'Mono', weight: 500, strokeW: 0, box: '#000000a0', anim: 'type', size: 0.042 }],
  ];
  function addCaptionLines(lines, quiet) {
    const p = st.project;
    const look = (CAPTION_LOOKS.find((x) => x[0] === p.captionLook) || CAPTION_LOOKS[0])[2];
    edit(() => {
      for (const s of lines) {
        const dur = Math.max(0.4, Math.round((s.end - s.start) * 100) / 100);
        p.overlays.push(M.makeText(Math.max(0, Math.round(s.start * 100) / 100), Object.assign({}, CAPTION_STYLE, look, { dur, text: s.text, caption: true })));
      }
    });
    if (!quiet) toast(lines.length + ' captions added');
  }
  /** The project's sound as small 16 kHz mono WAV pieces: [{ blob, offset }]. */
  async function speechAudio(which) {
    const p = st.project;
    const keepAudio = (s) => { const m = mediaById(s.mediaId); return which === 'all' || (m && (m.source === 'recording' || m.source === 'ai' || m.fromVideo || m.source === 'tiktok')); };
    const tmp = Object.assign({}, p, { audio: p.audio.filter(keepAudio) });
    const keep = engine.project;
    engine.project = tmp;
    let buf;
    try { buf = await engine.mixdown(16000); } finally { engine.project = keep; }
    if (!buf) return [];
    const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    const mono = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) mono[i] = (L[i] + R[i]) / 2;
    const CH = 16000 * 240; // 4-minute pieces stay well under every provider's upload limit
    const out = [];
    for (let off = 0; off < mono.length; off += CH) {
      const part = mono.subarray(off, Math.min(mono.length, off + CH));
      let peak = 0; for (let i = 0; i < part.length; i += 16) peak = Math.max(peak, Math.abs(part[i]));
      if (peak < 0.005) continue; // silence
      out.push({ blob: new Blob([S.encodeWav({ sampleRate: 16000, channels: [part] })], { type: 'audio/wav' }), offset: off / 16000 });
    }
    return out;
  }
  async function tabCaptions(body) {
    const p = st.project;
    const tok = {}; body._tok = tok;
    const caps = p.overlays.filter((o) => o.caption);
    const prov = await providerRow('transcribe', null, () => setTab('captions'));
    const tprov = await providerRow('text', null, () => setTab('captions'));
    if (body._tok !== tok) return; // the panel was redrawn meanwhile
    let which = 'speech';
    const lang = h('input', { class: 'txt-in', placeholder: 'Language (optional), e.g. English, Swahili, Arabic' });
    const msg = h('p', { class: 'muted', style: { fontSize: '12.5px' } });
    const go = h('button', { class: 'btn primary' }, '✦ Generate captions');
    go.onclick = async () => {
      const pv = prov.get(); if (!pv) { aiSettingsDialog(() => setTab('captions')); return; }
      try {
        const n = await busy(go, msg, 'Listening…', async () => {
          msg.textContent = 'Preparing the sound…';
          const parts = await speechAudio(which);
          if (!parts.length) throw new Error('No speech found. Add a video with talking or a voice-over first.');
          const all = [];
          for (let i = 0; i < parts.length; i++) {
            msg.textContent = AI.PROVIDERS[pv].name + ' is listening' + (parts.length > 1 ? ' (part ' + (i + 1) + ' of ' + parts.length + ')' : '') + '…';
            const segs = await AI.transcribe(pv, parts[i].blob, { language: lang.value.trim() });
            for (const s of segs) all.push({ start: s.start + parts[i].offset, end: Math.max(s.end, s.start + 0.4) + parts[i].offset, text: s.text });
          }
          if (!all.length) throw new Error('No words were heard.');
          // long segments read badly on a phone: break them into pieces of about 6 words
          const short = [];
          for (const s of all) {
            const w = s.text.split(/\s+/).filter(Boolean);
            const n2 = Math.max(1, Math.ceil(w.length / 6));
            for (let k = 0; k < n2; k++) {
              const a = s.start + (s.end - s.start) * k / n2, b = s.start + (s.end - s.start) * (k + 1) / n2;
              short.push({ start: a, end: b, text: w.slice(Math.round(k * w.length / n2), Math.round((k + 1) * w.length / n2)).join(' ') });
            }
          }
          addCaptionLines(short, true);
          return short.length;
        });
        toast(n + ' captions added');
        renderTab();
      } catch (e) { fail(e); }
    };
    const script = h('textarea', { rows: 4, placeholder: 'Paste your script. It is spread over the video by length.' });
    const looks = h('div', { class: 'chips' });
    for (const [k, l] of CAPTION_LOOKS) looks.append(h('button', { class: 'chip' + ((p.captionLook || 'classic') === k ? ' on' : ''), onclick: () => edit(() => {
      p.captionLook = k;
      const look = CAPTION_LOOKS.find((x) => x[0] === k)[2];
      p.overlays.forEach((o) => { if (o.caption) Object.assign(o, CAPTION_STYLE, look, { x: o.x, y: o.y }); });
      renderTab();
    }) }, l));
    const tLang = h('input', { class: 'txt-in', placeholder: 'Translate to, e.g. French' });
    const tBtn = h('button', { class: 'btn' }, '✦ Translate captions');
    tBtn.onclick = async () => {
      const pv = tprov.get(); if (!pv) { aiSettingsDialog(() => setTab('captions')); return; }
      const list = p.overlays.filter((o) => o.caption);
      if (!list.length || !tLang.value.trim()) { toast(list.length ? 'Type a language' : 'Make captions first'); return; }
      try {
        const out = await busy(tBtn, msg, AI.PROVIDERS[pv].name + ' is translating…', () => AI.text(pv, 'Translate each caption line to ' + tLang.value.trim() + '. Keep them short and keep the order. Return a JSON array of strings with exactly ' + list.length + ' items.\n\n' + JSON.stringify(list.map((o) => o.text)), { json: true }));
        if (!Array.isArray(out) || out.length !== list.length) throw new Error('The translation came back with a different number of lines. Try again.');
        edit(() => list.forEach((o, i) => { o.text = String(out[i]); }));
        msg.textContent = 'Translated ' + list.length + ' captions.';
      } catch (e) { fail(e); }
    };
    body.append(
      h('div', { class: 'sec' }, h('h3', null, 'Auto captions'),
        h('p', { class: 'note', style: { marginTop: 0 } }, 'The AI listens to your video and writes the words on screen, timed to the speech.'),
        fld('Listen with', prov.el),
        fld('Listen to', chipsLocal([['speech', 'Clips and voice-overs'], ['all', 'All sound (with music)']], which, (v) => { which = v; })),
        lang, msg, h('div', { class: 'row' }, go)),
      h('div', { class: 'sec' }, h('h3', null, 'Look'), looks),
      h('div', { class: 'sec' }, h('h3', null, 'From your script'), script,
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => {
          const txt = script.value.trim();
          if (!txt) { toast('Paste a script first'); return; }
          const parts = txt.split(/(?<=[.!?…])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
          const total = Math.max(2, M.videoEnd(p) || M.duration(p) || parts.length * 2);
          const chars = parts.reduce((a, x) => a + x.length, 0) || 1;
          let t = 0; const lines = [];
          for (const x of parts) { const d = total * x.length / chars; lines.push({ start: t, end: t + d, text: x }); t += d; }
          addCaptionLines(lines);
          renderTab();
        } }, 'Place over the video'))),
      h('div', { class: 'sec' }, h('h3', null, 'Translate'), fld('Translated by', tprov.el), h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, tLang, tBtn)),
      h('div', { class: 'sec' }, h('h3', null, caps.length + ' caption' + (caps.length === 1 ? '' : 's') + ' in this video'),
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', disabled: !caps.length, onclick: () => edit(() => { p.overlays.forEach((o) => { if (o.caption) o.y = o.y > 0.5 ? 0.18 : 0.78; }); }) }, 'Move top / bottom'),
          h('button', { class: 'btn sm danger', disabled: !caps.length, onclick: () => { if (confirm('Remove all ' + caps.length + ' captions?')) { edit(() => { p.overlays = p.overlays.filter((o) => !o.caption); }); renderTab(); } } }, 'Remove all'))));
  }


  // ---------------- inspector ----------------
  function fld(label, control, value) {
    return h('div', { class: 'fld' }, h('label', null, h('span', null, label), value || ''), control);
  }
  function range(label, val, min, max, step, show, set) {
    const out = h('span', null, show(val));
    const r = h('input', { type: 'range', min, max, step, value: val });
    r.oninput = () => { const v = parseFloat(r.value); out.textContent = show(v); edit(() => set(v), true); };
    r.onchange = () => renderTimeline();
    return fld(label, r, out);
  }
  function chips(label, opts, cur, set) {
    const box = h('div', { class: 'chips' });
    for (const [v, l] of opts) box.append(h('button', { class: 'chip' + (v === cur ? ' on' : ''), onclick: () => edit(() => set(v)) }, l));
    return label ? fld(label, box) : box;
  }
  function colors(label, cur, set, allowNone) {
    const box = h('div', { class: 'swatches' });
    const list = ['#ffffff', '#000000', '#ffe14d', '#ff4d4d', '#ff2d7a', '#3ce0b4', '#4da3ff', '#8b7bff', '#ff9f43', '#1d8f5a'];
    if (allowNone) box.append(h('button', { class: 'sw none' + (!cur ? ' on' : ''), title: 'None', onclick: () => edit(() => set('')) }));
    for (const c of list) box.append(h('button', { class: 'sw' + (cur && cur.slice(0, 7).toLowerCase() === c ? ' on' : ''), style: { background: c }, title: c, onclick: () => edit(() => set(allowNone === 'box' ? c + 'd0' : c)) }));
    const pick = h('input', { type: 'color', value: (cur || '#ffffff').slice(0, 7), title: 'Any colour' });
    pick.oninput = () => edit(() => set(pick.value), true);
    box.append(pick);
    return fld(label, box);
  }
  const pct = (v) => Math.round(v * 100) + '%';
  const secs = (v) => (Math.round(v * 10) / 10) + ' s';

  function renderInspector() {
    const body = $('#inspBody');
    body.innerHTML = '';
    const p = st.project;
    if (!p) return;
    const f = selected();
    const head = (title, extra) => h('div', { class: 'insp-h' }, h('b', null, title), h('div', { class: 'grow' }), extra || '');
    if (!f) {
      body.append(head('Project'), h('div', { class: 'insp-b' },
        chips('Shape', Object.keys(M.RATIOS).map((r) => [r, r]), p.ratio, (v) => { p.ratio = v; sizeCanvas(); }),
        chips('Background behind clips', [['blur', 'Blurred'], ['color', 'Colour'], ['image', 'Picture']], p.bg.mode, (v) => { if (v === 'image' && !p.bg.mediaId) { backgroundDialog(); return; } p.bg.mode = v; }),
        p.bg.mode === 'color' ? colors('Background colour', p.bg.color, (v) => { p.bg.color = v; }) : null,
        chips('Frame rate', [[24, '24'], [30, '30'], [60, '60']], p.fps, (v) => { p.fps = v; }),
        chips('HD (1080p preview and export)', [[true, 'On'], [false, 'Off']], p.hd !== false, (v) => { p.hd = v; sizeCanvas(); }),
        h('p', { class: 'note' }, 'Tap a clip, text or sound on the timeline to edit it. Shortcuts: Space play, S split, Delete remove, Ctrl+Z undo.')));
      return;
    }
    const it = f.item;
    const actions = h('div', { class: 'actions' },
      h('button', { class: 'btn sm', onclick: () => act('split') }, '✂ Split'),
      h('button', { class: 'btn sm', onclick: () => act('duplicate') }, '⧉ Copy'),
      f.list === 'video' && it.kind === 'video' ? h('button', { class: 'btn sm', onclick: () => act('detach') }, '♫ Detach audio') : null,
      f.list === 'video' && it.kind === 'video' ? h('button', { class: 'btn sm', onclick: async () => { try { toast('Taking the sound out…', 9000); const m = mediaById(it.mediaId); const s = await extractSound(m.blob, 'extract', m.name.replace(/\.[^.]+$/, '') + ' (sound)'); toast('Saved "' + s.name + '" in Sounds'); } catch (e) { fail(e); } } }, '♪ Save sound') : null,
      f.list === 'audio' ? h('button', { class: 'btn sm', onclick: async () => { try { const m = mediaById(it.mediaId); const buf = await decode(m.blob); toast(await Platform.save(bufferToWav(buf), safeName(it.name) + '.wav', { kind: 'audio' })); } catch (e) { fail(e); } } }, '⤓ Save WAV') : null,
      h('button', { class: 'btn sm danger', onclick: () => act('delete') }, '🗑 Delete'));

    if (f.list === 'video') {
      const m = mediaById(it.mediaId);
      const next = p.video[f.index + 1];
      const tr = it.transition || { type: 'none', dur: 0.5 };
      body.append(head(it.kind === 'image' ? 'Photo' : 'Video clip', h('small', { class: 'muted' }, secs(M.clipDur(it)))), h('div', { class: 'insp-b' },
        it.kind === 'video' ? range('Volume', it.volume, 0, 2, 0.01, pct, (v) => { it.volume = v; }) : null,
        it.kind === 'video' ? chips('Speed', [[0.25, '0.25×'], [0.5, '0.5×'], [0.75, '0.75×'], [1, '1×'], [1.5, '1.5×'], [2, '2×'], [3, '3×'], [4, '4×']], it.speed, (v) => { it.speed = v; }) : null,
        it.kind === 'image' ? range('Length', it.out - it.in, 0.5, 20, 0.1, secs, (v) => { it.in = 0; it.out = Math.round(v * 10) / 10; }) : null,
        it.kind === 'image' ? chips('Slow zoom (Ken Burns)', [[true, 'On'], [false, 'Off']], !!it.kenburns, (v) => { it.kenburns = v; }) : null,
        chips('Fit', [['fit', 'Fit'], ['fill', 'Fill']], it.fit, (v) => { it.fit = v; }),
        range('Zoom', it.zoom || 1, 0.5, 3, 0.01, pct, (v) => { it.zoom = v; }),
        h('div', { class: 'two' }, range('Move left/right', it.x || 0, -0.5, 0.5, 0.005, (v) => Math.round(v * 100), (v) => { it.x = v; }), range('Move up/down', it.y || 0, -0.5, 0.5, 0.005, (v) => Math.round(v * 100), (v) => { it.y = v; })),
        chips('Rotate and flip', [[0, '0°'], [90, '90°'], [180, '180°'], [270, '270°']], it.rotate || 0, (v) => { it.rotate = v; }),
        chips('', [[true, '⇋ Mirrored'], [false, 'Normal']], !!it.flip, (v) => { it.flip = v; }),
        fld('Filter', h('select', { onchange: (e) => edit(() => { it.filter = e.target.value; }) }, Object.keys(Engine.FILTERS).map((k) => h('option', { value: k, selected: it.filter === k }, Engine.FILTERS[k].name)))),
        range('Brightness', it.adjust.b, -100, 100, 1, String, (v) => { it.adjust.b = v; }),
        range('Contrast', it.adjust.c, -100, 100, 1, String, (v) => { it.adjust.c = v; }),
        range('Saturation', it.adjust.s, -100, 100, 1, String, (v) => { it.adjust.s = v; }),
        range('Warmth', it.adjust.w, -100, 100, 1, String, (v) => { it.adjust.w = v; }),
        next ? chips('Transition to the next clip', [['none', 'None'], ['fade', 'Fade'], ['black', 'Dip black'], ['white', 'Flash'], ['slide', 'Slide'], ['push', 'Push'], ['up', 'Up'], ['wipe', 'Wipe'], ['circle', 'Circle'], ['zoom', 'Zoom'], ['blur', 'Blur']], tr.type, (v) => { it.transition = { type: v, dur: tr.dur || 0.5 }; }) : null,
        next && tr.type !== 'none' ? range('Transition length', tr.dur, 0.2, 2, 0.05, secs, (v) => { it.transition = { type: tr.type, dur: v }; }) : null,
        h('p', { class: 'muted', style: { fontSize: '11.5px' } }, m ? m.name : 'Missing file'),
        actions));
    } else if (f.list === 'overlays') {
      const ta = h('textarea', { rows: 3 });
      ta.value = it.text;
      ta.oninput = () => edit(() => { it.text = ta.value; }, true);
      body.append(head(/^\p{Extended_Pictographic}/u.test(it.text) && it.text.length <= 4 ? 'Sticker' : 'Text'), h('div', { class: 'insp-b' },
        fld('Words', ta),
        chips('Font', Object.keys(Engine.FONTS).map((k) => [k, k]), it.font, (v) => { it.font = v; it.weight = v === 'Poppins' ? 800 : v === 'Playfair' ? 700 : v === 'Mono' ? 500 : 400; }),
        range('Size', it.size, 0.02, 0.3, 0.002, (v) => Math.round(v * 1000), (v) => { it.size = v; }),
        colors('Colour', it.color, (v) => { it.color = v; }),
        colors('Outline', it.strokeW > 0 ? it.stroke : '', (v) => { if (v) { it.stroke = v; it.strokeW = it.strokeW || 0.12; } else it.strokeW = 0; }, true),
        it.strokeW > 0 ? range('Outline width', it.strokeW, 0.02, 0.3, 0.01, (v) => Math.round(v * 100), (v) => { it.strokeW = v; }) : null,
        colors('Background', it.box, (v) => { it.box = v; }, 'box'),
        chips('Shadow', [[true, 'On'], [false, 'Off']], !!it.shadow, (v) => { it.shadow = v; }),
        chips('Animation', [['none', 'None'], ['fade', 'Fade'], ['pop', 'Pop'], ['slide', 'Slide up'], ['bounce', 'Bounce'], ['zoom', 'Grow'], ['type', 'Typewriter']], it.anim, (v) => { it.anim = v; }),
        h('div', { class: 'two' }, range('Starts at', it.start, 0, Math.max(10, M.duration(p)), 0.1, secs, (v) => { it.start = v; }), range('Length', it.dur, 0.3, Math.max(15, it.dur * 2), 0.1, secs, (v) => { it.dur = v; })),
        chips('Place', [['top', 'Top'], ['mid', 'Middle'], ['low', 'Bottom']], it.y < 0.3 ? 'top' : it.y > 0.7 ? 'low' : 'mid', (v) => { it.x = 0.5; it.y = v === 'top' ? 0.16 : v === 'low' ? 0.82 : 0.5; }),
        actions));
    } else if (f.list === 'pip') {
      const m = mediaById(it.mediaId);
      body.append(head(it.kind === 'image' ? 'Overlay photo' : 'Overlay video', h('small', { class: 'muted' }, secs(M.clipDur(it)))), h('div', { class: 'insp-b' },
        range('Size', it.scale || 0.45, 0.1, 1.6, 0.01, pct, (v) => { it.scale = v; }),
        h('div', { class: 'two' }, range('Move left/right', it.x || 0, -0.6, 0.6, 0.005, (v) => Math.round(v * 100), (v) => { it.x = v; }), range('Move up/down', it.y || 0, -0.6, 0.6, 0.005, (v) => Math.round(v * 100), (v) => { it.y = v; })),
        chips('Place', [['tl', 'Top left'], ['tr', 'Top right'], ['c', 'Middle'], ['bl', 'Bottom left'], ['br', 'Bottom right']], null, (v) => { it.x = v === 'c' ? 0 : v[1] === 'l' ? -0.24 : 0.24; it.y = v === 'c' ? 0 : v[0] === 't' ? -0.26 : 0.26; }),
        chips('Shape', [['rect', 'Rectangle'], ['round', 'Rounded'], ['circle', 'Circle']], it.shape === 'circle' ? 'circle' : it.round > 0 ? 'round' : 'rect', (v) => { it.shape = v === 'circle' ? 'circle' : 'rect'; it.round = v === 'round' ? 0.08 : 0; }),
        colors('Border', it.border || '', (v) => { it.border = v; }, true),
        range('Opacity', it.opacity == null ? 1 : it.opacity, 0.05, 1, 0.01, pct, (v) => { it.opacity = v; }),
        chips('Blend', [['normal', 'Normal'], ['screen', 'Screen'], ['multiply', 'Multiply'], ['overlay', 'Overlay'], ['lighten', 'Lighten'], ['darken', 'Darken']], it.blend || 'normal', (v) => { it.blend = v; }),
        chips('Rotate', [[0, '0°'], [-8, '−8°'], [8, '8°'], [90, '90°'], [180, '180°']], it.rotate || 0, (v) => { it.rotate = v; }),
        chips('Appear', [['none', 'Cut'], ['fade', 'Fade in'], ['pop', 'Pop in']], it.anim || 'none', (v) => { it.anim = v; }),
        it.kind === 'video' ? range('Volume', it.volume, 0, 2, 0.01, pct, (v) => { it.volume = v; }) : null,
        it.kind === 'video' ? chips('Speed', [[0.5, '0.5×'], [1, '1×'], [1.5, '1.5×'], [2, '2×']], it.speed || 1, (v) => { it.speed = v; }) : range('Length', it.out - it.in, 0.5, 30, 0.1, secs, (v) => { it.in = 0; it.out = Math.round(v * 10) / 10; }),
        range('Starts at', it.start, 0, Math.max(10, M.duration(p)), 0.1, secs, (v) => { it.start = v; }),
        fld('Filter', h('select', { onchange: (e) => edit(() => { it.filter = e.target.value; }) }, Object.keys(Engine.FILTERS).map((k) => h('option', { value: k, selected: it.filter === k }, Engine.FILTERS[k].name)))),
        range('Brightness', it.adjust.b, -100, 100, 1, String, (v) => { it.adjust.b = v; }),
        range('Contrast', it.adjust.c, -100, 100, 1, String, (v) => { it.adjust.c = v; }),
        range('Saturation', it.adjust.s, -100, 100, 1, String, (v) => { it.adjust.s = v; }),
        h('p', { class: 'muted', style: { fontSize: '11.5px' } }, (m ? m.name : 'Missing file') + ' · drag it on the preview to move it'),
        h('div', { class: 'actions' }, h('button', { class: 'btn sm', onclick: () => act('split') }, '✂ Split'), h('button', { class: 'btn sm', onclick: () => act('duplicate') }, '⧉ Copy'),
          h('button', { class: 'btn sm', onclick: () => act('tomain') }, 'Move to main track'), h('button', { class: 'btn sm danger', onclick: () => act('delete') }, '🗑 Delete'))));
    } else if (f.list === 'effects') {
      const E = Engine.EFFECTS;
      body.append(head('Effect: ' + ((E[it.type] || {}).name || it.type), h('small', { class: 'muted' }, secs(it.dur))), h('div', { class: 'insp-b' },
        fld('Effect', h('select', { onchange: (e) => edit(() => { it.type = e.target.value; }) }, Object.keys(E).map((k) => h('option', { value: k, selected: it.type === k }, E[k].group + ' · ' + E[k].name)))),
        range('Strength', it.strength == null ? 1 : it.strength, 0.1, 2, 0.05, pct, (v) => { it.strength = v; }),
        h('div', { class: 'two' }, range('Starts at', it.start, 0, Math.max(10, M.duration(p)), 0.1, secs, (v) => { it.start = v; }), range('Length', it.dur, 0.3, Math.max(15, it.dur * 2), 0.1, secs, (v) => { it.dur = v; })),
        h('button', { class: 'btn sm', onclick: () => edit(() => { const at = M.videoAt(p, it.start)[0]; if (at) { const r = M.layout(p)[at.index]; it.start = r.start; it.dur = Math.round((r.end - r.start) * 100) / 100; } }) }, 'Cover the whole clip'),
        h('div', { class: 'actions' }, h('button', { class: 'btn sm', onclick: () => act('split') }, '✂ Split'), h('button', { class: 'btn sm', onclick: () => act('duplicate') }, '⧉ Copy'), h('button', { class: 'btn sm danger', onclick: () => act('delete') }, '🗑 Delete'))));
    } else {
      const m = mediaById(it.mediaId);
      body.append(head('Sound', h('small', { class: 'muted' }, secs(M.soundDur(it)))), h('div', { class: 'insp-b' },
        h('p', { style: { margin: '0 0 6px', fontWeight: 600 } }, it.name),
        range('Volume', it.volume, 0, 2, 0.01, pct, (v) => { it.volume = v; }),
        range('Fade in', it.fadeIn || 0, 0, Math.min(10, M.soundDur(it) / 2), 0.1, secs, (v) => { it.fadeIn = v; }),
        range('Fade out', it.fadeOut || 0, 0, Math.min(10, M.soundDur(it) / 2), 0.1, secs, (v) => { it.fadeOut = v; }),
        range('Starts at', it.start, 0, Math.max(10, M.duration(p)), 0.1, secs, (v) => { it.start = v; }),
        it.mediaDur > M.soundDur(it) + 0.05 || it.in > 0 ? range('Play from (inside the sound)', it.in, 0, Math.max(0, (it.mediaDur || 0) - 0.2), 0.1, secs, (v) => { const len = it.out - it.in; it.in = v; it.out = Math.min(it.mediaDur || v + len, v + len); }) : null,
        h('button', { class: 'btn sm', onclick: () => edit(() => { const vend = M.videoEnd(p); if (vend > it.start) it.out = Math.min(it.mediaDur || it.out, it.in + (vend - it.start)); }) }, 'Fit to video length'),
        m ? null : h('p', { class: 'note warn' }, 'The sound file is missing.'),
        actions));
    }
  }

  // ---------------- actions ----------------
  function act(what) {
    const p = st.project;
    const f = selected();
    if (what === 'addtext') return addText({});
    if (!f) {
      if (what === 'split') {
        const at = M.videoAt(p, engine.time)[0];
        if (at) { st.sel = at.clip.id; return act('split'); }
      }
      toast('Tap a clip on the timeline first'); return;
    }
    if (what === 'split') {
      let nid = null;
      snap(); nid = M.split(p, st.sel, engine.time);
      if (!nid) { st.hist.pop(); toast('Move the playhead inside the selected item to split it'); return; }
      st.sel = nid; refresh();
    } else if (what === 'delete') {
      edit(() => { M.remove(p, st.sel); st.sel = null; });
    } else if (what === 'duplicate') {
      edit(() => { st.sel = M.duplicate(p, st.sel) || st.sel; });
    } else if (what === 'tooverlay' && f.list === 'video') {
      const m = mediaById(f.item.mediaId); if (!m) return;
      const start = M.layout(p)[f.index].start;
      let nid;
      edit(() => {
        const c = f.item;
        const l = M.makeLayer(m, start, { in: c.in, out: c.out, speed: c.speed || 1, volume: c.volume, filter: c.filter, adjust: Object.assign({}, c.adjust) });
        l.lane = M.freeRow(p, 'pip', start, start + M.clipDur(l));
        M.remove(p, c.id); p.pip.push(l); nid = l.id;
      });
      select(nid);
    } else if (what === 'tomain' && f.list === 'pip') {
      const m = mediaById(f.item.mediaId); if (!m) return;
      let nid;
      edit(() => {
        const l = f.item;
        const c = M.makeClip(m, { in: l.in, out: l.out, speed: l.speed || 1, volume: l.volume, filter: l.filter, adjust: Object.assign({}, l.adjust) });
        const L = M.layout(p);
        const at = L.findIndex((r) => l.start < r.end);
        p.video.splice(at < 0 ? p.video.length : at + (l.start > L[at].start ? 1 : 0), 0, c);
        M.remove(p, l.id); nid = c.id;
      });
      select(nid);
    } else if (what === 'detach') {
      const m = f.list === 'video' && mediaById(f.item.mediaId);
      if (!m || f.item.kind !== 'video') { toast('Select a video clip'); return; }
      if ((f.item.speed || 1) !== 1) { toast('Set speed back to 1× to detach the sound'); return; }
      let nid; edit(() => { nid = M.detachAudio(p, f.item.id, Object.assign({}, m, { name: m.name.replace(/\.[^.]+$/, '') + ' (sound)' })); });
      if (nid) select(nid);
    }
  }

  // ---------------- timeline ----------------
  function textLanes(list) {
    const lanes = []; const out = new Map();
    for (const o of [...list].sort((a, b) => a.start - b.start)) {
      let l = lanes.findIndex((end) => end <= o.start + 0.001);
      if (l < 0) { l = lanes.length; lanes.push(0); }
      lanes[l] = o.start + o.dur; out.set(o.id, l);
    }
    return { count: Math.max(1, lanes.length), lane: out };
  }
  function waveCanvas(m, it, widthPx) {
    if (!m || !m.peaks || !m.peaks.length) return null;
    const c = h('canvas', { class: 'wave' });
    const W = Math.max(2, Math.min(4000, Math.round(widthPx))); c.width = W; c.height = 40;
    const g = c.getContext('2d'); g.fillStyle = '#fff';
    const per = m.peaks.length / (m.duration || 1);
    for (let x = 0; x < W; x++) {
      const t = it.in + (x / W) * (it.out - it.in);
      const v = m.peaks[Math.min(m.peaks.length - 1, Math.floor(t * per))] || 0;
      const hh = Math.max(1, v * 36); g.fillRect(x, 20 - hh / 2, 1, hh);
    }
    return c;
  }

  function renderTimeline() {
    const p = st.project;
    if (!p) return;
    const pps = st.pps;
    const dur = M.duration(p);
    const inner = $('#tlInner');
    const O = origin();
    const sw = $('#tlScroll').clientWidth;
    const width = isPhone() ? O + dur * pps + sw / 2 : Math.max(O + (dur + 8) * pps, sw);
    inner.style.width = width + 'px';
    // ruler
    const ruler = $('#ruler'); ruler.innerHTML = '';
    const step = pps >= 120 ? 1 : pps >= 50 ? 2 : pps >= 25 ? 5 : 10;
    for (let t = 0; t <= dur + 8; t += step) {
      ruler.append(h('span', { style: { left: (O + t * pps) + 'px' } }, M.fmt(t).replace(/\.\d$/, '')));
      for (let k = 0; k < 4; k++) ruler.append(h('i', { style: { left: (O + (t + k * step / 4) * pps) + 'px', height: k ? '4px' : '7px' } }));
    }
    const tracks = $('#tracks'); tracks.innerHTML = '';
    const X = (t) => O + t * pps;
    const mk = (cls, it, left, w, label, extra) => {
      const el = h('div', { class: 'item ' + cls + (st.sel === it.id ? ' sel' : '') + (st.drag && st.drag.id === it.id ? ' dragging' : ''), 'data-id': it.id, style: { left: left + 'px', width: Math.max(6, w) + 'px' } },
        extra || null, h('span', { class: 'nm' }, label), h('span', { class: 'h l' }), h('span', { class: 'h r' }));
      return el;
    };
    // main video track
    const phone = isPhone();
    const head = (kind, label, onclick, title, on) => h('div', { class: 'head' }, h('button', { class: 'hd-btn' + (on ? ' on' : ''), title, onclick: (e) => { e.stopPropagation(); onclick(); }, html: Icons.svg(kind, 22) + (label ? '<span>' + label + '</span>' : '') }));
    const vt = h('div', { class: 'track video', 'data-track': 'video' });
    if (phone) {
      const muted = p.video.length > 0 && p.video.every((c) => c.kind !== 'video' || c.volume === 0);
      const hv = head(muted ? 'mute' : 'volume', muted ? 'Unmute' : 'Mute clips', () => edit(() => { p.video.forEach((c) => { if (c.kind === 'video') c.volume = muted ? 1 : 0; }); toast(muted ? 'Clip sound on' : 'Clip sound off'); }), 'Mute or unmute the sound of all clips', muted);
      hv.prepend(h('button', { class: 'hd-btn cover' + (p.cover != null ? ' on' : ''), title: 'Use the frame at the playhead as the project cover', onclick: (e) => { e.stopPropagation(); setCover(); }, html: (p.thumb ? '<img src="' + p.thumb + '" alt="">' : Icons.svg('cover', 22)) + '<span>Cover</span>' }));
      vt.append(hv);
    }
    if (!p.video.length) vt.append(phone ? h('button', { class: 'add-lane big', style: { left: O + 'px' }, onclick: () => $('#fileMedia').click(), html: Icons.svg('plus', 20) + ' Add videos or photos' }) : h('span', { class: 'track-empty', style: { left: O + 'px' } }, 'Videos and photos (Media › tap to add)'));
    for (const r of M.layout(p)) {
      const c = r.clip; const m = mediaById(c.mediaId);
      const label = (c.speed && c.speed !== 1 ? c.speed + '× ' : '') + (c.volume === 0 && c.kind === 'video' ? '🔇 ' : '') + (m ? m.name : 'Missing');
      const el = mk('v', c, X(r.start), (r.end - r.start) * pps - 2, label);
      const w = (r.end - r.start) * pps - 2;
      if (m && m.strip && m.strip.length) {
        const trackH = isPhone() ? 64 : 56;
        const tileW = Math.max(30, Math.min(100, Math.round(trackH * (m.w && m.h ? m.w / m.h : 1))));
        const strip = h('div', { class: 'strip' });
        const n = Math.min(400, Math.ceil(w / tileW));
        for (let k = 0; k < n; k++) {
          const tt = c.kind === 'image' ? 0 : c.in + ((k + 0.5) * tileW / pps) * (c.speed || 1);
          const idx = Math.max(0, Math.min(m.strip.length - 1, Math.floor(tt / Math.max(0.01, m.duration) * m.strip.length)));
          strip.append(h('i', { style: { backgroundImage: 'url(' + m.strip[idx] + ')', width: tileW + 'px' } }));
        }
        el.prepend(strip);
      } else if (m && m.thumb) el.style.backgroundImage = 'url(' + m.thumb + ')';
      if (r.index < p.video.length - 1) {
        const tt = c.transition && c.transition.type !== 'none';
        el.append(h('button', { class: 'tr', title: 'Transition', onclick: (e) => { e.stopPropagation(); select(c.id, true); setTimeout(() => { const ins = $('#insp'); ins.scrollTop = ins.scrollHeight; }, 30); } }, tt ? '⋈' : '+'));
      }
      vt.append(el);
    }
    tracks.append(vt);
    // overlay lanes (picture in picture)
    if (p.pip.length) {
      const n = Math.min(8, Math.max(...p.pip.map((l) => (l.lane || 0) + 1)));
      for (let l = 0; l < n; l++) {
        const ot = h('div', { class: 'track pip', 'data-track': 'pip', 'data-lane': l });
        if (phone && l === 0) ot.append(head('overlay', null, () => setTab('overlay'), 'Overlay'));
        for (const it of p.pip) if ((it.lane || 0) === l) {
          const m = mediaById(it.mediaId);
          const el = mk('o', it, X(it.start), M.clipDur(it) * pps - 2, (m ? m.name : 'Missing'));
          if (m && m.thumb) el.style.backgroundImage = 'url(' + m.thumb + ')';
          ot.append(el);
        }
        tracks.append(ot);
      }
    }
    // audio lanes
    const lanes = Math.max(1, ...p.audio.map((s) => s.lane + (phone ? 1 : 2)));
    for (let l = 0; l < Math.min(8, lanes); l++) {
      const at = h('div', { class: 'track audio', 'data-track': 'audio', 'data-lane': l });
      if (phone && l === 0) at.append(head('audio', null, () => setTab('sounds'), 'Sounds'));
      if (!p.audio.length && l === 0) at.append(phone ? h('button', { class: 'add-lane', style: { left: O + 'px' }, onclick: () => setTab('sounds'), html: Icons.svg('plus', 18) + ' Add audio' }) : h('span', { class: 'track-empty', style: { left: O + 'px' } }, 'Music, effects and voice (Sounds › +)'));
      for (const s of p.audio) if (s.lane === l) {
        const m = mediaById(s.mediaId); const w = M.soundDur(s) * pps - 2;
        at.append(mk('a' + (s.fx ? ' fx' : ''), s, X(s.start), w, '♪ ' + s.name + (s.volume === 0 ? ' 🔇' : ''), waveCanvas(m, s, w)));
      }
      tracks.append(at);
    }
    // text track(s)
    const tl = textLanes(p.overlays);
    for (let l = 0; l < tl.count; l++) {
      const tr = h('div', { class: 'track text', 'data-track': 'text' });
      if (phone && l === 0) tr.append(head('text', null, () => setTab('text'), 'Text'));
      if (!p.overlays.length) tr.append(phone ? h('button', { class: 'add-lane', style: { left: O + 'px' }, onclick: () => setTab('text'), html: Icons.svg('plus', 18) + ' Add text' }) : h('span', { class: 'track-empty', style: { left: O + 'px' } }, 'Text and stickers'));
      for (const o of p.overlays) if (tl.lane.get(o.id) === l) tr.append(mk('t' + (o.caption ? ' cap' : ''), o, X(o.start), o.dur * pps - 2, (o.caption ? '▭ ' : 'T  ') + o.text.replace(/\n/g, ' ')));
      tracks.append(tr);
    }
    // effect lanes
    if (p.effects.length) {
      const n = Math.min(8, Math.max(...p.effects.map((e) => (e.lane || 0) + 1)));
      for (let l = 0; l < n; l++) {
        const et = h('div', { class: 'track fx', 'data-track': 'effects', 'data-lane': l });
        if (phone && l === 0) et.append(head('effects', null, () => setTab('effects'), 'Effects'));
        for (const e of p.effects) if ((e.lane || 0) === l) et.append(mk('e', e, X(e.start), e.dur * pps - 2, '✦ ' + ((Engine.EFFECTS[e.type] || {}).name || e.type)));
        tracks.append(et);
      }
    }
    placePlayhead();
    renderBottomNav();
    placeAddBtn();
    $$('.tl-tools button').forEach((b) => { if (['split', 'delete', 'duplicate'].includes(b.dataset.act)) b.disabled = !st.sel && b.dataset.act !== 'split'; });
    const f = selected();
    $('.tl-tools [data-act=detach]').disabled = !(f && f.list === 'video' && f.item.kind === 'video');
  }
  function origin() { return isPhone() ? Math.round($('#tlScroll').clientWidth / 2) : 16; }
  function placePlayhead(follow) {
    const x = origin() + engine.time * st.pps;
    $('#playhead').style.left = x + 'px';
    $$('.add-lane').forEach((el) => { el.style.left = (x + 6) + 'px'; });
    const sc = $('#tlScroll');
    if (isPhone() && !st.drag) {
      // phones: the playhead stays in the middle and the timeline slides under it
      const want = Math.round(x - sc.clientWidth / 2);
      if (Math.abs(sc.scrollLeft - want) > 0.5) { st.progScroll = want; sc.scrollLeft = want; }
      return;
    }
    if (follow && (x > sc.scrollLeft + sc.clientWidth * 0.8 || x < sc.scrollLeft)) sc.scrollLeft = x - sc.clientWidth * 0.25;
  }
  // phones: sliding the timeline moves the playhead (it is fixed in the middle)
  let scrubRaf = 0;
  $('#tlScroll').addEventListener('scroll', () => {
    if (!isPhone() || !st.project || st.drag) return;
    const sc = $('#tlScroll');
    if (st.progScroll != null && Math.abs(sc.scrollLeft - st.progScroll) <= 1) { st.progScroll = null; return; }
    st.progScroll = null;
    if (engine.playing) { engine.pause(); setPlayIcon(); }
    engine.time = Math.max(0, Math.min(M.duration(st.project), sc.scrollLeft / st.pps));
    const x = origin() + engine.time * st.pps;
    $('#playhead').style.left = x + 'px';
    $$('.add-lane').forEach((el) => { el.style.left = (x + 6) + 'px'; });
    $('#tNow').textContent = M.fmt(engine.time);
    cancelAnimationFrame(scrubRaf);
    scrubRaf = requestAnimationFrame(() => engine.drawAt(engine.time, true));
  }, { passive: true });

  // pointer interactions on the timeline
  function timeFromX(clientX) {
    const r = $('#tlInner').getBoundingClientRect();
    return Math.max(0, (clientX - r.left - origin()) / st.pps);
  }
  function snapPoints(exceptId) {
    const p = st.project; const pts = [0, engine.time, M.videoEnd(p)];
    for (const r of M.layout(p)) { pts.push(r.start, r.end); }
    for (const o of p.overlays) if (o.id !== exceptId) pts.push(o.start, o.start + o.dur);
    for (const s of p.audio) if (s.id !== exceptId) pts.push(s.start, s.start + M.soundDur(s));
    for (const l of p.pip) if (l.id !== exceptId) pts.push(l.start, l.start + M.clipDur(l));
    for (const x of p.effects) if (x.id !== exceptId) pts.push(x.start, x.start + x.dur);
    return pts;
  }
  function snapT(t, pts) {
    const th = 8 / st.pps;
    let best = t, bd = th;
    for (const q of pts) { const d = Math.abs(q - t); if (d < bd) { bd = d; best = q; } }
    return best;
  }

  function onTimelineDown(e) {
    st.glide = (st.glide || 0) + 1; // a new touch stops any glide
    if (e.button > 0) return;
    const itemEl = e.target.closest('.item');
    const p = st.project;
    if (e.target.closest('.tr')) return;
    const touch = e.pointerType === 'touch' || e.pointerType === 'pen';
    if (!itemEl) {
      if (touch) {
        // phones: a swipe scrolls the timeline (the playhead stays in the middle); a tap clears the selection
        const x0 = e.clientX, y0 = e.clientY;
        const up = (ev) => { window.removeEventListener('pointerup', up); if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 8 && st.sel) select(null); };
        window.addEventListener('pointerup', up);
        return;
      }
      // scrub
      engine.pause(); setPlayIcon();
      const move = (ev) => { engine.time = Math.min(M.duration(p), timeFromX(ev.clientX)); placePlayhead(); $('#tNow').textContent = M.fmt(engine.time); engine.drawAt(engine.time, true); };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      if (e.target.closest('.ruler') || e.target.closest('.track') || e.target === $('#tlInner')) {
        if (!e.target.closest('.ruler') && st.sel) { st.sel = null; renderInspector(); renderTimeline(); }
        move(e);
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      }
      return;
    }
    const id = itemEl.dataset.id;
    const f = M.find(p, id);
    if (!f) return;
    const handle = e.target.classList.contains('h') ? (e.target.classList.contains('l') ? 'start' : 'end') : null;
    if (touch && !handle) {
      // phones: swipe = scroll, tap = select, press and hold = pick the clip up and move it
      const x0 = e.clientX, y0 = e.clientY;
      let last = e;
      const wasSel = st.sel === id;
      // clips take every touch themselves (touch-action: none), so swiping is done here, with a little glide
      const sc = $('#tlScroll');
      const sl0 = sc.scrollLeft, st0 = sc.scrollTop;
      let panning = false, vx = 0, lastX = e.clientX, lastT = performance.now();
      const cleanup = () => { clearTimeout(timer); window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', upp); window.removeEventListener('pointercancel', upp); };
      const mv = (ev) => {
        last = ev;
        if (!panning && Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) > 10) { panning = true; clearTimeout(timer); }
        if (!panning) return;
        const now = performance.now();
        vx = (ev.clientX - lastX) / Math.max(1, now - lastT); lastX = ev.clientX; lastT = now;
        sc.scrollLeft = sl0 - (ev.clientX - x0);
        sc.scrollTop = st0 - (ev.clientY - y0);
      };
      const upp = () => {
        cleanup();
        if (!panning) { if (!wasSel) select(id); else openSheet('edit'); return; }
        let v = vx * 16;
        const gid = st.glide = (st.glide || 0) + 1;
        const glide = () => { if (Math.abs(v) < 0.5 || st.glide !== gid) return; sc.scrollLeft -= v; v *= 0.92; requestAnimationFrame(glide); };
        if (performance.now() - lastT < 80) requestAnimationFrame(glide);
      };
      const timer = setTimeout(() => {
        cleanup();
        try { navigator.vibrate && navigator.vibrate(20); } catch (_) { /* no vibration */ }
        if (!wasSel) select(id);
        st.holding = true;
        const stop = () => { st.holding = false; window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); };
        window.addEventListener('pointerup', stop); window.addEventListener('pointercancel', stop);
        startItemDrag(last, id, f, null, true);
        toast('Move it, then let go', 1500);
      }, 380);
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', upp); window.addEventListener('pointercancel', cleanup);
      return;
    }
    const wasSel = st.sel === id;
    if (!wasSel) select(id);
    e.preventDefault();
    startItemDrag(e, id, f, handle, wasSel);
  }

  function startItemDrag(e, id, f, handle, wasSel) {
    const p = st.project;
    const x0 = e.clientX, y0 = e.clientY;
    const orig = JSON.stringify(f.item);
    const pts = snapPoints(id);
    let moved = false, mark = null, dropIndex = null, lastEv = null, auto = 0;
    const sc = $('#tlScroll'), s0 = sc.scrollLeft;
    // near the left/right edge the timeline scrolls by itself while you hold the clip there
    const autoScroll = () => {
      auto = 0;
      if (!lastEv || !st.drag) return;
      const r = sc.getBoundingClientRect();
      const dir = lastEv.clientX < r.left + 48 ? -1 : lastEv.clientX > r.right - 48 ? 1 : 0;
      if (!dir) return;
      const before = sc.scrollLeft;
      sc.scrollLeft += dir * 10;
      if (sc.scrollLeft !== before) move(lastEv);
      auto = requestAnimationFrame(autoScroll);
    };
    const move = (ev) => {
      lastEv = ev;
      const dx = ev.clientX - x0 + (sc.scrollLeft - s0), dy = ev.clientY - y0;
      if (!moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      if (!auto) auto = requestAnimationFrame(autoScroll);
      if (!moved) { snap(); moved = true; st.drag = { id }; }
      const cur = M.find(p, id); if (!cur) return;
      Object.assign(cur.item, JSON.parse(orig));
      const dt = dx / st.pps;
      if (handle) {
        if (cur.list === 'video') M.trim(p, id, handle, dt);
        else {
          const o = JSON.parse(orig);
          const edgeT = handle === 'start' ? o.start + dt : (cur.list === 'audio' ? o.start + M.soundDur(o) : cur.list === 'pip' ? o.start + M.clipDur(o) : o.start + o.dur) + dt;
          const sn = snapT(edgeT, pts);
          M.trim(p, id, handle, dt + (sn - edgeT));
        }
      } else if (cur.list === 'video') {
        // reorder: find the drop slot
        const t = timeFromX(ev.clientX);
        const L = M.layout(p);
        dropIndex = L.filter((r) => (r.start + r.end) / 2 < t && r.clip.id !== id).length;
        if (!mark) { mark = h('div', { class: 'drop-mark' }); }
        const others = L.filter((r) => r.clip.id !== id);
        const xs = dropIndex === 0 ? 0 : others[dropIndex - 1] ? others[dropIndex - 1].end - (L.find((r) => r.clip.id === id).index < dropIndex ? 0 : 0) : M.videoEnd(p);
        mark.style.left = (origin() + (dropIndex === 0 ? 0 : (others[dropIndex - 1] || {}).end || 0) * st.pps) + 'px';
        void xs;
        const itemEl = $('.item[data-id="' + id + '"]');
        if (itemEl) { itemEl.style.transform = 'translate(' + dx + 'px, -6px)'; itemEl.classList.add('dragging'); }
        const vt = $('.track.video'); if (vt && !mark.parentNode) vt.append(mark);
        return;
      } else {
        const o = JSON.parse(orig);
        const len = cur.list === 'audio' ? M.soundDur(o) : cur.list === 'pip' ? M.clipDur(o) : o.dur;
        let ns = Math.max(0, o.start + dt);
        const s1 = snapT(ns, pts), s2 = snapT(ns + len, pts) - len;
        ns = Math.abs(s1 - ns) <= Math.abs(s2 - ns) ? s1 : s2;
        cur.item.start = Math.max(0, Math.round(ns * 1000) / 1000);
        if (cur.list === 'audio') {
          const under = document.elementFromPoint(ev.clientX, ev.clientY);
          const tr = under && under.closest && under.closest('.track.audio');
          if (tr) cur.item.lane = +tr.dataset.lane;
        } else if (cur.list === 'pip' || cur.list === 'effects') {
          const under = document.elementFromPoint(ev.clientX, ev.clientY);
          const tr = under && under.closest && under.closest('.track[data-track="' + cur.list + '"]');
          if (tr) cur.item.lane = +tr.dataset.lane;
          else {
            // dragged below the last lane of its kind: open a new lane
            const lanes = $$('.track[data-track="' + cur.list + '"]');
            const lastT = lanes[lanes.length - 1];
            if (lastT && ev.clientY > lastT.getBoundingClientRect().bottom + 6 && ev.clientY < lastT.getBoundingClientRect().bottom + 50) cur.item.lane = Math.min(7, lanes.length);
          }
        }
      }
      renderTimeline();
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      st.drag = null; cancelAnimationFrame(auto);
      if (mark) mark.remove();
      if (!moved) {
        // a tap: move the playhead into the item if it is outside, and open Edit on phones
        if (isPhone() && wasSel) openSheet('edit');
        return;
      }
      if (f.list === 'video' && !handle && dropIndex != null) {
        const cur = p.video.findIndex((c) => c.id === id);
        M.moveVideo(p, id, dropIndex > cur ? dropIndex : dropIndex);
      }
      refresh();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  }

  // dragging text on the preview
  function onPreviewDown(e) {
    const r = canvas.getBoundingClientRect();
    const nx = (e.clientX - r.left) / r.width, ny = (e.clientY - r.top) / r.height;
    const inBox = (b) => nx >= b.x - 0.02 && nx <= b.x + b.w + 0.02 && ny >= b.y - 0.02 && ny <= b.y + b.h + 0.02;
    const hit = [...engine.boxes].reverse().find(inBox) || [...(engine.pipBoxes || [])].reverse().find(inBox);
    if (!hit) { togglePlay(); return; }
    const f = M.find(st.project, hit.id); if (!f) return;
    if (st.sel !== hit.id) select(hit.id);
    const o = f.item; const ox = o.x, oy = o.y; let moved = false;
    const isLayer = f.list === 'pip';
    canvas.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const dx = (ev.clientX - e.clientX) / r.width, dy = (ev.clientY - e.clientY) / r.height;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 0.01) return;
      if (!moved) { snap(); moved = true; }
      if (isLayer) { o.x = Math.max(-0.7, Math.min(0.7, ox + dx)); o.y = Math.max(-0.7, Math.min(0.7, oy + dy)); if (Math.abs(o.x) < 0.015) o.x = 0; } else {
        o.x = Math.max(0, Math.min(1, ox + dx)); o.y = Math.max(0, Math.min(1, oy + dy));
        if (Math.abs(o.x - 0.5) < 0.015) o.x = 0.5;
      }
      engine.drawAt(engine.time, false);
    };
    const up = () => { canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); if (moved) refresh(true); else if (isPhone()) openSheet('edit'); };
    canvas.addEventListener('pointermove', move); canvas.addEventListener('pointerup', up);
  }

  // ---------------- playback ----------------
  function setPlayIcon() { $('#play').innerHTML = Icons.svg(engine.playing ? 'pause' : 'play', 28); }
  async function togglePlay() {
    if (engine.playing) { engine.pause(); setPlayIcon(); await engine.drawAt(engine.time, true); return; }
    stopPreview();
    $('#play').innerHTML = Icons.svg('pause', 28);
    try { await engine.play(); } catch (e) { fail(e); }
    setPlayIcon();
  }
  engine.onTime = (t) => { $('#tNow').textContent = M.fmt(t); placePlayhead(engine.playing); };
  engine.onEnd = () => setPlayIcon();

  // ---------------- export ----------------
  function exportDialog() {
    const p = st.project;
    if (!p.video.length && !p.overlays.length) { toast('Add a clip first'); return; }
    let res = p.hd === false ? 720 : 1080, fps = p.fps || 30, cancelled = false, busy = false;
    modal((c, close) => {
      const bar = h('div', { class: 'bar' }, h('i'));
      const msg = h('p', { class: 'muted', style: { fontSize: '12.5px' } }, 'Duration ' + M.fmt(M.duration(p)) + '. Export runs on this device; long videos take a while.');
      const resChips = h('div');
      const fpsChips = h('div');
      const drawChips = () => {
        resChips.innerHTML = ''; fpsChips.innerHTML = '';
        resChips.append(h('div', { class: 'chips' }, [[480, '480p'], [720, '720p'], [1080, '1080p'], [1440, '2K']].map(([v, l]) => h('button', { class: 'chip' + (v === res ? ' on' : ''), onclick: () => { res = v; drawChips(); } }, l))));
        fpsChips.append(h('div', { class: 'chips' }, [24, 30, 60].map((v) => h('button', { class: 'chip' + (v === fps ? ' on' : ''), onclick: () => { fps = v; drawChips(); } }, v + ' fps'))));
      };
      drawChips();
      const go = h('button', { class: 'btn primary' }, 'Export video');
      const wav = h('button', { class: 'btn' }, 'Sound only (WAV)');
      go.onclick = async () => {
        if (busy) return; busy = true; go.disabled = true; wav.disabled = true;
        const t0 = performance.now();
        try {
          const [rw, rh] = M.RATIOS[p.ratio];
          const longSide = Math.round(res * Math.max(rw, rh) / Math.min(rw, rh));
          const blob = await engine.exportVideo({ maxSide: longSide, fps, isCancelled: () => cancelled, onProgress: (x, label) => { bar.firstChild.style.width = Math.round(x * 100) + '%'; msg.textContent = (label || 'Rendering…') + ' ' + Math.round(x * 100) + '%'; } });
          msg.textContent = 'Done in ' + Math.round((performance.now() - t0) / 1000) + ' s (' + (blob.size / 1048576).toFixed(1) + ' MB). Saving…';
          const r = await Platform.save(blob, safeName(p.name) + '.mp4');
          msg.textContent = r; toast(r, 5000);
        } catch (e) { msg.textContent = e.message || String(e); if (!cancelled) fail(e); }
        busy = false; go.disabled = false; wav.disabled = false;
        engine.drawAt(engine.time, true);
      };
      wav.onclick = async () => {
        try {
          wav.disabled = true; msg.textContent = 'Mixing sound…';
          const buf = await engine.mixdown(48000);
          if (!buf) { msg.textContent = 'This project has no sound.'; wav.disabled = false; return; }
          const r = await Platform.save(bufferToWav(buf), safeName(p.name) + '.wav', { kind: 'audio' });
          msg.textContent = r;
        } catch (e) { fail(e); }
        wav.disabled = false;
      };
      c.append(h('h2', null, 'Export'), h('p', { class: 'sub' }, p.name + ' · ' + p.ratio),
        fld('Quality', resChips), fld('Frame rate', fpsChips), bar, msg,
        h('div', { class: 'modal-foot' }, h('button', { class: 'btn ghost', onclick: () => { cancelled = true; close(); } }, busy ? 'Cancel' : 'Close'), wav, go));
    }, () => { cancelled = true; });
  }

  // ---------------- wiring ----------------
  $('#newProject').onclick = newProjectDialog;
  $('#back').onclick = closeProject;
  $('#projName').onchange = () => { st.project.name = $('#projName').value.trim() || 'Untitled'; refresh(true); };
  $('#undo').onclick = () => undo(false);
  $('#redo').onclick = () => undo(true);
  $('#exportBtn').onclick = exportDialog;
  $$('[data-icon]').forEach((b) => { b.innerHTML = Icons.svg(b.dataset.icon, 24); });
  setPlayIcon();
  $('#hdPill').onclick = () => { const p = st.project; edit(() => { p.hd = p.hd === false; sizeCanvas(); }); toast(p.hd === false ? 'HD off: 720p, lighter on slower phones' : 'HD on: 1080p preview and export'); };
  $('#fullBtn').onclick = () => { document.body.classList.toggle('pv-full'); setTimeout(fitCanvas, 30); };
  $('#addClipBtn').onclick = () => $('#fileMedia').click();
  $('#tlScroll').addEventListener('scroll', placeAddBtn, { passive: true });
  // two-finger pinch on the timeline zooms it
  let pinch = null;
  $('#tlScroll').addEventListener('touchstart', (e) => { if (e.touches.length === 2) pinch = { d: Math.abs(e.touches[0].clientX - e.touches[1].clientX) || 1, pps: st.pps }; }, { passive: true });
  $('#tlScroll').addEventListener('touchmove', (e) => {
    if (st.holding) { e.preventDefault(); return; } // a held clip is being moved: don't scroll
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const d = Math.abs(e.touches[0].clientX - e.touches[1].clientX) || 1;
    st.pps = Math.max(10, Math.min(300, pinch.pps * d / pinch.d)); $('#zoom').value = st.pps; renderTimeline();
  }, { passive: false });
  $('#tlScroll').addEventListener('touchend', (e) => { if (e.touches.length < 2) pinch = null; }, { passive: true });
  $('#play').onclick = togglePlay;
  $$('#libTabs button').forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });
  $$('.sheet-grip').forEach((g) => { g.onclick = closeSheets; });
  $$('.tl-tools [data-act]').forEach((b) => { b.onclick = () => act(b.dataset.act); });
  $('#zoom').oninput = (e) => { st.pps = +e.target.value; renderTimeline(); placePlayhead(true); };
  $('#tlScroll').addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return; e.preventDefault();
    st.pps = Math.max(10, Math.min(300, st.pps * (e.deltaY < 0 ? 1.15 : 0.87))); $('#zoom').value = st.pps; renderTimeline();
  }, { passive: false });
  $('#tlInner').addEventListener('pointerdown', onTimelineDown);
  canvas.addEventListener('pointerdown', onPreviewDown);

  $('#fileMedia').onchange = async (e) => {
    const fs = [...e.target.files]; e.target.value = '';
    const asLayer = st.importAs === 'overlay'; st.importAs = null;
    const recs = await importMedia(fs);
    if (asLayer) { for (const m of recs) await addLayer(m, true); if (recs.length) toast(recs.length === 1 ? 'Overlay added' : recs.length + ' overlays added'); return; }
    importSheet(recs);
  };
  $('#homeAi').onclick = () => aiSettingsDialog();
  $('#fileBg').onchange = async (e) => {
    const fs = [...e.target.files]; e.target.value = '';
    const recs = await importMedia(fs);
    const m = recs[0];
    const pick = st.avatarPick; st.avatarPick = null;
    const bg = st.bgPick; st.bgPick = null;
    if (!m) return;
    if (pick) pick(m); else if (bg) setBgImage(m);
  };
  $('#fileAudio').onchange = async (e) => {
    const fs = [...e.target.files]; e.target.value = ''; let n = 0;
    for (const f of fs) { try { toast('Reading ' + f.name + '…', 8000); await importSound(f, 'file'); n++; } catch (er) { fail(er); } }
    if (n) toast(n === 1 ? 'Sound added to My sounds' : n + ' sounds added');
    if (st.modalClose) st.modalClose();
    setTab('sounds', true);
  };
  $('#fileVidAudio').onchange = async (e) => { const fs = [...e.target.files]; e.target.value = ''; await onVideoAudioFiles(fs); };
  $('#fileTikTok').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try { toast('Reading your TikTok data…', 8000); const res = await S.readTikTokExport(f); toast('Done'); if (st.tiktokList) st.tiktokList(res); } catch (er) { fail(er); }
  };

  // drag and drop files (Windows)
  window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drop-on'); });
  window.addEventListener('dragleave', () => document.body.classList.remove('drop-on'));
  window.addEventListener('drop', async (e) => {
    e.preventDefault(); document.body.classList.remove('drop-on');
    if (!st.project) { toast('Open a project first'); return; }
    const fs = [...e.dataTransfer.files];
    if (st.tiktokList) { st.tiktokPick = true; await onVideoAudioFiles(fs); return; }
    importSheet(await importMedia(fs));
  });

  window.addEventListener('keydown', (e) => {
    if (!st.project || $('#editor').classList.contains('hidden')) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && document.activeElement.type !== 'range') return;
    if (!$('#modal').classList.contains('hidden')) { if (e.key === 'Escape') st.modalClose && st.modalClose(); return; }
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); togglePlay(); } else if (k === 's' && !e.ctrlKey) act('split');
    else if (k === 'delete' || k === 'backspace') act('delete');
    else if (k === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undo(e.shiftKey); } else if (k === 'y' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undo(true); }
    else if (k === 'arrowleft' || k === 'arrowright') { e.preventDefault(); const d = (e.shiftKey ? 1 : 1 / (st.project.fps || 30)) * (k === 'arrowleft' ? -1 : 1); engine.seekTo(Math.max(0, Math.min(M.duration(st.project), engine.time + d))); } else if (k === 'escape') { select(null); }
  });
  Platform.onBack(() => {
    if (st.modalClose) return st.modalClose();
    if (document.body.classList.contains('pv-full')) { document.body.classList.remove('pv-full'); fitCanvas(); return; }
    if (st.sheet) return closeSheets();
    if (st.sel) return select(null);
    if (st.navSub) { st.navSub = null; renderBottomNav(); return; }
    if (st.project) return closeProject();
    if (window.Capacitor && window.Capacitor.Plugins.App) window.Capacitor.Plugins.App.exitApp();
  });
  window.addEventListener('resize', () => { if (st.project) { renderTimeline(); } });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { if (engine.playing) { engine.pause(); setPlayIcon(); } saveNow(); } });

  (async function boot() {
    try { await document.fonts.load('800 20px Poppins'); } catch (_) { /* fine */ }
    Promise.all(['Anton', 'Bebas Neue', 'Permanent Marker', 'Pacifico', '700 20px Playfair Display', '500 20px Roboto Mono'].map((f) => document.fonts.load(/^\d/.test(f) ? f : '20px "' + f + '"'))).catch(() => {});
    await loadMedia();
    await renderHome();
  })().catch(fail);
})();
