/* Cliente de control remoto: funciona en la APK, en el navegador (enlace de invitación) y en el .exe. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const IS_ANDROID_APP = typeof window.AndroidBridge !== 'undefined';
  const IS_TOUCH = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

  // ---------------- scancodes (set 1). 0xE000 = tecla extendida ----------------
  const E = 0xE000;
  const SC = {
    Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06, Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0A, Digit0: 0x0B,
    Minus: 0x0C, Equal: 0x0D, Backspace: 0x0E, Tab: 0x0F, KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16, KeyI: 0x17,
    KeyO: 0x18, KeyP: 0x19, BracketLeft: 0x1A, BracketRight: 0x1B, Enter: 0x1C, ControlLeft: 0x1D, KeyA: 0x1E, KeyS: 0x1F, KeyD: 0x20, KeyF: 0x21,
    KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27, Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2A, Backslash: 0x2B,
    KeyZ: 0x2C, KeyX: 0x2D, KeyC: 0x2E, KeyV: 0x2F, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36,
    NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39, CapsLock: 0x3A, F1: 0x3B, F2: 0x3C, F3: 0x3D, F4: 0x3E, F5: 0x3F, F6: 0x40, F7: 0x41, F8: 0x42,
    F9: 0x43, F10: 0x44, NumLock: E | 0x45, ScrollLock: 0x46, Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4A, Numpad4: 0x4B,
    Numpad5: 0x4C, Numpad6: 0x4D, NumpadAdd: 0x4E, Numpad1: 0x4F, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53,
    IntlBackslash: 0x56, F11: 0x57, F12: 0x58, NumpadEnter: E | 0x1C, ControlRight: E | 0x1D, NumpadDivide: E | 0x35, PrintScreen: E | 0x37,
    AltRight: E | 0x38, Home: E | 0x47, ArrowUp: E | 0x48, PageUp: E | 0x49, ArrowLeft: E | 0x4B, ArrowRight: E | 0x4D, End: E | 0x4F,
    ArrowDown: E | 0x50, PageDown: E | 0x51, Insert: E | 0x52, Delete: E | 0x53, MetaLeft: E | 0x5B, MetaRight: E | 0x5C, ContextMenu: E | 0x5D
  };
  const NAMED = {
    esc: SC.Escape, tab: SC.Tab, ctrl: SC.ControlLeft, alt: SC.AltLeft, shift: SC.ShiftLeft, win: SC.MetaLeft,
    left: SC.ArrowLeft, up: SC.ArrowUp, down: SC.ArrowDown, right: SC.ArrowRight, del: SC.Delete, home: SC.Home, end: SC.End,
    pgup: SC.PageUp, pgdn: SC.PageDown, enter: SC.Enter, bksp: SC.Backspace, f4: SC.F4, f5: SC.F5
  };
  function charSc(ch) {
    ch = ch.toLowerCase();
    if (/^[a-z]$/.test(ch)) return SC['Key' + ch.toUpperCase()];
    if (/^[0-9]$/.test(ch)) return SC['Digit' + ch];
    if (ch === ' ') return SC.Space;
    return 0;
  }
  function nameSc(n) { return NAMED[n] || charSc(n) || 0; }

  // ---------------- estado ----------------
  let settings = RD.loadSettings();
  let peer = null, conn = null, pc = null, fast = null;
  let hostId = '', authSecret = '', viewOnly = false, screens = [], curScreen = null;
  let mode = settings.mode || (IS_TOUCH ? 'touch' : 'touch'); // 'touch' (directo) | 'pad' (touchpad)
  let seq = 0, connected = false, userQuit = false, retries = 0, lastLogin = null;
  let talkSender = null, talkTrack = null, muted = false, recMode = false;
  const view = { s: 1, x: 0, y: 0 };
  const mods = { ctrl: false, alt: false, shift: false, win: false };

  // ---------------- UI login ----------------
  const hash = new URLSearchParams(location.hash.slice(1));
  const invite = hash.get('u') && hash.get('k') ? { user: hash.get('u'), token: hash.get('k') } : null;
  if (hash.get('s')) settings.sigHost = hash.get('s');

  $('user').value = settings.user || '';
  $('quality').value = settings.quality || (IS_TOUCH ? 'bal' : 'bal');
  $('codec').value = settings.codec || 'H264';
  $('sigHost').value = settings.sigHost || '';
  $('turnUrl').value = settings.turnUrl || '';
  $('turnUser').value = settings.turnUser || '';
  $('turnPass').value = settings.turnPass || '';
  if (settings.key) $('pass').placeholder = '•••••• (guardada)';

  if (invite) {
    $('inviteBox').classList.remove('hidden');
    $('inviteUser').textContent = invite.user;
    $('credBox').classList.add('hidden');
    $('connectBtn').textContent = 'Aceptar y conectar';
  }

  function setStatus(t, err) { const s = $('loginStatus'); s.textContent = t || ''; s.classList.toggle('err', !!err); }

  $('connectBtn').onclick = () => {
    settings.quality = $('quality').value; settings.codec = $('codec').value;
    settings.sigHost = $('sigHost').value.trim(); settings.turnUrl = $('turnUrl').value.trim();
    settings.turnUser = $('turnUser').value.trim(); settings.turnPass = $('turnPass').value;
    let user, secret;
    if (invite) { user = invite.user; secret = invite.token; }
    else {
      user = RD.normUser($('user').value);
      if (!user) return setStatus('Escribe el usuario del PC', true);
      const pass = $('pass').value;
      if (pass) secret = passKey(user, pass);
      else if (settings.key && settings.user === user) secret = settings.key;
      else return setStatus('Escribe la contraseña', true);
      settings.user = user;
      if ($('remember').checked) settings.key = secret; else delete settings.key;
    }
    RD.saveSettings(settings);
    retries = 0; userQuit = false;
    start(user, secret);
  };
  $('pass').addEventListener('keydown', e => { if (e.key === 'Enter') $('connectBtn').click(); });

  function passKey(user, pass) { return RD.hex(RD.sha256(RD.utf8('pw:' + RD.normUser(user) + ':' + pass))); }

  // ---------------- conexión ----------------
  function start(user, secret) {
    lastLogin = { user, secret };
    cleanup();
    hostId = RD.peerIdFor(user); authSecret = secret;
    $('connectBtn').disabled = true;
    setStatus('Buscando el PC…');
    const Peer = RD.PeerCtor();
    peer = new Peer(RD.peerOptions(settings));
    peer.on('open', () => {
      setStatus('Conectando con el PC…');
      conn = peer.connect(hostId, { reliable: true, serialization: 'json', metadata: { v: RD.PROTO, dev: navigator.userAgent.slice(0, 80) } });
      conn.on('data', onData);
      conn.on('close', onLost);
      conn.on('error', onLost);
      setTimeout(() => { if (!connected && conn && !conn.open) fail('El PC no responde. ¿Está encendido y con la app abierta?'); }, 20000);
    });
    peer.on('error', e => {
      if (e.type === 'peer-unavailable') fail('Ese PC no está en línea (usuario incorrecto o app cerrada).');
      else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') fail('Sin conexión con el servidor de señalización.');
      else if (!connected) fail('Error: ' + e.type);
    });
  }

  function send(o) { if (conn && conn.open) conn.send(o); }
  function sendFast(o) {
    if (fast && fast.readyState === 'open') fast.send(JSON.stringify(o)); else send(o);
  }

  async function onData(m) {
    switch (m.t) {
      case 'hello':
        send({ t: 'auth', mac: RD.hmac(authSecret, m.nonce + '|' + hostId), kind: invite ? 'inv' : 'pwd', codec: settings.codec || 'H264' });
        setStatus('Verificando…');
        break;
      case 'fail':
        fail(m.why === 'locked' ? 'Demasiados intentos. Espera un minuto.' : m.why === 'expired' ? 'La invitación ha caducado.' : 'Usuario o contraseña incorrectos.');
        if (!invite) { delete settings.key; RD.saveSettings(settings); }
        userQuit = true;
        break;
      case 'ok':
        viewOnly = !!m.viewOnly; screens = m.screens || []; curScreen = m.cur;
        recMode = false; if (m.rec) setTimeout(() => setRecMode(true), 1500);
        setStatus('Abriendo vídeo…');
        setupRtc();
        send({ t: 'q', p: settings.quality || 'bal' });
        break;
      case 'sdp':
        await pc.setRemoteDescription({ type: m.type, sdp: m.sdp });
        if (m.type === 'offer') {
          // el canal de audio es bidireccional: recibimos el sonido del PC y enviamos el talkback
          pc.getTransceivers().forEach(tr => {
            if (tr.receiver.track && tr.receiver.track.kind === 'audio') { tr.direction = 'sendrecv'; talkSender = tr.sender; }
          });
          if (talkTrack && talkSender) talkSender.replaceTrack(talkTrack);
          const ans = await pc.createAnswer();
          ans.sdp = RD.tuneSdp(ans.sdp, settings.codec || 'H264');
          await pc.setLocalDescription(ans);
          send({ t: 'sdp', type: 'answer', sdp: pc.localDescription.sdp });
        }
        break;
      case 'ice':
        try { await pc.addIceCandidate(m.c); } catch (e) { }
        break;
      case 'screens':
        screens = m.screens; curScreen = m.cur; if (subOpen === 'screens') showScreens();
        break;
      case 'toast': toast(m.text); break;
      case 'rec': setRecMode(!!m.on); break;
      case 'bye': userQuit = true; fail(m.text || 'El PC ha cerrado la sesión.'); break;
    }
  }

  function setupRtc() {
    pc = new RTCPeerConnection({ iceServers: RD.iceServers(settings), bundlePolicy: 'max-bundle' });
    pc.onicecandidate = e => { if (e.candidate) send({ t: 'ice', c: e.candidate.toJSON() }); };
    pc.ondatachannel = e => { if (e.channel.label === 'fast') fast = e.channel; };
    pc.ontrack = e => {
      if (e.track.kind === 'audio') {
        // audio: búfer pequeño pero no nulo para evitar cortes en la música
        try { e.receiver.jitterBufferTarget = settings.audioBuf != null ? settings.audioBuf : 40; } catch (x) { }
        const a = $('audio');
        a.srcObject = new MediaStream([e.track]);
        a.play().catch(() => toast('Toca la pantalla para activar el sonido'));
        return;
      }
      // vídeo: latencia mínima, sin búfer de reproducción
      try { e.receiver.playoutDelayHint = 0; } catch (x) { }
      try { e.receiver.jitterBufferTarget = 0; } catch (x) { }
      const v = $('video');
      v.srcObject = e.streams[0] || new MediaStream([e.track]);
      v.play().catch(() => { });
      enterSession();
    };
    pc.onconnectionstatechange = () => {
      if (pc && (pc.connectionState === 'failed')) onLost();
    };
  }

  function enterSession() {
    if (connected) return;
    connected = true; retries = 0;
    $('connectBtn').disabled = false; setStatus('');
    $('login').classList.add('hidden'); $('session').classList.remove('hidden');
    $('touch').classList.toggle('pc', !IS_TOUCH);
    applyMode(); resetView();
    if (IS_ANDROID_APP) try { AndroidBridge.setSession(true); } catch (e) { }
    toast(viewOnly ? 'Conectado (solo ver)' : 'Conectado');
  }

  function onLost() {
    if (!connected && !conn) return;
    const wasConnected = connected;
    cleanup();
    if (!userQuit && lastLogin && retries < 5) {
      retries++;
      showLogin();
      setStatus('Conexión perdida. Reintentando (' + retries + ')…');
      setTimeout(() => { if (!userQuit) start(lastLogin.user, lastLogin.secret); }, wasConnected ? 800 : 2500);
    } else if (!userQuit) { showLogin(); setStatus('Conexión perdida.', true); }
  }

  function fail(msg) { cleanup(); showLogin(); setStatus(msg, true); }

  function cleanup() {
    connected = false;
    try { conn && conn.close(); } catch (e) { }
    try { pc && pc.close(); } catch (e) { }
    try { peer && peer.destroy(); } catch (e) { }
    conn = null; pc = null; peer = null; fast = null;
    if (talkTrack) { talkTrack.stop(); talkTrack = null; }
    if (monCtx) toggleMonitor(false);
    talkSender = null;
    const tb = $('talkBtn'); tb.classList.remove('on'); tb.textContent = '🎙 Hablar';
    $('video').srcObject = null; $('audio').srcObject = null;
    if (IS_ANDROID_APP) try { AndroidBridge.setSession(false); } catch (e) { }
  }
  function showLogin() {
    $('connectBtn').disabled = false;
    $('session').classList.add('hidden'); $('login').classList.remove('hidden');
    closeMenu(); $('keybar').classList.add('hidden');
  }
  function quit() { userQuit = true; send({ t: 'bye' }); setTimeout(() => { cleanup(); showLogin(); setStatus('Desconectado.'); }, 50); }

  // ---------------- mapeo de coordenadas ----------------
  const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
  function toNorm(cx, cy) {
    const v = $('video'), r = v.getBoundingClientRect();
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return null;
    const s = Math.min(r.width / vw, r.height / vh), w = vw * s, h = vh * s;
    const ox = r.left + (r.width - w) / 2, oy = r.top + (r.height - h) / 2;
    return { x: clamp01((cx - ox) / w), y: clamp01((cy - oy) / h) };
  }
  function applyView() {
    const W = innerWidth, H = innerHeight;
    view.s = Math.max(1, Math.min(6, view.s));
    view.x = Math.min(0, Math.max(W - W * view.s, view.x));
    view.y = Math.min(0, Math.max(H - H * view.s, view.y));
    $('video').style.transform = `translate(${view.x}px,${view.y}px) scale(${view.s})`;
  }
  function resetView() { view.s = 1; view.x = 0; view.y = 0; applyView(); }
  addEventListener('resize', applyView);

  // ---------------- envío de entrada ----------------
  function move(n) { if (!viewOnly && n) sendFast({ t: 'm', x: +n.x.toFixed(5), y: +n.y.toFixed(5), s: ++seq }); }
  function rel(dx, dy) { if (!viewOnly) sendFast({ t: 'r', x: Math.round(dx), y: Math.round(dy) }); }
  function btn(b, d, n) { if (viewOnly) return; const o = { t: 'b', b, d: d ? 1 : 0 }; if (n) { o.x = n.x; o.y = n.y; o.s = ++seq; } send(o); }
  function click(b, n) { btn(b, 1, n); btn(b, 0, n); }
  function wheel(dy, dx) { if (!viewOnly && (dy || dx)) send({ t: 'w', y: Math.round(dy), x: Math.round(dx || 0) }); }
  function key(code, d) { if (!viewOnly && code) send({ t: 'k', c: code, d: d ? 1 : 0 }); }
  function tap(code) { key(code, 1); key(code, 0); }
  function combo(codes) { codes.forEach(c => key(c, 1)); codes.slice().reverse().forEach(c => key(c, 0)); }
  function text(s) { if (!viewOnly && s) send({ t: 'txt', s }); }
  function vibrate(ms) {
    if (IS_ANDROID_APP) { try { AndroidBridge.vibrate(ms); return; } catch (e) { } }
    try { navigator.vibrate && navigator.vibrate(ms); } catch (e) { }
  }

  // ---------------- gestos táctiles ----------------
  const T = $('touch');
  let g = null;            // gesto en curso
  let lastTap = 0, pendingClick = null;
  const TAP_MS = 250, LONG_MS = 550, SLOP = 9;

  function pts(e) { return Array.from(e.touches, t => ({ x: t.clientX, y: t.clientY })); }
  function centroid(p) { return { x: p.reduce((a, b) => a + b.x, 0) / p.length, y: p.reduce((a, b) => a + b.y, 0) / p.length }; }
  function dist(p) { return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); }

  T.addEventListener('touchstart', e => {
    e.preventDefault();
    const p = pts(e), now = performance.now();
    if (p.length === 1 && (!g || g.n === 0)) {
      g = { n: 1, t0: now, start: p[0], last: p[0], moved: false, dragging: false, long: false, max: 1 };
      if (mode === 'touch') {
        g.longTimer = setTimeout(() => {
          if (g && g.n === 1 && !g.moved) { g.long = true; vibrate(30); click(1, toNorm(g.start.x, g.start.y)); }
        }, LONG_MS);
      } else if (now - lastTap < TAP_MS + 100 && pendingClick) {
        // doble toque y arrastrar en modo touchpad
        clearTimeout(pendingClick); pendingClick = null;
        g.padDrag = true; btn(0, 1);
      }
    } else if (p.length >= 2 && g) {
      clearTimeout(g.longTimer);
      if (g.dragging) { btn(0, 0, toNorm(g.last.x, g.last.y)); g.dragging = false; }
      g.n = p.length; g.max = Math.max(g.max, p.length);
      g.c0 = centroid(p); g.cLast = g.c0; g.d0 = p.length === 2 ? dist(p) : 0;
      g.v0 = { s: view.s, x: view.x, y: view.y }; g.two = null; g.moved2 = false; g.scrollAcc = { x: 0, y: 0 };
    }
  }, { passive: false });

  T.addEventListener('touchmove', e => {
    e.preventDefault();
    if (!g) return;
    const p = pts(e);
    if (p.length === 1 && g.n === 1) {
      const q = p[0];
      if (!g.moved && Math.hypot(q.x - g.start.x, q.y - g.start.y) > SLOP) { g.moved = true; clearTimeout(g.longTimer); }
      if (!g.moved) return;
      if (mode === 'touch') {
        if (g.long) { move(toNorm(q.x, q.y)); }
        else {
          if (!g.dragging) { g.dragging = true; move(toNorm(g.start.x, g.start.y)); btn(0, 1, toNorm(g.start.x, g.start.y)); }
          move(toNorm(q.x, q.y));
        }
      } else {
        const dx = q.x - g.last.x, dy = q.y - g.last.y;
        const sp = Math.hypot(dx, dy);
        const k = (settings.sens || 1.6) * (1 + Math.min(sp, 40) / 18); // aceleración
        rel(dx * k, dy * k);
      }
      g.last = q;
    } else if (p.length >= 2 && g.n >= 2) {
      const c = centroid(p);
      if (p.length === 2 && g.two !== 'scroll') {
        const d = dist(p);
        if (!g.two && Math.abs(d - g.d0) > 28) g.two = 'zoom';
        if (g.two === 'zoom') {
          const s = Math.max(1, Math.min(6, g.v0.s * d / g.d0));
          const px = (g.c0.x - g.v0.x) / g.v0.s, py = (g.c0.y - g.v0.y) / g.v0.s;
          view.s = s; view.x = c.x - px * s; view.y = c.y - py * s; applyView();
          g.moved2 = true; return;
        }
      }
      const dx = c.x - g.cLast.x, dy = c.y - g.cLast.y;
      if (!g.two && Math.hypot(c.x - g.c0.x, c.y - g.c0.y) > 12) g.two = 'scroll';
      if (g.two === 'scroll') {
        g.moved2 = true;
        if (view.s > 1.01 && p.length === 3) { view.x += dx; view.y += dy; applyView(); }
        else {
          g.scrollAcc.y += dy * 4; g.scrollAcc.x += dx * 4;
          const wy = Math.trunc(g.scrollAcc.y / 10) * 10, wx = Math.trunc(g.scrollAcc.x / 10) * 10;
          if (wy || wx) { wheel(wy, -wx); g.scrollAcc.y -= wy; g.scrollAcc.x -= wx; }
        }
      }
      g.cLast = c;
    }
  }, { passive: false });

  function touchEnd(e) {
    e.preventDefault();
    if (!g) return;
    const left = e.touches.length, now = performance.now();
    if (left > 0) { g.n = left; if (left === 1) { g.n = 1; g.last = { x: e.touches[0].clientX, y: e.touches[0].clientY }; g.moved = true; g.start = g.last; } return; }
    clearTimeout(g.longTimer);
    const dur = now - g.t0;
    if (g.max >= 3 && !g.moved2 && dur < 400) { toggleKbd(); }
    else if (g.max === 2 && !g.moved2 && dur < 400) {
      const c = g.c0;
      click(1, mode === 'touch' ? toNorm(c.x, c.y) : null);
    } else if (g.max === 1) {
      if (mode === 'touch') {
        if (g.dragging) btn(0, 0, toNorm(g.last.x, g.last.y));
        else if (g.long) { /* clic derecho ya enviado */ }
        else if (!g.moved) { const n = toNorm(g.start.x, g.start.y); move(n); click(0, n); }
      } else {
        if (g.padDrag) btn(0, 0);
        else if (!g.moved && dur < TAP_MS) {
          lastTap = now;
          pendingClick = setTimeout(() => { pendingClick = null; click(0); }, TAP_MS);
        }
      }
    }
    g = null;
  }
  T.addEventListener('touchend', touchEnd, { passive: false });
  T.addEventListener('touchcancel', touchEnd, { passive: false });

  // ---------------- ratón (cliente en PC) ----------------
  let mmPending = null;
  T.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse') return;
    const n = toNorm(e.clientX, e.clientY);
    if (!mmPending) { mmPending = n; requestAnimationFrame(() => { move(mmPending); mmPending = null; }); } else mmPending = n;
  });
  const MB = { 0: 0, 2: 1, 1: 2 };
  T.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse') return;
    e.preventDefault(); T.setPointerCapture(e.pointerId);
    btn(MB[e.button] ?? 0, 1, toNorm(e.clientX, e.clientY));
  });
  T.addEventListener('pointerup', e => {
    if (e.pointerType !== 'mouse') return;
    btn(MB[e.button] ?? 0, 0, toNorm(e.clientX, e.clientY));
  });
  T.addEventListener('contextmenu', e => e.preventDefault());
  T.addEventListener('wheel', e => {
    e.preventDefault();
    const f = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    wheel(-e.deltaY * f * 1.2, e.deltaX * f * 1.2);
  }, { passive: false });

  // ---------------- teclado físico ----------------
  const down = new Set();
  addEventListener('keydown', e => {
    if (!connected || $('session').classList.contains('hidden')) return;
    if (e.keyCode === 229 || !e.code || !(e.code in SC)) return; // teclado virtual -> lo gestiona 'input'
    e.preventDefault();
    down.add(e.code); key(SC[e.code], 1);
  }, true);
  addEventListener('keyup', e => {
    if (!connected || !(e.code in SC)) return;
    if (!down.has(e.code)) return;
    e.preventDefault(); down.delete(e.code); key(SC[e.code], 0);
  }, true);
  addEventListener('blur', () => { down.forEach(c => key(SC[c], 0)); down.clear(); });

  // ---------------- teclado del móvil (diferencias sobre un textarea oculto) ----------------
  const kbd = $('kbd'), PAD = '⁣⁣⁣⁣⁣⁣⁣⁣';
  let lastVal = PAD, composing = false;
  kbd.value = PAD;
  kbd.addEventListener('compositionstart', () => composing = true);
  kbd.addEventListener('compositionend', () => { composing = false; setTimeout(repad, 0); });
  kbd.addEventListener('input', () => {
    const v = kbd.value;
    let p = 0; while (p < v.length && p < lastVal.length && v[p] === lastVal[p]) p++;
    const del = lastVal.length - p, ins = v.slice(p);
    const activeMods = modList();
    for (let i = 0; i < del; i++) tap(SC.Backspace);
    if (ins) {
      if (activeMods.length && ins.length === 1 && charSc(ins)) { combo(activeMods.concat(charSc(ins))); clearMods(); }
      else {
        const parts = ins.replace(/⁣/g, '').split('\n');
        parts.forEach((s, i) => { if (s) text(s); if (i < parts.length - 1) tap(SC.Enter); });
      }
    }
    lastVal = v;
    if (!composing) repad();
  });
  kbd.addEventListener('keydown', e => {
    // algunos teclados envían Enter/Retroceso como tecla real
    if (e.key === 'Enter' && e.keyCode !== 229) { e.preventDefault(); tap(SC.Enter); }
  });
  function repad() { if (kbd.value !== PAD && (!kbd.value.startsWith(PAD) || kbd.value.length > 40 || kbd.value.length < PAD.length)) { kbd.value = PAD; lastVal = PAD; } kbd.setSelectionRange(kbd.value.length, kbd.value.length); }
  let kbdOpen = false;
  function toggleKbd() {
    kbdOpen = !kbdOpen;
    if (kbdOpen) { kbd.value = PAD; lastVal = PAD; kbd.focus(); kbd.setSelectionRange(PAD.length, PAD.length); $('keybar').classList.remove('hidden'); }
    else { kbd.blur(); }
    if (IS_ANDROID_APP) try { AndroidBridge.keyboard(kbdOpen); } catch (e) { }
  }
  kbd.addEventListener('blur', () => { kbdOpen = false; });

  // ---------------- barra de teclas especiales ----------------
  function modList() { return Object.keys(mods).filter(k => mods[k]).map(k => NAMED[k]); }
  function clearMods() { for (const k in mods) mods[k] = false; document.querySelectorAll('#keybar [data-mod]').forEach(b => b.classList.remove('on')); }
  $('keybar').addEventListener('pointerdown', e => e.preventDefault()); // no robar el foco al teclado
  $('keybar').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.mod) { mods[b.dataset.mod] = !mods[b.dataset.mod]; b.classList.toggle('on', mods[b.dataset.mod]); return; }
    if (b.dataset.sc) { combo(modList().concat(nameSc(b.dataset.sc))); clearMods(); }
    if (b.dataset.combo) { combo(b.dataset.combo.split('+').map(nameSc)); clearMods(); }
    vibrate(10);
  });

  // ---------------- menú ----------------
  let subOpen = null;
  const fab = $('fab');
  // botón flotante arrastrable
  let fabDrag = null;
  fab.addEventListener('pointerdown', e => { fabDrag = { y: e.clientY, top: fab.offsetTop, moved: false }; fab.setPointerCapture(e.pointerId); });
  fab.addEventListener('pointermove', e => {
    if (!fabDrag) return; const dy = e.clientY - fabDrag.y;
    if (Math.abs(dy) > 6) fabDrag.moved = true;
    if (fabDrag.moved) fab.style.top = Math.max(10, Math.min(innerHeight - 56, fabDrag.top + dy)) + 'px';
  });
  fab.addEventListener('pointerup', () => { const m = fabDrag && fabDrag.moved; fabDrag = null; if (!m) toggleMenu(); });
  function toggleMenu() { $('menu').classList.toggle('hidden'); subOpen = null; $('sub').classList.add('hidden'); syncMenu(); }
  function closeMenu() { $('menu').classList.add('hidden'); subOpen = null; }
  function syncMenu() { $('modeBtn').textContent = mode === 'touch' ? '👆 Táctil' : '🖱 Touchpad'; }
  function applyMode() { syncMenu(); }

  $('menu').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'mode') { mode = mode === 'touch' ? 'pad' : 'touch'; settings.mode = mode; RD.saveSettings(settings); syncMenu(); toast(mode === 'touch' ? 'Modo táctil: toca donde quieras hacer clic' : 'Modo touchpad: mueve el cursor como en un portátil'); }
    else if (act === 'kbd') { closeMenu(); toggleKbd(); }
    else if (act === 'keys') { $('keybar').classList.toggle('hidden'); closeMenu(); }
    else if (act === 'screens') showScreens();
    else if (act === 'quality') showQuality();
    else if (act === 'stats') { $('stats').classList.toggle('hidden'); }
    else if (act === 'talk') { toggleTalk(); }
    else if (act === 'mon') { toggleMonitor(); }
    else if (act === 'sound') { muted = !muted; $('audio').muted = muted; b.textContent = muted ? '🔇 Silencio' : '🔊 Sonido'; b.classList.toggle('on', muted); }
    else if (act === 'abuf') { showAudioBuf(); }
    else if (b.dataset.abuf) {
      settings.audioBuf = +b.dataset.abuf; RD.saveSettings(settings);
      pc && pc.getReceivers().forEach(r => { if (r.track && r.track.kind === 'audio') try { r.jitterBufferTarget = settings.audioBuf; } catch (x) { } });
      closeMenu(); toast('Búfer de audio: ' + b.textContent);
    }
    else if (act === 'zoom') { resetView(); }
    else if (act === 'full') { fullscreen(); }
    else if (act === 'quit') { closeMenu(); quit(); }
    else if (b.dataset.screen) { send({ t: 'sel', id: b.dataset.screen }); closeMenu(); toast('Cambiando de pantalla…'); }
    else if (b.dataset.q) { settings.quality = b.dataset.q; RD.saveSettings(settings); send({ t: 'q', p: b.dataset.q }); closeMenu(); toast('Calidad: ' + b.textContent); }
  });
  function sub(html, name) { const s = $('sub'); s.innerHTML = html; s.classList.remove('hidden'); subOpen = name; }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function showScreens() {
    if (!screens.length) return sub('<div>Sin pantallas</div>', 'screens');
    sub(screens.map((s, i) => `<button data-screen="${esc(s.id)}" class="${s.id === curScreen ? 'on' : ''}">Pantalla ${i + 1} · ${s.w}×${s.h}${s.primary ? ' (principal)' : ''}</button>`).join(''), 'screens');
  }
  function showQuality() {
    const q = settings.quality || 'bal';
    const opts = [['lat', 'Mínima latencia · 720p60'], ['bal', 'Equilibrado · 1080p60'], ['max', 'Máxima · nativa 60'], ['mob', 'Datos móviles · 720p30']];
    sub(opts.map(([k, t]) => `<button data-q="${k}" class="${k === q ? 'on' : ''}">${t}</button>`).join(''), 'quality');
  }
  function showAudioBuf() {
    const cur = settings.audioBuf != null ? settings.audioBuf : 40;
    const opts = [[0, 'Mínimo (puede cortarse)'], [40, 'Bajo · 40 ms'], [120, 'Medio · 120 ms'], [300, 'Estable · 300 ms (redes malas)']];
    sub(opts.map(([k, t]) => `<button data-abuf="${k}" class="${k === cur ? 'on' : ''}">${t}</button>`).join(''), 'abuf');
  }

  // talkback: el micrófono de este dispositivo suena en el PC (en la salida que se elija allí)
  async function toggleTalk() {
    const b = $('talkBtn');
    if (talkTrack) {
      if (monCtx) toggleMonitor(false);
      talkTrack.stop(); talkTrack = null;
      if (talkSender) talkSender.replaceTrack(null);
      b.classList.remove('on'); b.textContent = '🎙 Hablar'; send({ t: 'talk', on: 0 });
      return;
    }
    try {
      if (IS_ANDROID_APP) try { AndroidBridge.requestMic(); } catch (e) { }
      await openMic();
      b.classList.add('on'); b.textContent = recMode ? '🔴 Grabando voz' : '🎙 Hablando…'; send({ t: 'talk', on: 1 });
      toast(recMode ? 'Micrófono en calidad de estudio. Usa auriculares.' : 'Micrófono abierto: te escuchan en el PC');
      if (recMode && !monCtx) toggleMonitor(true);
    } catch (e) { toast('No se pudo abrir el micrófono (' + e.name + ')'); }
  }

  // en modo grabación el micro va en bruto (sin cancelación de eco, ruido ni ganancia automática)
  async function openMic() {
    const c = recMode
      ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1, sampleRate: 48000, latency: 0 }
      : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    const s = await navigator.mediaDevices.getUserMedia({ audio: c });
    const old = talkTrack;
    talkTrack = s.getAudioTracks()[0];
    try { talkTrack.contentHint = recMode ? 'music' : 'speech'; } catch (e) { }
    if (talkSender) await talkSender.replaceTrack(talkTrack);
    if (old) old.stop();
    if (monCtx) { toggleMonitor(false); toggleMonitor(true); }
  }

  async function setRecMode(on) {
    if (recMode === on) return;
    recMode = on;
    $('monBtn').classList.toggle('hidden', !on && !monCtx);
    toast(on ? '🔴 Modo grabación: ponte auriculares y pulsa 🎙 para cantar' : 'Modo grabación desactivado');
    if (talkTrack) { try { await openMic(); $('talkBtn').textContent = on ? '🔴 Grabando voz' : '🎙 Hablando…'; } catch (e) { } }
  }

  // escucharse a uno mismo en local (sin pasar por la red: latencia mínima)
  let monCtx = null;
  function toggleMonitor(on) {
    if (on === undefined) on = !monCtx;
    if (monCtx) { monCtx.close(); monCtx = null; }
    if (on && talkTrack) {
      monCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 0 });
      const src = monCtx.createMediaStreamSource(new MediaStream([talkTrack]));
      const g = monCtx.createGain(); g.gain.value = 1;
      src.connect(g); g.connect(monCtx.destination);
    } else if (on) { toast('Abre primero el micrófono (🎙)'); }
    const b = $('monBtn'); b.classList.toggle('on', !!monCtx); b.textContent = monCtx ? '🎧 Me escucho' : '🎧 Escucharme';
  }

  // informa al PC de los retrasos de este lado para calcular la compensación de la toma
  setInterval(async () => {
    if (!pc || !talkTrack) return;
    try {
      const st = await pc.getStats(); let jb = 0;
      st.forEach(r => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio' && r.jitterBufferEmittedCount) {
          // valor de los últimos 2 s (no la media desde el inicio)
          const dd = r.jitterBufferDelay - jbPrev.d, dc = r.jitterBufferEmittedCount - jbPrev.c;
          jb = dc > 0 ? dd / dc * 1000 : 0;
          jbPrev = { d: r.jitterBufferDelay, c: r.jitterBufferEmittedCount };
        }
      });
      if (!latCtx) latCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 0 });
      const out = ((latCtx.outputLatency || 0) + (latCtx.baseLatency || 0)) * 1000;
      send({ t: 'lat', jb: Math.round(jb), out: Math.round(out) });
    } catch (e) { }
  }, 2000);
  let latCtx = null, jbPrev = { d: 0, c: 0 };

  function fullscreen() {
    const d = document;
    if (d.fullscreenElement) d.exitFullscreen && d.exitFullscreen();
    else d.documentElement.requestFullscreen && d.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => { });
  }
  let toastT;
  function toast(t) { const el = $('toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hidden'), 2200); }

  // ---------------- estadísticas ----------------
  let prevBytes = 0, prevTs = 0;
  setInterval(async () => {
    if (!pc || $('stats').classList.contains('hidden')) return;
    const st = await pc.getStats();
    let inb, pair, codec = '', local, remote;
    st.forEach(r => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') inb = r;
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
    });
    if (!inb) return;
    st.forEach(r => { if (r.id === inb.codecId) codec = r.mimeType; if (pair && r.id === pair.localCandidateId) local = r; if (pair && r.id === pair.remoteCandidateId) remote = r; });
    const br = prevTs ? ((inb.bytesReceived - prevBytes) * 8 / ((inb.timestamp - prevTs) / 1000) / 1e6) : 0;
    prevBytes = inb.bytesReceived; prevTs = inb.timestamp;
    const jb = inb.jitterBufferEmittedCount ? (inb.jitterBufferDelay / inb.jitterBufferEmittedCount * 1000) : 0;
    const route = local && remote ? ((local.candidateType === 'relay' || remote.candidateType === 'relay') ? 'TURN (relé)' : 'P2P directo') : '?';
    $('stats').textContent =
      `${inb.frameWidth || 0}×${inb.frameHeight || 0} @ ${Math.round(inb.framesPerSecond || 0)} fps\n` +
      `${br.toFixed(1)} Mbps · ${codec.replace('video/', '')}\n` +
      `ping ${pair ? Math.round((pair.currentRoundTripTime || 0) * 1000) : '?'} ms · búfer ${jb.toFixed(0)} ms\n` +
      `ruta: ${route}\n` +
      `decodificador: ${inb.decoderImplementation || '?'}`;
  }, 1000);

  // ---------------- integración Android ----------------
  window.RDC = {
    back() {
      if (!$('menu').classList.contains('hidden')) { closeMenu(); return true; }
      if (!$('keybar').classList.contains('hidden')) { $('keybar').classList.add('hidden'); return true; }
      if (connected) { quit(); return true; }
      return false;
    }
  };

  // invitación: conectar directamente
  if (invite) setTimeout(() => $('connectBtn').click(), 300);
})();
