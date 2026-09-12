import * as THREE from "three";
import { NEON, neonMat, matteMat } from "./engine";
import { circuitFloor, installLook, lookOf } from "./look";
import { clamp } from "./math";
import { killMesh } from "./kit";
import type { GameContext, MiniGame } from "./types";

type Run = "playing" | "won" | "lost";

export class ArcBatteryGame implements MiniGame {
  private ctx!: GameContext;
  private status: Run = "playing";
  private angle = 0.7;
  private power = 14;
  private barrel = new THREE.Mesh();
  private shots: Array<{ mesh: THREE.Mesh; vel: THREE.Vector3 }> = [];
  private forts: THREE.Mesh[] = [];
  private cd = 0;
  private hudAcc = 0;
  private ammo = 12;

  mount(ctx: GameContext) {
    this.ctx = ctx;
    installLook(ctx.engine, { accent: NEON.orange, bg: 0x140c08 });
    ctx.engine.scene.add(circuitFloor(36, lookOf(ctx.engine)));
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.8, 0.5, 10), neonMat(NEON.slate, 0.3));
    base.position.set(-12, 0.25, 0);
    this.barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 2.2, 8), neonMat(NEON.amber, 0.8));
    ctx.engine.scene.add(base, this.barrel);
    ctx.engine.camera.position.set(0, 12, 18);
    ctx.engine.camera.lookAt(0, 1, 0);
    ctx.emitHud({ status: "ready", score: 0, objective: "调整角度与力度，炸毁对面 4 座堡垒" });
  }

  start() {
    this.status = "playing";
    this.angle = 0.7;
    this.power = 14;
    this.ammo = 12;
    this.cd = 0;
    this.clear();
    for (let i = 0; i < 4; i++) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.6, 1.4), neonMat(NEON.rose, 0.6));
      mesh.position.set(6 + i * 2.2, 0.8, (i - 1.5) * 2.4);
      this.ctx.engine.scene.add(mesh);
      this.forts.push(mesh);
    }
    this.ctx.emitHud({ status: "playing", score: 0, lives: 12, objective: "W/S 角度 · A/D 力度 · 空格开火", toast: "装填" });
  }

  pause() {}
  resume() {}
  dispose() {
    this.clear();
  }

  update(dt: number) {
    if (this.status !== "playing") return;
    const axis = this.ctx.engine.axis();
    this.angle = clamp(this.angle + axis.y * 0.9 * dt, 0.15, 1.35);
    this.power = clamp(this.power + axis.x * 10 * dt, 7, 24);
    this.barrel.position.set(-12 + Math.cos(this.angle), 0.6 + Math.sin(this.angle), 0);
    this.barrel.rotation.z = this.angle - Math.PI / 2;
    this.cd = Math.max(0, this.cd - dt);
    if ((this.ctx.engine.jumpPressed() || this.ctx.engine.firePressed()) && this.cd <= 0 && this.ammo > 0) {
      this.cd = 0.45;
      this.ammo -= 1;
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 8), neonMat(NEON.amber, 1));
      const dir = new THREE.Vector3(Math.cos(this.angle), Math.sin(this.angle), 0);
      mesh.position.set(-12, 0.7, 0).addScaledVector(dir, 1.4);
      this.ctx.engine.scene.add(mesh);
      this.shots.push({ mesh, vel: dir.multiplyScalar(this.power) });
    }
    this.shots = this.shots.filter((s) => {
      s.vel.y -= 12 * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      const hit = this.forts.find((f) => f.position.distanceTo(s.mesh.position) < 1.1);
      if (hit) {
        this.forts = this.forts.filter((f) => f !== hit);
        killMesh(this.ctx.engine.scene, hit);
        killMesh(this.ctx.engine.scene, s.mesh);
        if (this.forts.length === 0) {
          this.status = "won";
      lookOf(this.ctx.engine).sfx(523, 0.28, "triangle", 0.05, 220);
      lookOf(this.ctx.engine).shockwave(new THREE.Vector3(), lookOf(this.ctx.engine).accent, 1.2);
          this.ctx.emitHud({ status: "won", score: this.ammo * 15 + 80, objective: "堡垒清空", toast: "命中" });
        }
        return false;
      }
      if (s.mesh.position.y < 0 || s.mesh.position.x > 18) {
        killMesh(this.ctx.engine.scene, s.mesh);
        return false;
      }
      return true;
    });
    if (this.forts.length > 0 && this.ammo <= 0 && this.shots.length === 0) {
      this.status = "lost";
      lookOf(this.ctx.engine).sfx(90, 0.22, "sawtooth", 0.05, -50);
      this.ctx.emitHud({ status: "lost", lives: 0, objective: "弹药耗尽", toast: "哑火" });
      return;
    }
    this.pushHud();
  }

  private clear() {
    this.shots.forEach((s) => killMesh(this.ctx.engine.scene, s.mesh));
    this.shots = [];
    this.forts.forEach((f) => killMesh(this.ctx.engine.scene, f));
    this.forts = [];
  }

  private pushHud() {
    this.hudAcc += 0.016;
    if (this.hudAcc < 0.16) return;
    this.hudAcc = 0;
    this.ctx.emitHud({
      status: "playing",
      score: (4 - this.forts.length) * 25,
      lives: this.ammo,
      objective: `角 ${(this.angle * 57.3) | 0}° · 力 ${this.power | 0} · 剩 ${this.forts.length} 堡`,
    });
  }
}

