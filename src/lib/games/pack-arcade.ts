import * as THREE from "three";
import { NEON, neonMat, matteMat } from "./engine";
import { circuitFloor, installLook, lookOf } from "./look";
import { clamp } from "./math";
import { killMesh } from "./kit";
import type { GameContext, MiniGame } from "./types";

type Run = "playing" | "won" | "lost";

export class PrismSnakeGame implements MiniGame {
  private ctx!: GameContext;
  private status: Run = "playing";
  private body: Array<{ x: number; z: number; mesh: THREE.Mesh }> = [];
  private dir = { x: 1, z: 0 };
  private pending = { x: 1, z: 0 };
  private food = new THREE.Mesh();
  private acc = 0;
  private hudAcc = 0;
  private readonly n = 16;

  mount(ctx: GameContext) {
    this.ctx = ctx;
    installLook(ctx.engine, { accent: NEON.emerald, bg: 0x081018 });
    ctx.engine.scene.add(circuitFloor(22, lookOf(ctx.engine)));
    const rim = new THREE.Mesh(new THREE.BoxGeometry(18.4, 0.4, 18.4), matteMat(0x1e293b, 0.2));
    rim.position.y = -0.05;
    ctx.engine.scene.add(rim);
    this.food = new THREE.Mesh(new THREE.OctahedronGeometry(0.35), neonMat(NEON.amber, 1));
    ctx.engine.scene.add(this.food);
    ctx.engine.camera.position.set(0, 22, 16);
    ctx.engine.camera.lookAt(0, 0, 0);
    ctx.emitHud({ status: "ready", score: 0, objective: "吃到 10 枚棱镜，不要撞自己" });
  }

  start() {
    this.status = "playing";
    this.clearBody();
    this.dir = { x: 1, z: 0 };
    this.pending = { x: 1, z: 0 };
    this.acc = 0;
    for (let i = 0; i < 3; i++) this.pushSeg(1 - i, 0);
    this.placeFood();
    this.ctx.emitHud({ status: "playing", score: 0, objective: "长度 3 · 目标 12", toast: "蠕行" });
  }

  pause() {}
  resume() {}
  dispose() {
    this.clearBody();
  }

  update(dt: number) {
    if (this.status !== "playing") return;
    const axis = this.ctx.engine.axis();
    if (axis.x && this.dir.x === 0) this.pending = { x: axis.x, z: 0 };
    if (axis.y && this.dir.z === 0) this.pending = { x: 0, z: -axis.y };
    this.acc += dt;
    if (this.acc < 0.16) return;
    this.acc = 0;
    this.dir = this.pending;
    const head = this.body[0];
    const nx = head.x + this.dir.x;
    const nz = head.z + this.dir.z;
    if (Math.abs(nx) > 7 || Math.abs(nz) > 7 || this.body.some((s) => s.x === nx && s.z === nz)) {
      this.status = "lost";
      lookOf(this.ctx.engine).sfx(90, 0.22, "sawtooth", 0.05, -50);
      this.ctx.emitHud({ status: "lost", score: this.body.length, objective: "撞壁 / 自噬", toast: "断裂" });
      return;
    }
    const grow = nx === this.food.userData.gx && nz === this.food.userData.gz;
    this.pushSeg(nx, nz);
    if (!grow) {
      const tail = this.body.pop();
      if (tail) killMesh(this.ctx.engine.scene, tail.mesh);
    } else {
      this.placeFood();
      if (this.body.length >= 12) {
        this.status = "won";
      lookOf(this.ctx.engine).sfx(523, 0.28, "triangle", 0.05, 220);
      lookOf(this.ctx.engine).shockwave(new THREE.Vector3(), lookOf(this.ctx.engine).accent, 1.2);
        this.ctx.emitHud({ status: "won", score: this.body.length, objective: "棱镜满足", toast: "成环" });
        return;
      }
    }
    this.layout();
    this.pushHud();
  }

