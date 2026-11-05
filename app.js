(() => {
  'use strict';

  const H = 600;             // ワールドの高さ（幅は画面比率から決める）
  const STEP_HZ = 180;       // 物理のサブステップ / 秒
  const SPAWN_Y = -12;       // 水滴の出現位置（画面上端の少し上）
  const SPAWN_VY = 1.2;
  const MAX_PARTICLES = 2000;
  const FS = 0.75;           // 水描画用フィールドの解像度倍率

  const $ = (id) => document.getElementById(id);
  const canvas = $('c');
  const ctx = canvas.getContext('2d');

  // ---------- 状態 ----------
  let bpm = 90, beatsPerBar = 4, dropSize = 5, volume = 0.7;
  let running = false;
  let W, glass, sim, bowlCapacity;
  const view = { s: 1, ox: 0, oy: 0, dpr: 1 };

  // ---------- ワールド ----------
  function initWorld() {
    const aspect = innerWidth / innerHeight;
    W = Math.round(Math.min(1400, Math.max(640, H * aspect)));
    const deskY = H - 80;
    glass = FluidSim.makeGlass(W / 2, deskY);
    sim = new FluidSim.Sim({ W, H, deskY, glass, cap: 4000 });
    bowlCapacity = glass.area / sim.areaPer;
    setupField();
    resize();
  }

  function resize() {
    view.dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(innerWidth * view.dpr);
    canvas.height = Math.round(innerHeight * view.dpr);
    view.s = Math.min(canvas.width / W, canvas.height / H);
    view.ox = (canvas.width - W * view.s) / 2;
    view.oy = (canvas.height - H * view.s) / 2;
  }
  addEventListener('resize', resize);

  // ---------- オーディオ ----------
  let actx = null, master, reverbIn, noiseBuf;

  function ensureAudio() {
    if (actx) return;
    actx = new (window.AudioContext || window.webkitAudioContext)();
    master = actx.createGain();
    master.gain.value = volume;
    master.connect(actx.destination);

    // 簡易リバーブ（減衰ノイズのインパルス応答）
    const len = Math.floor(actx.sampleRate * 1.2);
    const ir = actx.createBuffer(2, len, actx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.5);
    }
    const conv = actx.createConvolver();
    conv.buffer = ir;
    const wet = actx.createGain();
    wet.gain.value = 0.22;
    conv.connect(wet).connect(master);
    reverbIn = conv;

    noiseBuf = actx.createBuffer(1, Math.floor(actx.sampleRate * 0.1), actx.sampleRate);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  }

  // 水滴の「ポチャン」: 周波数が急上昇するサイン波（気泡の共鳴）+ 着水ノイズ
  function playDrop(t, accent, pitch) {
    const out = actx.createGain();
    out.connect(master);
    out.connect(reverbIn);
    const amp = accent ? 0.9 : 0.5;
    const f0 = pitch * (accent ? 1.2 : 1);

    const o = actx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 2.3, t + 0.06);
    const g = actx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(amp, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.2);

    const n = actx.createBufferSource();
    n.buffer = noiseBuf;
    const bp = actx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = Math.min(8000, f0 * 3);
    bp.Q.value = 1.2;
    const ng = actx.createGain();
    ng.gain.setValueAtTime(amp * 0.35, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
    n.connect(bp).connect(ng).connect(out);
    n.start(t);
    n.stop(t + 0.06);
  }

  // ---------- 拍のスケジューリング ----------
  // beats: 音を鳴らす時刻（=着水時刻）。水滴は落下時間を逆算して早めに生成する。
  let beats = [], nextBeatTime = 0, beatCounter = 0;
  const audioNow = () => actx.currentTime - (actx.outputLatency || actx.baseLatency || 0);

  function fallSeconds() {
    return sim.predictFall(SPAWN_Y, SPAWN_VY, surfaceY() - 2) / STEP_HZ;
  }

  function fillQueue() {
    const ahead = audioNow() + 2.5;
    while (nextBeatTime < ahead) {
      beats.push({
        time: nextBeatTime,
        idx: beatCounter,
        accent: beatsPerBar > 1 && beatCounter % beatsPerBar === 0,
        spawned: false, sounded: false, skip: false,
      });
      beatCounter++;
      nextBeatTime += 60 / bpm;
    }
  }

  // BPM や開始時に、まだ水滴を落としていない拍を組み直す
  function rescheduleFrom() {
    beats = beats.filter((b) => b.spawned);
    const minStart = audioNow() + fallSeconds() + 0.05;
    const last = beats[beats.length - 1];
    if (last) {
      nextBeatTime = Math.max(last.time + 60 / bpm, minStart);
      beatCounter = last.idx + 1;
    } else {
      nextBeatTime = minStart;
      beatCounter = 0;
    }
    if (running) fillQueue();
  }

  function soundPitch() {
    const fill = sim.countInBowl() / bowlCapacity;
    if (sim.baseY <= glass.rimY + 6) return 420;   // グラスが水没した後
    if (fill > 0.9) return 380;                    // あふれて机に落ちる音
    return 520 + 650 * Math.min(1, fill);          // 溜まるほど音が高くなる
  }

  setInterval(() => {
    if (!actx) return;
    if (running) fillQueue();
    const now = audioNow();
    for (const b of beats) {
      if (b.spawned && !b.sounded && !b.skip && b.time < now + 0.15) {
        playDrop(Math.max(b.time + (actx.currentTime - now), actx.currentTime), b.accent, soundPitch());
        b.sounded = true;
      }
    }
    beats = beats.filter((b) => !(b.time < now - 1 && (b.sounded || b.skip)));
  }, 25);

  function processSpawns() {
    if (!actx) return;
    const now = audioNow();
    const surf = surfaceY();
    const steps = sim.predictFall(SPAWN_Y, SPAWN_VY, surf - 2);
    for (const b of beats) {
      if (b.spawned) continue;
      const spawnT = b.time - steps / STEP_HZ;
      if (now < spawnT) break;
      b.spawned = true;
      if (now > b.time - 0.03) { b.skip = true; continue; }  // タブ非表示などで間に合わなかった拍
      const late = Math.round((now - spawnT) * STEP_HZ);
      const st = sim.kinematic(SPAWN_Y, SPAWN_VY, late);
      sim.spawnDrop(glass.cx, st.y, dropSize, st.v);
    }
  }

  // グラス中心の水面の高さ（落下中の水滴は除外）
  const ysBuf = [];
  function surfaceY() {
    const { x, y, vy, n } = sim;
    ysBuf.length = 0;
    for (let i = 0; i < n; i++) {
      if (Math.abs(x[i] - glass.cx) < 9 && vy[i] < 1.0 && y[i] > 0) ysBuf.push(y[i]);
    }
    let s;
    if (ysBuf.length >= 3) { ysBuf.sort((a, b) => a - b); s = ysBuf[2] - sim.pr; }
    else s = glass.bottomY - sim.pr - 1.5;
    return Math.min(s, sim.baseY);
  }

  // ---------- 描画 ----------
  let fw, fh, fCan, fCtx, oCan, oCtx, outImg, sprite, spriteR, rowCol;
  function setupField() {
    fw = Math.ceil(W * FS); fh = Math.ceil(H * FS);
    fCan = document.createElement('canvas'); fCan.width = fw; fCan.height = fh;
    fCtx = fCan.getContext('2d', { willReadFrequently: true });
    oCan = document.createElement('canvas'); oCan.width = fw; oCan.height = fh;
    oCtx = oCan.getContext('2d');
    outImg = oCtx.createImageData(fw, fh);

    const rad = 11;
    spriteR = Math.ceil(rad * FS);
    sprite = document.createElement('canvas');
    sprite.width = sprite.height = spriteR * 2;
    const sc = sprite.getContext('2d');
    const gr = sc.createRadialGradient(spriteR, spriteR, 0, spriteR, spriteR, spriteR);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.45, 'rgba(255,255,255,0.55)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    sc.fillStyle = gr;
    sc.fillRect(0, 0, spriteR * 2, spriteR * 2);

    // 行ごとの水の色（深いほど濃い）
    rowCol = new Uint8Array(fh * 3);
    for (let r = 0; r < fh; r++) {
      const t = r / fh;
      rowCol[r * 3] = 70 - 40 * t;
      rowCol[r * 3 + 1] = 165 - 60 * t;
      rowCol[r * 3 + 2] = 245 - 45 * t;
    }
  }

  function drawWater() {
    fCtx.globalCompositeOperation = 'source-over';
    fCtx.clearRect(0, 0, fw, fh);
    fCtx.globalCompositeOperation = 'lighter';
    const { x, y, vx, vy, rho, onFloor, n } = sim;
    const rho0 = sim.rho0;
    for (let i = 0; i < n; i++) {
      const cx = x[i] * FS, cy = y[i] * FS;
      if (cy < -2 * spriteR || cy > fh + spriteR) continue;
      // 周りに粒子が少ない（しぶき・水滴）ほど小さく描いて、ボール感を減らす
      const d = Math.min(1, rho[i] / rho0);
      const size = 0.65 + 0.4 * d;
      let a = size, b = size, c = 1, s = 0;
      if (onFloor[i]) {
        // 床の水は横に平たく伸ばして水たまりに見せる
        a = size * 2.0; b = size * 0.5;
      } else {
        // 速く動く水滴は進行方向に少し伸ばす
        const sp = Math.hypot(vx[i], vy[i]);
        if (sp > 0.8) {
          const st = 1 + Math.min(1.2, (sp - 0.8) * 0.3);
          c = vx[i] / sp; s = vy[i] / sp;
          a = size * st; b = size / Math.sqrt(st);
        }
      }
      fCtx.setTransform(c * a, s * a, -s * b, c * b, cx, cy);
      fCtx.drawImage(sprite, -spriteR, -spriteR);
    }
    fCtx.setTransform(1, 0, 0, 1, 0, 0);
    if (sim.baseY < sim.deskY - 0.5) {
      fCtx.fillStyle = '#fff';
      fCtx.fillRect(0, sim.baseY * FS, fw, (sim.deskY - sim.baseY) * FS + 2);
    }

    const src = fCtx.getImageData(0, 0, fw, fh).data;
    const dst = outImg.data;
    const T = 95, E = 22, F = 25;   // しきい値・ハイライト幅・アンチエイリアス幅
    for (let r = 0, i = 0; r < fh; r++) {
      const cr = rowCol[r * 3], cg = rowCol[r * 3 + 1], cb = rowCol[r * 3 + 2];
      for (let c = 0; c < fw; c++, i += 4) {
        const a = src[i + 3];
        if (a < T - F) { dst[i + 3] = 0; continue; }
        if (a < T + E) {
          // 縁: 明るい色から内部の色へなめらかに
          const t = a < T ? 0 : (a - T) / E;
          dst[i] = 200 + (cr - 200) * t; dst[i + 1] = 235 + (cg - 235) * t; dst[i + 2] = 255 + (cb - 255) * t;
          dst[i + 3] = a < T ? 210 * (a - (T - F)) / F : 210 - 60 * t;
        } else {
          dst[i] = cr; dst[i + 1] = cg; dst[i + 2] = cb; dst[i + 3] = 150;
        }
      }
    }
    oCtx.putImageData(outImg, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(oCan, 0, 0, fw / FS, fh / FS);
  }

  function bowlPath() {
    ctx.beginPath();
    const L = glass.left, R = glass.right;
    ctx.moveTo(L[L.length - 1][0], L[L.length - 1][1]);
    for (let i = L.length - 2; i >= 0; i--) ctx.lineTo(L[i][0], L[i][1]);
    for (let i = 1; i < R.length; i++) ctx.lineTo(R[i][0], R[i][1]);
  }

  function drawGlassBack() {
    bowlPath();
    ctx.closePath();
    ctx.fillStyle = 'rgba(200, 230, 255, 0.06)';
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(glass.cx, glass.rimY, glass.rimHW, 7, 0, Math.PI, Math.PI * 2);
    ctx.strokeStyle = 'rgba(220, 240, 255, 0.3)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  function drawGlassFront() {
    const { cx, rimY, rimHW, bottomY, deskY } = glass;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    bowlPath();
    ctx.strokeStyle = 'rgba(225, 240, 255, 0.75)';
    ctx.lineWidth = 2.4;
    ctx.stroke();

    ctx.beginPath();
    ctx.ellipse(cx, rimY, rimHW, 7, 0, 0, Math.PI);
    ctx.strokeStyle = 'rgba(235, 245, 255, 0.7)';
    ctx.lineWidth = 1.8;
    ctx.stroke();

    // ステム
    const sg = ctx.createLinearGradient(cx - 3, 0, cx + 3, 0);
    sg.addColorStop(0, 'rgba(255,255,255,0.85)');
    sg.addColorStop(1, 'rgba(170,200,230,0.45)');
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.moveTo(cx - 6, bottomY + 2);
    ctx.quadraticCurveTo(cx - 2.5, bottomY + 18, cx - 2.5, bottomY + 30);
    ctx.lineTo(cx - 2.5, deskY - 10);
    ctx.quadraticCurveTo(cx - 3, deskY - 6, cx - 10, deskY - 5);
    ctx.lineTo(cx + 10, deskY - 5);
    ctx.quadraticCurveTo(cx + 3, deskY - 6, cx + 2.5, deskY - 10);
    ctx.lineTo(cx + 2.5, bottomY + 30);
    ctx.quadraticCurveTo(cx + 2.5, bottomY + 18, cx + 6, bottomY + 2);
    ctx.closePath();
    ctx.fill();

    // 台座
    ctx.beginPath();
    ctx.ellipse(cx, deskY - 3.5, 48, 4.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(200, 225, 250, 0.35)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(235, 245, 255, 0.7)';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // ハイライト
    ctx.beginPath();
    for (let t = 0.3; t <= 0.86; t += 0.02) {
      const yy = bottomY - t * glass.bowlH;
      const xx = cx - glass.hwAt(t) + 9;
      if (t === 0.3) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
    }
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  function drawBackground() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const cw = canvas.width, ch = canvas.height;
    const gcx = view.ox + glass.cx * view.s, gcy = view.oy + glass.bottomY * view.s;
    const bg = ctx.createRadialGradient(gcx, gcy, 0, gcx, gcy, Math.max(cw, ch) * 0.8);
    bg.addColorStop(0, '#2c3d57');
    bg.addColorStop(1, '#0b1017');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cw, ch);

    const dy = view.oy + glass.deskY * view.s;
    const wood = ctx.createLinearGradient(0, dy, 0, ch);
    wood.addColorStop(0, '#8a5530');
    wood.addColorStop(0.08, '#6e4124');
    wood.addColorStop(1, '#3a2213');
    ctx.fillStyle = wood;
    ctx.fillRect(0, dy, cw, ch - dy);
    ctx.fillStyle = 'rgba(255, 210, 160, 0.25)';
    ctx.fillRect(0, dy, cw, Math.max(1, 2 * view.s));
  }

  function draw() {
    drawBackground();
    ctx.setTransform(view.s, 0, 0, view.s, view.ox, view.oy);
    drawGlassBack();
    drawWater();
    drawGlassFront();
  }

  // ---------- UI ----------
  const dotsEl = $('dots');
  function buildDots() {
    dotsEl.innerHTML = '';
    if (beatsPerBar <= 1) { dotsEl.appendChild(document.createElement('span')); return; }
    for (let i = 0; i < beatsPerBar; i++) {
      const s = document.createElement('span');
      if (i === 0) s.classList.add('accent');
      dotsEl.appendChild(s);
    }
  }

  function updateDots() {
    let cur = -1;
    if (actx) {
      const now = audioNow();
      for (const b of beats) {
        if (b.sounded && b.time <= now && now - b.time < Math.min(0.15, 30 / bpm)) cur = b.idx;
      }
    }
    const spans = dotsEl.children;
    for (let i = 0; i < spans.length; i++) {
      spans[i].classList.toggle('on', cur >= 0 && cur % spans.length === i);
    }
  }

  let statusTimer = 0;
  function updateStatus() {
    if (++statusTimer % 10) return;
    let text;
    if (sim.baseY <= glass.rimY + 6) text = 'グラスは水の底に…';
    else if (sim.baseY < sim.deskY - 0.5) text = `あふれた水 ${Math.round(sim.deskY - sim.baseY)}mm`;
    else {
      const fill = Math.min(100, Math.round(sim.countInBowl() / bowlCapacity * 100));
      text = fill >= 90 && sim.n - sim.countInBowl() > 30 ? 'あふれています' : `グラス ${fill}%`;
    }
    $('status').textContent = text;
  }

  function setBpm(v) {
    bpm = Math.max(30, Math.min(240, Math.round(v)));
    $('bpmVal').textContent = bpm;
    $('bpm').value = bpm;
    if (running) rescheduleFrom();
  }

  function toggle() {
    ensureAudio();
    actx.resume();
    running = !running;
    $('play').textContent = running ? '■ ストップ' : '▶ スタート';
    $('play').classList.toggle('on', running);
    rescheduleFrom();
  }

  let taps = [];
  function tap() {
    const t = performance.now() / 1000;
    if (taps.length && t - taps[taps.length - 1] > 2) taps = [];
    taps.push(t);
    if (taps.length > 5) taps.shift();
    if (taps.length >= 2) setBpm(60 * (taps.length - 1) / (taps[taps.length - 1] - taps[0]));
  }

  $('play').onclick = toggle;
  $('tap').onclick = tap;
  $('minus').onclick = () => setBpm(bpm - 1);
  $('plus').onclick = () => setBpm(bpm + 1);
  $('bpm').oninput = (e) => setBpm(+e.target.value);
  $('beats').onchange = (e) => {
    beatsPerBar = +e.target.value;
    buildDots();
    for (const b of beats) b.accent = beatsPerBar > 1 && b.idx % beatsPerBar === 0;
  };
  $('drop').oninput = (e) => { dropSize = +e.target.value; $('dropVal').textContent = dropSize; };
  $('vol').oninput = (e) => {
    volume = e.target.value / 100;
    $('volVal').textContent = e.target.value;
    if (master) master.gain.value = volume;
  };
  $('reset').onclick = () => sim.reset();
  $('hide').onclick = () => $('panel').classList.add('hidden');
  $('toggle').onclick = () => $('panel').classList.remove('hidden');

  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); toggle(); }
    else if (e.code === 'ArrowUp') { e.preventDefault(); setBpm(bpm + (e.shiftKey ? 10 : 1)); }
    else if (e.code === 'ArrowDown') { e.preventDefault(); setBpm(bpm - (e.shiftKey ? 10 : 1)); }
    else if (e.code === 'KeyT') tap();
  });

  // ---------- メインループ ----------
  let last = performance.now(), acc = 0;
  function frame(ts) {
    acc += Math.min(0.1, (ts - last) / 1000);
    last = ts;
    let steps = 0;
    while (acc >= 1 / STEP_HZ && steps < 8) { sim.step(); acc -= 1 / STEP_HZ; steps++; }
    if (steps === 8) acc = 0;
    sim.manage(MAX_PARTICLES);
    processSpawns();
    draw();
    updateDots();
    updateStatus();
    requestAnimationFrame(frame);
  }

  initWorld();
  buildDots();
  const qs = new URLSearchParams(location.search);
  if (qs.has('bpm')) setBpm(+qs.get('bpm'));
  if (qs.has('autostart')) toggle();
  if (qs.has('prefill')) {   // 確認用: 指定秒数ぶん水滴を落とした状態から始める
    const per = Math.round(STEP_HZ * 60 / bpm);
    for (let s = 0; s < STEP_HZ * +qs.get('prefill'); s++) {
      if (s % per === 0) sim.spawnDrop(glass.cx, SPAWN_Y, dropSize, SPAWN_VY);
      sim.step();
      if (s % 3 === 0) sim.manage(MAX_PARTICLES);
    }
  }
  requestAnimationFrame(frame);
})();