export class LightDuelGame implements MiniGame {
  private ctx!: GameContext;
  private status: Run = "playing";
  private you = { x: -6, z: 0, dx: 0.04, dz: 0, trail: [] as THREE.Mesh[] };
  private ai = { x: 6, z: 0, dx: -0.04, dz: 0, trail: [] as THREE.Mesh[] };
  private acc = 0;
  private hudAcc = 0;
  private occupied = new Set<string>();

  mount(ctx: GameContext) {
    this.ctx = ctx;
    installLook(ctx.engine, { accent: NEON.cyan, bg: 0x050814 });
    ctx.engine.scene.add(circuitFloor(24, lookOf(ctx.engine)));
    ctx.engine.camera.position.set(0, 22, 0.2);
    ctx.engine.camera.lookAt(0, 0, 0);
    ctx.emitHud({ status: "ready", score: 0, objective: "留下光轨，让对手先撞" });
  }

  start() {
    this.status = "playing";
    this.clear();
    this.you = { x: -6, z: 0, dx: 0.25, dz: 0, trail: [] };
    this.ai = { x: 6, z: 0, dx: -0.25, dz: 0, trail: [] };
    this.acc = 0;
    this.occupied = new Set();
    this.ctx.emitHud({ status: "playing", score: 0, objective: "不要撞墙和光轨", toast: "加速" });
  }

  pause() {}
  resume() {}
  dispose() {
    this.clear();
  }

  update(dt: number) {
    if (this.status !== "playing") return;
    const axis = this.ctx.engine.axis();
    if (axis.x && this.you.dz !== 0) {
      this.you.dx = axis.x * 0.25;
      this.you.dz = 0;
    }
    if (axis.y && this.you.dx !== 0) {
      this.you.dz = -axis.y * 0.25;
      this.you.dx = 0;
    }
    this.steerAi();
    this.acc += dt;
    if (this.acc < 0.05) return;
    this.acc = 0;
    if (!this.step(this.you, NEON.cyan)) {
      this.status = "lost";
      lookOf(this.ctx.engine).sfx(90, 0.22, "sawtooth", 0.05, -50);
      this.ctx.emitHud({ status: "lost", objective: "你的光轨撞毁", toast: "出局" });
      return;
    }
    if (!this.step(this.ai, NEON.rose)) {
      this.status = "won";
      lookOf(this.ctx.engine).sfx(523, 0.28, "triangle", 0.05, 220);
      lookOf(this.ctx.engine).shockwave(new THREE.Vector3(), lookOf(this.ctx.engine).accent, 1.2);
      this.ctx.emitHud({ status: "won", score: this.you.trail.length, objective: "对手撞轨", toast: "胜出" });
    }
    this.pushHud();
  }

