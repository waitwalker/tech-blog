import * as THREE from "three";
import { NEON, neonMat, matteMat } from "./engine";
import { circuitFloor, installLook, lookOf } from "./look";
import { clamp } from "./math";
import { groundPick, killMesh } from "./kit";
import type { GameContext, MiniGame } from "./types";

type Run = "playing" | "won" | "lost";

export class OrbitPuttGame implements MiniGame {
  private ctx!: GameContext;
  private status: Run = "playing";
  private ball = new THREE.Mesh();
  private hole = new THREE.Mesh();
  private vel = new THREE.Vector3();
  private holeIndex = 0;
  private strokes = 0;
  private total = 0;
  private hudAcc = 0;
  private walls: THREE.Mesh[] = [];

  mount(ctx: GameContext) {
    this.ctx = ctx;
    installLook(ctx.engine, { accent: NEON.emerald, bg: 0x07140f });
    ctx.engine.scene.add(circuitFloor(28, lookOf(ctx.engine)));
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 12), neonMat(NEON.cyan, 0.9));
    this.hole = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.08, 16), neonMat(NEON.slate, 0.4));
    ctx.engine.scene.add(this.ball, this.hole);
    ctx.engine.camera.position.set(0, 16, 14);
    ctx.engine.camera.lookAt(0, 0, 0);
    ctx.emitHud({ status: "ready", score: 0, objective: "三洞推杆，每洞尽量少杆" });
  }

  start() {
    this.status = "playing";
    this.holeIndex = 0;
    this.total = 0;
    this.loadHole(0);
    this.ctx.emitHud({ status: "playing", score: 0, lap: "1 / 3", objective: "点击地面瞄准并击球", toast: "开球" });
  }

  pause() {}
  resume() {}
  dispose() {
    this.clearWalls();
  }

  update(dt: number) {
    if (this.status !== "playing") return;
    if (this.ctx.engine.click && this.vel.length() < 0.15) {
      const aim = groundPick(this.ctx.engine.camera, this.ctx.engine.click.ndcX, this.ctx.engine.click.ndcY);
      const dir = aim.sub(this.ball.position);
      dir.y = 0;
      const power = clamp(dir.length() * 1.6, 2, 14);
      if (dir.lengthSq() > 0.01) {
        dir.normalize().multiplyScalar(power);
        this.vel.copy(dir);
        this.strokes += 1;
        this.total += 1;
      }
    }
    this.ball.position.addScaledVector(this.vel, dt);
    this.vel.multiplyScalar(Math.exp(-2.4 * dt));
    this.ball.position.x = clamp(this.ball.position.x, -10, 10);
    this.ball.position.z = clamp(this.ball.position.z, -10, 10);
    this.ball.position.y = 0.28;
    for (const w of this.walls) {
      if (Math.abs(this.ball.position.x - w.position.x) < w.scale.x * 0.5 + 0.3 && Math.abs(this.ball.position.z - w.position.z) < 0.6) {
        this.vel.x *= -0.7;
      }
    }
    const dist = Math.hypot(this.ball.position.x - this.hole.position.x, this.ball.position.z - this.hole.position.z);
    if (dist < 0.62 && this.vel.length() < 3.2) {
      this.ctx.emitHud({ toast: `第 ${this.holeIndex + 1} 洞 ${this.strokes} 杆` });
      this.holeIndex += 1;
      if (this.holeIndex >= 3) {
        this.status = "won";
      lookOf(this.ctx.engine).sfx(523, 0.28, "triangle", 0.05, 220);
      lookOf(this.ctx.engine).shockwave(new THREE.Vector3(), lookOf(this.ctx.engine).accent, 1.2);
        this.ctx.emitHud({ status: "won", score: Math.max(0, 90 - this.total * 6), lap: "3 / 3", objective: `总杆 ${this.total}`, toast: "完赛" });
        return;
      }
      this.loadHole(this.holeIndex);
    }
    this.ctx.engine.camera.position.lerp(new THREE.Vector3(this.ball.position.x, 14, this.ball.position.z + 12), 1 - Math.exp(-3 * dt));
    this.ctx.engine.camera.lookAt(this.ball.position.x, 0, this.ball.position.z);
    this.pushHud();
  }

  private loadHole(i: number) {
    this.strokes = 0;
    this.vel.set(0, 0, 0);
    this.clearWalls();
    const starts = [new THREE.Vector3(-6, 0.28, 7), new THREE.Vector3(6, 0.28, 7), new THREE.Vector3(0, 0.28, 8)];
    const holes = [new THREE.Vector3(6, 0.04, -6), new THREE.Vector3(-7, 0.04, -5), new THREE.Vector3(0, 0.04, -7)];
    this.ball.position.copy(starts[i]);
    this.hole.position.copy(holes[i]);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(8, 0.8, 0.5), matteMat(0x166534, 0.2));
    wall.position.set(i === 1 ? 2 : 0, 0.4, 0);
    this.ctx.engine.scene.add(wall);
    this.walls.push(wall);
  }

  private clearWalls() {
    this.walls.forEach((w) => killMesh(this.ctx.engine.scene, w));
    this.walls = [];
  }

  private pushHud() {
    this.hudAcc += 0.016;
    if (this.hudAcc < 0.18) return;
    this.hudAcc = 0;
    this.ctx.emitHud({ status: "playing", score: this.total, lap: `${this.holeIndex + 1} / 3`, objective: `本洞 ${this.strokes} 杆 · 总 ${this.total}` });
  }
}

