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
  let peer = null, conn = null, pc = null, progTr = null, talkTr = null, progStream = null, ctx = null;
  let talkOut = null, tbOn = false, duck = false, progVol = 1;
  // volumen final: el tuyo × el que marca el estudio, y la música baja mientras el estudio habla
  function applyVolumes() {
    const v = +$('vol').value;
    const pv = Math.min(1, v * progVol * (duck ? 0.25 : 1));
    const fast = ultraProgActive();
    // si llega el master por la vía rápida, suena esa; si no, la normal
    $('prog').volume = fast ? 0 : pv;
    if (plyOut && ctx) plyOut.gain.setTargetAtTime(fast ? pv : 0, ctx.currentTime, 0.02);
    if (talkOut && ctx) talkOut.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
  }

  // ================= MODO LATENCIA ULTRABAJA =================
  // Opus en paquetes de 5 ms por un canal directo sin reintentos (sin el búfer fijo de las llamadas).
  // La vía normal sigue funcionando en paralelo como respaldo.
  const ULTRA_US = 5000;
  let ultraOn = false, ultraOk = null, ultraDc = null, ultraMod = null, ply = null, plyOut = null, sinkZero = null;
  let progDec = null, progSeqLast = -1, lastUltraProg = 0;
  const CLIENT_WORKLETS = `
    class Ply extends AudioWorkletProcessor {
      constructor(){ super(); this.n=1<<17; this.b=new Float32Array(this.n*2); this.w=0; this.r=0; this.prime=true;
        this.start=Math.round(sampleRate*0.008); this.minF=1e9; this.win=0;
        this.port.onmessage=e=>{ const f=e.data; for(let i=0;i<f.length;i+=2){ if(this.w-this.r>=this.n-8) break; const k=(this.w&(this.n-1))*2; this.b[k]=f[i]; this.b[k+1]=f[i+1]; this.w++; } }; }
      process(_i,o){ const L=o[0][0], R=o[0][1]||o[0][0], q=L.length;
        if(this.prime && this.w-this.r>=this.start) this.prime=false;
        if(this.prime || this.w-this.r<q){ L.fill(0); R.fill(0);
          if(!this.prime){ this.prime=true; this.start=Math.min(this.start+Math.round(sampleRate*0.003), sampleRate*0.08); } this.minF=0; }
        else { for(let i=0;i<q;i++){ const k=((this.r+i)&(this.n-1))*2; L[i]=this.b[k]; R[i]=this.b[k+1]; } this.r+=q; this.minF=Math.min(this.minF,this.w-this.r); }
        this.win+=q;
        if(this.win>=sampleRate){ const safety=Math.round(sampleRate*0.002);
          if(!this.prime && this.minF>safety+32) this.r+=this.minF-safety;
          if(this.minF>0 && this.start>sampleRate*0.008) this.start-=Math.round(sampleRate*0.0005);
          this.minF=1e9; this.win=0; }
        return true; } }
    class Cap extends AudioWorkletProcessor {
      constructor(){ super(); this.on=false; this.port.onmessage=e=>{ this.on=!!e.data.on; }; }
      process(i){ if(!this.on) return true; const c=i[0]&&i[0][0]; const f=new Float32Array(128); if(c) f.set(c); this.port.postMessage(f,[f.buffer]); return true; } }
    registerProcessor('cr-ply', Ply); registerProcessor('cr-cap', Cap);`;

  function encCfg(ch) {
    return { codec: 'opus', sampleRate: 48000, numberOfChannels: ch, bitrate: ch === 1 ? 160000 : 256000,
      opus: { frameDuration: ULTRA_US, complexity: 5, useinbandfec: false, usedtx: false, packetlossperc: 0 } };
  }
  async function checkUltra() {
    if (ultraOk !== null) return ultraOk;
    ultraOk = false;
    try {
      if (!('AudioEncoder' in window) || !('AudioDecoder' in window) || !('AudioWorkletNode' in window)) return false;
      const a = await AudioEncoder.isConfigSupported(encCfg(1));
      const b = await AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });
      ultraOk = !!(a.supported && b.supported) && audioCtx().sampleRate === 48000;
    } catch (e) { ultraOk = false; }
    return ultraOk;
  }
  async function ensureUltraNodes() {
    const c = audioCtx();
    if (!ultraMod) ultraMod = c.audioWorklet.addModule(URL.createObjectURL(new Blob([CLIENT_WORKLETS], { type: 'application/javascript' })));
    await ultraMod;
    if (!ply) {
      ply = new AudioWorkletNode(c, 'cr-ply', { numberOfInputs: 0, outputChannelCount: [2] });
      plyOut = c.createGain(); plyOut.gain.value = 0; ply.connect(plyOut); plyOut.connect(c.destination);
      sinkZero = c.createGain(); sinkZero.gain.value = 0; sinkZero.connect(c.destination);
      if (progAn) ply.connect(progAn);
    }
  }
  async function setupMicUltra(m) {
    if (!ultraOk || !m.g) return;
    await ensureUltraNodes();
    if (!m.cap) {
      m.cap = new AudioWorkletNode(ctx, 'cr-cap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
      m.g.connect(m.cap); m.cap.connect(sinkZero);
      m.useq = 0; m.uts = 0;
      m.enc = new AudioEncoder({ output: ch => sendUltraMic(m, ch), error: e => console.warn('codificador', e) });
      m.enc.configure(encCfg(1));
      m.cap.port.onmessage = e => {
        if (!ultraOn || !m.enc || m.enc.state !== 'configured') return;
        const ad = new AudioData({ format: 'f32-planar', sampleRate: ctx.sampleRate, numberOfFrames: e.data.length, numberOfChannels: 1, timestamp: m.uts, data: e.data });
        m.uts += e.data.length * 1e6 / ctx.sampleRate;
        try { m.enc.encode(ad); } catch (x) { }
        ad.close();
      };
    }
    m.cap.port.postMessage({ on: ultraOn });
  }
  function dropMicUltra(m) {
    try { m.cap && m.cap.disconnect(); m.g && m.cap && m.g.disconnect(m.cap); } catch (e) { }
    try { m.enc && m.enc.state !== 'closed' && m.enc.close(); } catch (e) { }
    m.cap = null; m.enc = null;
  }
  function sendUltraMic(m, chunk) {
    if (!ultraDc || ultraDc.readyState !== 'open' || !m.tr || !m.tr.mid) return;
    if (ultraDc.bufferedAmount > 32768) return; // red atascada: mejor perder un paquete que acumular retraso
    const b = new Uint8Array(8 + chunk.byteLength);
    b[0] = 1; b[1] = Number(m.tr.mid) & 255;
    new DataView(b.buffer).setUint32(4, (m.useq++) >>> 0, true);
    chunk.copyTo(b.subarray(8));
    ultraDc.send(b);
  }
  function onUltraMsg(ev) {
    const b = new Uint8Array(ev.data);
    if (b[0] !== 2 || b.length < 9 || !ply) return;
    const seq = new DataView(ev.data).getUint32(4, true);
    if (!progDec) {
      progDec = new AudioDecoder({
        output: ad => {
          const n = ad.numberOfFrames, L = new Float32Array(n), R = new Float32Array(n);
          ad.copyTo(L, { planeIndex: 0, format: 'f32-planar' });
          if (ad.numberOfChannels > 1) ad.copyTo(R, { planeIndex: 1, format: 'f32-planar' }); else R.set(L);
          ad.close();
          const f = new Float32Array(n * 2);
          for (let i = 0; i < n; i++) { f[2 * i] = L[i]; f[2 * i + 1] = R[i]; }
          ply.port.postMessage(f, [f.buffer]);
        },
        error: e => { console.warn('decodificador', e); progDec = null; }
      });
      progDec.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });
      progSeqLast = -1;
    }
    if (progSeqLast >= 0) {
      if (seq <= progSeqLast) return;                                       // llegó tarde: se descarta
      const miss = Math.min(seq - progSeqLast - 1, 20);                     // perdidos: silencio del mismo largo
      for (let k = 0; k < miss; k++) ply.port.postMessage(new Float32Array(240 * 2));
    }
    progSeqLast = seq;
    const was = ultraProgActive();
    lastUltraProg = performance.now();
    if (!was) applyVolumes();
    try { progDec.decode(new EncodedAudioChunk({ type: 'key', timestamp: seq * ULTRA_US, data: b.subarray(8) })); } catch (e) { }
  }
  function ultraProgActive() { return performance.now() - lastUltraProg < 400; }
  setInterval(() => { if (plyOut) applyVolumes(); }, 300); // vuelve a la vía normal si deja de llegar
  async function setUltra(on) {
    await checkUltra();
    ultraOn = !!on && ultraOk;
    for (const m of mics) await setupMicUltra(m);
    mics.forEach(m => m.cap && m.cap.port.postMessage({ on: ultraOn }));
    send({ t: 'ultra', ok: ultraOk, on: ultraOn });
  }
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
    m.raw = t;
    try { t.contentHint = 'music'; } catch (e) { }
    if (cal && cal.mic === m) startCal(); // seguimos en calibración
    updateSender(m);
    if (ultraOn) setupMicUltra(m);
  }

  // Lo que se envía: el micro TAL CUAL (menos retraso) salvo que haga falta procesarlo
  // (ganancia distinta de 100 %, un solo canal, silenciado o midiendo el retraso).
  function sendTrack(m) {
    const direct = m.raw && m.raw.readyState === 'live' && m.ch === 'mix' && Math.abs(m.gain - 1) < 0.01 && !m.muted && !(cal && cal.mic === m);
    return direct ? m.raw : m.track;
  }
  function updateSender(m) { if (m.tr && !m.tr.stopped) m.tr.sender.replaceTrack(sendTrack(m)).catch(() => { }); }

  function micLabel(i) { return 'Micrófono ' + (i + 1); }

  async function addMic(cfg) {
    const m = Object.assign({ id: CR.randomToken(6), name: micLabel(mics.length), deviceId: 'default', ch: 'mix', gain: 1, muted: false }, cfg || {});
    mics.push(m);
    renderMic(m);
    try { await buildMic(m); } catch (e) { toast('No se pudo abrir el micrófono: ' + e.name); }
    if (pc) { m.tr = pc.addTransceiver(sendTrack(m), { direction: 'sendonly' }); negotiate(); }
    persistMics();
  }

  function removeMic(m) {
    const i = mics.indexOf(m); if (i < 0) return;
    mics.splice(i, 1);
    if (m.stream) m.stream.getTracks().forEach(t => t.stop());
    dropMicUltra(m);
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
    gn.oninput = () => { m.gain = +gn.value; if (!m.muted) m.g.gain.setTargetAtTime(m.gain, ctx.currentTime, 0.01); persistMics(); updateSender(m); };
    el.querySelector('.mute').onclick = e => {
      m.muted = !m.muted; e.target.textContent = m.muted ? '🔇' : '🔊'; el.classList.toggle('muted', m.muted);
      m.g.gain.setTargetAtTime(m.muted ? 0 : m.gain, ctx.currentTime, 0.01);
      updateSender(m);
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
      case 'tb': tbOn = !!m.on; duck = !!m.on && m.duck !== false; $('tbBanner').classList.toggle('hidden', !m.on); applyVolumes(); break;
      case 'pv': progVol = Math.max(0, Math.min(2, +m.v || 0)); applyVolumes(); break;
      case 'cal': if (m.on) startCal(); else stopCal(); break;
      case 'ultra': setUltra(!!m.on); break;
      case 'toast': toast(m.text); break;
      case 'bye': leaving = true; fail(m.text || 'El estudio ha cerrado la sesión.'); break;
    }
  }

  async function startRtc() {
    pc = new RTCPeerConnection({ iceServers: CR.iceServers(S), bundlePolicy: 'max-bundle' });
    progTr = pc.addTransceiver('audio', { direction: 'recvonly' });
    talkTr = pc.addTransceiver('audio', { direction: 'recvonly' });
    mics.forEach(m => { if (m.track) m.tr = pc.addTransceiver(sendTrack(m), { direction: 'sendonly' }); });
    // canal directo para el modo de latencia ultrabaja (sin orden ni reintentos)
    ultraDc = pc.createDataChannel('ultra', { ordered: false, maxRetransmits: 0 });
    ultraDc.binaryType = 'arraybuffer';
    ultraDc.onmessage = onUltraMsg;
    pc.onicecandidate = e => { if (e.candidate) send({ t: 'ice', c: e.candidate.toJSON() }); };
    pc.ontrack = e => {
      if (e.transceiver === talkTr) {
        try { e.receiver.jitterBufferTarget = 20; } catch (x) { }
        const st = new MediaStream([e.track]);
        const el = $('talkEl'); el.muted = true; el.srcObject = st; el.play().catch(() => { }); // para que fluya a WebAudio
        const c = audioCtx();
        if (!talkOut) { talkOut = c.createGain(); talkOut.connect(c.destination); }
        c.createMediaStreamSource(st).connect(talkOut);
        applyVolumes();
        return;
      }
      if (e.transceiver !== progTr) return;
      try { e.receiver.jitterBufferTarget = S.buf != null ? S.buf : 0; } catch (x) { } // mínimo que permita la red
      progStream = new MediaStream([e.track]);
      const a = $('prog'); a.srcObject = progStream; a.volume = +$('vol').value;
      if (S.outDev && a.setSinkId) a.setSinkId(S.outDev).catch(() => { });
      a.play().catch(() => toast('Toca la pantalla para activar el sonido'));
      // para el vúmetro y la calibración
      const c = audioCtx();
      progSrc = c.createMediaStreamSource(progStream);
      progAn = c.createAnalyser(); progAn.fftSize = 1024; progSrc.connect(progAn);
      if (ply) ply.connect(progAn);
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
      send({ t: 'sdp', type: 'offer', sdp: pc.localDescription.sdp, prog: progTr.mid, talk: talkTr.mid });
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
    updateSender(m); // durante la medición se envía la ruta procesada (la que lleva los clics)
    // vía rápida: lo que llega por el reproductor rápido vuelve por el canal rápido del micro 1
    if (m.cap && ply) { try { m.g.disconnect(m.cap); } catch (e) { } ply.connect(m.cap); cal.fast = true; }
    toast('Midiendo el retraso… (oirás unos clics)', 4000);
  }
  function stopCal() {
    if (!cal) return;
    try { progSrc.disconnect(cal.mic.dest); } catch (e) { }
    progSrc.connect(progAn);
    try { cal.mic.g.connect(cal.mic.dest); } catch (e) { }
    if (cal.fast && cal.mic.cap) { try { ply.disconnect(cal.mic.cap); } catch (e) { } try { cal.mic.g.connect(cal.mic.cap); } catch (e) { } }
    const m = cal.mic; cal = null;
    updateSender(m);
  }

  // ---------- estadísticas para el estudio ----------
  let jbPrev = { d: 0, c: 0 };
  setInterval(async () => {
    if (!pc || !connected) return;
    try {
      const st = await pc.getStats(); let jb = 0, rtt = 0;
      st.forEach(r => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio' && r.jitterBufferEmittedCount && progTr && r.mid === progTr.mid) {
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
    conn = pc = peer = null; progTr = talkTr = null; negotiating = false; pendingNeg = false;
    ultraDc = null; lastUltraProg = 0; progSeqLast = -1;
    try { progDec && progDec.state !== 'closed' && progDec.close(); } catch (e) { }
    progDec = null;
    mics.forEach(m => m.tr = null);
    if (full) {
      mics.forEach(m => { m.stream && m.stream.getTracks().forEach(t => t.stop()); dropMicUltra(m); });
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
  $('vol').oninput = applyVolumes;
  $('selfMon').onchange = () => { audioCtx(); monGain.gain.setTargetAtTime($('selfMon').checked ? 1 : 0, ctx.currentTime, 0.01); };

  async function loadOutputs() {
    const a = $('prog');
    if (!a.setSinkId) { $('outWrap').classList.add('hidden'); return; }
    const { outs } = await devices();
    $('outDev').innerHTML = outs.map(d => `<option value="${d.deviceId}">${(d.label || 'Salida').replace(/</g, '&lt;')}</option>`).join('');
    if (S.outDev) $('outDev').value = S.outDev;
    $('outDev').onchange = () => {
      S.outDev = $('outDev').value; save(); a.setSinkId(S.outDev).catch(() => { });
      if (ctx && ctx.setSinkId) ctx.setSinkId(S.outDev === 'default' ? '' : S.outDev).catch(() => { }); // talkback y escucha propia
    };
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