  private step(bike: { x: number; z: number; dx: number; dz: number; trail: THREE.Mesh[] }, color: number) {
    bike.x += bike.dx;
    bike.z += bike.dz;
    if (Math.abs(bike.x) > 10 || Math.abs(bike.z) > 10) return false;
    const key = `${bike.x.toFixed(2)},${bike.z.toFixed(2)}`;
    if (this.occupied.has(key)) return false;
    this.occupied.add(key);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.35, 0.22), neonMat(color, 0.9));
    mesh.position.set(bike.x, 0.2, bike.z);
    this.ctx.engine.scene.add(mesh);
    bike.trail.push(mesh);
    return true;
  }

  private steerAi() {
    const nextX = this.ai.x + this.ai.dx;
    const nextZ = this.ai.z + this.ai.dz;
    const blocked = Math.abs(nextX) > 9.5 || Math.abs(nextZ) > 9.5 || this.occupied.has(`${nextX.toFixed(2)},${nextZ.toFixed(2)}`);
    if (blocked) {
      const opts = [
        { dx: 0.25, dz: 0 },
        { dx: -0.25, dz: 0 },
        { dx: 0, dz: 0.25 },
        { dx: 0, dz: -0.25 },
      ].filter((o) => o.dx !== this.ai.dx || o.dz !== this.ai.dz);
      const pick = opts[Math.floor(Math.random() * opts.length)];
      this.ai.dx = pick.dx;
      this.ai.dz = pick.dz;
    }
  }

  private clear() {
    this.you.trail.forEach((m) => killMesh(this.ctx.engine.scene, m));
    this.ai.trail.forEach((m) => killMesh(this.ctx.engine.scene, m));
    this.you.trail = [];
    this.ai.trail = [];
  }

  private pushHud() {
    this.hudAcc += 0.02;
    if (this.hudAcc < 0.2) return;
    this.hudAcc = 0;
    this.ctx.emitHud({ status: "playing", score: this.you.trail.length, objective: `光轨 ${this.you.trail.length}` });
  }
}

export class LatticeBlastGame implements MiniGame {
  private ctx!: GameContext;
  private status: Run = "playing";
  private n = 9;
  private blocks = new Map<string, THREE.Mesh>();
  private px = 1;
  private pz = 1;
  private player = new THREE.Mesh();
  private bombs: Array<{ x: number; z: number; t: number; mesh: THREE.Mesh }> = [];
  private foes: Array<{ x: number; z: number; mesh: THREE.Mesh; acc: number }> = [];
  private moveCd = 0;
  private hudAcc = 0;
  private killed = 0;