type Ball = { mesh: THREE.Mesh; vel: THREE.Vector3; pocketed: boolean; cue?: boolean };

export class QuantumPoolGame implements MiniGame {
  private ctx!: GameContext;
  private status: Run = "playing";
  private balls: Ball[] = [];
  private hudAcc = 0;
  private shots = 0;

  mount(ctx: GameContext) {
    this.ctx = ctx;
    installLook(ctx.engine, { accent: NEON.emerald, bg: 0x07140c });
    const table = new THREE.Mesh(new THREE.BoxGeometry(12, 0.4, 7), matteMat(0x14532d, 0.15));
    ctx.engine.scene.add(table);
    ctx.engine.camera.position.set(0, 14, 0.2);
    ctx.engine.camera.lookAt(0, 0, 0);
    ctx.emitHud({ status: "ready", score: 0, objective: "把彩球打进袋，白球是母球" });
  }

  start() {
    this.status = "playing";
    this.shots = 0;
    this.clear();
    this.spawn();
    this.ctx.emitHud({ status: "playing", score: 0, objective: "击落全部 5 颗彩球", toast: "开球" });
  }

  pause() {}
  resume() {}
  dispose() {
    this.clear();
  }

  update(dt: number) {
    if (this.status !== "playing") return;
    const cue = this.balls.find((b) => b.cue);
    const moving = this.balls.some((b) => b.vel.length() > 0.08);
    if (this.ctx.engine.click && cue && !moving) {
      const aim = groundPick(this.ctx.engine.camera, this.ctx.engine.click.ndcX, this.ctx.engine.click.ndcY, 0.4);
      const dir = aim.sub(cue.mesh.position);
      dir.y = 0;
      const p = clamp(dir.length() * 1.8, 3, 16);
      if (dir.lengthSq() > 0.01) {
        cue.vel.copy(dir.normalize().multiplyScalar(p));
        this.shots += 1;
      }
    }
    for (const b of this.balls) {
      if (b.pocketed) continue;
      b.mesh.position.addScaledVector(b.vel, dt);
      b.vel.multiplyScalar(Math.exp(-1.8 * dt));
      if (Math.abs(b.mesh.position.x) > 5.6) {
        b.mesh.position.x = clamp(b.mesh.position.x, -5.6, 5.6);
        b.vel.x *= -0.85;
      }
      if (Math.abs(b.mesh.position.z) > 3.15) {
        b.mesh.position.z = clamp(b.mesh.position.z, -3.15, 3.15);
        b.vel.z *= -0.85;
      }
      const pocket =
        (Math.abs(b.mesh.position.x) > 5.15 && Math.abs(b.mesh.position.z) > 2.7) ||
        (Math.abs(b.mesh.position.x) > 5.3 && Math.abs(b.mesh.position.z) < 0.35);
      if (pocket) {
        b.pocketed = true;
        b.mesh.visible = false;
        b.vel.set(0, 0, 0);
        if (b.cue) {
          b.pocketed = false;
          b.mesh.visible = true;
          b.mesh.position.set(-3.5, 0.4, 0);
        }
      }
    }
    for (let i = 0; i < this.balls.length; i++) {
      for (let j = i + 1; j < this.balls.length; j++) {
        const a = this.balls[i];
        const b = this.balls[j];
        if (a.pocketed || b.pocketed) continue;
        const d = a.mesh.position.clone().sub(b.mesh.position);
        d.y = 0;
        const dist = d.length();
        if (dist < 0.62 && dist > 0) {
          const n = d.multiplyScalar(1 / dist);
          const rel = a.vel.clone().sub(b.vel);
          const imp = n.dot(rel);
          if (imp < 0) {
            a.vel.addScaledVector(n, -imp);
            b.vel.addScaledVector(n, imp);
          }
          const push = (0.62 - dist) * 0.5;
          a.mesh.position.addScaledVector(n, push);
          b.mesh.position.addScaledVector(n, -push);
        }
      }
    }
    const left = this.balls.filter((b) => !b.cue && !b.pocketed).length;
    if (left === 0) {
      this.status = "won";
      lookOf(this.ctx.engine).sfx(523, 0.28, "triangle", 0.05, 220);
      lookOf(this.ctx.engine).shockwave(new THREE.Vector3(), lookOf(this.ctx.engine).accent, 1.2);
      this.ctx.emitHud({ status: "won", score: Math.max(0, 200 - this.shots * 10), objective: `清台 · ${this.shots} 杆`, toast: "清台" });
      return;
    }
    this.pushHud(left);
  }

