// シーン「カエル」: 雨上がりの野原。頭上の葉っぱの先からしずくが落ち、カエルの頭に当たるたびに目を細める
(function () {
  'use strict';
  window.Scenes = window.Scenes || {};

  window.Scenes.frog = function (app) {
    const { ctx, H } = app;
    const view = app.view;
    const GROUND_Y = 600;      // カエルが座っている地面
    const LEAF_TIP_Y = 170;    // しずくが落ちる直前の葉先の高さ
    const LEAF_DROOP = 0.05;   // しずくの重みで葉がしなる角度（rad）
    const PUDDLE_MAX = 330;    // 水たまりの最大半径

    let W, frog, leaf, scenery, sim;
    let hitAt = -10, hitPeak = 0;      // 頭に当たった時刻（目を細める演出用）
    let blinkAt = 3;                   // 次のまばたき（performance 秒）
    let forcedSquint = 0;              // 確認用（?squint=0.6）
    const puddle = { rx: 0, ripples: [] };   // カエルの周りの水たまり（地面の水の量で大きさが決まる）

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

    // ---------- 背景 ----------
    function drawBackground() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const cw = app.canvas.width, ch = app.canvas.height;
      const sky = ctx.createLinearGradient(0, 0, 0, ch);
      sky.addColorStop(0, '#9fc4d6');
      sky.addColorStop(0.6, '#dbe8dc');
      sky.addColorStop(1, '#e9efd9');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, cw, ch);

      ctx.setTransform(view.s, 0, 0, view.s, view.ox, view.oy);
      const t = performance.now() / 1000;
      const x0 = -view.ox / view.s, x1 = (app.canvas.width - view.ox) / view.s, top = -view.oy / view.s;

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
      const r = (3 + app.dropSize * 0.55) * (0.3 + 0.7 * prog);
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
      if (app.hasAudio()) {
        const age = app.audioNow() - hitAt;
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


    return {
      // 明るい屋外なので淡い水色、縁は濃いめ
      water: { top: [185, 225, 250], bottom: [135, 190, 235], edge: [70, 135, 200], alpha: 160, edgeAlpha: 200 },

      init(w) {
        W = w;
        frog = FluidSim.makeFrog(W / 2, GROUND_Y);
        // 葉っぱ: 付け根を軸に回転する。しなりきったとき葉先がカエルの真上に来る
        const px = W / 2 - 175, py = 72;
        leaf = {
          px, py,
          len: Math.hypot(W / 2 - px, LEAF_TIP_Y - py),
          full: Math.atan2(LEAF_TIP_Y - py, W / 2 - px),
          angle: 0, vel: 0,
        };
        leaf.angle = leaf.full - LEAF_DROOP * 0.7;
        puddle.rx = 0;
        puddle.ripples = [];
        buildScenery();
        const qs = new URLSearchParams(location.search);
        if (qs.has('squint')) forcedSquint = +qs.get('squint');
        return { body: frog, floorY: GROUND_Y, params: { topLimit: GROUND_Y - 25 } };
      },
      attach(s) { sim = s; },

      get spawnX() { return frog.cx; },
      // 先頭の粒子の出現位置。しずくの上端が葉先に来るようにする
      spawnY() { return LEAF_TIP_Y + 3 + 4.2 * (app.dropSize - 1); },
      surfaceRange() { return [LEAF_TIP_Y + 40, frog.headTopY + 10]; },
      defaultSurface() { return frog.headTopY - sim.pr - 3; },

      // 地面に着いた水は粒子ではなく水たまりとして描く
      sprite(i) { return sim.onFloor[i] && sim.y[i] > GROUND_Y - 10 ? false : null; },

      afterPhysics() { sim.soak(0.0015, frog.cx, Math.max(140, puddle.rx)); },

      update(dt, prog) {
        updateLeaf(dt, prog);
        updatePuddle(dt);
      },
      drawBack() {
        drawBackground();
        ctx.setTransform(view.s, 0, 0, view.s, view.ox, view.oy);
        drawPuddle();
        drawFrog(eyeSquint());
      },
      drawFront(prog) {
        drawLeaf(prog);
        drawGrass();
      },

      onHit(b) {
        hitAt = b.time;
        hitPeak = b.accent ? 0.75 : 0.5;
        addRipples();
      },
      pitch() { return 640; },
      status() { return ''; },
      onReset() { puddle.rx = 0; puddle.ripples = []; },
      prefillDone() { for (let k = 0; k < 20; k++) updatePuddle(0.2); },
    };
  };
})();