  mount(ctx: GameContext) {
    this.ctx = ctx;
    installLook(ctx.engine, { accent: NEON.amber, bg: 0x0c1018 });
    this.player = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), neonMat(NEON.cyan, 0.9));
    ctx.engine.scene.add(this.player);
    ctx.engine.camera.position.set(0, 16, 10);
    ctx.engine.camera.lookAt(0, 0, 0);
    ctx.emitHud({ status: "ready", score: 0, objective: "空格放炸弹，炸掉 3 个敌人" });
  }

  start() {
    this.status = "playing";
    this.killed = 0;
    this.px = 1;
    this.pz = 1;
    this.moveCd = 0;
    this.clear();
    this.build();
    this.place();
    this.ctx.emitHud({ status: "playing", score: 0, objective: "炸掉 3 个敌人", toast: "爆破" });
  }

  pause() {}
  resume() {}
  dispose() {
    this.clear();
  }

  update(dt: number) {
    if (this.status !== "playing") return;
    this.moveCd = Math.max(0, this.moveCd - dt);
    const axis = this.ctx.engine.axis();
    if (this.moveCd <= 0 && (axis.x || axis.y)) {
      const nx = this.px + axis.x;
      const nz = this.pz - axis.y;
      if (this.walkable(nx, nz)) {
        this.px = nx;
        this.pz = nz;
        this.moveCd = 0.14;
        this.place();
      }
    }
    if ((this.ctx.engine.jumpPressed() || this.ctx.engine.firePressed()) && this.bombs.length < 2) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), neonMat(NEON.orange, 1));
      mesh.position.copy(this.world(this.px, this.pz)).setY(0.4);
      this.ctx.engine.scene.add(mesh);
      this.bombs.push({ x: this.px, z: this.pz, t: 1.6, mesh });
    }
    this.bombs = this.bombs.filter((b) => {
      b.t -= dt;
      b.mesh.scale.setScalar(1 + Math.sin(b.t * 10) * 0.1);
      if (b.t > 0) return true;
      this.explode(b.x, b.z);
      killMesh(this.ctx.engine.scene, b.mesh);
      return false;
    });
    for (const f of this.foes) {
      f.acc += dt;
      if (f.acc > 0.5) {
        f.acc = 0;
        const opts = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].filter(([x, z]) => this.walkable(f.x + x, f.z + z));
        if (opts.length) {
          const [x, z] = opts[Math.floor(Math.random() * opts.length)];
          f.x += x;
          f.z += z;
          f.mesh.position.copy(this.world(f.x, f.z)).setY(0.4);
        }
      }
      if (f.x === this.px && f.z === this.pz) {
        this.status = "lost";
      lookOf(this.ctx.engine).sfx(90, 0.22, "sawtooth", 0.05, -50);
        this.ctx.emitHud({ status: "lost", score: this.killed, objective: "被敌人碰上", toast: "炸自己之前先被撞" });
        return;
      }
    }
    this.pushHud();
  }

  private explode(x: number, z: number) {
    const cells = [
      [x, z],
      [x + 1, z],
      [x - 1, z],
      [x, z + 1],
      [x, z - 1],
    ];
    for (const [cx, cz] of cells) {
      const key = `${cx},${cz}`;
      const block = this.blocks.get(key);
      if (block && block.userData.soft) {
        killMesh(this.ctx.engine.scene, block);
        this.blocks.delete(key);
      }
      if (cx === this.px && cz === this.pz) {
        this.status = "lost";
      lookOf(this.ctx.engine).sfx(90, 0.22, "sawtooth", 0.05, -50);
        this.ctx.emitHud({ status: "lost", objective: "被自己的炸弹波及", toast: "误炸" });
      }
      this.foes = this.foes.filter((f) => {
        if (f.x !== cx || f.z !== cz) return true;
        killMesh(this.ctx.engine.scene, f.mesh);
        this.killed += 1;
        if (this.killed >= 3) {
          this.status = "won";
      lookOf(this.ctx.engine).sfx(523, 0.28, "triangle", 0.05, 220);
      lookOf(this.ctx.engine).shockwave(new THREE.Vector3(), lookOf(this.ctx.engine).accent, 1.2);
          this.ctx.emitHud({ status: "won", score: this.killed * 50, objective: "敌人清除", toast: "爆破成功" });
        }
        return false;
      });
    }
  }

  private build() {
    for (let z = 0; z < this.n; z++) {
      for (let x = 0; x < this.n; x++) {
        const edge = x === 0 || z === 0 || x === this.n - 1 || z === this.n - 1;
        const pillar = x % 2 === 0 && z % 2 === 0;
        const start = x + z < 3;
        if (!edge && !pillar && !start && Math.random() < 0.45) {
          const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), neonMat(NEON.indigo, 0.35));
          mesh.position.copy(this.world(x, z)).setY(0.45);
          mesh.userData.soft = true;
          this.ctx.engine.scene.add(mesh);
          this.blocks.set(`${x},${z}`, mesh);
        }
        if (edge || pillar) {
          const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1.2, 1), matteMat(0x334155, 0.2));
          mesh.position.copy(this.world(x, z)).setY(0.6);
          this.ctx.engine.scene.add(mesh);
          this.blocks.set(`${x},${z}`, mesh);
        }
      }
    }
    [
      [5, 5],
      [7, 3],
      [3, 7],
    ].forEach(([x, z]) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.65, 0.65), neonMat(NEON.rose, 0.85));
      mesh.position.copy(this.world(x, z)).setY(0.4);
      this.ctx.engine.scene.add(mesh);
      this.foes.push({ x, z, mesh, acc: 0 });
    });
  }

  private walkable(x: number, z: number) {
    return !this.blocks.has(`${x},${z}`) && !this.bombs.some((b) => b.x === x && b.z === z);
  }

  private world(x: number, z: number) {
    return new THREE.Vector3((x - 4) * 1.15, 0, (z - 4) * 1.15);
  }

  private place() {
    this.player.position.copy(this.world(this.px, this.pz)).setY(0.4);
  }

  private clear() {
    this.blocks.forEach((m) => killMesh(this.ctx.engine.scene, m));
    this.blocks.clear();
    this.bombs.forEach((b) => killMesh(this.ctx.engine.scene, b.mesh));
    this.bombs = [];
    this.foes.forEach((f) => killMesh(this.ctx.engine.scene, f.mesh));
    this.foes = [];
  }

  private pushHud() {
    this.hudAcc += 0.016;
    if (this.hudAcc < 0.18) return;
    this.hudAcc = 0;
    this.ctx.emitHud({ status: "playing", score: this.killed * 50, objective: `击破 ${this.killed} / 3 · 空格放弹` });
  }
}

