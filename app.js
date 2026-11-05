// メトロノームの本体: 音・拍のスケジューリング・水の描画・UI。
// 景色（しずくの出どころ・水が当たる物体・背景）は scene-*.js のシーンが担当し、切り替えられる。
(() => {
  'use strict';

  const H = 720;             // ワールドの高さ（幅は画面比率から決める）
  const STEP_HZ = 180;       // 物理のサブステップ / 秒
  const MAX_PARTICLES = 2000;
  const FS = 0.7;            // 水描画用フィールドの解像度倍率
  const SPAWN_VY = 0.5;      // しずくが離れるときの初速

  const $ = (id) => document.getElementById(id);

  // ---------- 言語（日本語 / 英語） ----------
  const I18N = {
    ja: {
      title: 'しずくメトロノーム', tap: 'タップ', scene: 'シーン', sceneGlass: 'グラスと天井', sceneFrog: 'カエルと葉っぱ',
      beats: '拍子', beatsNone: 'なし', beatsN: '{n}拍', dropSize: 'しずくの大きさ', volume: '音量',
      reset: '最初からやり直す', hint: 'Space: スタート/ストップ　↑↓: BPM　T: タップ',
      close: 'メニューを閉じる', open: 'メニューを開く', start: '▶ スタート', stop: '■ ストップ',
      status: 'しずく {n}滴 ・ 経過 {time}',
      glassUnder: 'グラスは水の底に…', floorWater: '床の水 {n}mm', overflowing: 'あふれています', glassFill: 'グラス {n}%',
    },
    en: {
      title: 'Drip Metronome', tap: 'Tap', scene: 'Scene', sceneGlass: 'Glass & ceiling', sceneFrog: 'Frog & leaf',
      beats: 'Beats', beatsNone: 'None', beatsN: '{n} beats', dropSize: 'Drop size', volume: 'Volume',
      reset: 'Start over', hint: 'Space: start/stop　↑↓: BPM　T: tap',
      close: 'Close menu', open: 'Open menu', start: '▶ Start', stop: '■ Stop',
      status: '{n} drops · {time}',
      glassUnder: 'The glass is under water…', floorWater: 'Floor water {n}mm', overflowing: 'Overflowing', glassFill: 'Glass {n}%',
    },
  };
  let lang = 'ja';
  const t = (key, params = {}) => (I18N[lang][key] || key).replace(/\{(\w+)\}/g, (_, k) => params[k]);

  function applyLang(l) {
    lang = I18N[l] ? l : 'ja';
    document.documentElement.lang = lang;
    document.title = t('title');
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n, { n: el.dataset.n });
    for (const el of document.querySelectorAll('[data-i18n-label]')) {
      el.title = t(el.dataset.i18nLabel);
      el.setAttribute('aria-label', el.title);
    }
    $('lang').setAttribute('aria-checked', String(lang === 'en'));
    updatePlayLabel();
    statusTimer = -1;
    try { localStorage.setItem('metronome.lang', lang); } catch (e) { /* 保存できなくても動作は続ける */ }
  }
  const canvas = $('c');
  const ctx = canvas.getContext('2d');

  // ---------- 状態 ----------
  let bpm = 90, beatsPerBar = 4, dropSize = 5, volume = 0.7;
  let running = false;
  let W, sim, scene;
  let playSec = 0, dropCount = 0;
  let lastSpawnT = 0, nextSpawnT = 0;
  const view = { s: 1, ox: 0, oy: 0, dpr: 1 };

  // シーンから使う窓口
  const app = {
    ctx, canvas, H, view,
    get W() { return W; },
    get dropSize() { return dropSize; },
    get running() { return running; },
    hasAudio: () => !!actx,
    t: (key, params) => t(key, params),
    screenTop: () => -view.oy / view.s,   // 画面の上端のワールド y 座標
    audioNow: () => (actx ? audioNow() : 0),
  };

  // ---------- ワールド ----------
  function initWorld() {
    const aspect = innerWidth / innerHeight;
    W = Math.round(Math.min(1680, Math.max(720, H * aspect)));
    const cfg = scene.init(W);
    sim = new FluidSim.Sim({ W, H, floorY: cfg.floorY, table: cfg.table || null, body: cfg.body, cap: 4000, params: cfg.params || {} });
    scene.attach(sim);
    resize();
  }

  function setScene(name) {
    if (!window.Scenes[name]) name = 'glass';
    scene = window.Scenes[name](app);
    initWorld();
    $('scene').value = name;
    try { localStorage.setItem('metronome.scene', name); } catch (e) { /* 保存できなくても動作は続ける */ }
    if (actx) rescheduleFrom();
  }

  function resize() {
    view.dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(innerWidth * view.dpr);
    canvas.height = Math.round(innerHeight * view.dpr);
    view.s = Math.min(canvas.width / W, canvas.height / H);
    view.ox = (canvas.width - W * view.s) / 2;
    view.oy = canvas.height - H * view.s;   // 地面・床が画面の下端に来るように下揃え
    // 下揃えで画面の上に余白ができる分も、しずくが見えるように水の描画範囲に含める
    const top = Math.floor(Math.min(0, -view.oy / view.s));
    if (sim && (top !== fieldTop || !fCan)) { fieldTop = top; setupField(); }
  }
  addEventListener('resize', resize);

  const toWorld = (e) => [
    (e.clientX * view.dpr - view.ox) / view.s,
    (e.clientY * view.dpr - view.oy) / view.s,
  ];
  canvas.addEventListener('pointerdown', (e) => {
    if (scene.click) scene.click(...toWorld(e));
  });
  canvas.addEventListener('pointermove', (e) => {
    canvas.style.cursor = scene.hitTest && scene.hitTest(...toWorld(e)) ? 'pointer' : '';
  });

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
  // beats: 音を鳴らす時刻（=着水時刻）。しずくは落下時間を逆算して早めに離す。
  let beats = [], nextBeatTime = 0, beatCounter = 0;
  const audioNow = () => actx.currentTime - (actx.outputLatency || actx.baseLatency || 0);

  function fallSeconds() {
    return sim.predictFall(scene.spawnY(), SPAWN_VY, surfaceY() - 2) / STEP_HZ;
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

  // BPM・シーン変更や開始時に、まだしずくを離していない拍を組み直す
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
        playDrop(Math.max(b.time + (actx.currentTime - now), actx.currentTime), b.accent, scene.pitch());
        b.sounded = true;
      }
    }
    beats = beats.filter((b) => !(b.time < now - 1 && (b.sounded || b.skip)));
  }, 25);

  function processSpawns() {
    if (!actx) return;
    const now = audioNow();
    const y0 = scene.spawnY();
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
      sim.spawnDrop(scene.spawnX, st.y, dropSize, st.v);
      lastSpawnT = now;
    }
    // 着水の瞬間をシーンに知らせる（カエルが目を細める など）
    for (const b of beats) {
      if (b.sounded && !b.hit && b.time <= now) {
        b.hit = true;
        dropCount++;
        scene.onHit(b);
      }
    }
  }

  // しずくが落ちる真下の水面の高さ（落下中のしずくは除外）
  const ysBuf = [];
  function surfaceY() {
    const { x, y, vy, n } = sim;
    const [y0, y1] = scene.surfaceRange();
    const sx = scene.spawnX;
    ysBuf.length = 0;
    for (let i = 0; i < n; i++) {
      if (Math.abs(x[i] - sx) < 9 && vy[i] < 1.0 && y[i] > y0 && y[i] < y1) ysBuf.push(y[i]);
    }
    let s;
    if (ysBuf.length >= 3) { ysBuf.sort((a, b) => a - b); s = ysBuf[2] - sim.pr; }
    else s = scene.defaultSurface();
    return Math.min(s, sim.baseY);
  }

  // 次のしずくが離れるまでの進み具合（0〜1）。しずくがふくらむアニメーションに使う
  let forcedProg = -1;   // 確認用（?prog=0.8）
  function dropProgress() {
    if (forcedProg >= 0) return forcedProg;
    if (running && actx && nextSpawnT > lastSpawnT) {
      return Math.min(1, Math.max(0, (audioNow() - lastSpawnT) / (nextSpawnT - lastSpawnT)));
    }
    return 0.3;
  }

  // ---------- 水の描画 ----------
  let fw, fh, fCan, fCtx, oCan, oCtx, outImg, sprite, spriteR, rowCol;
  let fieldTop = 0;   // 水の描画範囲の上端（ワールド y）
  function setupField() {
    fw = Math.ceil(W * FS); fh = Math.ceil((H - fieldTop) * FS);
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

    // 行ごとの水の色（シーンの配色で、下ほど濃い）
    const { top, bottom } = scene.water;
    rowCol = new Uint8Array(fh * 3);
    for (let r = 0; r < fh; r++) {
      const t = r / fh;
      for (let k = 0; k < 3; k++) rowCol[r * 3 + k] = top[k] + (bottom[k] - top[k]) * t;
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
      let cy = (y[i] - fieldTop) * FS;
      if (cy < -2 * spriteR || cy > fh + spriteR) continue;
      // 周りに粒子が少ない（しぶき・しずく）ほど小さく描いて、ボール感を減らす
      const d = Math.min(1, rho[i] / rho0);
      const size = 0.65 + 0.4 * d;
      let a = size, b = size, c = 1, s = 0;
      const custom = scene.sprite(i, size);
      if (custom === false) continue;
      if (custom) {
        a = custom.a; b = custom.b;
        if (custom.y !== undefined) cy = (custom.y - fieldTop) * FS;
      } else if (onFloor[i]) {
        a = size * 2.0; b = size * 0.5;   // 床の水は横に平たく
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
    if (scene.drawPool && sim.baseY < H) {
      fCtx.fillStyle = '#fff';
      fCtx.fillRect(0, (sim.baseY - fieldTop) * FS, fw, (H - sim.baseY) * FS + 2);
    }

    const src = fCtx.getImageData(0, 0, fw, fh).data;
    const dst = outImg.data;
    const T = 95, E = 22, F = 25;   // しきい値・縁の幅・アンチエイリアス幅
    const [er, eg, eb] = scene.water.edge, ia = scene.water.alpha, ea = scene.water.edgeAlpha;
    for (let r = 0, i = 0; r < fh; r++) {
      const cr = rowCol[r * 3], cg = rowCol[r * 3 + 1], cb = rowCol[r * 3 + 2];
      for (let c = 0; c < fw; c++, i += 4) {
        const a = src[i + 3];
        if (a < T - F) { dst[i + 3] = 0; continue; }
        if (a < T + E) {
          // 縁から内部の色へなめらかに
          const t = a < T ? 0 : (a - T) / E;
          dst[i] = er + (cr - er) * t; dst[i + 1] = eg + (cg - eg) * t; dst[i + 2] = eb + (cb - eb) * t;
          dst[i + 3] = a < T ? ea * (a - (T - F)) / F : ea + (ia - ea) * t;
        } else {
          dst[i] = cr; dst[i + 1] = cg; dst[i + 2] = cb; dst[i + 3] = ia;
        }
      }
    }
    oCtx.putImageData(outImg, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(oCan, 0, fieldTop, fw / FS, fh / FS);
  }

  function draw(dt) {
    const prog = dropProgress();
    scene.update(dt, prog);
    scene.drawBack(prog);
    ctx.setTransform(view.s, 0, 0, view.s, view.ox, view.oy);
    drawWater();
    scene.drawFront(prog);
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
    if (++statusTimer % 10 && statusTimer > 0) return;
    const m = Math.floor(playSec / 60), sec = Math.floor(playSec % 60);
    const extra = scene.status();
    const base = t('status', { n: dropCount, time: `${m}:${String(sec).padStart(2, '0')}` });
    $('status').textContent = extra ? `${extra} ・ ${base}` : base;
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
    updatePlayLabel();
    rescheduleFrom();
  }

  function updatePlayLabel() {
    $('play').textContent = running ? t('stop') : t('start');
    $('play').classList.toggle('on', running);
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
  $('scene').onchange = (e) => setScene(e.target.value);
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
  $('reset').onclick = () => { sim.reset(); scene.onReset(); playSec = 0; dropCount = 0; };
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
  $('lang').onclick = () => applyLang(lang === 'ja' ? 'en' : 'ja');

  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); toggle(); }
    else if (e.code === 'ArrowUp') { e.preventDefault(); setBpm(bpm + (e.shiftKey ? 10 : 1)); }
    else if (e.code === 'ArrowDown') { e.preventDefault(); setBpm(bpm - (e.shiftKey ? 10 : 1)); }
    else if (e.code === 'KeyT') tap();
  });

  // ---------- メインループ ----------
  function physicsStep() {
    if (scene.substep) scene.substep(1 / STEP_HZ);
    sim.step();
  }

  let last = performance.now(), acc = 0;
  function frame(ts) {
    const dt = Math.min(0.1, (ts - last) / 1000);
    last = ts;
    acc += dt;
    if (running) playSec += dt;
    let steps = 0;
    while (acc >= 1 / STEP_HZ && steps < 8) { physicsStep(); acc -= 1 / STEP_HZ; steps++; }
    if (steps === 8) acc = 0;
    sim.manage(MAX_PARTICLES);
    if (scene.afterPhysics) scene.afterPhysics();
    processSpawns();
    draw(dt);
    updateDots();
    updateStatus();
    requestAnimationFrame(frame);
  }

  const qs = new URLSearchParams(location.search);
  let saved = null, savedLang = null;
  try {
    saved = localStorage.getItem('metronome.scene');
    savedLang = localStorage.getItem('metronome.lang');
  } catch (e) { /* 読めなければ既定値 */ }
  applyLang(qs.get('lang') || savedLang || ((navigator.language || '').startsWith('ja') ? 'ja' : 'en'));
  setScene(qs.get('scene') || saved || 'glass');
  buildDots();
  if (qs.has('bpm')) setBpm(+qs.get('bpm'));
  if (qs.has('prog')) forcedProg = +qs.get('prog');
  if (qs.has('autostart')) toggle();
  if (qs.has('prefill')) {   // 確認用: 指定秒数ぶんしずくを落とした状態から始める
    const per = Math.round(STEP_HZ * 60 / bpm);
    for (let s = 0; s < STEP_HZ * +qs.get('prefill'); s++) {
      if (s % per === 0) sim.spawnDrop(scene.spawnX, scene.spawnY(), dropSize, SPAWN_VY);
      physicsStep();
      if (s % 3 === 0) { sim.manage(MAX_PARTICLES); if (scene.afterPhysics) scene.afterPhysics(); }
    }
    playSec = +qs.get('prefill');
    scene.prefillDone();
  }
  // 確認用: グラスを揺らしてから指定秒数（?wobble=0.15）進めた状態を表示する
  if (qs.has('wobble') && scene.click) {
    scene.click(scene.spawnX - 40, H - 300);
    for (let s = 0; s < STEP_HZ * +qs.get('wobble'); s++) physicsStep();
  }
  requestAnimationFrame(frame);
})();
