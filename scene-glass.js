// シーン「グラス」: 部屋の丸テーブルに置いたワイングラス。天井にしずくができて落ち、
// グラスにたまってあふれ、テーブルからこぼれた水が床から部屋を満たしていく。
// グラスはクリックすると揺れ、その動きが中の水に伝わる。
(function () {
  'use strict';
  window.Scenes = window.Scenes || {};

  window.Scenes.glass = function (app) {
    const { ctx, H } = app;
    const view = app.view;
    const DESK_Y = 585;        // テーブル天板の高さ
    const TABLE_THICK = 22;    // 天板の厚み
    // 天井の面は画面の上端のすぐ下（薄い天井が見えるだけ）。画面の縦横比で高さが変わる
    const ceilY = () => app.screenTop() + 14;
    const FLOOR_Y = H + 60;    // 床は画面の外。こぼれた水はここに溜まり、やがて画面下からせり上がる
    // 揺れ: 台座を軸にしたばね。約 2.2Hz で、数回揺れて止まる
    const WOBBLE_W = 2 * Math.PI * 2.2, WOBBLE_DAMP = 0.07, WOBBLE_MAX_V = 1.8;

    let W, glass, table, tableRy, sim, bowlCapacity;
    const wobble = { angle: 0, vel: 0 };

    // ---------- 背景・天井 ----------
    function drawBackground() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const cw = app.canvas.width, ch = app.canvas.height;
      const gcx = view.ox + glass.cx * view.s, gcy = view.oy + glass.bottomY * view.s;
      const bg = ctx.createRadialGradient(gcx, gcy, 0, gcx, gcy, Math.max(cw, ch) * 0.8);
      bg.addColorStop(0, '#2c3d57');
      bg.addColorStop(1, '#0b1017');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, cw, ch);
    }

    function drawCeiling() {
      const CEIL_Y = ceilY();
      const top = app.screenTop() - 2;
      const x0 = -view.ox / view.s - 2, x1 = (app.canvas.width - view.ox) / view.s + 2;
      const g = ctx.createLinearGradient(0, top, 0, CEIL_Y);
      g.addColorStop(0, '#2a303a');
      g.addColorStop(1, '#3d4552');
      ctx.fillStyle = g;
      ctx.fillRect(x0, top, x1 - x0, CEIL_Y - top);
      // 天井の縁と、しずくが染み出すしみ
      ctx.fillStyle = 'rgba(200, 215, 235, 0.18)';
      ctx.fillRect(x0, CEIL_Y - 1.5, x1 - x0, 1.5);
      const st = ctx.createRadialGradient(glass.cx, CEIL_Y, 0, glass.cx, CEIL_Y, 70);
      st.addColorStop(0, 'rgba(15, 20, 28, 0.55)');
      st.addColorStop(1, 'rgba(15, 20, 28, 0)');
      ctx.fillStyle = st;
      ctx.beginPath();
      ctx.ellipse(glass.cx, CEIL_Y - 4, 70, 14, 0, Math.PI, Math.PI * 2);
      ctx.fill();
      // 細いひび
      ctx.strokeStyle = 'rgba(10, 14, 20, 0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(glass.cx - 60, CEIL_Y - 9);
      ctx.lineTo(glass.cx - 25, CEIL_Y - 5);
      ctx.lineTo(glass.cx - 4, CEIL_Y - 2);
      ctx.moveTo(glass.cx - 25, CEIL_Y - 5);
      ctx.lineTo(glass.cx - 30, CEIL_Y - 14);
      ctx.stroke();
    }

    // 天井の平らな面から、薄い水の膜 → ふくらみ → くびれ → 重みで落ちる直前、と育つしずく
    function drawCeilingDrop(prog) {
      const cx = glass.cx, c0 = ceilY();
      const rmax = 3 + app.dropSize * 0.55;
      ctx.beginPath();
      if (prog < 0.45) {
        // 膜が少しずつ盛り上がる
        const q = prog / 0.45;
        ctx.ellipse(cx, c0, 5 + 9 * q, 1 + rmax * 0.9 * q, 0, 0, Math.PI);
      } else {
        // 玉が垂れ下がり、首が細くなっていく
        const q = (prog - 0.45) / 0.55;
        const r = rmax * (0.85 + 0.15 * q);
        const base = 14 - 4 * q;
        const by = c0 + rmax * 0.9 + rmax * 1.5 * q * q;
        const neck = r * (0.95 - 0.8 * q);
        const gam = Math.acos(Math.min(1, neck / r));
        const jy = by - r * Math.sin(gam);
        ctx.moveTo(cx - base, c0);
        ctx.quadraticCurveTo(cx - neck * 0.9, (c0 + jy) / 2, cx - neck, jy);
        ctx.arc(cx, by, r, Math.PI + gam, -gam, true);
        ctx.quadraticCurveTo(cx + neck * 0.9, (c0 + jy) / 2, cx + base, c0);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(120, 185, 245, 0.85)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(210, 238, 255, 0.75)';
      ctx.lineWidth = 1;
      ctx.stroke();
      if (prog >= 0.45) {
        const q = (prog - 0.45) / 0.55;
        const r = rmax * (0.85 + 0.15 * q), by = c0 + rmax * 0.9 + rmax * 1.5 * q * q;
        ctx.beginPath();
        ctx.arc(cx - r * 0.35, by - r * 0.3, Math.max(0.8, r * 0.2), 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.fill();
      }
    }

    // ---------- テーブル ----------
    // 一本脚の丸テーブル（天板は斜め上から見た楕円）。床は画面外で、天板と脚の首だけ見せる
    function drawTable() {
      const { cx, rx } = table;
      const TABLE_RY = tableRy;
      const top = DESK_Y, bot = DESK_Y + TABLE_THICK;

      const sh = ctx.createRadialGradient(cx, bot + TABLE_RY, 0, cx, bot + TABLE_RY, rx);
      sh.addColorStop(0, 'rgba(0,0,0,0.5)');
      sh.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = sh;
      ctx.fillRect(cx - rx, bot, rx * 2, H - bot + 20);

      const lg = ctx.createLinearGradient(cx - 30, 0, cx + 30, 0);
      lg.addColorStop(0, '#3a2213'); lg.addColorStop(0.35, '#8a5732'); lg.addColorStop(1, '#2a180c');
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.moveTo(cx - 70, bot + TABLE_RY - 8);
      ctx.quadraticCurveTo(cx - 26, bot + TABLE_RY + 4, cx - 24, bot + TABLE_RY + 40);
      ctx.lineTo(cx - 24, H + 20);
      ctx.lineTo(cx + 24, H + 20);
      ctx.lineTo(cx + 24, bot + TABLE_RY + 40);
      ctx.quadraticCurveTo(cx + 26, bot + TABLE_RY + 4, cx + 70, bot + TABLE_RY - 8);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(30, 16, 8, 0.6)';
      ctx.fillRect(cx - 25, bot + TABLE_RY + 52, 50, 4);
      ctx.fillStyle = 'rgba(255, 210, 160, 0.12)';
      ctx.fillRect(cx - 25, bot + TABLE_RY + 56, 50, 2);

      const eg = ctx.createLinearGradient(cx - rx, 0, cx + rx, 0);
      eg.addColorStop(0, '#3a2213'); eg.addColorStop(0.35, '#6b3f22'); eg.addColorStop(1, '#2c190c');
      ctx.fillStyle = eg;
      ctx.beginPath();
      ctx.ellipse(cx, top, rx, TABLE_RY, 0, Math.PI, 0, true);
      ctx.lineTo(cx + rx, bot);
      ctx.ellipse(cx, bot, rx, TABLE_RY, 0, 0, Math.PI, false);
      ctx.closePath();
      ctx.fill();

      const tg = ctx.createRadialGradient(cx - rx * 0.3, top - TABLE_RY * 0.5, 0, cx, top, rx * 1.1);
      tg.addColorStop(0, '#a8703f'); tg.addColorStop(0.6, '#8a5530'); tg.addColorStop(1, '#5e3519');
      ctx.fillStyle = tg;
      ctx.beginPath();
      ctx.ellipse(cx, top, rx, TABLE_RY, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(60, 30, 10, 0.18)';
      ctx.lineWidth = 1;
      for (let k = 1; k <= 4; k++) {
        ctx.beginPath();
        ctx.ellipse(cx + 6 * k, top + 1, rx * (0.2 * k), TABLE_RY * (0.2 * k), 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.ellipse(cx, top, rx, TABLE_RY, 0, 0.05 * Math.PI, 0.95 * Math.PI);
      ctx.strokeStyle = 'rgba(255, 215, 170, 0.35)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // ---------- グラス（傾きを反映して描く） ----------
    function withTilt(fn) {
      ctx.save();
      ctx.translate(glass.pivotX, glass.pivotY);
      ctx.rotate(wobble.angle);
      ctx.translate(-glass.pivotX, -glass.pivotY);
      fn();
      ctx.restore();
    }

    function bowlPath() {
      ctx.beginPath();
      const L = glass.left, R = glass.right;
      ctx.moveTo(L[L.length - 1][0], L[L.length - 1][1]);
      for (let i = L.length - 2; i >= 0; i--) ctx.lineTo(L[i][0], L[i][1]);
      for (let i = 1; i < R.length; i++) ctx.lineTo(R[i][0], R[i][1]);
    }

    function drawGlassBack() {
      withTilt(() => {
        bowlPath();
        ctx.closePath();
        ctx.fillStyle = 'rgba(200, 230, 255, 0.06)';
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(glass.cx, glass.rimY, glass.rimHW, 7, 0, Math.PI, Math.PI * 2);
        ctx.strokeStyle = 'rgba(220, 240, 255, 0.3)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });
    }

    function drawGlassFront() {
      withTilt(() => {
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
      });
    }

    return {
      water: { top: [70, 165, 245], bottom: [30, 105, 200], edge: [200, 235, 255], alpha: 150, edgeAlpha: 210 },
      drawPool: true,

      init(w) {
        W = w;
        const rx = Math.round(Math.min(560, W * 0.44));
        tableRy = Math.round(rx * 0.12);
        table = { cx: W / 2, rx, x0: W / 2 - rx, x1: W / 2 + rx, top: DESK_Y, bottom: DESK_Y + TABLE_THICK };
        glass = FluidSim.makeGlass(W / 2, DESK_Y);
        wobble.angle = wobble.vel = 0;
        return { body: glass, floorY: FLOOR_Y, table, params: { killY: H + 10, topLimit: 100 } };
      },
      attach(s) {
        sim = s;
        bowlCapacity = glass.area / sim.areaPer;
      },

      get spawnX() { return glass.cx; },
      // しずくが離れる瞬間の先頭（一番下）の粒子の位置
      spawnY() {
        const rmax = 3 + app.dropSize * 0.55, c = ceilY();
        return Math.max(c + rmax * 3.3, c + 2 + 4.2 * (app.dropSize - 1));
      },
      surfaceRange() { return [ceilY() + 60, H]; },
      defaultSurface() { return glass.bottomY - sim.pr - 1.5; },

      // テーブルの上の水: 奥行き方向に縦長に伸ばして、楕円の天板に沿った一枚の水たまりに見せる（見た目だけ）
      sprite(i, size) {
        const u = (sim.x[i] - table.cx) / table.rx;
        if (sim.baseY > DESK_Y && sim.y[i] > DESK_Y - 14 && sim.y[i] < DESK_Y && Math.abs(u) < 1) {
          const depth = tableRy * 0.8 * Math.sqrt(1 - u * u) * (0.55 + 0.45 * sim.seed[i]);
          return { a: size * 1.6, b: Math.max(size * 0.8, depth / 7), y: DESK_Y + (sim.seed[i] - 0.5) * depth * 0.3 };
        }
        return null;
      },

      // 揺れ（物理のサブステップごと）。グラスの壁が動くので中の水が揺さぶられる
      substep(dt) {
        if (wobble.angle === 0 && wobble.vel === 0) return;
        wobble.vel += (-WOBBLE_W * WOBBLE_W * wobble.angle - 2 * WOBBLE_DAMP * WOBBLE_W * wobble.vel) * dt;
        wobble.angle += wobble.vel * dt;
        if (Math.abs(wobble.angle) < 1e-4 && Math.abs(wobble.vel) < 1e-3) wobble.angle = wobble.vel = 0;
        glass.setAngle(wobble.angle, wobble.vel * dt);
      },
      // グラスをクリックすると、押した側と反対へ揺れる
      click(wx, wy) {
        const [lx, ly] = glass.toLocal(wx, wy);
        if (Math.abs(lx - glass.cx) > glass.R + 30 || ly < glass.rimY - 30 || ly > glass.deskY + 10) return false;
        const dir = lx < glass.cx ? 1 : -1;
        wobble.vel = Math.max(-WOBBLE_MAX_V, Math.min(WOBBLE_MAX_V, wobble.vel + dir * 1.1));
        return true;
      },
      hitTest(wx, wy) {
        const [lx, ly] = glass.toLocal(wx, wy);
        return Math.abs(lx - glass.cx) <= glass.R + 30 && ly >= glass.rimY - 30 && ly <= glass.deskY + 10;
      },

      update() {},
      drawBack() {
        drawBackground();
        ctx.setTransform(view.s, 0, 0, view.s, view.ox, view.oy);
        drawTable();
        drawGlassBack();
      },
      drawFront(prog) {
        drawGlassFront();
        drawCeiling();
        drawCeilingDrop(prog);
      },

      onHit() {},
      pitch() {
        const fill = sim.countInBowl() / bowlCapacity;
        if (sim.baseY <= glass.rimY + 6) return 420;   // グラスが水没した後
        if (fill > 0.9) return 380;                    // あふれてテーブルに落ちる音
        return 520 + 650 * Math.min(1, fill);          // 溜まるほど音が高くなる
      },
      status() {
        if (sim.baseY <= glass.rimY + 6) return app.t('glassUnder');
        if (sim.baseY < sim.floorY - 0.5) return app.t('floorWater', { n: Math.round(sim.floorY - sim.baseY) });
        const inBowl = sim.countInBowl();
        const fill = Math.min(100, Math.round(inBowl / bowlCapacity * 100));
        return fill >= 90 && sim.n - inBowl > 30 ? app.t('overflowing') : app.t('glassFill', { n: fill });
      },
      onReset() { wobble.angle = wobble.vel = 0; glass.setAngle(0); },
      prefillDone() {},
    };
  };
})();