const SOKO: string[][] = [
  ["######", "#@.$.#", "# $$ #", "#  . #", "######"],
  ["#####", "#.$.#", "# $ #", "#@  #", "#####"],
  ["#######", "#. . .#", "# $$$ #", "#  @  #", "#######"],
];

export class CubeShoveGame implements MiniGame {
  private ctx!: GameContext;
  private status: Run = "playing";
  private level = 0;
  private map: string[] = [];
  private tiles: THREE.Mesh[] = [];
  private moveCd = 0;
  private hudAcc = 0;

  mount(ctx: GameContext) {
    this.ctx = ctx;
    installLook(ctx.engine, { accent: NEON.violet, bg: 0x0c0818 });
    ctx.engine.camera.position.set(0, 14, 12);
    ctx.engine.camera.lookAt(0, 0, 0);
    ctx.emitHud({ status: "ready", score: 0, wave: 1, objective: "把箱子推到点上，三关" });
  }

  start() {
    this.status = "playing";
    this.level = 0;
    this.load(0);
    this.ctx.emitHud({ status: "playing", score: 0, wave: 1, objective: "关卡 1 / 3", toast: "推移" });
  }

  pause() {}
  resume() {}
  dispose() {
    this.clear();
  }

  update(dt: number) {
    if (this.status !== "playing") return;
    this.moveCd = Math.max(0, this.moveCd - dt);
    const axis = this.ctx.engine.axis();
    if (this.moveCd <= 0 && (axis.x || axis.y)) {
      this.tryMove(axis.x, -axis.y);
      this.moveCd = 0.16;
    }
    this.pushHud();
  }

  private load(i: number) {
    this.clear();
    this.map = SOKO[i].map((r) => r);
    this.draw();
  }

