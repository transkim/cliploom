// Renders app/img/icon.svg to PNGs and build/icon.ico (Playwright Chromium).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
(async () => {
  const root = path.join(__dirname, '..');
  const svg = fs.readFileSync(path.join(root, 'app/img/icon.svg'), 'utf8');
  const b = await chromium.launch();
  const pg = await b.newPage();
  const render = async (size, pad) => {
    await pg.setViewportSize({ width: size, height: size });
    await pg.setContent(`<html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px;padding:${pad||0}px;box-sizing:border-box">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div></body></html>`);
    return pg.screenshot({ omitBackground: true });
  };
  fs.writeFileSync(path.join(root, 'app/img/icon.png'), await render(512));
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build/icon.png'), await render(1024));
  const sizes = [256, 64, 48, 32, 16];
  const pngs = [];
  for (const s of sizes) pngs.push(await render(s));
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let off = 6 + 16 * sizes.length; const dirs = [];
  sizes.forEach((s, i) => { const d = Buffer.alloc(16); d.writeUInt8(s >= 256 ? 0 : s, 0); d.writeUInt8(s >= 256 ? 0 : s, 1); d.writeUInt16LE(1, 4); d.writeUInt16LE(32, 6); d.writeUInt32LE(pngs[i].length, 8); d.writeUInt32LE(off, 12); off += pngs[i].length; dirs.push(d); });
  fs.writeFileSync(path.join(root, 'build/icon.ico'), Buffer.concat([head, ...dirs, ...pngs]));
  // Android adaptive foreground source (icon on transparent, padded)
  fs.mkdirSync(path.join(root, 'mobile/assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'mobile/assets/icon-only.png'), await render(1024));
  await b.close();
})();
