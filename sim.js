// 2D 粒子流体シミュレーション（Clavet et al. 2005 の double density relaxation）
// DOM に依存しないので Node からもテストできる。
(function (root) {
  'use strict';

  const DEFAULTS = {
    h: 16,        // 相互作用半径
    rho0: 3.0,    // 静止密度
    k: 0.35,      // 圧力の硬さ
    kNear: 1.6,   // 近接圧（粒子の重なり防止・表面張力っぽさ）
    g: 0.15,      // 重力 (px / substep^2)
    vmax: 3.8,      // 最大速度 (px / substep) すり抜け防止
    pr: 3,        // 粒子の衝突半径
    visc: 0.15,   // 粘性
    areaPer: 42,  // 1粒子あたりの面積（プールに変換するときの水位計算用）
    topLimit: 70, // プールの水位上限（画面上端からの距離）
    killY: Infinity, // これより下（画面外）に落ちた粒子はすぐプールに変換する
  };

  // ワイングラス。台座の中心 (cx, deskY) を軸に傾けられる（setAngle）。y は下向き。
  // 当たり判定はボウル部分だけ（ステムと台座は立体的に水が回り込めるので付けない）
  function makeGlass(cx, deskY) {
    const stemH = 150, bowlH = 150, R = 72;
    const bottomY = deskY - stemH;
    const rimY = bottomY - bowlH;
    const hwAt = (t) => {
      if (t <= 0) return 0;
      if (t >= 1) t = 1;
      if (t < 0.6) { const u = 1 - t / 0.6; return R * Math.sqrt(1 - u * u); }
      const u = (t - 0.6) / 0.4;
      return R * (1 - 0.1 * u * u);
    };
    const hwAtY = (y) => hwAt((bottomY - y) / bowlH);

    const N = 22;
    const left = [], right = [];
    for (let i = 0; i <= N; i++) {
      const t = 1 - Math.cos((i / N) * Math.PI / 2);
      const y = bottomY - t * bowlH, hw = hwAt(t);
      left.push([cx - hw, y]);
      right.push([cx + hw, y]);
    }
    // 傾けていないときの線分（ローカル座標）
    const local = [];
    for (let i = 0; i < N; i++) {
      local.push([left[i], left[i + 1]]);
      local.push([right[i], right[i + 1]]);
    }

    let area = 0;
    for (let i = 0; i < 200; i++) area += 2 * Math.max(0, hwAt((i + 0.5) / 200) - 4) * bowlH / 200;

    const g = {
      cx, deskY, bottomY, rimY, bowlH, R, stemH, hwAt, hwAtY, left, right,
      rimHW: hwAt(1), area,
      pivotX: cx, pivotY: deskY,
      angle: 0,          // 傾き（rad、正で時計回り）
      omega: 0,          // 角速度（rad / substep）。壁が水を押す速さの計算に使う
      segs: local.map(() => ({ ax: 0, ay: 0, tx: 0, ty: 0, nx: 0, ny: 0, len: 0, half: 1.5 })),
      bbox: { x0: 0, x1: 0, y0: 0, y1: 0 },
      // ワールド座標 → 傾けていないグラスの座標
      toLocal(x, y) {
        const c = Math.cos(-g.angle), s = Math.sin(-g.angle), dx = x - cx, dy = y - deskY;
        return [cx + dx * c - dy * s, deskY + dx * s + dy * c];
      },
      inBowl(x, y) {
        const [lx, ly] = g.angle ? g.toLocal(x, y) : [x, y];
        return ly > rimY && ly < bottomY && Math.abs(lx - cx) < hwAtY(ly);
      },
      // 点 (x, y) にある壁の速度（px / substep）
      velAt(x, y) { return [-g.omega * (y - deskY), g.omega * (x - cx)]; },
      setAngle(angle, omega = 0) {
        g.angle = angle; g.omega = omega;
        const c = Math.cos(angle), s = Math.sin(angle);
        const rot = (p) => [cx + (p[0] - cx) * c - (p[1] - deskY) * s, deskY + (p[0] - cx) * s + (p[1] - deskY) * c];
        let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
        for (let k = 0; k < local.length; k++) {
          const a = rot(local[k][0]), b = rot(local[k][1]);
          const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1e-6;
          const sg = g.segs[k];
          sg.ax = a[0]; sg.ay = a[1]; sg.len = len;
          sg.tx = dx / len; sg.ty = dy / len; sg.nx = -sg.ty; sg.ny = sg.tx;
          x0 = Math.min(x0, a[0], b[0]); x1 = Math.max(x1, a[0], b[0]);
          y0 = Math.min(y0, a[1], b[1]); y1 = Math.max(y1, a[1], b[1]);
        }
        g.bbox.x0 = x0 - 12; g.bbox.x1 = x1 + 12; g.bbox.y0 = y0 - 12; g.bbox.y1 = y1 + 12;
      },
    };
    g.setAngle(0);
    return g;
  }

  // カエルの体の輪郭（正面から見た姿）。y は下向き。
  // 水が当たる・流れ落ちる面だけを当たり判定にする（目の出っぱりは見た目だけ）
  function makeFrog(cx, groundY) {
    const height = 140, halfW = 110;
    // 地面からの高さ h における体の半分の幅
    const halfAt = (h) => {
      if (h <= 0) return halfW;
      if (h >= height) return 0;
      return halfW * Math.sqrt(1 - Math.pow(h / height, 3));
    };
    const N = 24;
    const left = [], right = [];
    for (let i = 0; i <= N; i++) {
      const h = height * Math.sin((i / N) * Math.PI / 2);   // 頭のてっぺん付近を細かく
      left.push([cx - halfAt(h), groundY - h]);
      right.push([cx + halfAt(h), groundY - h]);
    }
    left[N] = right[N] = [cx, groundY - height];

    const segs = [];
    const add = (a, b, half) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
      if (len < 1e-6) return;
      const tx = dx / len, ty = dy / len;
      segs.push({ ax: a[0], ay: a[1], tx, ty, nx: -ty, ny: tx, len, half });
    };
    for (let i = 0; i < N; i++) {
      add(left[i], left[i + 1], 2);
      add(right[i], right[i + 1], 2);
    }

    return {
      cx, groundY, height, halfW, halfAt, left, right, segs,
      headTopY: groundY - height,
      rimY: -Infinity,                 // 器ではないので水没判定は使わない
      inBowl() { return false; },
      bbox: { x0: cx - halfW - 12, x1: cx + halfW + 12, y0: groundY - height - 12, y1: groundY + 4 },
    };
  }

  class Sim {
    // body: 水が当たる物体（輪郭の線分 segs と、器なら inBowl / rimY を持つ）
    // table: 台の天板 { x0, x1, top, bottom }（省略可）。天板の外にこぼれた水は床 (floorY) に落ちる
    constructor({ W, H, floorY, table = null, body, cap = 4000, params = {} }) {
      Object.assign(this, DEFAULTS, params);
      this.W = W; this.H = H; this.floorY = floorY; this.table = table; this.body = body; this.cap = cap;
      this.x = new Float32Array(cap); this.y = new Float32Array(cap);
      this.px = new Float32Array(cap); this.py = new Float32Array(cap);
      this.vx = new Float32Array(cap); this.vy = new Float32Array(cap);
      this.mark = new Uint8Array(cap);
      this.wd = new Float32Array(cap); this.wnx = new Float32Array(cap); this.wny = new Float32Array(cap);
      this.buildWallTable();
      this.cnx = new Float32Array(cap); this.cny = new Float32Array(cap);  // 衝突面の法線
      this.cwv = new Float32Array(cap);   // 衝突した壁が粒子を押し出す向きの速さ（動く壁用）
      this.rho = new Float32Array(cap);      // 描画用: 周りの混み具合
      this.onFloor = new Uint8Array(cap);    // 描画用: 床に接しているか
      this.seed = new Float32Array(cap);     // 描画用: 粒子ごとの固定乱数
      this.yOff = 240;
      this.gw = Math.ceil(W / this.h) + 2;
      this.gh = Math.ceil((H + this.yOff) / this.h) + 2;
      this.cellStart = new Int32Array(this.gw * this.gh + 1);
      this.cellIdx = new Int32Array(cap);
      this.cellOf = new Int32Array(cap);
      this.nbJ = new Int32Array(512); this.nbQ = new Float32Array(512);
      this.nbUx = new Float32Array(512); this.nbUy = new Float32Array(512);
      this.reset();
    }

    // 壁の向こうに仮想粒子が並んでいるとみなした密度寄与のテーブル。
    // これが無いと壁際の密度が低く見積もられ、水が壁に吸い寄せられて這い上がる。
    buildWallTable() {
      const h = this.h, sp = 5.5, N = 64;
      this.wt = { N, step: h / N, W1: new Float32Array(N + 1), W2: new Float32Array(N + 1), N1: new Float32Array(N + 1), N2: new Float32Array(N + 1) };
      for (let a = 0; a <= N; a++) {
        const d = Math.max(0.01, a * h / N);
        for (let k = -4; k <= 4; k++) {
          const r = Math.hypot(d, k * sp), q = 1 - r / h;
          if (q <= 0) continue;
          this.wt.W1[a] += q * q; this.wt.W2[a] += q * q * q;
          this.wt.N1[a] += q * d / r; this.wt.N2[a] += q * q * d / r;
        }
      }
    }

    // 物体の壁に近い粒子について、最も近い壁面までの距離と法線を求める
    wallDistances() {
      const { n, x, y, wd, wnx, wny, h, body } = this;
      const segs = body.segs, bb = body.bbox;
      for (let i = 0; i < n; i++) {
        wd[i] = 1e9;
        const xi = x[i], yi = y[i];
        if (xi < bb.x0 - h || xi > bb.x1 + h || yi < bb.y0 - h || yi > bb.y1 + h) continue;
        for (let s = 0; s < segs.length; s++) {
          const sg = segs[s];
          const u = (xi - sg.ax) * sg.tx + (yi - sg.ay) * sg.ty;
          if (u < 0 || u > sg.len) continue;   // 線分の端点では支えない
          const dx = xi - (sg.ax + sg.tx * u), dy = yi - (sg.ay + sg.ty * u);
          const d = Math.hypot(dx, dy);
          if (d - sg.half < wd[i] && d > 1e-6) { wd[i] = d - sg.half; wnx[i] = dx / d; wny[i] = dy / d; }
        }
      }
    }

    reset() { this.n = 0; this.baseY = this.floorY; }

    add(x, y, vx, vy) {
      if (this.n >= this.cap) return;
      const i = this.n++;
      this.x[i] = x; this.y[i] = y; this.vx[i] = vx; this.vy[i] = vy;
      this.rho[i] = 0; this.onFloor[i] = 0; this.seed[i] = Math.random();
    }

    // 先頭（一番下）の粒子が (x, y) に来るように水滴を生成
    spawnDrop(x, y, count, vy) {
      for (let k = 0; k < count; k++) {
        this.add(x + (Math.random() - 0.5) * 0.8, y - k * 4.2, 0, vy);
      }
    }

    // 自由落下の予測（step() と同じ積分）
    predictFall(y0, v0, targetY) {
      let y = y0, v = v0, n = 0;
      while (y < targetY && n < 5000) { v = Math.min(v + this.g, this.vmax); y += v; n++; }
      return n;
    }
    kinematic(y0, v0, steps) {
      let y = y0, v = v0;
      for (let i = 0; i < steps; i++) { v = Math.min(v + this.g, this.vmax); y += v; }
      return { y, v };
    }

    buildGrid() {
      const { n, h, gw, gh, yOff, cellStart, cellIdx, cellOf, x, y } = this;
      cellStart.fill(0);
      for (let i = 0; i < n; i++) {
        let cx = Math.floor(x[i] / h) + 1, cy = Math.floor((y[i] + yOff) / h) + 1;
        if (cx < 1) cx = 1; else if (cx > gw - 2) cx = gw - 2;
        if (cy < 1) cy = 1; else if (cy > gh - 2) cy = gh - 2;
        const c = cy * gw + cx;
        cellOf[i] = c;
        cellStart[c + 1]++;
      }
      for (let c = 0; c < gw * gh; c++) cellStart[c + 1] += cellStart[c];
      const fillPos = this._fill || (this._fill = new Int32Array(gw * gh));
      fillPos.set(cellStart.subarray(0, gw * gh));
      for (let i = 0; i < n; i++) cellIdx[fillPos[cellOf[i]]++] = i;
    }

    // 近傍を集めて nb* 配列に格納し、件数を返す
    gather(i) {
      const { h, gw, cellStart, cellIdx, cellOf, x, y, nbJ, nbQ, nbUx, nbUy } = this;
      const h2 = h * h, xi = x[i], yi = y[i], c0 = cellOf[i];
      let cnt = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const c = c0 + oy * gw + ox;
          for (let s = cellStart[c], e = cellStart[c + 1]; s < e; s++) {
            const j = cellIdx[s];
            if (j === i) continue;
            const dx = x[j] - xi, dy = y[j] - yi, r2 = dx * dx + dy * dy;
            if (r2 >= h2 || r2 < 1e-6 || cnt >= 512) continue;
            const r = Math.sqrt(r2);
            nbJ[cnt] = j; nbQ[cnt] = 1 - r / h; nbUx[cnt] = dx / r; nbUy[cnt] = dy / r;
            cnt++;
          }
        }
      }
      return cnt;
    }

    step() {
      const n = this.n;
      if (n === 0) return;
      const { x, y, px, py, vx, vy, g } = this;

      this.buildGrid();

      // 粘性（近傍との相対速度を減衰）
      if (this.visc > 0) {
        const { nbJ, nbQ, nbUx, nbUy } = this;
        for (let i = 0; i < n; i++) {
          const cnt = this.gather(i);
          for (let a = 0; a < cnt; a++) {
            const j = nbJ[a];
            if (j < i) continue;
            const ux = nbUx[a], uy = nbUy[a];
            const u = (vx[i] - vx[j]) * ux + (vy[i] - vy[j]) * uy;
            if (u > 0) {
              const I = 0.5 * nbQ[a] * this.visc * u;
              vx[i] -= I * ux; vy[i] -= I * uy;
              vx[j] += I * ux; vy[j] += I * uy;
            }
          }
        }
      }

      for (let i = 0; i < n; i++) {
        vy[i] += g;
        px[i] = x[i]; py[i] = y[i];
        x[i] += vx[i]; y[i] += vy[i];
      }

      this.buildGrid();
      this.wallDistances();
      this.relax();
      this.collide();

      const vmax2 = this.vmax * this.vmax;
      for (let i = 0; i < n; i++) {
        let ux = x[i] - px[i], uy = y[i] - py[i];
        const s2 = ux * ux + uy * uy;
        if (s2 > vmax2) { const f = this.vmax / Math.sqrt(s2); ux *= f; uy *= f; }
        // 押し戻しで生じた「壁から離れる速度」は捨てる（壁を這い上がる現象の防止）。
        // ただし壁自体が動いて押している分（グラスを揺らしたとき）は残す
        const nx = this.cnx[i], ny = this.cny[i];
        if (nx !== 0 || ny !== 0) {
          const nl = Math.hypot(nx, ny), vn = (ux * nx + uy * ny) / nl, wv = this.cwv[i];
          if (vn > wv) { const d = vn - wv; ux -= d * nx / nl; uy -= d * ny / nl; }
        }
        vx[i] = ux; vy[i] = uy;
      }
    }

    relax() {
      const { n, x, y, k, kNear, rho0, nbJ, nbQ, nbUx, nbUy, wt } = this;
      for (let i = 0; i < n; i++) {
        const cnt = this.gather(i);
        let rho = 0, rhoN = 0;
        for (let a = 0; a < cnt; a++) { const q = nbQ[a]; rho += q * q; rhoN += q * q * q; }
        this.rho[i] = rho;
        let wa = -1;
        if (this.wd[i] < this.h) {
          wa = Math.max(0, Math.min(wt.N, Math.round(this.wd[i] / wt.step)));
          rho += wt.W1[wa]; rhoN += wt.W2[wa];
        }
        let P = k * (rho - rho0);
        if (P < 0) P *= 0.25;   // 引力（表面張力）を弱めて気泡や盛り上がりが残らないようにする
        const PN = kNear * rhoN;
        let dxi = 0, dyi = 0;
        if (wa >= 0) {
          // 壁からの押し返し（壁への吸着は起こさないよう圧力が正のときだけ）
          const push = 0.7 * (Math.max(0, P) * wt.N1[wa] + PN * wt.N2[wa]);
          dxi += push * this.wnx[i]; dyi += push * this.wny[i];
        }
        for (let a = 0; a < cnt; a++) {
          const q = nbQ[a], j = nbJ[a];
          const D = 0.5 * (P * q + PN * q * q);
          const dx = D * nbUx[a], dy = D * nbUy[a];
          x[j] += dx; y[j] += dy;
          dxi -= dx; dyi -= dy;
        }
        x[i] += dxi; y[i] += dyi;
      }
    }

    collide() {
      const { n, x, y, px, py, pr, W, body } = this;
      const segs = body.segs, bb = body.bbox, m = pr + 6;
      const submerged = this.baseY <= body.rimY + 6;
      const tb = this.table, tableDry = !!tb && this.baseY > tb.top;

      for (let i = 0; i < n; i++) {
        let xi = x[i], yi = y[i], cnx = 0, cny = 0, cwv = 0, hit = false;

        // 床（床 or 溜まった水のプール）。水没前の器の中はプールの影響を受けない
        const floor = !submerged && body.inBowl(xi, yi) ? this.floorY : this.baseY;
        this.onFloor[i] = yi > floor - pr - 1.5 ? 1 : 0;
        if (yi > floor - pr) {
          yi = floor - pr;
          xi = px[i] + (xi - px[i]) * 0.85;
          cny -= 1;
        }

        // テーブルの天板（箱）。めり込みが最も浅い面から押し出す
        if (tableDry && xi > tb.x0 - pr && xi < tb.x1 + pr && yi > tb.top - pr && yi < tb.bottom + pr) {
          const up = yi - (tb.top - pr), down = tb.bottom + pr - yi;
          const left = xi - (tb.x0 - pr), right = tb.x1 + pr - xi;
          const mn = Math.min(up, down, left, right);
          if (mn === up) {
            yi = tb.top - pr; cny -= 1;
            xi = px[i] + (xi - px[i]) * 0.85;
            this.onFloor[i] = 1;
          } else if (mn === down) { yi = tb.bottom + pr; cny += 1; }
          else if (mn === left) { xi = tb.x0 - pr; cnx -= 1; }
          else { xi = tb.x1 + pr; cnx += 1; }
        } else if (tableDry && xi > tb.x0 && xi < tb.x1 && yi > tb.top - pr - 1.5 && yi < tb.top) {
          this.onFloor[i] = 1;
        }
        // 左右の壁
        if (xi < pr) xi = pr; else if (xi > W - pr) xi = W - pr;

        // 物体（カエルなど）
        if (xi > bb.x0 - m && xi < bb.x1 + m && yi > bb.y0 - m && yi < bb.y1 + m) {
          const p0x = px[i], p0y = py[i];
          for (let s = 0; s < segs.length; s++) {
            const sg = segs[s], R = pr + sg.half;
            // すり抜け判定
            const s0 = (p0x - sg.ax) * sg.nx + (p0y - sg.ay) * sg.ny;
            const s1 = (xi - sg.ax) * sg.nx + (yi - sg.ay) * sg.ny;
            if ((s0 > 0) !== (s1 > 0) && s0 !== s1) {
              const f = s0 / (s0 - s1);
              const ix = p0x + (xi - p0x) * f, iy = p0y + (yi - p0y) * f;
              const u = (ix - sg.ax) * sg.tx + (iy - sg.ay) * sg.ty;
              if (u >= -1 && u <= sg.len + 1) {
                const side = s0 > 0 ? 1 : -1;
                xi = ix + sg.nx * side * R; yi = iy + sg.ny * side * R;
                cnx += sg.nx * side; cny += sg.ny * side;
                hit = true;
              }
            }
            // カプセルとの距離
            let u = (xi - sg.ax) * sg.tx + (yi - sg.ay) * sg.ty;
            if (u < 0) u = 0; else if (u > sg.len) u = sg.len;
            const cxp = sg.ax + sg.tx * u, cyp = sg.ay + sg.ty * u;
            const dx = xi - cxp, dy = yi - cyp, d2 = dx * dx + dy * dy;
            if (d2 < R * R) {
              if (d2 > 1e-8) {
                const d = Math.sqrt(d2);
                xi = cxp + dx / d * R; yi = cyp + dy / d * R;
                cnx += dx / d; cny += dy / d;
                hit = true;
              } else {
                const side = s0 > 0 ? 1 : -1;
                xi = cxp + sg.nx * side * R; yi = cyp + sg.ny * side * R;
                cnx += sg.nx * side; cny += sg.ny * side;
                hit = true;
              }
            }
          }
        }
        if (hit && body.omega && (cnx || cny)) {
          const v = body.velAt(xi, yi), nl = Math.hypot(cnx, cny);
          cwv = Math.max(0, (v[0] * cnx + v[1] * cny) / nl);
        }
        x[i] = xi; y[i] = yi;
        this.cnx[i] = cnx; this.cny[i] = cny; this.cwv[i] = cwv;
      }
    }

    // 粒子数が多くなったら、底の粒子を静的な「プール」に変換して水位を上げる
    manage(maxN, maxRemove = 30) {
      const { x, y, body, mark } = this;
      const n = this.n;
      const submerged = this.baseY <= body.rimY + 6;
      const poolActive = this.baseY < this.floorY - 0.5;
      mark.fill(0, 0, n);
      let removed = 0;

      if (poolActive) {
        for (let i = 0; i < n; i++) {
          if (y[i] > this.baseY + this.pr && (submerged || !body.inBowl(x[i], y[i]))) { mark[i] = 1; removed++; }
        }
      }
      for (let i = 0; i < n; i++) {
        if (!mark[i] && y[i] > this.killY) { mark[i] = 1; removed++; }
      }
      const excess = n - removed - maxN;
      if (excess > 0) {
        const cand = [];
        for (let i = 0; i < n; i++) {
          if (!mark[i] && (submerged || !body.inBowl(x[i], y[i]))) cand.push(i);
        }
        cand.sort((a, b) => y[b] - y[a]);
        const take = Math.min(excess, maxRemove, cand.length);
        for (let a = 0; a < take; a++) { mark[cand[a]] = 1; removed++; }
      }
      if (removed === 0) return;

      let w = 0;
      for (let i = 0; i < n; i++) {
        if (mark[i]) continue;
        if (w !== i) {
          this.x[w] = this.x[i]; this.y[w] = this.y[i];
          this.vx[w] = this.vx[i]; this.vy[w] = this.vy[i];
          this.rho[w] = this.rho[i]; this.onFloor[w] = this.onFloor[i]; this.seed[w] = this.seed[i];
        }
        w++;
      }
      this.n = w;
      this.baseY = Math.max(this.topLimit, this.baseY - removed * this.areaPer / this.W);
    }

    countInBowl() {
      let c = 0;
      for (let i = 0; i < this.n; i++) if (this.body.inBowl(this.x[i], this.y[i])) c++;
      return c;
    }

    // 地面に落ちた水を少しずつ土に染み込ませる（水たまりが一定の大きさで落ち着く）
    // cx, rx: 水たまりの中心と半径。そこから外れた水は早く染み込む
    soak(prob, cx = 0, rx = Infinity) {
      const { x, y, mark, onFloor } = this;
      const n = this.n, limit = this.floorY - this.pr - 2;
      let removed = 0;
      for (let i = 0; i < n; i++) {
        const p = Math.abs(x[i] - cx) < rx ? prob : prob * 20;
        mark[i] = onFloor[i] && y[i] > limit && Math.random() < p ? 1 : 0;
        removed += mark[i];
      }
      if (!removed) return;
      let w = 0;
      for (let i = 0; i < n; i++) {
        if (mark[i]) continue;
        if (w !== i) {
          this.x[w] = this.x[i]; this.y[w] = this.y[i];
          this.vx[w] = this.vx[i]; this.vy[w] = this.vy[i];
          this.rho[w] = this.rho[i]; this.onFloor[w] = this.onFloor[i]; this.seed[w] = this.seed[i];
        }
        w++;
      }
      this.n = w;
    }
  }

  const api = { Sim, makeGlass, makeFrog, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FluidSim = api;
})(typeof window !== 'undefined' ? window : globalThis);