  private tryMove(dx: number, dz: number) {
    const p = this.find("@") || this.find("+");
    if (!p) return;
    const nx = p.x + dx;
    const nz = p.z + dz;
    const dest = this.at(nx, nz);
    if (dest === "#" || dest === undefined) return;
    if (dest === "$" || dest === "*") {
      const bx = nx + dx;
      const bz = nz + dz;
      const beyond = this.at(bx, bz);
      if (beyond !== " " && beyond !== ".") return;
      this.set(bx, bz, beyond === "." ? "*" : "$");
      this.set(nx, nz, dest === "*" ? "." : " ");
    }
    const here = this.at(p.x, p.z);
    this.set(p.x, p.z, here === "+" ? "." : " ");
    const land = this.at(nx, nz);
    if (land === "." ) this.set(nx, nz, "+");
    else this.set(nx, nz, "@");
    this.draw();
    if (this.solved()) {
      if (this.level >= SOKO.length - 1) {
        this.status = "won";
      lookOf(this.ctx.engine).sfx(523, 0.28, "triangle", 0.05, 220);
      lookOf(this.ctx.engine).shockwave(new THREE.Vector3(), lookOf(this.ctx.engine).accent, 1.2);
        this.ctx.emitHud({ status: "won", score: 300, wave: 3, objective: "三关推完", toast: "归位" });
        return;
      }
      this.level += 1;
      this.load(this.level);
      this.ctx.emitHud({ toast: `关卡 ${this.level + 1}`, wave: this.level + 1, score: this.level * 100 });
    }
  }

  private solved() {
    return !this.map.some((r) => r.includes("$"));
  }

  private find(ch: string) {
    for (let z = 0; z < this.map.length; z++) {
      const x = this.map[z].indexOf(ch);
      if (x >= 0) return { x, z };
    }
    return null;
  }

  private at(x: number, z: number) {
    return this.map[z]?.[x];
  }

  private set(x: number, z: number, ch: string) {
    const row = this.map[z];
    this.map[z] = row.slice(0, x) + ch + row.slice(x + 1);
  }

  private draw() {
    this.clear();
    const ox = this.map[0].length / 2;
    const oz = this.map.length / 2;
    this.map.forEach((row, z) => {
      [...row].forEach((ch, x) => {
        const pos = new THREE.Vector3(x - ox, 0, z - oz);
        if (ch === "#") {
          const m = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1, 0.95), matteMat(0x334155, 0.2));
          m.position.copy(pos).setY(0.5);
          this.ctx.engine.scene.add(m);
          this.tiles.push(m);
        }
        if (ch === "." || ch === "*" || ch === "+") {
          const m = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.08, 0.7), neonMat(NEON.emerald, 0.5));
          m.position.copy(pos).setY(0.04);
          this.ctx.engine.scene.add(m);
          this.tiles.push(m);
        }
        if (ch === "$" || ch === "*") {
          const m = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), neonMat(NEON.amber, 0.8));
          m.position.copy(pos).setY(0.4);
          this.ctx.engine.scene.add(m);
          this.tiles.push(m);
        }
        if (ch === "@" || ch === "+") {
          const m = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.8, 0.6), neonMat(NEON.cyan, 0.9));
          m.position.copy(pos).setY(0.45);
          this.ctx.engine.scene.add(m);
          this.tiles.push(m);
        }
      });
    });
  }

  private clear() {
    this.tiles.forEach((t) => killMesh(this.ctx.engine.scene, t));
    this.tiles = [];
  }

  private pushHud() {
    this.hudAcc += 0.016;
    if (this.hudAcc < 0.2) return;
    this.hudAcc = 0;
    this.ctx.emitHud({ status: "playing", score: this.level * 100, wave: this.level + 1, objective: `关卡 ${this.level + 1} / 3` });
  }
}

export class WormholeDiveGame implements MiniGame {
  private ctx!: GameContext;
  private status: Run = "playing";
  private x = 0;
  private y = 0;
  private z = 0;
  private ship = new THREE.Mesh();
  private rings: Array<{ mesh: THREE.Mesh; x: number; y: number; z: number; passed: boolean }> = [];
  private passed = 0;
  private lives = 3;
  private hudAcc = 0;
  private next = 12;