  private pushSeg(x: number, z: number) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.9), neonMat(NEON.cyan, 0.75));
    this.ctx.engine.scene.add(mesh);
    this.body.unshift({ x, z, mesh });
    this.layout();
  }

  private layout() {
    this.body.forEach((s, i) => {
      s.mesh.position.set(s.x * 1.05, 0.35, s.z * 1.05);
      (s.mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = i === 0 ? 1 : 0.45;
    });
  }

  private placeFood() {
    let x = 0;
    let z = 0;
    do {
      x = Math.floor(Math.random() * 15) - 7;
      z = Math.floor(Math.random() * 15) - 7;
    } while (this.body.some((s) => s.x === x && s.z === z));
    this.food.position.set(x * 1.05, 0.45, z * 1.05);
    this.food.userData = { gx: x, gz: z };
  }

  private clearBody() {
    this.body.forEach((s) => killMesh(this.ctx.engine.scene, s.mesh));
    this.body = [];
  }

  private pushHud() {
    this.hudAcc += 0.05;
    if (this.hudAcc < 0.2) return;
    this.hudAcc = 0;
    this.ctx.emitHud({ status: "playing", score: this.body.length, objective: `长度 ${this.body.length} / 12` });
  }
}

export class PhotonBreakoutGame implements MiniGame {
  private ctx!: GameContext;
  private status: Run = "playing";
  private paddle = new THREE.Mesh();
  private ball = new THREE.Mesh();
  private vel = new THREE.Vector3();
  private bricks: THREE.Mesh[] = [];
  private lives = 3;
  private hudAcc = 0;

  mount(ctx: GameContext) {
    this.ctx = ctx;
    installLook(ctx.engine, { accent: NEON.indigo, bg: 0x0b1020 });
    ctx.engine.scene.add(circuitFloor(24, lookOf(ctx.engine)));
    this.paddle = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.4, 0.7), neonMat(NEON.cyan, 0.8));
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 10), neonMat(NEON.amber, 1));
    ctx.engine.scene.add(this.paddle, this.ball);
    ctx.engine.camera.position.set(0, 16, 14);
    ctx.engine.camera.lookAt(0, 0, -2);
    ctx.emitHud({ status: "ready", score: 0, lives: 3, objective: "打掉全部砖块" });
  }

  start() {
    this.status = "playing";
    this.lives = 3;
    this.paddle.position.set(0, 0.3, 8);
    this.resetBall();
    this.buildBricks();
    this.ctx.emitHud({ status: "playing", score: 0, lives: 3, objective: "打掉全部砖块", toast: "发球" });
  }

  pause() {}
  resume() {}
  dispose() {
    this.clearBricks();
  }

  update(dt: number) {
    if (this.status !== "playing") return;
    const axis = this.ctx.engine.axis();
    this.paddle.position.x = clamp(this.paddle.position.x + axis.x * 14 * dt, -7.2, 7.2);
    this.ball.position.addScaledVector(this.vel, dt);
    if (Math.abs(this.ball.position.x) > 8) {
      this.ball.position.x = clamp(this.ball.position.x, -8, 8);
      this.vel.x *= -1;
    }
    if (this.ball.position.z < -9) this.vel.z *= -1;
    if (this.ball.position.z > this.paddle.position.z - 0.6 && this.ball.position.z < this.paddle.position.z + 0.6 && Math.abs(this.ball.position.x - this.paddle.position.x) < 1.8 && this.vel.z > 0) {
      this.vel.z *= -1;
      this.vel.x += (this.ball.position.x - this.paddle.position.x) * 2.4;
    }
    this.bricks = this.bricks.filter((b) => {
      if (b.position.distanceTo(this.ball.position) > 0.85) return true;
      this.vel.z *= -1;
      killMesh(this.ctx.engine.scene, b);
      if (this.bricks.length <= 1) {
        this.status = "won";
      lookOf(this.ctx.engine).sfx(523, 0.28, "triangle", 0.05, 220);
      lookOf(this.ctx.engine).shockwave(new THREE.Vector3(), lookOf(this.ctx.engine).accent, 1.2);
        this.ctx.emitHud({ status: "won", score: 240, lives: this.lives, objective: "砖墙清空", toast: "破阵" });
      }
      return false;
    });
    if (this.ball.position.z > 10.5) {
      this.lives -= 1;
      if (this.lives <= 0) {
        this.status = "lost";
      lookOf(this.ctx.engine).sfx(90, 0.22, "sawtooth", 0.05, -50);
        this.ctx.emitHud({ status: "lost", lives: 0, objective: "球出界", toast: "失误" });
        return;
      }
      this.resetBall();
      this.ctx.emitHud({ toast: "再发", lives: this.lives });
    }
    this.pushHud();
  }

  private resetBall() {
    this.ball.position.set(0, 0.4, 6.5);
    this.vel.set((Math.random() - 0.5) * 6, 0, -10);
  }

  private buildBricks() {
    this.clearBricks();
    for (let z = 0; z < 4; z++) {
      for (let x = 0; x < 8; x++) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 0.7), neonMat(z % 2 ? NEON.violet : NEON.rose, 0.55));
        mesh.position.set(-6.2 + x * 1.75, 0.4, -6 + z * 1.1);
        this.ctx.engine.scene.add(mesh);
        this.bricks.push(mesh);
      }
    }
  }

  private clearBricks() {
    this.bricks.forEach((b) => killMesh(this.ctx.engine.scene, b));
    this.bricks = [];
  }

  private pushHud() {
    this.hudAcc += 0.016;
    if (this.hudAcc < 0.2) return;
    this.hudAcc = 0;
    this.ctx.emitHud({ status: "playing", score: (32 - this.bricks.length) * 10, lives: this.lives, objective: `剩余砖块 ${this.bricks.length}` });
  }
}

