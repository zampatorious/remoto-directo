/* Cabina Remota · cliente del artista (se abre con el enlace de invitación, sin instalar nada). */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const LS = 'cab-client';
  let S = {}; try { S = JSON.parse(localStorage.getItem(LS) || '{}'); } catch (e) { }
  const save = () => { try { localStorage.setItem(LS, JSON.stringify(S)); } catch (e) { } };

  // ---------- invitación ----------
  const h = new URLSearchParams(location.hash.slice(1));
  let studio = h.get('u') || '', token = h.get('k') || '';
  if (h.get('s')) S.sigHost = h.get('s');
  if (!studio || !token) { $('manual').classList.remove('hidden'); $('joinSub').textContent = 'Abre el enlace que te ha enviado el estudio, o escribe los datos.'; }
  else $('joinSub').innerHTML = 'Te han invitado a grabar en <b></b>.', $('joinSub').querySelector('b').textContent = studio;
  $('name').value = S.name || '';

  // ---------- estado ----------
  let peer = null, conn = null, pc = null, progTr = null, progStream = null, ctx = null;
  let connected = false, leaving = false, retries = 0;
  let negotiating = false, pendingNeg = false;
  const mics = [];             // {id, name, deviceId, ch, gain, muted, stream, src, split, g, an, dest, track, tr, el}
  let monGain = null, progAn = null, progSrc = null, cal = null;

  function toast(t, ms) { const el = $('toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('hidden'), ms || 3000); }
  function setJoin(t, err) { const s = $('joinStatus'); s.textContent = t || ''; s.classList.toggle('err', !!err); }
  function setConn(t, cls) { const p = $('conn'); p.textContent = t; p.className = 'pill ' + (cls || ''); }

  // ---------- audio local ----------
  function audioCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 0, sampleRate: 48000 });
      monGain = ctx.createGain(); monGain.gain.value = 0; monGain.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  async function devices() {
    const list = await navigator.mediaDevices.enumerateDevices();
    return { ins: list.filter(d => d.kind === 'audioinput' && d.deviceId !== 'communications'), outs: list.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'communications') };
  }

  async function openMicStream(m) {
    const c = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 }, sampleRate: 48000, latency: 0 };
    if (m.deviceId && m.deviceId !== 'default') c.deviceId = { exact: m.deviceId };
    return navigator.mediaDevices.getUserMedia({ audio: c });
  }

  // Cada micro: fuente -> (canal elegido) -> ganancia -> destino mono (pista que se envía)
  async function buildMic(m) {
    const c = audioCtx();
    if (!m.g) {
      m.g = c.createGain(); m.g.channelCount = 1; m.g.channelCountMode = 'explicit';
      m.an = c.createAnalyser(); m.an.fftSize = 1024;
      m.dest = c.createMediaStreamDestination(); m.dest.channelCount = 1;
      m.g.connect(m.an); m.g.connect(m.dest); m.g.connect(monGain);
      m.track = m.dest.stream.getAudioTracks()[0];
    }
    if (m.stream) m.stream.getTracks().forEach(t => t.stop());
    try { m.src && m.src.disconnect(); m.split && m.split.disconnect(); } catch (e) { }
    m.stream = await openMicStream(m);
    const t = m.stream.getAudioTracks()[0];
    const chans = (t.getSettings && t.getSettings().channelCount) || 1;
    m.src = c.createMediaStreamSource(m.stream);
    if (m.ch === 'mix' || chans < 2) { m.src.connect(m.g); m.split = null; }
    else { m.split = c.createChannelSplitter(2); m.src.connect(m.split); m.split.connect(m.g, Number(m.ch) || 0); }
    m.g.gain.value = m.muted ? 0 : m.gain;
    if (cal && cal.mic === m) startCal(); // seguimos en calibración
  }

  function micLabel(i) { return 'Micrófono ' + (i + 1); }

  async function addMic(cfg) {
    const m = Object.assign({ id: CR.randomToken(6), name: micLabel(mics.length), deviceId: 'default', ch: 'mix', gain: 1, muted: false }, cfg || {});
    mics.push(m);
    renderMic(m);
    try { await buildMic(m); } catch (e) { toast('No se pudo abrir el micrófono: ' + e.name); }
    if (pc) { m.tr = pc.addTransceiver(m.track, { direction: 'sendonly' }); negotiate(); }
    persistMics();
  }

  function removeMic(m) {
    const i = mics.indexOf(m); if (i < 0) return;
    mics.splice(i, 1);
    if (m.stream) m.stream.getTracks().forEach(t => t.stop());
    try { m.g.disconnect(); } catch (e) { }
    if (m.tr) { try { m.tr.stop(); } catch (e) { } negotiate(); }
    m.el.remove(); persistMics(); sendMics();
  }

  function persistMics() { S.mics = mics.map(m => ({ name: m.name, deviceId: m.deviceId, ch: m.ch, gain: m.gain })); save(); }

  async function renderMic(m) {
    const el = $('micTpl').content.firstElementChild.cloneNode(true);
    m.el = el; $('mics').appendChild(el);
    const nm = el.querySelector('.mname'), dev = el.querySelector('.mdev'), ch = el.querySelector('.mch'), gn = el.querySelector('.mgain');
    nm.value = m.name; ch.value = m.ch; gn.value = m.gain;
    const { ins } = await devices();
    dev.innerHTML = ins.map(d => `<option value="${d.deviceId}">${(d.label || 'Micrófono').replace(/</g, '&lt;')}</option>`).join('');
    dev.value = m.deviceId; if (dev.value !== m.deviceId && dev.options.length) { m.deviceId = dev.value; }
    nm.onchange = () => { m.name = nm.value.trim() || micLabel(mics.indexOf(m)); nm.value = m.name; persistMics(); sendMics(); };
    dev.onchange = async () => { m.deviceId = dev.value; persistMics(); try { await buildMic(m); } catch (e) { toast('No se pudo abrir: ' + e.name); } };
    ch.onchange = async () => { m.ch = ch.value; persistMics(); await buildMic(m); };
    gn.oninput = () => { m.gain = +gn.value; if (!m.muted) m.g.gain.setTargetAtTime(m.gain, ctx.currentTime, 0.01); persistMics(); };
    el.querySelector('.mute').onclick = e => {
      m.muted = !m.muted; e.target.textContent = m.muted ? '🔇' : '🔊'; el.classList.toggle('muted', m.muted);
      m.g.gain.setTargetAtTime(m.muted ? 0 : m.gain, ctx.currentTime, 0.01);
    };
    el.querySelector('.del').onclick = () => removeMic(m);
  }

  // vúmetros
  function meters() {
    mics.forEach(m => { if (m.an && m.el) m.el.querySelector('.meter i').style.width = CR.dbToPct(CR.peakDb(m.an)) + '%'; });
    if (progAn) $('progMeter').style.width = CR.dbToPct(CR.peakDb(progAn)) + '%';
    requestAnimationFrame(meters);
  }

  // ---------- conexión ----------
  function hostId() { return CR.peerIdFor(studio); }
  function send(o) { if (conn && conn.open) conn.send(o); }

  function connect() {
    cleanup(false);
    setConn('Conectando…', 'warn');
    const Peer = CR.PeerCtor();
    peer = new Peer(CR.peerOptions(S));
    peer.on('open', () => {
      conn = peer.connect(hostId(), { reliable: true, serialization: 'json', metadata: { v: CR.PROTO } });
      conn.on('data', onData);
      conn.on('close', lost);
      conn.on('error', lost);
    });
    peer.on('error', e => {
      if (e.type === 'peer-unavailable') fail('El estudio no está conectado ahora mismo. Inténtalo en un rato.');
      else if (!connected) { if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) lost(); }
    });
  }

  async function onData(m) {
    switch (m.t) {
      case 'hello':
        send({ t: 'auth', mac: CR.hmac(token, m.nonce + '|' + hostId()), name: S.name, ua: navigator.userAgent.slice(0, 90) });
        break;
      case 'fail':
        leaving = true;
        fail(m.why === 'expired' ? 'Esta invitación ha caducado. Pide un enlace nuevo al estudio.' : m.why === 'locked' ? 'Demasiados intentos. Espera un minuto.' : 'Enlace no válido. Pide uno nuevo al estudio.');
        break;
      case 'ok':
        $('studioName').textContent = m.studio || studio;
        await startRtc();
        break;
      case 'sdp':
        if (m.type === 'answer') {
          await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
          negotiating = false;
          tuneSenders();
          if (pendingNeg) { pendingNeg = false; negotiate(); }
        }
        break;
      case 'ice': try { await pc.addIceCandidate(m.c); } catch (e) { } break;
      case 'tb': $('tbBanner').classList.toggle('hidden', !m.on); break;
      case 'cal': if (m.on) startCal(); else stopCal(); break;
      case 'toast': toast(m.text); break;
      case 'bye': leaving = true; fail(m.text || 'El estudio ha cerrado la sesión.'); break;
    }
  }

  async function startRtc() {
    pc = new RTCPeerConnection({ iceServers: CR.iceServers(S), bundlePolicy: 'max-bundle' });
    progTr = pc.addTransceiver('audio', { direction: 'recvonly' });
    mics.forEach(m => { if (m.track) m.tr = pc.addTransceiver(m.track, { direction: 'sendonly' }); });
    pc.onicecandidate = e => { if (e.candidate) send({ t: 'ice', c: e.candidate.toJSON() }); };
    pc.ontrack = e => {
      if (e.transceiver !== progTr) return;
      try { e.receiver.jitterBufferTarget = S.buf != null ? S.buf : 30; } catch (x) { }
      progStream = new MediaStream([e.track]);
      const a = $('prog'); a.srcObject = progStream; a.volume = +$('vol').value;
      if (S.outDev && a.setSinkId) a.setSinkId(S.outDev).catch(() => { });
      a.play().catch(() => toast('Toca la pantalla para activar el sonido'));
      // para el vúmetro y la calibración
      const c = audioCtx();
      progSrc = c.createMediaStreamSource(progStream);
      progAn = c.createAnalyser(); progAn.fftSize = 1024; progSrc.connect(progAn);
    };
    pc.onconnectionstatechange = () => {
      const st = pc && pc.connectionState;
      if (st === 'connected') { connected = true; retries = 0; setConn('En directo', 'ok'); }
      if (st === 'failed') lost();
    };
    negotiate();
  }

  // El cliente siempre hace la oferta (añadir/quitar micros = renegociar), el estudio solo responde.
  async function negotiate() {
    if (!pc) return;
    if (negotiating) { pendingNeg = true; return; }
    negotiating = true;
    try {
      const offer = await pc.createOffer();
      offer.sdp = CR.tuneSdp(offer.sdp);
      await pc.setLocalDescription(offer);
      send({ t: 'sdp', type: 'offer', sdp: pc.localDescription.sdp, prog: progTr.mid });
      sendMics();
    } catch (e) { negotiating = false; console.warn(e); }
  }

  function sendMics() {
    send({ t: 'mics', list: mics.filter(m => m.tr && m.tr.mid).map(m => ({ mid: m.tr.mid, name: m.name, id: m.id })) });
  }

  async function tuneSenders() {
    for (const m of mics) {
      if (!m.tr) continue;
      try {
        const p = m.tr.sender.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = 510000; p.encodings[0].priority = 'high'; p.encodings[0].networkPriority = 'high';
        await m.tr.sender.setParameters(p);
      } catch (e) { }
    }
  }

  // ---------- calibración: devolvemos al estudio lo que nos llega, por el micro 1 ----------
  function startCal() {
    const m = mics[0]; if (!m || !progSrc) return;
    stopCal();
    try { m.g.disconnect(m.dest); } catch (e) { }
    progSrc.connect(m.dest);
    cal = { mic: m };
    toast('Midiendo el retraso… (oirás unos clics)', 4000);
  }
  function stopCal() {
    if (!cal) return;
    try { progSrc.disconnect(cal.mic.dest); } catch (e) { }
    progSrc.connect(progAn);
    try { cal.mic.g.connect(cal.mic.dest); } catch (e) { }
    cal = null;
  }

  // ---------- estadísticas para el estudio ----------
  let jbPrev = { d: 0, c: 0 };
  setInterval(async () => {
    if (!pc || !connected) return;
    try {
      const st = await pc.getStats(); let jb = 0, rtt = 0;
      st.forEach(r => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio' && r.jitterBufferEmittedCount) {
          const dd = r.jitterBufferDelay - jbPrev.d, dc = r.jitterBufferEmittedCount - jbPrev.c;
          if (dc > 0) jb = dd / dc * 1000;
          jbPrev = { d: r.jitterBufferDelay, c: r.jitterBufferEmittedCount };
        }
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') rtt = (r.currentRoundTripTime || 0) * 1000;
      });
      const out = ctx ? ((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000 : 0;
      send({ t: 'lat', jb: Math.round(jb), out: Math.round(out), rtt: Math.round(rtt) });
      $('lat').textContent = `ping ${Math.round(rtt)} ms`;
    } catch (e) { }
  }, 2000);

  // ---------- ciclo de vida ----------
  function lost() {
    if (leaving) return;
    connected = false;
    cleanup(false);
    if (retries++ < 20) { setConn('Reconectando…', 'warn'); setTimeout(() => { if (!leaving) connect(); }, Math.min(1000 * retries, 5000)); }
    else setConn('Sin conexión', 'warn');
  }
  function fail(msg) {
    cleanup(true);
    $('room').classList.add('hidden'); $('join').classList.remove('hidden');
    setJoin(msg, true); $('joinBtn').disabled = false;
  }
  function cleanup(full) {
    stopCal();
    try { conn && conn.close(); } catch (e) { }
    try { pc && pc.close(); } catch (e) { }
    try { peer && peer.destroy(); } catch (e) { }
    conn = pc = peer = null; progTr = null; negotiating = false; pendingNeg = false;
    mics.forEach(m => m.tr = null);
    if (full) {
      mics.forEach(m => m.stream && m.stream.getTracks().forEach(t => t.stop()));
      mics.length = 0; $('mics').innerHTML = '';
      $('prog').srcObject = null;
    }
  }

  $('joinBtn').onclick = async () => {
    if (!studio || !token) {
      studio = CR.normUser($('mStudio').value); token = $('mCode').value.trim();
      if (!studio || !token) return setJoin('Faltan el estudio o el código.', true);
    }
    S.name = $('name').value.trim() || 'Artista'; save();
    $('joinBtn').disabled = true; setJoin('Pidiendo permiso para el micrófono…');
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); }
    catch (e) { $('joinBtn').disabled = false; return setJoin('Necesitamos permiso para usar el micrófono.', true); }
    audioCtx();
    $('join').classList.add('hidden'); $('room').classList.remove('hidden');
    $('studioName').textContent = studio;
    leaving = false; retries = 0;
    const saved = (S.mics && S.mics.length) ? S.mics : [{}];
    for (const c of saved) await addMic(c);
    loadOutputs();
    connect();
    meters();
  };

  $('addMic').onclick = () => addMic();
  $('leaveBtn').onclick = () => { leaving = true; send({ t: 'bye' }); setTimeout(() => fail(''), 100); setJoin('Has salido del estudio.'); };
  $('vol').oninput = () => { $('prog').volume = +$('vol').value; };
  $('selfMon').onchange = () => { audioCtx(); monGain.gain.setTargetAtTime($('selfMon').checked ? 1 : 0, ctx.currentTime, 0.01); };

  async function loadOutputs() {
    const a = $('prog');
    if (!a.setSinkId) { $('outWrap').classList.add('hidden'); return; }
    const { outs } = await devices();
    $('outDev').innerHTML = outs.map(d => `<option value="${d.deviceId}">${(d.label || 'Salida').replace(/</g, '&lt;')}</option>`).join('');
    if (S.outDev) $('outDev').value = S.outDev;
    $('outDev').onchange = () => { S.outDev = $('outDev').value; save(); a.setSinkId(S.outDev).catch(() => { }); };
  }
  navigator.mediaDevices && navigator.mediaDevices.addEventListener && navigator.mediaDevices.addEventListener('devicechange', () => {
    loadOutputs();
    mics.forEach(async m => {
      const sel = m.el && m.el.querySelector('.mdev'); if (!sel) return;
      const { ins } = await devices(); const v = sel.value;
      sel.innerHTML = ins.map(d => `<option value="${d.deviceId}">${(d.label || 'Micrófono').replace(/</g, '&lt;')}</option>`).join('');
      sel.value = v;
    });
  });
  addEventListener('beforeunload', () => send({ t: 'bye' }));
})();