  private spawn() {
    const cueMesh = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 10), neonMat(0xf8fafc, 0.35));
    cueMesh.position.set(-3.6, 0.4, 0);
    this.ctx.engine.scene.add(cueMesh);
    this.balls.push({ mesh: cueMesh, vel: new THREE.Vector3(), pocketed: false, cue: true });
    const colors = [NEON.rose, NEON.amber, NEON.cyan, NEON.violet, NEON.orange];
    colors.forEach((c, i) => {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 10), neonMat(c, 0.7));
      mesh.position.set(2 + (i % 3) * 0.62, 0.4, (Math.floor(i / 3) - 0.5) * 0.7);
      this.ctx.engine.scene.add(mesh);
      this.balls.push({ mesh, vel: new THREE.Vector3(), pocketed: false });
    });
  }

  private clear() {
    this.balls.forEach((b) => killMesh(this.ctx.engine.scene, b.mesh));
    this.balls = [];
  }

  private pushHud(left: number) {
    this.hudAcc += 0.016;
    if (this.hudAcc < 0.18) return;
    this.hudAcc = 0;
    this.ctx.emitHud({ status: "playing", score: (5 - left) * 20, objective: `剩余 ${left} · 已击 ${this.shots} 杆` });
  }
}

export class GyroLabyrinthGame implements MiniGame {
  private ctx!: GameContext;
  private status: Run = "playing";
  private ball = new THREE.Mesh();
  private vel = new THREE.Vector3();
  private goal = new THREE.Mesh();
  private pits: THREE.Vector3[] = [];
  private walls: Array<{ x: number; z: number; w: number; d: number }> = [];
  private decor: THREE.Mesh[] = [];
  private hudAcc = 0;

