/* Cliploom — GPU transitions.
 * Runs the GL Transitions shaders (vendor/gl-transitions.js, MIT) on one shared WebGL canvas.
 * render(name, from, to, progress, W, H) draws the mix of two canvases and returns the GL canvas,
 * or null when WebGL or that shader is not available (the caller then cross-fades).
 */
const GLTrans = (() => {
  const LIST = (window.GL_TRANSITIONS || []).slice();
  const BY = new Map(LIST.map((t) => [t.name, t]));
  const VS = 'attribute vec2 _p; varying vec2 _uv; void main(){ gl_Position = vec4(_p, 0.0, 1.0); _uv = (_p + 1.0) * 0.5; }';
  const HEAD = 'precision highp float;\nvarying vec2 _uv;\nuniform sampler2D from, to;\nuniform float progress, ratio;\n' +
    'vec4 getFromColor(vec2 uv){ return texture2D(from, uv); }\nvec4 getToColor(vec2 uv){ return texture2D(to, uv); }\n';
  const FOOT = '\nvoid main(){ gl_FragColor = transition(_uv); }\n';
  let cv = null, gl, vs, buf, texA, texB, lost = false;
  const progs = new Map(), bad = new Set();

  function init() {
    if (gl !== undefined) return gl && !lost ? gl : null;
    cv = document.createElement('canvas');
    cv.width = 2; cv.height = 2;
    gl = cv.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false }) || null;
    if (!gl) return null;
    cv.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });
    cv.addEventListener('webglcontextrestored', () => { lost = false; progs.clear(); setup(); });
    setup();
    return gl;
  }
  function setup() {
    vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, VS); gl.compileShader(vs);
    buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const tex = () => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    texA = tex(); texB = tex();
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  }

  function program(name) {
    if (progs.has(name)) return progs.get(name);
    const t = BY.get(name);
    if (!t || bad.has(name)) return null;
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, HEAD + t.glsl + FOOT);
    gl.compileShader(fs);
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, '_p');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.warn('Transition ' + name + ' did not compile:', gl.getShaderInfoLog(fs) || gl.getProgramInfoLog(p));
      bad.add(name); gl.deleteProgram(p); gl.deleteShader(fs);
      return null;
    }
    gl.useProgram(p);
    gl.uniform1i(gl.getUniformLocation(p, 'from'), 0);
    gl.uniform1i(gl.getUniformLocation(p, 'to'), 1);
    for (const [k, [type, d]] of Object.entries(t.params)) {
      const loc = gl.getUniformLocation(p, k);
      if (!loc || d == null) continue;
      const v = Array.isArray(d) ? d : [typeof d === 'boolean' ? (d ? 1 : 0) : d];
      if (type === 'float') gl.uniform1f(loc, v[0]);
      else if (type === 'int' || type === 'bool') gl.uniform1i(loc, v[0]);
      else if (type === 'vec2') gl.uniform2fv(loc, v);
      else if (type === 'vec3') gl.uniform3fv(loc, v);
      else if (type === 'vec4') gl.uniform4fv(loc, v);
      else if (type === 'ivec2') gl.uniform2iv(loc, v);
      else if (type === 'ivec3') gl.uniform3iv(loc, v);
      else if (type === 'ivec4') gl.uniform4iv(loc, v);
    }
    const o = { p, progress: gl.getUniformLocation(p, 'progress'), ratio: gl.getUniformLocation(p, 'ratio') };
    progs.set(name, o);
    return o;
  }

  /** from/to: canvases or images of the same size. Returns the WebGL canvas (valid until the next call). */
  function render(name, from, to, progress, W, H, sameTextures) {
    if (!init()) return null;
    const o = program(name);
    if (!o) return null;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    gl.viewport(0, 0, W, H);
    gl.useProgram(o.p);
    if (!sameTextures) {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, from);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texB);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, to);
    }
    gl.uniform1f(o.progress, progress);
    gl.uniform1f(o.ratio, W / H);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return cv;
  }

  /** Try every shader once (used by the tests). */
  function check() {
    if (!init()) return { webgl: false };
    const failed = LIST.filter((t) => !program(t.name)).map((t) => t.name);
    return { webgl: true, total: LIST.length, failed };
  }

  const pretty = (n) => n.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
  return { LIST, has: (n) => BY.has(n), render, check, pretty, available: () => !!init() };
})();
if (typeof window !== 'undefined') window.GLTrans = GLTrans;
