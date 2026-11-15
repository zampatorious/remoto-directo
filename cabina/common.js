/* Cabina Remota · código compartido entre el panel del estudio y el cliente web. */
(function (g) {
  'use strict';

  // ---------- SHA-256 / HMAC en JS puro ----------
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
    const l = bytes.length, bitLen = l * 8, n = ((l + 9 + 63) >> 6) << 6;
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
      let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], gg = H[6], h = H[7];
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const t1 = (h + S1 + ((e & f) ^ (~e & gg)) + K[i] + W[i]) | 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = gg; gg = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += gg; H[7] += h;
    }
    const out = new Uint8Array(32), odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
    return out;
  }
  function hex(b) { return Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); }
  function hmac(keyStr, msgStr) {
    let key = utf8(keyStr); if (key.length > 64) key = sha256(key);
    const k = new Uint8Array(64); k.set(key);
    const ipad = new Uint8Array(64), opad = new Uint8Array(64);
    for (let i = 0; i < 64; i++) { ipad[i] = k[i] ^ 0x36; opad[i] = k[i] ^ 0x5c; }
    const msg = utf8(msgStr);
    const inner = new Uint8Array(64 + msg.length); inner.set(ipad); inner.set(msg, 64);
    const outer = new Uint8Array(96); outer.set(opad); outer.set(sha256(inner), 64);
    return hex(sha256(outer));
  }
  function randomToken(n) {
    const b = new Uint8Array(n || 16); crypto.getRandomValues(b);
    const A = 'abcdefghjkmnpqrstuvwxyz23456789';
    return Array.from(b, x => A[x % A.length]).join('');
  }

  function normUser(u) { return String(u || '').trim().toLowerCase(); }
  function peerIdFor(studio) { return 'cab1-' + hex(sha256(utf8('cabina-remota:' + normUser(studio)))).slice(0, 32); }

  // STUN de Google + TURN público de PeerJS como respaldo.
  const ICE = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' }
  ];
  function iceServers(s) {
    const list = ICE.slice();
    if (s && s.turnUrl) list.unshift({ urls: s.turnUrl.split(',').map(x => x.trim()), username: s.turnUser || '', credential: s.turnPass || '' });
    return list;
  }
  function peerOptions(s) {
    const o = { debug: 1, config: { iceServers: iceServers(s) } };
    if (s && s.sigHost) { o.host = s.sigHost; o.port = Number(s.sigPort || 443); o.path = s.sigPath || '/'; o.secure = s.sigSecure !== false; }
    return o;
  }

  // Opus calidad estudio en TODAS las líneas de audio: estéreo, 510 kbps, FEC, paquetes de 10 ms, sin DTX.
  function tuneSdp(sdp) {
    const lines = sdp.split('\r\n');
    const opus = new Set();
    lines.forEach(l => { const m = l.match(/^a=rtpmap:(\d+) opus\/48000\/2/i); if (m) opus.add(m[1]); });
    const want = { stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: '510000', maxplaybackrate: '48000', useinbandfec: '1', minptime: '10', usedtx: '0', cbr: '0' };
    const out = [];
    let inAudio = false, hasPtime = false;
    const closeSection = () => { if (inAudio && !hasPtime) out.push('a=ptime:10'); };
    for (const l of lines) {
      if (l.startsWith('m=')) { closeSection(); inAudio = l.startsWith('m=audio'); hasPtime = false; }
      if (inAudio && l.startsWith('a=ptime:')) { out.push('a=ptime:10'); hasPtime = true; continue; } // paquetes de 10 ms
      const m = l.match(/^a=fmtp:(\d+) (.*)$/);
      if (!m || !opus.has(m[1])) { out.push(l); continue; }
      const o = {};
      m[2].split(';').forEach(kv => { const [k, v] = kv.split('='); if (k) o[k.trim()] = (v || '').trim(); });
      Object.assign(o, want);
      out.push('a=fmtp:' + m[1] + ' ' + Object.entries(o).map(([k, v]) => k + '=' + v).join(';'));
    }
    // la última línea del SDP es vacía (termina en \r\n): la sección final se cierra antes de ella
    if (out.length && out[out.length - 1] === '') { out.pop(); closeSection(); out.push(''); } else closeSection();
    return out.join('\r\n');
  }

  function PeerCtor() { return g.Peer || (g.peerjs && g.peerjs.Peer); }

  // Vúmetro: pico en dBFS de un AnalyserNode
  const _buf = new Float32Array(1024);
  function peakDb(an) {
    an.getFloatTimeDomainData(_buf);
    let pk = 0; for (let i = 0; i < an.fftSize; i++) { const v = Math.abs(_buf[i]); if (v > pk) pk = v; }
    return 20 * Math.log10(pk || 1e-7);
  }
  function dbToPct(db) { return Math.max(0, Math.min(100, (db + 60) / 60 * 100)); }

  g.CR = { sha256, hmac, hex, utf8, randomToken, normUser, peerIdFor, iceServers, peerOptions, tuneSdp, PeerCtor, peakDb, dbToPct, PROTO: 1 };
})(typeof window !== 'undefined' ? window : globalThis);