  mount(ctx: GameContext) {
    this.ctx = ctx;
    installLook(ctx.engine, { accent: NEON.amber, bg: 0x101018 });
    ctx.engine.scene.add(circuitFloor(18, lookOf(ctx.engine)));
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(0.32, 16, 12), neonMat(NEON.cyan, 0.95));
    this.goal = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.08, 16), neonMat(NEON.emerald, 0.8));
    ctx.engine.scene.add(this.ball, this.goal);
    ctx.engine.camera.position.set(0, 18, 0.1);
    ctx.engine.camera.lookAt(0, 0, 0);
    ctx.emitHud({ status: "ready", score: 0, objective: "倾斜迷宫，把球滚进绿洞，躲开黑洞" });
  }

  start() {
    this.status = "playing";
    this.vel.set(0, 0, 0);
    this.ball.position.set(-6, 0.34, 6);
    this.goal.position.set(6, 0.04, -6);
    this.pits = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(3, 0, 3), new THREE.Vector3(-3, 0, -2)];
    this.walls = [
      { x: 0, z: 2, w: 8, d: 0.5 },
      { x: -2, z: -1, w: 0.5, d: 7 },
      { x: 3, z: -3, w: 6, d: 0.5 },
    ];
    this.decor.forEach((m) => killMesh(this.ctx.engine.scene, m));
    this.decor = [];
    this.walls.forEach((w) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w.w, 0.8, w.d), matteMat(0x334155, 0.25));
      mesh.position.set(w.x, 0.4, w.z);
      this.ctx.engine.scene.add(mesh);
      this.decor.push(mesh);
    });
    this.pits.forEach((p) => {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.65, 0.08, 12), neonMat(0x0f172a, 0.4));
      mesh.position.set(p.x, 0.05, p.z);
      this.ctx.engine.scene.add(mesh);
      this.decor.push(mesh);
    });
    this.ctx.emitHud({ status: "playing", score: 0, objective: "滚进绿洞", toast: "倾斜" });
  }

  pause() {}
  resume() {}
  dispose() {
    this.decor.forEach((m) => killMesh(this.ctx.engine.scene, m));
    this.decor = [];
  }

  update(dt: number) {
    if (this.status !== "playing") return;
    const axis = this.ctx.engine.axis();
    this.vel.x += axis.x * 10 * dt;
    this.vel.z -= axis.y * 10 * dt;
    this.vel.multiplyScalar(Math.exp(-1.2 * dt));
    this.ball.position.x = clamp(this.ball.position.x + this.vel.x * dt, -8, 8);
    this.ball.position.z = clamp(this.ball.position.z + this.vel.z * dt, -8, 8);
    for (const w of this.walls) {
      if (Math.abs(this.ball.position.x - w.x) < w.w * 0.5 + 0.32 && Math.abs(this.ball.position.z - w.z) < w.d * 0.5 + 0.32) {
        this.vel.multiplyScalar(-0.4);
      }
    }
    if (this.pits.some((p) => Math.hypot(this.ball.position.x - p.x, this.ball.position.z - p.z) < 0.7)) {
      this.status = "lost";
      lookOf(this.ctx.engine).sfx(90, 0.22, "sawtooth", 0.05, -50);
      this.ctx.emitHud({ status: "lost", objective: "掉进黑洞", toast: "坠落" });
      return;
    }
    if (Math.hypot(this.ball.position.x - this.goal.position.x, this.ball.position.z - this.goal.position.z) < 0.55) {
      this.status = "won";
      lookOf(this.ctx.engine).sfx(523, 0.28, "triangle", 0.05, 220);
      lookOf(this.ctx.engine).shockwave(new THREE.Vector3(), lookOf(this.ctx.engine).accent, 1.2);
      this.ctx.emitHud({ status: "won", score: 100, objective: "入洞", toast: "归位" });
      return;
    }
    this.pushHud();
  }

  private pushHud() {
    this.hudAcc += 0.016;
    if (this.hudAcc < 0.2) return;
    this.hudAcc = 0;
    this.ctx.emitHud({ status: "playing", score: 0, objective: "绿洞是终点，深色坑不要靠近" });
  }
}

export class CrescentShotGame implements MiniGame {
  private ctx!: GameContext;
  private status: Run = "playing";
  private targets: THREE.Mesh[] = [];
  private arrows: Array<{ mesh: THREE.Mesh; vel: THREE.Vector3 }> = [];
  private hits = 0;
  private arrowsLeft = 10;
  private hudAcc = 0;
  private cd = 0;

  mount(ctx: GameContext) {
    this.ctx = ctx;
    installLook(ctx.engine, { accent: NEON.orange, bg: 0x140e08 });
    ctx.engine.scene.add(circuitFloor(40, lookOf(ctx.engine)));
    ctx.engine.camera.position.set(0, 2, 12);
    ctx.engine.camera.lookAt(0, 2, -10);
    ctx.emitHud({ status: "ready", score: 0, objective: "点击瞄准射出，击中 8 个靶" });
  }

