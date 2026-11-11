const { app, BrowserWindow, ipcMain, shell, dialog, net, session } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_DIR = path.join(__dirname, '..', 'app');
let win = null;

if (!app.requestSingleInstanceLock()) app.quit();
else app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.setAppUserModelId('app.cliploom.desktop');

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 380, minHeight: 560,
    title: 'Cliploom',
    icon: path.join(APP_DIR, 'img', 'icon.png'),
    backgroundColor: '#0c0e13',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(APP_DIR, 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  win.on('closed', () => { win = null; });
}

// microphone for voice-over; nothing else
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media' || perm === 'clipboard-sanitized-write'));
  createWindow();
});

ipcMain.handle('cliploom:save', async (_e, { name, bytes, kind }) => {
  const dir = path.join(app.getPath(kind === 'audio' ? 'music' : 'videos'), 'Cliploom');
  const ext = path.extname(name).slice(1) || 'mp4';
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(dir, String(name).replace(/[\\/:*?"<>|]/g, '_')),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (r.canceled || !r.filePath) return {};
  fs.mkdirSync(path.dirname(r.filePath), { recursive: true });
  fs.writeFileSync(r.filePath, Buffer.from(bytes));
  shell.showItemInFolder(r.filePath);
  return { path: r.filePath };
});

// Direct media links only (the renderer checks the host); 300 MB cap.
ipcMain.handle('cliploom:fetch', async (_e, url) => {
  try {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { error: 'Bad link' };
    const res = await net.fetch(url, { redirect: 'follow' });
    if (!res.ok) return { error: 'The link answered ' + res.status };
    const type = res.headers.get('content-type') || '';
    if (/text\/html/i.test(type)) return { error: 'That link is a web page, not a sound or video file.' };
    const len = +res.headers.get('content-length') || 0;
    if (len > 300 * 1048576) return { error: 'File is larger than 300 MB' };
    return { type, bytes: Buffer.from(await res.arrayBuffer()) };
  } catch (e) { return { error: (e && e.message) || String(e) }; }
});

ipcMain.handle('cliploom:open', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });

app.on('window-all-closed', () => app.quit());