const SHAPES = [
  [[1, 1, 1, 1]],
  [
    [1, 1],
    [1, 1],
  ],
  [
    [0, 1, 0],
    [1, 1, 1],
  ],
  [
    [1, 1, 0],
    [0, 1, 1],
  ],
];

export class StackMatrixGame implements MiniGame {
  private ctx!: GameContext;
  private status: Run = "playing";
  private w = 8;
  private h = 12;
  private grid: number[] = [];
  private cells: THREE.Mesh[] = [];
  private px = 3;
  private py = 0;
  private shape: number[][] = [];
  private fall = 0;
  private cleared = 0;
  private hudAcc = 0;
  private moveCd = 0;

  mount(ctx: GameContext) {
    this.ctx = ctx;
    installLook(ctx.engine, { accent: NEON.violet, bg: 0x0c0814 });
    const well = new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.2, 12.6), matteMat(0x1e1b4b, 0.12));
    well.position.set(0, -0.2, 0);
    ctx.engine.scene.add(well);
    ctx.engine.camera.position.set(0, 16, 16);
    ctx.engine.camera.lookAt(0, 0, 0);
    ctx.emitHud({ status: "ready", score: 0, objective: "消掉 5 行" });
  }

  start() {
    this.status = "playing";
    this.grid = new Array(this.w * this.h).fill(0);
    this.cleared = 0;
    this.fall = 0;
    this.spawn();
    this.redraw();
    this.ctx.emitHud({ status: "playing", score: 0, objective: "消行 0 / 5", toast: "下落" });
  }

  pause() {}
  resume() {}
  dispose() {
    this.clearCells();
  }

  update(dt: number) {
    if (this.status !== "playing") return;
    this.moveCd = Math.max(0, this.moveCd - dt);
    const axis = this.ctx.engine.axis();
    if (this.moveCd <= 0 && axis.x) {
      this.tryMove(axis.x, 0);
      this.moveCd = 0.12;
    }
    if (this.ctx.engine.jumpPressed() || this.ctx.engine.firePressed() || this.ctx.engine.justPressed.has("KeyQ")) this.rotate();
    if (axis.y < 0) this.fall += dt * 8;
    this.fall += dt;
    if (this.fall > 0.55) {
      this.fall = 0;
      if (!this.tryMove(0, 1)) this.lock();
    }
    this.pushHud();
  }

  private spawn() {
    this.shape = SHAPES[Math.floor(Math.random() * SHAPES.length)].map((r) => [...r]);
    this.px = 3;
    this.py = 0;
    if (this.collides(this.px, this.py, this.shape)) {
      this.status = "lost";
      lookOf(this.ctx.engine).sfx(90, 0.22, "sawtooth", 0.05, -50);
      this.ctx.emitHud({ status: "lost", score: this.cleared * 100, objective: "堆满", toast: "溢出" });
    }
    this.redraw();
  }

  private tryMove(dx: number, dy: number) {
    if (this.collides(this.px + dx, this.py + dy, this.shape)) return false;
    this.px += dx;
    this.py += dy;
    this.redraw();
    return true;
  }

  private rotate() {
    const next = this.shape[0].map((_, i) => this.shape.map((row) => row[i]).reverse());
    if (!this.collides(this.px, this.py, next)) {
      this.shape = next;
      this.redraw();
    }
  }

  private collides(x: number, y: number, shape: number[][]) {
    for (let r = 0; r < shape.length; r++) {
      for (let c = 0; c < shape[r].length; c++) {
        if (!shape[r][c]) continue;
        const gx = x + c;
        const gy = y + r;
        if (gx < 0 || gx >= this.w || gy >= this.h) return true;
        if (gy >= 0 && this.grid[gy * this.w + gx]) return true;
      }
    }
    return false;
  }

  private lock() {
    for (let r = 0; r < this.shape.length; r++) {
      for (let c = 0; c < this.shape[r].length; c++) {
        if (!this.shape[r][c]) continue;
        const gy = this.py + r;
        const gx = this.px + c;
        if (gy >= 0) this.grid[gy * this.w + gx] = 1;
      }
    }
    for (let y = this.h - 1; y >= 0; y--) {
      let full = true;
      for (let x = 0; x < this.w; x++) if (!this.grid[y * this.w + x]) full = false;
      if (full) {
        this.grid.splice(y * this.w, this.w);
        this.grid.unshift(...new Array(this.w).fill(0));
        this.cleared += 1;
        y += 1;
      }
    }
    if (this.cleared >= 5) {
      this.status = "won";
      lookOf(this.ctx.engine).sfx(523, 0.28, "triangle", 0.05, 220);
      lookOf(this.ctx.engine).shockwave(new THREE.Vector3(), lookOf(this.ctx.engine).accent, 1.2);
      this.ctx.emitHud({ status: "won", score: this.cleared * 100, objective: "层积完成", toast: "五行已消" });
      this.redraw();
      return;
    }
    this.spawn();
  }

  private redraw() {
    this.clearCells();
    const draw = (x: number, y: number, color: number) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.42, 0.92), neonMat(color, 0.7));
      mesh.position.set(x - this.w / 2 + 0.5, 0.25, y - this.h / 2 + 0.5);
      this.ctx.engine.scene.add(mesh);
      this.cells.push(mesh);
    };
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) if (this.grid[y * this.w + x]) draw(x, y, NEON.indigo);
    }
    for (let r = 0; r < this.shape.length; r++) {
      for (let c = 0; c < this.shape[r].length; c++) {
        if (this.shape[r][c]) draw(this.px + c, this.py + r, NEON.cyan);
      }
    }
  }

  private clearCells() {
    this.cells.forEach((c) => killMesh(this.ctx.engine.scene, c));
    this.cells = [];
  }

  private pushHud() {
    this.hudAcc += 0.016;
    if (this.hudAcc < 0.2) return;
    this.hudAcc = 0;
    this.ctx.emitHud({ status: "playing", score: this.cleared * 100, objective: `消行 ${this.cleared} / 5 · 空格旋转` });
  }
}