  start() {
    this.status = "playing";
    this.hits = 0;
    this.arrowsLeft = 10;
    this.cd = 0;
    this.clear();
    for (let i = 0; i < 8; i++) {
      const mesh = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.08, 8, 18), neonMat(i % 2 ? NEON.rose : NEON.amber, 0.85));
      mesh.position.set((Math.random() - 0.5) * 10, 1.2 + Math.random() * 3, -12 - Math.random() * 10);
      this.ctx.engine.scene.add(mesh);
      this.targets.push(mesh);
    }
    this.ctx.emitHud({ status: "playing", score: 0, lives: 10, objective: "击中 8 靶 · 10 箭", toast: "上弦" });
  }

  pause() {}
  resume() {}
  dispose() {
    this.clear();
  }

  update(dt: number) {
    if (this.status !== "playing") return;
    this.cd = Math.max(0, this.cd - dt);
    if (this.ctx.engine.click && this.cd <= 0 && this.arrowsLeft > 0) {
      this.cd = 0.25;
      this.arrowsLeft -= 1;
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(this.ctx.engine.click.ndcX, this.ctx.engine.click.ndcY), this.ctx.engine.camera);
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 6), neonMat(NEON.cyan, 0.9));
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), ray.ray.direction.clone().normalize());
      mesh.position.copy(this.ctx.engine.camera.position).addScaledVector(ray.ray.direction, 1);
      this.ctx.engine.scene.add(mesh);
      this.arrows.push({ mesh, vel: ray.ray.direction.clone().multiplyScalar(28) });
    }
    this.arrows = this.arrows.filter((a) => {
      a.mesh.position.addScaledVector(a.vel, dt);
      const hit = this.targets.find((t) => t.position.distanceTo(a.mesh.position) < 0.7);
      if (hit) {
        this.hits += 1;
        this.targets = this.targets.filter((t) => t !== hit);
        killMesh(this.ctx.engine.scene, hit);
        killMesh(this.ctx.engine.scene, a.mesh);
        if (this.hits >= 8) {
          this.status = "won";
      lookOf(this.ctx.engine).sfx(523, 0.28, "triangle", 0.05, 220);
      lookOf(this.ctx.engine).shockwave(new THREE.Vector3(), lookOf(this.ctx.engine).accent, 1.2);
          this.ctx.emitHud({ status: "won", score: this.hits * 20 + this.arrowsLeft * 5, objective: "靶场清空", toast: "满贯" });
        }
        return false;
      }
      if (a.mesh.position.z < -40) {
        killMesh(this.ctx.engine.scene, a.mesh);
        return false;
      }
      return true;
    });
    if (this.hits < 8 && this.arrowsLeft <= 0 && this.arrows.length === 0) {
      this.status = "lost";
      lookOf(this.ctx.engine).sfx(90, 0.22, "sawtooth", 0.05, -50);
      this.ctx.emitHud({ status: "lost", score: this.hits * 20, lives: 0, objective: `只中 ${this.hits} 靶`, toast: "箭尽" });
      return;
    }
    this.pushHud();
  }

  private clear() {
    this.targets.forEach((t) => killMesh(this.ctx.engine.scene, t));
    this.targets = [];
    this.arrows.forEach((a) => killMesh(this.ctx.engine.scene, a.mesh));
    this.arrows = [];
  }

  private pushHud() {
    this.hudAcc += 0.016;
    if (this.hudAcc < 0.16) return;
    this.hudAcc = 0;
    this.ctx.emitHud({ status: "playing", score: this.hits * 20, lives: this.arrowsLeft, objective: `命中 ${this.hits} / 8 · 余箭 ${this.arrowsLeft}` });
  }
}

export class RingClashGame implements MiniGame {
  private ctx!: GameContext;
  private status: Run = "playing";
  private you = new THREE.Mesh();
  private ai = new THREE.Mesh();
  private youVel = new THREE.Vector3();
  private aiVel = new THREE.Vector3();
  private wins = 0;
  private losses = 0;
  private hudAcc = 0;

