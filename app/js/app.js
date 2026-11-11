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
          try { c.getContext('2d').drawImage(v, 0, 0, c.width, c.height); } catch (_) { /* no frame */ }
          done({ duration: dur, w: v.videoWidth, h: v.videoHeight, thumb: c.toDataURL('image/jpeg', 0.7) });
        };
        const go = () => { v.onseeked = grab; v.currentTime = Math.min(1, (dur || 1) / 3); };
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
    let n = 0;
    for (const f of files) {
      const kind = kindOf(f);
      try {
        if (kind === 'video') {
          toast('Importing ' + f.name + '…', 8000);
          const p = await probeVideo(f);
          if (!p) { toast('This device cannot play ' + f.name, 4000); continue; }
          await saveMedia({ id: M.uid('m'), name: f.name, kind, type: f.type, blob: f, duration: p.duration, w: p.w, h: p.h, thumb: p.thumb, source: 'import' });
          n++;
        } else if (kind === 'image') {
          const p = await probeImage(f);
          if (!p) { toast('Cannot open ' + f.name, 4000); continue; }
          await saveMedia({ id: M.uid('m'), name: f.name, kind, type: f.type, blob: f, duration: 0, w: p.w, h: p.h, thumb: p.thumb, source: 'import' });
          n++;
        } else if (kind === 'audio') {
          await importSound(f, 'file');
          n++;
        }
      } catch (e) { fail(e); }
    }
    if (n) toast(n === 1 ? 'Added 1 file' : 'Added ' + n + ' files');
    renderTab();
    return n;
  }

  /** Audio file -> sound in the library. */
  async function importSound(blob, source, name) {
    const buf = await decode(blob).catch(() => null);
    if (!buf) throw new Error('Cannot read the sound in ' + (name || blob.name || 'this file'));
    return saveMedia({ id: M.uid('s'), name: name || (blob.name || 'Sound').replace(/\.[^.]+$/, ''), kind: 'audio', type: blob.type || 'audio/*', blob, duration: buf.duration, peaks: bufferPeaks(buf), source });
  }

  /** Video file -> its soundtrack as a WAV sound in the library. */
  async function extractSound(blob, source, name) {
    const buf = await decode(blob).catch(() => null);
    if (!buf) throw new Error((name || blob.name || 'This video') + ' has no sound this device can read.');
    const wav = bufferToWav(buf);
    return saveMedia({ id: M.uid('s'), name, kind: 'audio', type: 'audio/wav', blob: wav, duration: buf.duration, peaks: bufferPeaks(buf), source });
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
    return ps.filter((p) => p.video.some((c) => c.mediaId === id) || p.audio.some((s) => s.mediaId === id));
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
    st.project = p; st.sel = null; st.hist = []; st.fut = [];
    engine.pause();
    engine.setProject(p);
    for (const c of p.video) { const m = mediaById(c.mediaId); if (m) await engine.addMedia(m); }
    for (const s of p.audio) { const m = mediaById(s.mediaId); if (m) await engine.addMedia(m); }
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
    const { w, h: hh } = M.size(st.project, small ? 720 : 960);
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
  function refresh(soft) {
    const p = st.project;
    if (!p) return;
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
    $$('#bottomNav button').forEach((b) => b.classList.toggle('on', which === 'edit' ? b.dataset.tab === 'edit' : which === 'lib' && b.dataset.tab === st.tab));
  }
  function closeSheets() { openSheet(null); }

  function renderTab() {
    const body = $('#tabBody');
    if (!body || !st.project) return;
    body.innerHTML = '';
    ({ media: tabMedia, sounds: tabSounds, text: tabText, stickers: tabStickers, filters: tabFilters })[st.tab](body);
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
  async function addClip(m) {
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
        toast('Taking the sound out of ' + f.name + '…', 20000);
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
        chips('Background behind clips', [['blur', 'Blurred'], ['color', 'Colour']], p.bg.mode, (v) => { p.bg.mode = v; }),
        p.bg.mode === 'color' ? colors('Background colour', p.bg.color, (v) => { p.bg.color = v; }) : null,
        chips('Frame rate', [[24, '24'], [30, '30'], [60, '60']], p.fps, (v) => { p.fps = v; }),
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
    } else if (what === 'detach') {
      const m = f.list === 'video' && mediaById(f.item.mediaId);
      if (!m || f.item.kind !== 'video') { toast('Select a video clip'); return; }
      if ((f.item.speed || 1) !== 1) { toast('Set speed back to 1× to detach the sound'); return; }
      engine.buffer(m.id).then((b) => {
        if (!b) { toast('This clip has no sound'); return; }
        let nid; edit(() => { nid = M.detachAudio(p, f.item.id, Object.assign({}, m, { name: m.name.replace(/\.[^.]+$/, '') + ' (sound)', duration: b.duration })); });
        if (nid) select(nid);
      });
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
    const width = Math.max((dur + 8) * pps, $('#tlScroll').clientWidth);
    inner.style.width = width + 'px';
    // ruler
    const ruler = $('#ruler'); ruler.innerHTML = '';
    const step = pps >= 120 ? 1 : pps >= 50 ? 2 : pps >= 25 ? 5 : 10;
    for (let t = 0; t <= dur + 8; t += step) {
      ruler.append(h('span', { style: { left: (16 + t * pps) + 'px' } }, M.fmt(t).replace(/\.\d$/, '')));
      for (let k = 0; k < 4; k++) ruler.append(h('i', { style: { left: (16 + (t + k * step / 4) * pps) + 'px', height: k ? '4px' : '7px' } }));
    }
    const tracks = $('#tracks'); tracks.innerHTML = '';
    const X = (t) => 16 + t * pps;
    const mk = (cls, it, left, w, label, extra) => {
      const el = h('div', { class: 'item ' + cls + (st.sel === it.id ? ' sel' : '') + (st.drag && st.drag.id === it.id ? ' dragging' : ''), 'data-id': it.id, style: { left: left + 'px', width: Math.max(6, w) + 'px' } },
        extra || null, h('span', { class: 'nm' }, label), h('span', { class: 'h l' }), h('span', { class: 'h r' }));
      return el;
    };
    // text track(s)
    const tl = textLanes(p.overlays);
    for (let l = 0; l < tl.count; l++) {
      const tr = h('div', { class: 'track text', 'data-track': 'text' });
      if (!p.overlays.length) tr.append(h('span', { class: 'track-empty', style: { left: '16px' } }, 'Text and stickers'));
      for (const o of p.overlays) if (tl.lane.get(o.id) === l) tr.append(mk('t', o, X(o.start), o.dur * pps - 2, 'T  ' + o.text.replace(/\n/g, ' ')));
      tracks.append(tr);
    }
    // main video track
    const vt = h('div', { class: 'track video', 'data-track': 'video' });
    if (!p.video.length) vt.append(h('span', { class: 'track-empty', style: { left: '16px' } }, 'Videos and photos (Media › tap to add)'));
    for (const r of M.layout(p)) {
      const c = r.clip; const m = mediaById(c.mediaId);
      const label = (c.speed && c.speed !== 1 ? c.speed + '× ' : '') + (c.volume === 0 && c.kind === 'video' ? '🔇 ' : '') + (m ? m.name : 'Missing');
      const el = mk('v', c, X(r.start), (r.end - r.start) * pps - 2, label);
      if (m && m.thumb) el.style.backgroundImage = 'url(' + m.thumb + ')';
      if (r.index < p.video.length - 1) {
        const tt = c.transition && c.transition.type !== 'none';
        el.append(h('button', { class: 'tr', title: 'Transition', onclick: (e) => { e.stopPropagation(); select(c.id, true); setTimeout(() => { const ins = $('#insp'); ins.scrollTop = ins.scrollHeight; }, 30); } }, tt ? '⋈' : '|'));
      }
      vt.append(el);
    }
    tracks.append(vt);
    // audio lanes
    const lanes = Math.max(1, ...p.audio.map((s) => s.lane + 2));
    for (let l = 0; l < Math.min(8, lanes); l++) {
      const at = h('div', { class: 'track audio', 'data-track': 'audio', 'data-lane': l });
      if (!p.audio.length && l === 0) at.append(h('span', { class: 'track-empty', style: { left: '16px' } }, 'Music, effects and voice (Sounds › +)'));
      for (const s of p.audio) if (s.lane === l) {
        const m = mediaById(s.mediaId); const w = M.soundDur(s) * pps - 2;
        at.append(mk('a' + (s.fx ? ' fx' : ''), s, X(s.start), w, '♪ ' + s.name + (s.volume === 0 ? ' 🔇' : ''), waveCanvas(m, s, w)));
      }
      tracks.append(at);
    }
    placePlayhead();
    $$('.tl-tools button').forEach((b) => { if (['split', 'delete', 'duplicate'].includes(b.dataset.act)) b.disabled = !st.sel && b.dataset.act !== 'split'; });
    const f = selected();
    $('.tl-tools [data-act=detach]').disabled = !(f && f.list === 'video' && f.item.kind === 'video');
  }
  function placePlayhead(follow) {
    const x = 16 + engine.time * st.pps;
    $('#playhead').style.left = x + 'px';
    if (follow) {
      const sc = $('#tlScroll');
      if (x > sc.scrollLeft + sc.clientWidth * 0.8 || x < sc.scrollLeft) sc.scrollLeft = x - sc.clientWidth * 0.25;
    }
  }

  // pointer interactions on the timeline
  function timeFromX(clientX) {
    const r = $('#tlInner').getBoundingClientRect();
    return Math.max(0, (clientX - r.left - 16) / st.pps);
  }
  function snapPoints(exceptId) {
    const p = st.project; const pts = [0, engine.time, M.videoEnd(p)];
    for (const r of M.layout(p)) { pts.push(r.start, r.end); }
    for (const o of p.overlays) if (o.id !== exceptId) pts.push(o.start, o.start + o.dur);
    for (const s of p.audio) if (s.id !== exceptId) pts.push(s.start, s.start + M.soundDur(s));
    return pts;
  }
  function snapT(t, pts) {
    const th = 8 / st.pps;
    let best = t, bd = th;
    for (const q of pts) { const d = Math.abs(q - t); if (d < bd) { bd = d; best = q; } }
    return best;
  }

  function onTimelineDown(e) {
    if (e.button > 0) return;
    const itemEl = e.target.closest('.item');
    const p = st.project;
    if (e.target.closest('.tr')) return;
    if (!itemEl) {
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
    const wasSel = st.sel === id;
    if (!wasSel) select(id);
    const x0 = e.clientX, y0 = e.clientY;
    const orig = JSON.stringify(f.item);
    const pts = snapPoints(id);
    let moved = false, mark = null, dropIndex = null;
    e.preventDefault();
    const move = (ev) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (!moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      if (!moved) { snap(); moved = true; st.drag = { id }; }
      const cur = M.find(p, id); if (!cur) return;
      Object.assign(cur.item, JSON.parse(orig));
      const dt = dx / st.pps;
      if (handle) {
        if (cur.list === 'video') M.trim(p, id, handle, dt);
        else {
          const o = JSON.parse(orig);
          const edgeT = handle === 'start' ? o.start + dt : (cur.list === 'audio' ? o.start + M.soundDur(o) : o.start + o.dur) + dt;
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
        mark.style.left = (16 + (dropIndex === 0 ? 0 : (others[dropIndex - 1] || {}).end || 0) * st.pps) + 'px';
        void xs;
        itemEl.style.transform = 'translate(' + dx + 'px, -6px)'; itemEl.classList.add('dragging');
        const vt = $('.track.video'); if (vt && !mark.parentNode) vt.append(mark);
        return;
      } else {
        const o = JSON.parse(orig);
        const len = cur.list === 'audio' ? M.soundDur(o) : o.dur;
        let ns = Math.max(0, o.start + dt);
        const s1 = snapT(ns, pts), s2 = snapT(ns + len, pts) - len;
        ns = Math.abs(s1 - ns) <= Math.abs(s2 - ns) ? s1 : s2;
        cur.item.start = Math.max(0, Math.round(ns * 1000) / 1000);
        if (cur.list === 'audio') {
          const under = document.elementFromPoint(ev.clientX, ev.clientY);
          const tr = under && under.closest && under.closest('.track.audio');
          if (tr) cur.item.lane = +tr.dataset.lane;
        }
      }
      renderTimeline();
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      st.drag = null;
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
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  // dragging text on the preview
  function onPreviewDown(e) {
    const r = canvas.getBoundingClientRect();
    const nx = (e.clientX - r.left) / r.width, ny = (e.clientY - r.top) / r.height;
    const hit = [...engine.boxes].reverse().find((b) => nx >= b.x - 0.02 && nx <= b.x + b.w + 0.02 && ny >= b.y - 0.02 && ny <= b.y + b.h + 0.02);
    if (!hit) { if (!engine.playing) togglePlay(); else togglePlay(); return; }
    const f = M.find(st.project, hit.id); if (!f) return;
    if (st.sel !== hit.id) select(hit.id);
    const o = f.item; const ox = o.x, oy = o.y; let moved = false;
    canvas.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const dx = (ev.clientX - e.clientX) / r.width, dy = (ev.clientY - e.clientY) / r.height;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 0.01) return;
      if (!moved) { snap(); moved = true; }
      o.x = Math.max(0, Math.min(1, ox + dx)); o.y = Math.max(0, Math.min(1, oy + dy));
      if (Math.abs(o.x - 0.5) < 0.015) o.x = 0.5;
      engine.drawAt(engine.time, false);
    };
    const up = () => { canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); if (moved) refresh(true); else if (isPhone()) openSheet('edit'); };
    canvas.addEventListener('pointermove', move); canvas.addEventListener('pointerup', up);
  }

  // ---------------- playback ----------------
  function setPlayIcon() { $('#play').innerHTML = engine.playing ? '&#10074;&#10074;' : '&#9654;'; }
  async function togglePlay() {
    if (engine.playing) { engine.pause(); setPlayIcon(); await engine.drawAt(engine.time, true); return; }
    stopPreview();
    $('#play').innerHTML = '…';
    try { await engine.play(); } catch (e) { fail(e); }
    setPlayIcon();
  }
  engine.onTime = (t) => { $('#tNow').textContent = M.fmt(t); placePlayhead(engine.playing); };
  engine.onEnd = () => setPlayIcon();

  // ---------------- export ----------------
  function exportDialog() {
    const p = st.project;
    if (!p.video.length && !p.overlays.length) { toast('Add a clip first'); return; }
    let res = 1080, fps = p.fps || 30, cancelled = false, busy = false;
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
  $('#play').onclick = togglePlay;
  $$('#libTabs button').forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });
  $$('#bottomNav button').forEach((b) => {
    b.onclick = () => {
      const isOpen = b.dataset.tab === 'edit' ? st.sheet === 'edit' : st.sheet === 'lib' && st.tab === b.dataset.tab;
      if (isOpen) closeSheets(); else setTab(b.dataset.tab);
    };
  });
  $$('.sheet-grip').forEach((g) => { g.onclick = closeSheets; });
  $$('.tl-tools [data-act]').forEach((b) => { b.onclick = () => act(b.dataset.act); });
  $('#zoom').oninput = (e) => { st.pps = +e.target.value; renderTimeline(); placePlayhead(true); };
  $('#tlScroll').addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return; e.preventDefault();
    st.pps = Math.max(10, Math.min(300, st.pps * (e.deltaY < 0 ? 1.15 : 0.87))); $('#zoom').value = st.pps; renderTimeline();
  }, { passive: false });
  $('#tlInner').addEventListener('pointerdown', onTimelineDown);
  canvas.addEventListener('pointerdown', onPreviewDown);

  $('#fileMedia').onchange = async (e) => { const fs = [...e.target.files]; e.target.value = ''; await importMedia(fs); };
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
    await importMedia(fs);
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
    if (st.sheet) return closeSheets();
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