export class PhaseCrossingGame implements MiniGame {
  private ctx!: GameContext;
  private status: Run = "playing";
  private player = new THREE.Mesh();
  private row = 0;
  private col = 2;
  private cars: Array<{ mesh: THREE.Mesh; row: number; x: number; v: number }> = [];
  private hudAcc = 0;
  private goal = 12;

  mount(ctx: GameContext) {
    this.ctx = ctx;
    installLook(ctx.engine, { accent: NEON.orange, bg: 0x0b1220 });
    ctx.engine.scene.add(circuitFloor(28, lookOf(ctx.engine)));
    this.player = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), neonMat(NEON.cyan, 0.9));
    ctx.engine.scene.add(this.player);
    const goal = new THREE.Mesh(new THREE.BoxGeometry(8, 0.15, 1.4), neonMat(NEON.emerald, 0.5));
    goal.position.set(0, 0.05, -this.goal * 1.6);
    ctx.engine.scene.add(goal);
    ctx.emitHud({ status: "ready", score: 0, objective: "一格一跳，躲开车流到达对岸" });
  }

  start() {
    this.status = "playing";
    this.row = 0;
    this.col = 2;
    this.clearCars();
    for (let r = 1; r < this.goal; r++) {
      if (r % 2 === 0) continue;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 0.9), neonMat(NEON.rose, 0.7));
      this.ctx.engine.scene.add(mesh);
      this.cars.push({ mesh, row: r, x: (Math.random() - 0.5) * 10, v: (r % 4 === 1 ? 1 : -1) * (3 + r * 0.2) });
    }
    this.place();
    this.ctx.emitHud({ status: "playing", score: 0, objective: `前进 ${this.goal} 格`, toast: "过街" });
  }

  pause() {}
  resume() {}
  dispose() {
    this.clearCars();
  }

  update(dt: number) {
    if (this.status !== "playing") return;
    const e = this.ctx.engine;
    if (e.justPressed.has("KeyW") || e.justPressed.has("ArrowUp") || e.virtual.y > 0.5) {
      this.hop(0, 1);
      e.virtual.y = 0;
    }
    if (e.justPressed.has("KeyS") || e.justPressed.has("ArrowDown") || e.virtual.y < -0.5) {
      this.hop(0, -1);
      e.virtual.y = 0;
    }
    if (e.justPressed.has("KeyA") || e.justPressed.has("ArrowLeft") || e.virtual.x < -0.5) {
      this.hop(-1, 0);
      e.virtual.x = 0;
    }
    if (e.justPressed.has("KeyD") || e.justPressed.has("ArrowRight") || e.virtual.x > 0.5) {
      this.hop(1, 0);
      e.virtual.x = 0;
    }
    for (const car of this.cars) {
      car.x += car.v * dt;
      if (car.x > 8) car.x = -8;
      if (car.x < -8) car.x = 8;
      car.mesh.position.set(car.x, 0.35, -car.row * 1.6);
      if (car.row === this.row && Math.abs(car.x - (this.col - 2) * 1.5) < 1.15) {
        this.status = "lost";
      lookOf(this.ctx.engine).sfx(90, 0.22, "sawtooth", 0.05, -50);
        this.ctx.emitHud({ status: "lost", score: this.row, objective: "被车流带走", toast: "撞车" });
        return;
      }
    }
    this.ctx.engine.camera.position.lerp(new THREE.Vector3(0, 12, this.player.position.z + 10), 1 - Math.exp(-4 * dt));
    this.ctx.engine.camera.lookAt(0, 0, this.player.position.z);
    this.pushHud();
  }

  private hop(dc: number, dr: number) {
    this.col = clamp(this.col + dc, 0, 4);
    this.row = clamp(this.row + dr, 0, this.goal);
    this.place();
    if (this.row >= this.goal) {
      this.status = "won";
      lookOf(this.ctx.engine).sfx(523, 0.28, "triangle", 0.05, 220);
      lookOf(this.ctx.engine).shockwave(new THREE.Vector3(), lookOf(this.ctx.engine).accent, 1.2);
      this.ctx.emitHud({ status: "won", score: this.goal * 10, objective: "对岸抵达", toast: "穿越" });
    }
  }

  private place() {
    this.player.position.set((this.col - 2) * 1.5, 0.45, -this.row * 1.6);
  }

  private clearCars() {
    this.cars.forEach((c) => killMesh(this.ctx.engine.scene, c.mesh));
    this.cars = [];
  }

  private pushHud() {
    this.hudAcc += 0.016;
    if (this.hudAcc < 0.18) return;
    this.hudAcc = 0;
    this.ctx.emitHud({ status: "playing", score: this.row * 10, objective: `前进 ${this.row} / ${this.goal}` });
  }
}