  mount(ctx: GameContext) {
    this.ctx = ctx;
    installLook(ctx.engine, { accent: NEON.pink, bg: 0x120814 });
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 5.2, 0.4, 32), neonMat(NEON.violet, 0.35));
    ring.position.y = -0.2;
    ctx.engine.scene.add(ring);
    this.you = new THREE.Mesh(new THREE.SphereGeometry(0.7, 16, 12), neonMat(NEON.cyan, 0.9));
    this.ai = new THREE.Mesh(new THREE.SphereGeometry(0.7, 16, 12), neonMat(NEON.rose, 0.9));
    ctx.engine.scene.add(this.you, this.ai);
    ctx.engine.camera.position.set(0, 12, 10);
    ctx.engine.camera.lookAt(0, 0, 0);
    ctx.emitHud({ status: "ready", score: 0, objective: "把对手撞出圆环，先赢两局" });
  }

  start() {
    this.status = "playing";
    this.wins = 0;
    this.losses = 0;
    this.resetRound();
    this.ctx.emitHud({ status: "playing", score: 0, objective: "先赢两局", toast: "对撞" });
  }

  pause() {}
  resume() {}
  dispose() {}

  update(dt: number) {
    if (this.status !== "playing") return;
    const axis = this.ctx.engine.axis();
    this.youVel.x += axis.x * 18 * dt;
    this.youVel.z -= axis.y * 18 * dt;
    const toYou = this.you.position.clone().sub(this.ai.position);
    toYou.y = 0;
    if (toYou.lengthSq() > 0) toYou.normalize();
    this.aiVel.addScaledVector(toYou, 11 * dt);
    this.youVel.multiplyScalar(Math.exp(-2 * dt));
    this.aiVel.multiplyScalar(Math.exp(-2 * dt));
    this.you.position.addScaledVector(this.youVel, dt);
    this.ai.position.addScaledVector(this.aiVel, dt);
    this.you.position.y = 0.7;
    this.ai.position.y = 0.7;
    const d = this.you.position.clone().sub(this.ai.position);
    d.y = 0;
    if (d.length() < 1.4 && d.length() > 0) {
      const n = d.normalize();
      const rel = this.youVel.clone().sub(this.aiVel).dot(n);
      if (rel < 0) {
        this.youVel.addScaledVector(n, -rel);
        this.aiVel.addScaledVector(n, rel);
      }
    }
    const youOut = Math.hypot(this.you.position.x, this.you.position.z) > 5.3;
    const aiOut = Math.hypot(this.ai.position.x, this.ai.position.z) > 5.3;
    if (youOut || aiOut) {
      if (aiOut && !youOut) this.wins += 1;
      else if (youOut && !aiOut) this.losses += 1;
      else {
        this.wins += 0;
      }
      if (this.wins >= 2) {
        this.status = "won";
      lookOf(this.ctx.engine).sfx(523, 0.28, "triangle", 0.05, 220);
      lookOf(this.ctx.engine).shockwave(new THREE.Vector3(), lookOf(this.ctx.engine).accent, 1.2);
        this.ctx.emitHud({ status: "won", score: this.wins, objective: `${this.wins} : ${this.losses}`, toast: "擂台胜" });
        return;
      }
      if (this.losses >= 2) {
        this.status = "lost";
      lookOf(this.ctx.engine).sfx(90, 0.22, "sawtooth", 0.05, -50);
        this.ctx.emitHud({ status: "lost", score: this.wins, objective: `${this.wins} : ${this.losses}`, toast: "出局" });
        return;
      }
      this.resetRound();
      this.ctx.emitHud({ toast: `${this.wins} : ${this.losses}` });
    }
    this.pushHud();
  }

  private resetRound() {
    this.you.position.set(-1.6, 0.7, 0);
    this.ai.position.set(1.6, 0.7, 0);
    this.youVel.set(0, 0, 0);
    this.aiVel.set(0, 0, 0);
  }

  private pushHud() {
    this.hudAcc += 0.016;
    if (this.hudAcc < 0.18) return;
    this.hudAcc = 0;
    this.ctx.emitHud({ status: "playing", score: this.wins, objective: `局分 ${this.wins} : ${this.losses}（先到 2）` });
  }
}
