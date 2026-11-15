/* Código compartido entre anfitrión (PC) y cliente (Android / web / exe). */
(function (g) {
  'use strict';

  // ---------- SHA-256 / HMAC en JS puro (funciona también fuera de contextos seguros) ----------
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);

  function utf8(s) { return new TextEncoder().encode(s); }

  function sha256(bytes) {
    const l = bytes.length, bitLen = l * 8;
    const n = ((l + 9 + 63) >> 6) << 6;
    const m = new Uint8Array(n); m.set(bytes); m[l] = 0x80;
    const dv = new DataView(m.buffer);
    dv.setUint32(n - 4, bitLen >>> 0); dv.setUint32(n - 8, Math.floor(bitLen / 4294967296));
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const W = new Uint32Array(64);
    for (let o = 0; o < n; o += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + i * 4);
      for (let i = 16; i < 64; i++) {
        const a = W[i - 15], b = W[i - 2];
        const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
        const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, h0, h] = H;
      let gg = h0;
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & gg);
        const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const mj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + mj) | 0;
        h = gg; gg = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += gg; H[7] += h;
    }
    const out = new Uint8Array(32); const odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
    return out;
  }

  function hmac(keyStr, msgStr) {
    let key = utf8(keyStr);
    if (key.length > 64) key = sha256(key);
    const k = new Uint8Array(64); k.set(key);
    const ipad = new Uint8Array(64 + 0), opad = new Uint8Array(64);
    for (let i = 0; i < 64; i++) { ipad[i] = k[i] ^ 0x36; opad[i] = k[i] ^ 0x5c; }
    const msg = utf8(msgStr);
    const inner = new Uint8Array(64 + msg.length); inner.set(ipad); inner.set(msg, 64);
    const ih = sha256(inner);
    const outer = new Uint8Array(96); outer.set(opad); outer.set(ih, 64);
    return hex(sha256(outer));
  }

  function hex(b) { return Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); }

  function randomToken(nBytes) {
    const b = new Uint8Array(nBytes || 16); crypto.getRandomValues(b);
    // base32-ish legible (sin caracteres ambiguos)
    const A = 'abcdefghjkmnpqrstuvwxyz23456789';
    return Array.from(b, x => A[x % A.length]).join('');
  }

  // El ID en el servidor de señalización es un hash del usuario: el servidor nunca ve el nombre.
  function normUser(u) { return String(u || '').trim().toLowerCase(); }
  function peerIdFor(user) { return 'rdk1-' + hex(sha256(utf8('remoto-directo:' + normUser(user)))).slice(0, 32); }

  // Servidores ICE: STUN de Google + TURN público de PeerJS (respaldo cuando no hay P2P directo).
  const DEFAULT_ICE = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' }
  ];

  function loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem('rd-settings') || '{}'); } catch (e) { }
    return s;
  }
  function saveSettings(s) { try { localStorage.setItem('rd-settings', JSON.stringify(s)); } catch (e) { } }

  function iceServers(s) {
    const list = DEFAULT_ICE.slice();
    if (s && s.turnUrl) list.unshift({ urls: s.turnUrl.split(',').map(x => x.trim()), username: s.turnUser || '', credential: s.turnPass || '' });
    return list;
  }

  // Opciones para new Peer(): servidor PeerJS público por defecto, o uno propio.
  function peerOptions(s) {
    const o = { debug: 1, config: { iceServers: iceServers(s) } };
    if (s && s.sigHost) {
      o.host = s.sigHost; o.port = Number(s.sigPort || 443); o.path = s.sigPath || '/';
      o.secure = s.sigSecure !== false; if (s.sigKey) o.key = s.sigKey;
    }
    return o;
  }

  // Reordena los códecs de vídeo del SDP para preferir el elegido (H264 = decodificación por hardware en casi todos los móviles).
  function preferCodec(sdp, codec) {
    if (!codec || codec === 'auto') return sdp;
    const lines = sdp.split('\r\n');
    const mi = lines.findIndex(l => l.startsWith('m=video'));
    if (mi < 0) return sdp;
    const pts = [];
    const re = new RegExp('^a=rtpmap:(\\d+) ' + codec + '/', 'i');
    for (const l of lines) { const m = l.match(re); if (m) pts.push(m[1]); }
    // incluir RTX asociados
    for (const l of lines) { const m = l.match(/^a=fmtp:(\d+) apt=(\d+)/); if (m && pts.includes(m[2])) pts.push(m[1]); }
    if (!pts.length) return sdp;
    const parts = lines[mi].split(' ');
    const head = parts.slice(0, 3), rest = parts.slice(3);
    lines[mi] = head.concat(pts.filter(p => rest.includes(p)), rest.filter(p => !pts.includes(p))).join(' ');
    return lines.join('\r\n');
  }

  // Opus en estéreo y alta tasa de bits (calidad de estudio), FEC activado y paquetes de 10 ms (menos latencia).
  function tuneOpus(sdp, kbps) {
    const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
    if (!m) return sdp;
    const pt = m[1], br = (kbps || 510) * 1000;
    const want = { stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: String(br), useinbandfec: '1', minptime: '10', cbr: '0' };
    const re = new RegExp('a=fmtp:' + pt + ' ([^\\r\\n]*)');
    if (re.test(sdp)) {
      return sdp.replace(re, (all, params) => {
        const o = {};
        params.split(';').forEach(kv => { const [k, v] = kv.split('='); if (k) o[k.trim()] = (v || '').trim(); });
        Object.assign(o, want);
        return 'a=fmtp:' + pt + ' ' + Object.entries(o).map(([k, v]) => k + '=' + v).join(';');
      });
    }
    return sdp.replace('a=rtpmap:' + pt + ' opus/48000/2', 'a=rtpmap:' + pt + ' opus/48000/2\r\na=fmtp:' + pt + ' ' + Object.entries(want).map(([k, v]) => k + '=' + v).join(';'));
  }

  function tuneSdp(sdp, codec) { return tuneOpus(preferCodec(sdp, codec)); }

  function PeerCtor() { return g.Peer || (g.peerjs && g.peerjs.Peer); }

  g.RD = { sha256, hmac, hex, utf8, randomToken, normUser, peerIdFor, iceServers, peerOptions, loadSettings, saveSettings, preferCodec, tuneOpus, tuneSdp, PeerCtor, PROTO: 1 };
})(typeof window !== 'undefined' ? window : globalThis);