export class ArcSliceGame implements MiniGame {
  private ctx!: GameContext;
  private status: Run = "playing";
  private fruits: Array<{ mesh: THREE.Mesh; vel: THREE.Vector3; bomb: boolean }> = [];
  private spawn = 0;
  private sliced = 0;
  private lives = 3;
  private hudAcc = 0;

  mount(ctx: GameContext) {
    this.ctx = ctx;
    installLook(ctx.engine, { accent: NEON.rose, bg: 0x14080c });
    ctx.engine.scene.add(circuitFloor(20, lookOf(ctx.engine)));
    ctx.engine.camera.position.set(0, 4, 12);
    ctx.engine.camera.lookAt(0, 2, 0);
    ctx.emitHud({ status: "ready", score: 0, lives: 3, objective: "点击切开飞来的晶体，避开炸弹" });
  }

  start() {
    this.status = "playing";
    this.sliced = 0;
    this.lives = 3;
    this.spawn = 0.2;
    this.clear();
    this.ctx.emitHud({ status: "playing", score: 0, lives: 3, objective: "切开 16 个 · 避开炸弹", toast: "出刃" });
  }

  pause() {}
  resume() {}
  dispose() {
    this.clear();
  }

  update(dt: number) {
    if (this.status !== "playing") return;
    this.spawn -= dt;
    if (this.spawn <= 0) {
      this.spawn = 0.7 + Math.random() * 0.4;
      const bomb = Math.random() < 0.18;
      const mesh = new THREE.Mesh(bomb ? new THREE.DodecahedronGeometry(0.45) : new THREE.IcosahedronGeometry(0.42, 0), neonMat(bomb ? NEON.rose : NEON.amber, 0.95));
      mesh.position.set((Math.random() - 0.5) * 8, -0.4, (Math.random() - 0.5) * 2);
      this.ctx.engine.scene.add(mesh);
      this.fruits.push({ mesh, vel: new THREE.Vector3((Math.random() - 0.5) * 3, 8 + Math.random() * 3, 0), bomb });
    }
    if (this.ctx.engine.click) {
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(this.ctx.engine.click.ndcX, this.ctx.engine.click.ndcY), this.ctx.engine.camera);
      const hits = ray.intersectObjects(this.fruits.map((f) => f.mesh));
      if (hits[0]) {
        const fruit = this.fruits.find((f) => f.mesh === hits[0].object);
        if (fruit) {
          if (fruit.bomb) {
            this.status = "lost";
      lookOf(this.ctx.engine).sfx(90, 0.22, "sawtooth", 0.05, -50);
            this.ctx.emitHud({ status: "lost", score: this.sliced, objective: "切到炸弹", toast: "爆裂" });
            return;
          }
          this.sliced += 1;
          this.fruits = this.fruits.filter((f) => f !== fruit);
          killMesh(this.ctx.engine.scene, fruit.mesh);
          if (this.sliced >= 16) {
            this.status = "won";
      lookOf(this.ctx.engine).sfx(523, 0.28, "triangle", 0.05, 220);
      lookOf(this.ctx.engine).shockwave(new THREE.Vector3(), lookOf(this.ctx.engine).accent, 1.2);
            this.ctx.emitHud({ status: "won", score: this.sliced * 10, lives: this.lives, objective: "弧光收刃", toast: "切完" });
            return;
          }
        }
      }
    }
    this.fruits = this.fruits.filter((f) => {
      f.vel.y -= 12 * dt;
      f.mesh.position.addScaledVector(f.vel, dt);
      f.mesh.rotation.x += dt * 4;
      if (f.mesh.position.y < -1.5) {
        if (!f.bomb) {
          this.lives -= 1;
          if (this.lives <= 0) {
            this.status = "lost";
      lookOf(this.ctx.engine).sfx(90, 0.22, "sawtooth", 0.05, -50);
            this.ctx.emitHud({ status: "lost", lives: 0, score: this.sliced, objective: "漏切过多", toast: "失手" });
          }
        }
        killMesh(this.ctx.engine.scene, f.mesh);
        return false;
      }
      return true;
    });
    this.pushHud();
  }

  private clear() {
    this.fruits.forEach((f) => killMesh(this.ctx.engine.scene, f.mesh));
    this.fruits = [];
  }

  private pushHud() {
    this.hudAcc += 0.016;
    if (this.hudAcc < 0.16) return;
    this.hudAcc = 0;
    this.ctx.emitHud({ status: "playing", score: this.sliced * 10, lives: this.lives, objective: `切开 ${this.sliced} / 16` });
  }
}
