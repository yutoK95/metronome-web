(() => {
  'use strict';

  const H = 720;             // ワールドの高さ（幅は画面比率から決める）
  const STEP_HZ = 180;       // 物理のサブステップ / 秒
  const MAX_PARTICLES = 2000;
  const FS = 0.7;            // 水描画用フィールドの解像度倍率

  // シーン: 雨上がりの野原。頭上の葉っぱの先から、地面に座ったカエルの頭へしずくが落ちる
  const GROUND_Y = 600;      // カエルが座っている地面
  const LEAF_TIP_Y = 170;    // しずくが落ちる直前の葉先の高さ
  const LEAF_DROOP = 0.05;   // しずくの重みで葉がしなる角度（rad）
  const PUDDLE_MAX = 330;    // 水たまりの最大半径
  const SPAWN_VY = 0.5;      // 葉先から離れるときの初速
  // 先頭の粒子の出現位置。しずくの上端が葉先に来るようにする
  const spawnY = () => LEAF_TIP_Y + 3 + 4.2 * (dropSize - 1);

  const $ = (id) => document.getElementById(id);
  const canvas = $('c');
  const ctx = canvas.getContext('2d');

  // ---------- 状態 ----------
  let bpm = 90, beatsPerBar = 4, dropSize = 5, volume = 0.7;
  let running = false;
  let W, frog, sim, leaf, scenery;
  let playSec = 0, dropCount = 0;
  let lastSpawnT = 0, nextSpawnT = 0;
  let hitAt = -10, hitPeak = 0;            // 頭に当たった時刻（目を細める演出用）
  let blinkAt = 3;                         // 次のまばたき（performance 秒）
  const puddle = { rx: 0, ripples: [] };   // カエルの周りの水たまり（地面の水の量で大きさが決まる）
  const view = { s: 1, ox: 0, oy: 0, dpr: 1 };

  // ---------- ワールド ----------
  function initWorld() {
    const aspect = innerWidth / innerHeight;
    W = Math.round(Math.min(1680, Math.max(720, H * aspect)));
    frog = FluidSim.makeFrog(W / 2, GROUND_Y);
    sim = new FluidSim.Sim({
      W, H, floorY: GROUND_Y, body: frog, cap: 4000,
      params: { topLimit: GROUND_Y - 25 },
    });
    // 葉っぱ: 付け根を軸に回転する。しなりきったとき葉先がカエルの真上に来る
    const px = W / 2 - 175, py = 72;
    leaf = {
      px, py,
      len: Math.hypot(W / 2 - px, LEAF_TIP_Y - py),
      full: Math.atan2(LEAF_TIP_Y - py, W / 2 - px),
      angle: 0, vel: 0,
    };
    leaf.angle = leaf.full - LEAF_DROOP * 0.7;
    buildScenery();
    setupField();
    resize();
  }

  function resize() {
    view.dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(innerWidth * view.dpr);
    canvas.height = Math.round(innerHeight * view.dpr);
    view.s = Math.min(canvas.width / W, canvas.height / H);
    view.ox = (canvas.width - W * view.s) / 2;
    view.oy = canvas.height - H * view.s;   // 地面が画面の下端に来るように下揃え
  }
  addEventListener('resize', resize);

  // 背景の草・雲などの配置（毎回同じになるよう固定の乱数）
  function buildScenery() {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const tufts = [];
    for (let i = 0; i < 60; i++) {
      const x = rnd() * W;
      if (Math.abs(x - W / 2) < 170) continue;          // カエルの前はあけておく
      tufts.push({ x, y: GROUND_Y + 30 + rnd() * (H - GROUND_Y - 20), h: 14 + rnd() * 22, n: 3 + Math.floor(rnd() * 4), hue: rnd() });
    }
    tufts.sort((a, b) => a.y - b.y);
    const clouds = [];
    for (let i = 0; i < 5; i++) clouds.push({ x: rnd() * W, y: 40 + rnd() * 160, r: 50 + rnd() * 60, sp: 2 + rnd() * 4 });
    scenery = { tufts, clouds };
  }

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
  // beats: 音を鳴らす時刻（=頭に当たる時刻）。しずくは落下時間を逆算して早めに離す。
  let beats = [], nextBeatTime = 0, beatCounter = 0;
  const audioNow = () => actx.currentTime - (actx.outputLatency || actx.baseLatency || 0);

  function fallSeconds() {
    return sim.predictFall(spawnY(), SPAWN_VY, surfaceY() - 2) / STEP_HZ;
  }

  function fillQueue() {
    const ahead = audioNow() + 2.5;
    while (nextBeatTime < ahead) {
      beats.push({
        time: nextBeatTime,
        idx: beatCounter,
        accent: beatsPerBar > 1 && beatCounter % beatsPerBar === 0,
        spawned: false, sounded: false, skip: false, hit: false,
      });
      beatCounter++;
      nextBeatTime += 60 / bpm;
    }
  }

  // BPM や開始時に、まだしずくを離していない拍を組み直す
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

  setInterval(() => {
    if (!actx) return;
    if (running) fillQueue();
    const now = audioNow();
    for (const b of beats) {
      if (b.spawned && !b.sounded && !b.skip && b.time < now + 0.15) {
        playDrop(Math.max(b.time + (actx.currentTime - now), actx.currentTime), b.accent, 640);
        b.sounded = true;
      }
    }
    beats = beats.filter((b) => !(b.time < now - 1 && (b.sounded || b.skip)));
  }, 25);

  function processSpawns() {
    if (!actx) return;
    const now = audioNow();
    const y0 = spawnY();
    const steps = sim.predictFall(y0, SPAWN_VY, surfaceY() - 2);
    nextSpawnT = 0;
    for (const b of beats) {
      if (b.spawned) continue;
      const spawnT = b.time - steps / STEP_HZ;
      if (now < spawnT) { nextSpawnT = spawnT; break; }
      b.spawned = true;
      if (now > b.time - 0.03) { b.skip = true; continue; }  // タブ非表示などで間に合わなかった拍
      const late = Math.round((now - spawnT) * STEP_HZ);
      const st = sim.kinematic(y0, SPAWN_VY, late);
      sim.spawnDrop(frog.cx, st.y, dropSize, st.v);
      lastSpawnT = now;
    }
    // 頭に当たった瞬間に目を細める
    for (const b of beats) {
      if (b.sounded && !b.hit && b.time <= now) {
        b.hit = true;
        hitAt = b.time;
        hitPeak = b.accent ? 0.75 : 0.5;
        dropCount++;
        addRipples();
      }
    }
  }

  // カエルの頭の真ん中の水面の高さ（落下中のしずくは除外）
  const ysBuf = [];
  function surfaceY() {
    const { x, y, vy, n } = sim;
    ysBuf.length = 0;
    for (let i = 0; i < n; i++) {
      if (Math.abs(x[i] - frog.cx) < 9 && vy[i] < 1.0 && y[i] > LEAF_TIP_Y + 40 && y[i] < frog.headTopY + 10) ysBuf.push(y[i]);
    }
    if (ysBuf.length >= 3) { ysBuf.sort((a, b) => a - b); return ysBuf[2] - sim.pr; }
    return frog.headTopY - sim.pr - 3;
  }

  // ---------- 水の描画 ----------
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

    // 行ごとの水の色（明るい屋外なので淡い水色、下ほど少し濃い）
    rowCol = new Uint8Array(fh * 3);
    for (let r = 0; r < fh; r++) {
      const t = r / fh;
      rowCol[r * 3] = 185 - 50 * t;
      rowCol[r * 3 + 1] = 225 - 35 * t;
      rowCol[r * 3 + 2] = 250 - 15 * t;
    }
  }

  function drawWater() {
    fCtx.globalCompositeOperation = 'source-over';
    fCtx.clearRect(0, 0, fw, fh);
    fCtx.globalCompositeOperation = 'lighter';
    const { x, y, vx, vy, rho, onFloor, n } = sim;
    const rho0 = sim.rho0;
    for (let i = 0; i < n; i++) {
      const cx = x[i] * FS;
      let cy = y[i] * FS;
      if (cy < -2 * spriteR || cy > fh + spriteR) continue;
      // 周りに粒子が少ない（しぶき・しずく）ほど小さく描いて、ボール感を減らす
      const d = Math.min(1, rho[i] / rho0);
      const size = 0.65 + 0.4 * d;
      let a = size, b = size, c = 1, s = 0;
      if (onFloor[i] && y[i] > GROUND_Y - 10) {
        continue;   // 地面に着いた水は水たまり（drawPuddle）として描く
      } else if (onFloor[i]) {
        a = size * 2.0; b = size * 0.5;
      } else {
        // 速く動くしずくは進行方向に少し伸ばす
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
    if (sim.baseY < GROUND_Y - 0.5) {
      fCtx.fillStyle = '#fff';
      fCtx.fillRect(0, sim.baseY * FS, fw, (H - sim.baseY) * FS + 2);
    }

    const src = fCtx.getImageData(0, 0, fw, fh).data;
    const dst = outImg.data;
    const T = 95, E = 22, F = 25;   // しきい値・縁の幅・アンチエイリアス幅
    const er = 70, eg = 135, eb = 200;   // 縁の色（明るい背景でも輪郭が見えるよう濃いめ）
    for (let r = 0, i = 0; r < fh; r++) {
      const cr = rowCol[r * 3], cg = rowCol[r * 3 + 1], cb = rowCol[r * 3 + 2];
      for (let c = 0; c < fw; c++, i += 4) {
        const a = src[i + 3];
        if (a < T - F) { dst[i + 3] = 0; continue; }
        if (a < T + E) {
          const t = a < T ? 0 : (a - T) / E;
          dst[i] = er + (cr - er) * t; dst[i + 1] = eg + (cg - eg) * t; dst[i + 2] = eb + (cb - eb) * t;
          dst[i + 3] = a < T ? 200 * (a - (T - F)) / F : 200 - 40 * t;
        } else {
          dst[i] = cr; dst[i + 1] = cg; dst[i + 2] = cb; dst[i + 3] = 160;
        }
      }
    }
    oCtx.putImageData(outImg, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(oCan, 0, 0, fw / FS, fh / FS);
  }

  // ---------- 背景 ----------
  function drawBackground() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const cw = canvas.width, ch = canvas.height;
    const sky = ctx.createLinearGradient(0, 0, 0, ch);
    sky.addColorStop(0, '#9fc4d6');
    sky.addColorStop(0.6, '#dbe8dc');
    sky.addColorStop(1, '#e9efd9');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, cw, ch);

    ctx.setTransform(view.s, 0, 0, view.s, view.ox, view.oy);
    const t = performance.now() / 1000;
    const x0 = -view.ox / view.s, x1 = (canvas.width - view.ox) / view.s, top = -view.oy / view.s;

    // 雲
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    for (const c of scenery.clouds) {
      const span = x1 - x0 + c.r * 4;
      const cx = x0 - c.r * 2 + ((c.x + t * c.sp) % span + span) % span;
      ctx.beginPath();
      ctx.ellipse(cx, c.y, c.r, c.r * 0.35, 0, 0, Math.PI * 2);
      ctx.ellipse(cx + c.r * 0.5, c.y - c.r * 0.15, c.r * 0.6, c.r * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // 遠くの丘（2層）
    const hill = (base, amp, freq, phase, color) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x0, H);
      for (let x = x0; x <= x1 + 20; x += 20) {
        ctx.lineTo(x, base - amp * (0.5 + 0.5 * Math.sin(x * freq + phase)) - amp * 0.4 * Math.sin(x * freq * 2.3 + phase * 2));
      }
      ctx.lineTo(x1 + 20, H);
      ctx.closePath();
      ctx.fill();
    };
    hill(500, 70, 0.004, 1.3, '#a9c6aa');
    hill(535, 45, 0.007, 4.1, '#8fb68c');

    // 野原（手前ほど濃い）
    const g = ctx.createLinearGradient(0, 520, 0, H);
    g.addColorStop(0, '#86b36a');
    g.addColorStop(1, '#4f8a3c');
    ctx.fillStyle = g;
    ctx.fillRect(x0, 528, x1 - x0, H - 528 + 40);
    // カエルの足元の土
    const soil = ctx.createRadialGradient(frog.cx, GROUND_Y + 14, 0, frog.cx, GROUND_Y + 14, 300);
    soil.addColorStop(0, 'rgba(110, 82, 52, 0.85)');
    soil.addColorStop(0.7, 'rgba(110, 82, 52, 0.4)');
    soil.addColorStop(1, 'rgba(110, 82, 52, 0)');
    ctx.fillStyle = soil;
    ctx.beginPath();
    ctx.ellipse(frog.cx, GROUND_Y + 14, 300, 58, 0, 0, Math.PI * 2);
    ctx.fill();
    void top;
  }

  // 地面の水の量から水たまりの大きさを決める
  function updatePuddle(dt) {
    let count = 0;
    for (let i = 0; i < sim.n; i++) if (sim.onFloor[i] && sim.y[i] > GROUND_Y - 10) count++;
    const target = count ? Math.min(PUDDLE_MAX, 120 + 10 * Math.sqrt(count)) : 0;
    puddle.rx += (target - puddle.rx) * Math.min(1, dt * 1.5);
    const now = performance.now() / 1000;
    puddle.ripples = puddle.ripples.filter((r) => now - r.t < 1.6);
  }

  function drawPuddle() {
    const rx = puddle.rx;
    if (rx < 4) return;
    const ry = rx * 0.15, cx = frog.cx, cy = GROUND_Y + 6;
    // ふちを少し波打たせた楕円
    ctx.beginPath();
    for (let k = 0; k <= 48; k++) {
      const a = k / 48 * Math.PI * 2;
      const r = 1 + 0.05 * Math.sin(a * 3 + 1.7) + 0.03 * Math.sin(a * 7 + 0.4);
      const px = cx + Math.cos(a) * rx * r, py = cy + Math.sin(a) * ry * r;
      if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    const g = ctx.createLinearGradient(0, cy - ry, 0, cy + ry);
    g.addColorStop(0, 'rgba(200, 230, 248, 0.9)');    // 空の映り込み
    g.addColorStop(1, 'rgba(120, 175, 220, 0.9)');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(70, 120, 150, 0.45)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // 波紋
    const now = performance.now() / 1000;
    for (const r of puddle.ripples) {
      const age = now - r.t;
      if (age < 0) continue;
      const rr = 6 + age * 34;
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.7 * (1 - age / 1.6)})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(r.x, cy + r.dy, rr, rr * 0.22, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // 頭から流れ落ちた水が水たまりに落ちるあたりに波紋を出す
  function addRipples() {
    if (puddle.rx < 150) return;
    const now = performance.now() / 1000;
    for (const sgn of [-1, 1]) {
      puddle.ripples.push({ x: frog.cx + sgn * (125 + Math.random() * 20), dy: 4 + Math.random() * 8, t: now + 0.35 + Math.random() * 0.2 });
    }
  }

  // 手前の草むら
  function drawGrass() {
    const t = performance.now() / 1000;
    ctx.lineCap = 'round';
    for (const tf of scenery.tufts) {
      const sway = Math.sin(t * 1.3 + tf.x * 0.05) * 2;
      ctx.strokeStyle = tf.hue < 0.5 ? '#3f7a31' : '#5a9440';
      ctx.lineWidth = 2.2;
      for (let k = 0; k < tf.n; k++) {
        const dx = (k - (tf.n - 1) / 2) * 4;
        ctx.beginPath();
        ctx.moveTo(tf.x + dx, tf.y);
        ctx.quadraticCurveTo(tf.x + dx * 1.5, tf.y - tf.h * 0.6, tf.x + dx * 2.2 + sway, tf.y - tf.h);
        ctx.stroke();
      }
    }
  }

  // ---------- 葉っぱ ----------
  function leafTip() {
    return [leaf.px + Math.cos(leaf.angle) * leaf.len, leaf.py + Math.sin(leaf.angle) * leaf.len];
  }

  // しずくの重みでしなり、離れるとばねのように跳ね返る
  function updateLeaf(dt, prog) {
    const target = leaf.full - LEAF_DROOP * (1 - prog);
    const k = 160, damp = 7;
    leaf.vel += (k * (target - leaf.angle) - damp * leaf.vel) * dt;
    leaf.angle += leaf.vel * dt;
  }

  function leafShape(L, wdt) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(L * 0.25, -wdt, L * 0.7, -wdt * 0.85, L, 0);
    ctx.bezierCurveTo(L * 0.7, wdt * 0.85, L * 0.25, wdt, 0, 0);
    ctx.closePath();
  }

  function drawLeaf(prog) {
    const top = -view.oy / view.s;
    const t = performance.now() / 1000;
    // 枝（画面の左上から）
    ctx.strokeStyle = '#6b4a2b';
    ctx.lineCap = 'round';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(leaf.px - 330, top - 10);
    ctx.quadraticCurveTo(leaf.px - 150, top + 40, leaf.px - 26, leaf.py - 14);
    ctx.stroke();
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(leaf.px - 200, top + 22);
    ctx.quadraticCurveTo(leaf.px - 230, top + 70, leaf.px - 280, top + 95);
    ctx.stroke();

    // 飾りの葉（ゆれるだけ）
    const deco = (x, y, ang, L, wdt) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(ang + Math.sin(t * 1.1 + x) * 0.03);
      leafShape(L, wdt);
      ctx.fillStyle = '#4f8f3a';
      ctx.fill();
      ctx.strokeStyle = 'rgba(30, 70, 20, 0.5)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(L * 0.95, 0);
      ctx.stroke();
      ctx.restore();
    };
    deco(leaf.px - 280, top + 95, 2.2, 110, 26);
    deco(leaf.px - 120, top + 28, -0.5, 120, 30);

    // しずくを落とす葉
    ctx.save();
    ctx.translate(leaf.px, leaf.py);
    ctx.rotate(leaf.angle);
    const L = leaf.len;
    ctx.strokeStyle = '#4c6b2a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-28, -12); ctx.lineTo(0, 0);
    ctx.stroke();
    leafShape(L, 46);
    const lg = ctx.createLinearGradient(0, -40, 0, 40);
    lg.addColorStop(0, '#7cc25a');
    lg.addColorStop(1, '#3e8a35');
    ctx.fillStyle = lg;
    ctx.fill();
    ctx.strokeStyle = 'rgba(40, 90, 30, 0.6)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    // 葉脈
    ctx.strokeStyle = 'rgba(220, 240, 190, 0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(L * 0.97, 0);
    ctx.stroke();
    ctx.lineWidth = 1;
    for (let k = 1; k <= 5; k++) {
      const vx = L * k / 6.5;
      for (const sgn of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(vx, 0);
        ctx.quadraticCurveTo(vx + 14, sgn * 14, vx + 26, sgn * 26 * (1 - k / 7));
        ctx.stroke();
      }
    }
    // 雨上がりのつや
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.beginPath();
    ctx.ellipse(L * 0.35, -14, 30, 5, -0.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 葉先でふくらむしずく（次に落ちるまでの進み具合で大きくなる）
    const [tx, ty] = leafTip();
    const r = (3 + dropSize * 0.55) * (0.3 + 0.7 * prog);
    const dy = ty + r * 0.95;
    ctx.beginPath();
    ctx.moveTo(tx - 2, ty);
    ctx.quadraticCurveTo(tx - r * 0.5, ty + r * 0.15, tx - r, dy);
    ctx.arc(tx, dy, r, Math.PI, 0, true);
    ctx.quadraticCurveTo(tx + r * 0.5, ty + r * 0.15, tx + 2, ty);
    ctx.closePath();
    ctx.fillStyle = 'rgba(185, 225, 250, 0.9)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(70, 135, 200, 0.8)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(tx - r * 0.35, dy - r * 0.3, Math.max(0.8, r * 0.2), 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.fill();
  }

  // ---------- カエル ----------
  function frogBodyPath() {
    const L = frog.left, R = frog.right;
    ctx.beginPath();
    ctx.moveTo(L[0][0], L[0][1]);
    for (let i = 1; i < L.length; i++) ctx.lineTo(L[i][0], L[i][1]);
    for (let i = R.length - 2; i >= 0; i--) ctx.lineTo(R[i][0], R[i][1]);
    ctx.closePath();
  }

  // squint: 0 = ぱっちり, 1 = 閉じる
  function drawEye(ex, ey, squint, lookX) {
    const rs = 30, r = 21;
    // 目の土台（頭から出っぱった部分）
    ctx.beginPath();
    ctx.arc(ex, ey, rs, 0, Math.PI * 2);
    const sg = ctx.createRadialGradient(ex - 8, ey - 10, 2, ex, ey, rs);
    sg.addColorStop(0, '#8fd36a');
    sg.addColorStop(1, '#4c9a3c');
    ctx.fillStyle = sg;
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.arc(ex, ey, r, 0, Math.PI * 2);
    ctx.clip();
    // 白目・虹彩・横長の瞳
    ctx.fillStyle = '#f7f3d2';
    ctx.fillRect(ex - r, ey - r, r * 2, r * 2);
    ctx.beginPath();
    ctx.arc(ex + lookX, ey + 1, 15, 0, Math.PI * 2);
    ctx.fillStyle = '#d9a52a';
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(ex + lookX, ey + 1, 10, 5, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#1d1a12';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(ex + lookX - 5, ey - 5, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.fill();
    // まぶた（上から大きく、下から少し閉じて目を細める）
    const upper = ey - r + r * 1.15 * squint;
    const lower = ey + r - r * 0.75 * squint;
    ctx.fillStyle = '#5fae47';
    ctx.beginPath();
    ctx.moveTo(ex - r - 2, ey - r - 2);
    ctx.lineTo(ex + r + 2, ey - r - 2);
    ctx.lineTo(ex + r + 2, upper);
    ctx.quadraticCurveTo(ex, upper + 6 * squint, ex - r - 2, upper);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(ex - r - 2, ey + r + 2);
    ctx.lineTo(ex + r + 2, ey + r + 2);
    ctx.lineTo(ex + r + 2, lower);
    ctx.quadraticCurveTo(ex, lower - 4 * squint, ex - r - 2, lower);
    ctx.closePath();
    ctx.fill();
    if (squint > 0.05) {
      ctx.strokeStyle = 'rgba(30, 70, 25, 0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ex - r, upper);
      ctx.quadraticCurveTo(ex, upper + 6 * squint, ex + r, upper);
      ctx.stroke();
    }
    ctx.restore();
    ctx.beginPath();
    ctx.arc(ex, ey, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(40, 90, 30, 0.7)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function drawFrog(squint) {
    const { cx } = frog, gy = GROUND_Y, top = frog.headTopY;
    ctx.save();
    // 当たった瞬間に少しつぶれる（見た目だけ）
    const sq = squint * 0.035;
    ctx.translate(cx, gy);
    ctx.scale(1 + sq, 1 - sq);
    ctx.translate(-cx, -gy);

    // 影
    ctx.fillStyle = 'rgba(40, 50, 20, 0.3)';
    ctx.beginPath();
    ctx.ellipse(cx, gy + 6, 150, 18, 0, 0, Math.PI * 2);
    ctx.fill();

    // 後ろ足（体の横に折りたたんだ太もも + 足先）
    for (const sgn of [-1, 1]) {
      ctx.fillStyle = '#4a9238';
      ctx.beginPath();
      ctx.ellipse(cx + sgn * 98, gy - 30, 46, 32, sgn * -0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#5aa243';
      ctx.beginPath();
      ctx.ellipse(cx + sgn * 128, gy - 4, 34, 9, 0, 0, Math.PI * 2);
      ctx.fill();
      for (let k = 0; k < 3; k++) {
        ctx.beginPath();
        ctx.arc(cx + sgn * (150 + k * 6), gy - 6 + k * 3, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 胴体（当たり判定と同じ輪郭）
    frogBodyPath();
    const bg = ctx.createRadialGradient(cx - 30, top + 40, 10, cx, gy - 50, 150);
    bg.addColorStop(0, '#93d36d');
    bg.addColorStop(0.7, '#62b049');
    bg.addColorStop(1, '#3f8a34');
    ctx.fillStyle = bg;
    ctx.fill();

    // おなか
    ctx.fillStyle = 'rgba(232, 240, 182, 0.9)';
    ctx.beginPath();
    ctx.ellipse(cx, gy - 38, 64, 40, 0, 0, Math.PI * 2);
    ctx.fill();

    // 前足
    for (const sgn of [-1, 1]) {
      ctx.strokeStyle = '#4f9a3c';
      ctx.lineWidth = 15;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx + sgn * 52, gy - 62);
      ctx.quadraticCurveTo(cx + sgn * 66, gy - 30, cx + sgn * 58, gy - 6);
      ctx.stroke();
      ctx.fillStyle = '#5aa243';
      for (let k = -1; k <= 1; k++) {
        ctx.beginPath();
        ctx.arc(cx + sgn * 58 + k * 8, gy - 3, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ほっぺ・鼻・口
    ctx.fillStyle = 'rgba(240, 140, 140, 0.35)';
    for (const sgn of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(cx + sgn * 62, top + 78, 13, 8, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(30, 60, 25, 0.7)';
    for (const sgn of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(cx + sgn * 9, top + 45, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(30, 65, 25, 0.85)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - 58, top + 66);
    ctx.quadraticCurveTo(cx, top + 92 - squint * 6, cx + 58, top + 66);
    ctx.stroke();

    // 体のつや
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, gy - 10, 112, Math.PI * 1.12, Math.PI * 1.3);
    ctx.stroke();

    // 目（頭の上に出っぱる）。しずくの方を少し見上げる
    drawEye(cx - 50, top + 10, squint, 3);
    drawEye(cx + 50, top + 10, squint, -3);
    ctx.restore();
  }

  function eyeSquint() {
    let s = 0;
    if (actx) {
      const age = audioNow() - hitAt;
      if (age >= 0 && age < 1.5) s = hitPeak * (age < 0.05 ? age / 0.05 : Math.exp(-(age - 0.05) / 0.18));
    }
    // ときどきまばたき
    const t = performance.now() / 1000;
    if (t > blinkAt) {
      const b = t - blinkAt;
      if (b < 0.16) s = Math.max(s, Math.sin(b / 0.16 * Math.PI));
      else blinkAt = t + 3 + Math.random() * 5;
    }
    return Math.max(s, forcedSquint);
  }

  function dropProgress() {
    if (running && actx && nextSpawnT > lastSpawnT) {
      return Math.min(1, Math.max(0, (audioNow() - lastSpawnT) / (nextSpawnT - lastSpawnT)));
    }
    return 0.3;
  }

  let forcedSquint = 0;   // 確認用（?squint=0.6）
  function draw(dt) {
    const prog = dropProgress();
    updateLeaf(dt, prog);
    updatePuddle(dt);
    drawBackground();
    ctx.setTransform(view.s, 0, 0, view.s, view.ox, view.oy);
    drawPuddle();
    drawFrog(eyeSquint());
    drawWater();
    drawLeaf(prog);
    drawGrass();
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
    const m = Math.floor(playSec / 60), sec = Math.floor(playSec % 60);
    $('status').textContent = `しずく ${dropCount}滴 ・ 経過 ${m}:${String(sec).padStart(2, '0')}`;
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
    lastSpawnT = audioNow();
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
  $('reset').onclick = () => { sim.reset(); playSec = 0; dropCount = 0; };
  const panel = $('panel');
  function closePanel() {
    panel.style.transition = 'transform 0.2s ease-out, opacity 0.2s ease-out';
    panel.style.transform = 'translateX(-110%)';
    panel.style.opacity = '0';
    setTimeout(() => {
      panel.classList.add('hidden');
      panel.style.transition = panel.style.transform = panel.style.opacity = '';
    }, 200);
  }
  $('hide').onclick = closePanel;

  // 左へスワイプして閉じる（スライダー・セレクトの操作中は除く）
  let swipe = null;
  panel.addEventListener('pointerdown', (e) => {
    if (e.target.closest('input, select')) return;
    swipe = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, active: false };
  });
  panel.addEventListener('pointermove', (e) => {
    if (!swipe || e.pointerId !== swipe.id) return;
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
    if (!swipe.active) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        swipe.active = true;
        panel.setPointerCapture(e.pointerId);
      } else if (Math.abs(dy) > 10) { swipe = null; return; }
      else return;
    }
    swipe.dx = Math.min(0, dx);
    panel.style.transition = 'none';
    panel.style.transform = `translateX(${swipe.dx}px)`;
    panel.style.opacity = String(Math.max(0.2, 1 + swipe.dx / 250));
  });
  const endSwipe = (e) => {
    if (!swipe || e.pointerId !== swipe.id) return;
    const sw = swipe;
    swipe = null;
    if (!sw.active) return;
    // スワイプ後に指を離した位置のボタンが押されないようにする
    const block = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
    addEventListener('click', block, { capture: true, once: true });
    setTimeout(() => removeEventListener('click', block, { capture: true }), 50);
    if (sw.dx < -60) closePanel();
    else {
      panel.style.transition = 'transform 0.15s, opacity 0.15s';
      panel.style.transform = '';
      panel.style.opacity = '';
    }
  };
  panel.addEventListener('pointerup', endSwipe);
  panel.addEventListener('pointercancel', endSwipe);
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
    const dt = Math.min(0.1, (ts - last) / 1000);
    last = ts;
    acc += dt;
    if (running) playSec += dt;
    let steps = 0;
    while (acc >= 1 / STEP_HZ && steps < 8) { sim.step(); acc -= 1 / STEP_HZ; steps++; }
    if (steps === 8) acc = 0;
    sim.manage(MAX_PARTICLES);
    sim.soak(0.0015, frog.cx, Math.max(140, puddle.rx));
    processSpawns();
    draw(dt);
    updateDots();
    updateStatus();
    requestAnimationFrame(frame);
  }

  initWorld();
  buildDots();
  const qs = new URLSearchParams(location.search);
  if (qs.has('bpm')) setBpm(+qs.get('bpm'));
  if (qs.has('squint')) forcedSquint = +qs.get('squint');
  if (qs.has('autostart')) toggle();
  if (qs.has('prefill')) {   // 確認用: 指定秒数ぶんしずくを落とした状態から始める
    const per = Math.round(STEP_HZ * 60 / bpm);
    for (let s = 0; s < STEP_HZ * +qs.get('prefill'); s++) {
      if (s % per === 0) sim.spawnDrop(frog.cx, spawnY(), dropSize, SPAWN_VY);
      sim.step();
      if (s % 3 === 0) { sim.manage(MAX_PARTICLES); sim.soak(0.0015, frog.cx, Math.max(140, puddle.rx)); }
    }
    playSec = +qs.get('prefill');
    for (let k = 0; k < 20; k++) updatePuddle(0.2);
  }
  requestAnimationFrame(frame);
})();
