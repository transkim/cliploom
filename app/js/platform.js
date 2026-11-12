/* One API over Windows (Electron), Android (Capacitor) and a plain browser. */
(function (root) {
  const cap = root.Capacitor;
  const isNative = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const P = (cap && cap.Plugins) || {};
  const desk = root.cliploomDesktop;
  const platform = isNative ? 'android' : desk ? 'windows' : 'web';

  function blobToB64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  const Platform = {
    platform,

    /** Save a finished file. Returns a short status line for a toast. */
    async save(blob, filename, opts) {
      opts = opts || {};
      if (desk) {
        const r = await desk.saveFile({ name: filename, bytes: await blob.arrayBuffer(), kind: opts.kind || 'video' });
        return r && r.path ? 'Saved to ' + r.path : 'Not saved';
      }
      if (isNative && P.Filesystem) {
        // write in pieces so long videos don't run the bridge out of memory
        const path = 'Cliploom/' + filename;
        const CH = 3 * 1024 * 1024; // multiple of 3 keeps base64 pieces joinable
        let uri = null;
        for (let off = 0; off < blob.size || off === 0; off += CH) {
          const data = await blobToB64(blob.slice(off, off + CH));
          if (off === 0) uri = (await P.Filesystem.writeFile({ path, data, directory: 'DOCUMENTS', recursive: true })).uri;
          else await P.Filesystem.appendFile({ path, data, directory: 'DOCUMENTS' });
          if (blob.size === 0) break;
        }
        if (opts.share !== false && P.Share) {
          try { await P.Share.share({ title: filename, files: [uri], dialogTitle: 'Share your video' }); } catch (_) { /* closed */ }
        }
        return 'Saved to Documents/Cliploom';
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      return 'Downloaded';
    },

    /** Download a direct media link (a file you have the rights to). Windows avoids browser CORS limits. */
    async fetchMedia(url) {
      if (!/^https?:\/\//i.test(url)) throw new Error('Paste a full link that starts with https://');
      if (desk) {
        const r = await desk.fetchMedia(url);
        if (r.error) throw new Error(r.error);
        return new Blob([r.bytes], { type: r.type || '' });
      }
      if (isNative && P.CapacitorHttp) {
        const r = await P.CapacitorHttp.request({ url, method: 'GET', responseType: 'blob', connectTimeout: 30000, readTimeout: 300000 });
        if (r.status >= 400) throw new Error('The link answered ' + r.status);
        const type = (r.headers && (r.headers['Content-Type'] || r.headers['content-type'])) || '';
        const bin = atob(r.data); const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return new Blob([arr], { type });
      }
      const res = await fetch(url);
      if (!res.ok) throw new Error('The link answered ' + res.status);
      return res.blob();
    },

    /**
     * AI provider requests. req = { url, method, headers, json | form (FormData), binary }
     * -> { status, ok, text, data (parsed JSON or null), blob (binary only) }.
     * Windows goes through the main process (provider hosts only); Android uses native HTTP
     * for JSON so there are no browser CORS limits; uploads use fetch with FormData.
     */
    async http(req) {
      const method = req.method || (req.json !== undefined || req.form ? 'POST' : 'GET');
      const headers = Object.assign({}, req.headers || {});
      if (req.json !== undefined) headers['Content-Type'] = 'application/json';
      const parse = (t) => { try { return JSON.parse(t); } catch (_) { return null; } };
      const done = (status, text, blob) => ({ status, ok: status >= 200 && status < 300, text: text || '', data: text ? parse(text) : null, blob });
      if (desk && desk.http) {
        let body;
        if (req.json !== undefined) body = JSON.stringify(req.json);
        else if (req.form) {
          const r = new Response(req.form);
          headers['Content-Type'] = r.headers.get('content-type');
          body = new Uint8Array(await r.arrayBuffer());
        }
        const r = await desk.http({ url: req.url, method, headers, body, binary: !!req.binary });
        if (r.error) throw new Error(r.error);
        if (r.bytes) return done(r.status, '', new Blob([r.bytes], { type: r.type || '' }));
        return done(r.status, r.text);
      }
      if (isNative && P.CapacitorHttp && !req.form) {
        const r = await P.CapacitorHttp.request({ url: req.url, method, headers, data: req.json, responseType: req.binary ? 'blob' : 'text', connectTimeout: 30000, readTimeout: 600000 });
        if (req.binary && r.status < 300) {
          const type = (r.headers && (r.headers['Content-Type'] || r.headers['content-type'])) || '';
          const bin = atob(r.data); const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          return done(r.status, '', new Blob([arr], { type }));
        }
        return done(r.status, typeof r.data === 'string' ? r.data : JSON.stringify(r.data));
      }
      const res = await fetch(req.url, { method, headers, body: req.form || (req.json !== undefined ? JSON.stringify(req.json) : undefined) });
      if (req.binary && res.ok) return done(res.status, '', await res.blob());
      return done(res.status, await res.text());
    },

    openExternal(url) {
      if (desk) return desk.openExternal(url);
      if (isNative && P.Browser) return P.Browser.open({ url });
      root.open(url, '_blank', 'noopener');
    },

    onBack(fn) {
      if (isNative && P.App) P.App.addListener('backButton', fn);
    },
  };
  root.Platform = Platform;
})(window);