  mount(ctx: GameContext) {
    this.ctx = ctx;
    installLook(ctx.engine, { accent: NEON.violet, bg: 0x050816 });
    this.ship = new THREE.Mesh(new THREE.ConeGeometry(0.28, 1.1, 8), neonMat(NEON.cyan, 0.95));
    this.ship.rotation.x = Math.PI / 2;
    ctx.engine.scene.add(this.ship);
    ctx.emitHud({ status: "ready", score: 0, lives: 3, objective: "穿过 12 个虫洞环" });
  }

  start() {
    this.status = "playing";
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.passed = 0;
    this.lives = 3;
    this.next = 10;
    this.clear();
    this.ctx.emitHud({ status: "playing", score: 0, lives: 3, objective: "穿过 12 个环", toast: "俯冲" });
  }

  pause() {}
  resume() {}
  dispose() {
    this.clear();
  }

  update(dt: number) {
    if (this.status !== "playing") return;
    const axis = this.ctx.engine.axis();
    this.x = clamp(this.x + axis.x * 8 * dt, -2.4, 2.4);
    this.y = clamp(this.y + axis.y * 8 * dt, -2.2, 2.2);
    this.z += 18 * dt;
    this.ship.position.set(this.x, this.y, this.z);
    this.ctx.engine.camera.position.set(this.x * 0.3, this.y * 0.3, this.z - 6);
    this.ctx.engine.camera.lookAt(this.x, this.y, this.z + 8);
    while (this.next < this.z + 40) {
      const mesh = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.08, 8, 24), neonMat(NEON.violet, 0.9));
      const rx = (Math.random() - 0.5) * 2.4;
      const ry = (Math.random() - 0.5) * 2;
      mesh.position.set(rx, ry, this.next);
      this.ctx.engine.scene.add(mesh);
      this.rings.push({ mesh, x: rx, y: ry, z: this.next, passed: false });
      this.next += 8;
    }
    for (const ring of this.rings) {
      if (ring.passed || ring.z > this.z + 0.6) continue;
      if (ring.z < this.z - 0.8) continue;
      const d = Math.hypot(this.x - ring.x, this.y - ring.y);
      ring.passed = true;
      if (d < 1.05) {
        this.passed += 1;
        (ring.mesh.material as THREE.MeshStandardMaterial).color.setHex(NEON.emerald);
        if (this.passed >= 12) {
          this.status = "won";
      lookOf(this.ctx.engine).sfx(523, 0.28, "triangle", 0.05, 220);
      lookOf(this.ctx.engine).shockwave(new THREE.Vector3(), lookOf(this.ctx.engine).accent, 1.2);
          this.ctx.emitHud({ status: "won", score: this.passed * 10, lives: this.lives, objective: "虫洞穿越完成", toast: "出隧" });
          return;
        }
      } else {
        this.lives -= 1;
        if (this.lives <= 0) {
          this.status = "lost";
      lookOf(this.ctx.engine).sfx(90, 0.22, "sawtooth", 0.05, -50);
          this.ctx.emitHud({ status: "lost", lives: 0, score: this.passed, objective: "偏离环心", toast: "擦环失败" });
          return;
        }
        this.ctx.emitHud({ toast: "擦环", lives: this.lives });
      }
    }
    this.rings = this.rings.filter((r) => {
      if (r.z > this.z - 10) return true;
      killMesh(this.ctx.engine.scene, r.mesh);
      return false;
    });
    this.pushHud();
  }

  private clear() {
    this.rings.forEach((r) => killMesh(this.ctx.engine.scene, r.mesh));
    this.rings = [];
  }

  private pushHud() {
    this.hudAcc += 0.016;
    if (this.hudAcc < 0.14) return;
    this.hudAcc = 0;
    this.ctx.emitHud({ status: "playing", score: this.passed * 10, lives: this.lives, objective: `穿环 ${this.passed} / 12` });
  }
}
