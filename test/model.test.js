const test = require('node:test');
const assert = require('node:assert');
const M = require('../app/js/model.js');
const S = require('../app/js/sources.js');

const vid = (id, d) => ({ id, kind: 'video', duration: d });

test('layout, split and duration', () => {
  const p = M.newProject('t', '9:16');
  p.video.push(M.makeClip(vid('a', 4)), M.makeClip(vid('b', 6)));
  assert.strictEqual(M.videoEnd(p), 10);
  const id = M.split(p, p.video[1].id, 7);
  assert.ok(id);
  assert.strictEqual(p.video.length, 3);
  assert.deepStrictEqual(M.layout(p).map((r) => [r.start, r.end]), [[0, 4], [4, 7], [7, 10]]);
  assert.strictEqual(p.video[2].in, 3);
  assert.strictEqual(M.split(p, p.video[0].id, 0.05), null);
});

test('speed changes timeline length and source time', () => {
  const p = M.newProject();
  const c = M.makeClip(vid('a', 10), { speed: 2 });
  p.video.push(c);
  assert.strictEqual(M.duration(p), 5);
  assert.strictEqual(M.videoAt(p, 2)[0].time, 4);
});

test('transitions give two entries around the cut', () => {
  const p = M.newProject();
  p.video.push(M.makeClip(vid('a', 4), { transition: { type: 'fade', dur: 1 } }), M.makeClip(vid('b', 4)));
  assert.strictEqual(M.videoAt(p, 2).length, 1);
  const e = M.videoAt(p, 4.2);
  assert.strictEqual(e.length, 2);
  assert.ok(e[1].incoming && e[1].progress > 0.5 && e[1].progress < 1);
  assert.strictEqual(M.videoAt(p, 3.8).length, 2);
});

test('sounds: trim, detach, schedule, lanes', () => {
  const p = M.newProject();
  p.video.push(M.makeClip(vid('a', 5)));
  const sid = M.detachAudio(p, p.video[0].id, { id: 'a', duration: 5, name: 'x' });
  assert.ok(sid);
  assert.strictEqual(p.video[0].volume, 0);
  const s = p.audio[0];
  M.trim(p, sid, 'start', 1);
  assert.strictEqual(s.in, 1); assert.strictEqual(s.start, 1);
  const music = M.makeSound({ id: 'm', duration: 30 }, 0);
  music.lane = M.freeLane(p, 0, 30);
  assert.strictEqual(music.lane, 1);
  p.audio.push(music);
  const sch = M.audioSchedule(p);
  assert.strictEqual(sch.length, 2);
  assert.strictEqual(M.duration(p), 30);
});

test('text overlays split and duplicate', () => {
  const p = M.newProject();
  const t = M.makeText(1); p.overlays.push(t);
  const r = M.split(p, t.id, 2);
  assert.strictEqual(p.overlays.length, 2);
  assert.strictEqual(M.find(p, r).item.dur, 2);
  const d = M.duplicate(p, t.id);
  assert.strictEqual(M.find(p, d).item.start, 2);
});

test('TikTok export: finds own posts and favourite sounds', () => {
  const json = {
    Activity: {
      'Favorite Sounds': { FavoriteSoundList: [{ Date: '2024-01-02 10:00:00', Link: 'https://www.tiktok.com/music/x-1' }] },
      'Like List': { ItemFavoriteList: [{ Date: '2024-01-03', Link: 'https://www.tiktokv.com/share/video/9/' }] },
      'Video Browsing History': { VideoList: [{ Date: '2024-01-04', Link: 'https://www.tiktokv.com/share/video/8/' }] },
    },
    Video: { Videos: { VideoList: [
      { Date: '2023-05-01 12:00:00', Link: 'https://www.tiktokv.com/share/video/1/', Likes: '12', Sound: 'original sound' },
      { Date: '2024-02-01 12:00:00', Link: 'https://www.tiktokv.com/share/video/2/', Likes: '3' },
    ] } },
  };
  const r = S.parseTikTok(json);
  assert.strictEqual(r.posts.length, 2);
  assert.strictEqual(r.posts[0].link, 'https://www.tiktokv.com/share/video/2/');
  assert.strictEqual(r.sounds.length, 1);
  assert.strictEqual(r.other.length, 2);
  assert.strictEqual(S.niceDate('2023-05-01 12:00:00'), '1 May 2023');
});

test('ZIP reader reads stored and deflated entries', async () => {
  const zlib = require('zlib');
  const enc = new TextEncoder();
  const files = [['a.txt', enc.encode('hello'), 0], ['TikTok/user_data_tiktok.json', enc.encode(JSON.stringify({ Post: { Posts: { VideoList: [{ Date: '2025-01-01', Link: 'https://t/1' }] } } })), 8]];
  const parts = [], central = []; let off = 0;
  const crc = (b) => zlib.crc32 ? zlib.crc32(b) : 0;
  for (const [name, data, method] of files) {
    const body = method ? zlib.deflateRawSync(data) : Buffer.from(data);
    const nb = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(crc(data), 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc(data), 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nb, body); central.push(ch, nb); off += 30 + nb.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(files.length, 8); eo.writeUInt16LE(files.length, 10); eo.writeUInt32LE(cd.length, 12); eo.writeUInt32LE(off, 16);
  const zip = Buffer.concat([...parts, cd, eo]);
  const entries = S.readZip(new Uint8Array(zip));
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(new TextDecoder().decode(await entries[0].read()), 'hello');
  const res = await S.readTikTokExport(new Blob([zip]));
  assert.strictEqual(res.posts.length, 1);
});

test('WAV encoder writes a valid header', () => {
  const w = S.encodeWav({ sampleRate: 8000, channels: [new Float32Array([0, 0.5, -0.5, 1])] });
  assert.strictEqual(w.length, 44 + 8);
  assert.strictEqual(String.fromCharCode(...w.slice(0, 4)), 'RIFF');
});
