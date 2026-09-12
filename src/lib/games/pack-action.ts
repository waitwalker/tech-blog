import * as THREE from "three";
import { NEON, neonMat, matteMat } from "./engine";
import { circuitFloor, installLook, lookOf } from "./look";
import { clamp } from "./math";
import { groundPick, killMesh } from "./kit";
import type { GameContext, MiniGame } from "./types";

type Run = "playing" | "won" | "lost";

export class StardustSweepGame implements MiniGame {
  private ctx!: GameContext;
  private status: Run = "playing";
  private score = 0;
  private lives = 3;
  private cd = 0;
  private hurt = 0;
  private hudAcc = 0;
  private player = new THREE.Mesh();
  private facing = new THREE.Vector3(0, 0, -1);
  private shots: Array<{ mesh: THREE.Mesh; dir: THREE.Vector3 }> = [];
  private foes: Array<{ mesh: THREE.Mesh; hp: number }> = [];
  private spawn = 0;

  mount(ctx: GameContext) {
    this.ctx = ctx;
    installLook(ctx.engine, { accent: NEON.cyan, bg: 0x071018 });
    ctx.engine.scene.add(circuitFloor(36, lookOf(ctx.engine)));
    this.player = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.2, 6), neonMat(NEON.cyan, 0.9));
    this.player.rotation.x = Math.PI / 2;
    ctx.engine.scene.add(this.player);
    ctx.engine.camera.position.set(0, 26, 14);
    ctx.engine.camera.lookAt(0, 0, 0);
    ctx.emitHud({ status: "ready", score: 0, lives: 3, objective: "击毁 28 个星尘体" });
  }

  start() {
    this.status = "playing";
    this.score = 0;
    this.lives = 3;
    this.cd = 0;
    this.hurt = 0;
    this.spawn = 0;
    this.player.position.set(0, 0.4, 6);
    this.clearShots();
    this.clearFoes();
    this.ctx.emitHud({ status: "playing", score: 0, lives: 3, objective: "击毁 28 个星尘体", toast: "扫荡开始" });
  }

  pause() {}
  resume() {}
  dispose() {
    this.clearShots();
    this.clearFoes();
  }

  update(dt: number) {
    if (this.status !== "playing") return;
    const axis = this.ctx.engine.axis();
    this.player.position.x = clamp(this.player.position.x + axis.x * 11 * dt, -15, 15);
    this.player.position.z = clamp(this.player.position.z - axis.y * 11 * dt, -15, 15);
    const aim = groundPick(this.ctx.engine.camera, this.ctx.engine.pointerNdc.ndcX, this.ctx.engine.pointerNdc.ndcY);
    this.facing.set(aim.x - this.player.position.x, 0, aim.z - this.player.position.z);
    if (this.facing.lengthSq() < 0.01) this.facing.set(axis.x, 0, -axis.y);
    if (this.facing.lengthSq() > 0.01) this.facing.normalize();
    this.player.rotation.z = Math.atan2(this.facing.x, this.facing.z);

    this.cd = Math.max(0, this.cd - dt);
    this.hurt = Math.max(0, this.hurt - dt);
    if ((this.ctx.engine.firePressed() || this.ctx.engine.keys.has("Space")) && this.cd <= 0) {
      this.cd = 0.14;
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), neonMat(NEON.amber, 1));
      mesh.position.copy(this.player.position).addScaledVector(this.facing, 0.8);
      this.ctx.engine.scene.add(mesh);
      this.shots.push({ mesh, dir: this.facing.clone() });
    }

    this.spawn -= dt;
    if (this.spawn <= 0 && this.foes.length < 10) {
      this.spawn = 0.7;
      const ang = Math.random() * Math.PI * 2;
      const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.48, 0), neonMat(NEON.rose, 0.8));
      mesh.position.set(Math.cos(ang) * 14, 0.45, Math.sin(ang) * 14);
      this.ctx.engine.scene.add(mesh);
      this.foes.push({ mesh, hp: 1 });
    }

    this.shots = this.shots.filter((shot) => {
      shot.mesh.position.addScaledVector(shot.dir, 28 * dt);
      if (shot.mesh.position.length() > 22) {
        killMesh(this.ctx.engine.scene, shot.mesh);
        return false;
      }
      const hit = this.foes.find((f) => f.mesh.position.distanceTo(shot.mesh.position) < 0.7);
      if (hit) {
        this.score += 1;
        this.foes = this.foes.filter((f) => f !== hit);
        killMesh(this.ctx.engine.scene, hit.mesh);
        killMesh(this.ctx.engine.scene, shot.mesh);
        if (this.score >= 28) {
          this.status = "won";
      lookOf(this.ctx.engine).sfx(523, 0.28, "triangle", 0.05, 220);
      lookOf(this.ctx.engine).shockwave(new THREE.Vector3(), lookOf(this.ctx.engine).accent, 1.2);
          this.ctx.emitHud({ status: "won", score: this.score, objective: "星尘清扫完毕", toast: "空域安全" });
        }
        return false;
      }
      return true;
    });

    for (const foe of [...this.foes]) {
      const dir = this.player.position.clone().sub(foe.mesh.position);
      dir.y = 0;
      if (dir.lengthSq() > 0) dir.normalize();
      foe.mesh.position.addScaledVector(dir, 3.4 * dt);
      if (foe.mesh.position.distanceTo(this.player.position) < 0.95 && this.hurt <= 0) {
        this.lives -= 1;
        this.hurt = 0.8;
        if (this.lives <= 0) {
          this.status = "lost";
      lookOf(this.ctx.engine).sfx(90, 0.22, "sawtooth", 0.05, -50);
          this.ctx.emitHud({ status: "lost", lives: 0, score: this.score, objective: "机体过载", toast: "被吞没" });
          return;
        }
        this.ctx.emitHud({ toast: "受损", lives: this.lives });
      }
    }
    this.pushHud();
  }

  private clearShots() {
    this.shots.forEach((s) => killMesh(this.ctx.engine.scene, s.mesh));
    this.shots = [];
  }
  private clearFoes() {
    this.foes.forEach((f) => killMesh(this.ctx.engine.scene, f.mesh));
    this.foes = [];
  }
  private pushHud() {
    this.hudAcc += 0.016;
    if (this.hudAcc < 0.18) return;
    this.hudAcc = 0;
    this.ctx.emitHud({ status: "playing", score: this.score, lives: this.lives, objective: `击毁 ${this.score} / 28` });
  }
}

const MAZE = [
  "###########",
  "#P..#...K.#",
  "#.##.#.##.#",
  "#.#.....#.#",
  "#.#.##G##.#",
  "#......#..#",
  "##.##.##.##",
  "#K#..G..#.#",
  "#.#.###.#.#",
  "#...#...KE#",
  "###########",
];

export class FogKeyhuntGame implements MiniGame {
  private ctx!: GameContext;
  private status: Run = "playing";
  private yaw = 0;
  private keysGot = 0;
  private keysNeed = 0;
  private pos = new THREE.Vector3();
  private solids: Array<{ x: number; z: number }> = [];
  private keys: THREE.Mesh[] = [];
  private guards: Array<{ mesh: THREE.Mesh; path: THREE.Vector3[]; i: number; t: number }> = [];
  private exit = new THREE.Vector3();
  private door!: THREE.Mesh;
  private wallMeshes: THREE.Mesh[] = [];
  private hudAcc = 0;

  mount(ctx: GameContext) {
    this.ctx = ctx;
    const { scene, camera } = ctx.engine;
    installLook(ctx.engine, { accent: NEON.violet, bg: 0x0b1018 });
    scene.add(camera);
    scene.add(circuitFloor(28, lookOf(ctx.engine)));
    camera.rotation.order = "YXZ";
    ctx.emitHud({ status: "ready", score: 0, objective: "取走钥匙，避开巡游体，抵达出口" });
  }

  start() {
    this.status = "playing";
    this.yaw = 0;
    this.keysGot = 0;
    this.buildMaze();
    this.ctx.engine.setPointerLock(true);
    this.placeCam();
    this.ctx.emitHud({ status: "playing", score: 0, objective: `钥匙 0 / ${this.keysNeed}`, toast: "探雾" });
  }

  pause() {
    this.ctx.engine.setPointerLock(false);
  }
  resume() {
    this.ctx.engine.setPointerLock(true);
  }
  dispose() {
    this.wipe();
  }

  update(dt: number) {
    if (this.status !== "playing") return;
    this.yaw -= this.ctx.engine.mouseDx * 0.0022;
    const axis = this.ctx.engine.axis();
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    this.tryMove((axis.y * sin + axis.x * cos) * 5.4 * dt, (axis.y * cos - axis.x * sin) * 5.4 * dt);
    this.placeCam();
    this.keys = this.keys.filter((key) => {
      if (key.position.distanceTo(this.pos) > 1.1) return true;
      this.keysGot += 1;
      killMesh(this.ctx.engine.scene, key);
      this.ctx.emitHud({ toast: "钥匙 +1", score: this.keysGot * 50 });
      return false;
    });
    for (const g of this.guards) {
      const a = g.path[g.i];
      const b = g.path[(g.i + 1) % g.path.length];
      g.t += dt * 1.3;
      if (g.t >= 1) {
        g.t = 0;
        g.i = (g.i + 1) % g.path.length;
      }
      g.mesh.position.lerpVectors(a, b, g.t);
      g.mesh.position.y = 0.9;
      if (g.mesh.position.distanceTo(this.pos) < 1.05) {
        this.status = "lost";
      lookOf(this.ctx.engine).sfx(90, 0.22, "sawtooth", 0.05, -50);
        this.ctx.engine.setPointerLock(false);
        this.ctx.emitHud({ status: "lost", objective: "被巡游体发现", toast: "暴露" });
        return;
      }
    }
    if (this.keysGot >= this.keysNeed && this.pos.distanceTo(this.exit) < 1.3) {
      this.status = "won";
      lookOf(this.ctx.engine).sfx(523, 0.28, "triangle", 0.05, 220);
      lookOf(this.ctx.engine).shockwave(new THREE.Vector3(), lookOf(this.ctx.engine).accent, 1.2);
      this.ctx.engine.setPointerLock(false);
      this.ctx.emitHud({ status: "won", score: 200, objective: "撤离成功", toast: "出口开启" });
      return;
    }
    this.door.material = neonMat(this.keysGot >= this.keysNeed ? NEON.emerald : NEON.rose, this.keysGot >= this.keysNeed ? 0.9 : 0.25);
    this.pushHud();
  }

  private buildMaze() {
    this.wipe();
    this.solids = [];
    this.keysNeed = 0;
    const cell = 2.2;
    const ox = -((MAZE[0].length - 1) * cell) / 2;
    const oz = -((MAZE.length - 1) * cell) / 2;
    MAZE.forEach((row, z) => {
      [...row].forEach((ch, x) => {
        const wx = ox + x * cell;
        const wz = oz + z * cell;
        if (ch === "#") {
          const mesh = new THREE.Mesh(new THREE.BoxGeometry(cell, 2.4, cell), matteMat(0x1e293b, 0.16));
          mesh.position.set(wx, 1.2, wz);
          this.ctx.engine.scene.add(mesh);
          this.wallMeshes.push(mesh);
          this.solids.push({ x: wx, z: wz });
        } else if (ch === "P") this.pos.set(wx, 1.5, wz);
        else if (ch === "K") {
          const key = new THREE.Mesh(new THREE.OctahedronGeometry(0.28), neonMat(NEON.amber, 1));
          key.position.set(wx, 0.8, wz);
          this.ctx.engine.scene.add(key);
          this.keys.push(key);
          this.keysNeed += 1;
        } else if (ch === "E") {
          this.exit.set(wx, 1.5, wz);
          this.door = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.08, 8, 20), neonMat(NEON.rose, 0.3));
          this.door.position.set(wx, 1.2, wz);
          this.ctx.engine.scene.add(this.door);
        } else if (ch === "G") {
          const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.5, 3, 8), neonMat(NEON.rose, 0.8));
          mesh.position.set(wx, 0.9, wz);
          this.ctx.engine.scene.add(mesh);
          this.guards.push({
            mesh,
            path: [new THREE.Vector3(wx, 0, wz), new THREE.Vector3(wx + 4.4, 0, wz), new THREE.Vector3(wx + 4.4, 0, wz + 4.4), new THREE.Vector3(wx, 0, wz + 4.4)],
            i: 0,
            t: 0,
          });
        }
      });
    });
  }

  private tryMove(dx: number, dz: number) {
    const nx = this.pos.x + dx;
    if (!this.blocked(nx, this.pos.z)) this.pos.x = nx;
    const nz = this.pos.z + dz;
    if (!this.blocked(this.pos.x, nz)) this.pos.z = nz;
  }

  private blocked(x: number, z: number) {
    return this.solids.some((s) => Math.abs(s.x - x) < 1.2 && Math.abs(s.z - z) < 1.2);
  }

  private placeCam() {
    this.ctx.engine.camera.position.copy(this.pos);
    this.ctx.engine.camera.rotation.y = this.yaw;
    this.ctx.engine.camera.rotation.x = 0;
  }

  private wipe() {
    this.keys.forEach((k) => killMesh(this.ctx.engine.scene, k));
    this.keys = [];
    this.guards.forEach((g) => killMesh(this.ctx.engine.scene, g.mesh));
    this.guards = [];
    this.wallMeshes.forEach((w) => killMesh(this.ctx.engine.scene, w));
    this.wallMeshes = [];
    if (this.door) killMesh(this.ctx.engine.scene, this.door);
    this.solids = [];
  }

  private pushHud() {
    this.hudAcc += 0.016;
    if (this.hudAcc < 0.2) return;
    this.hudAcc = 0;
    this.ctx.emitHud({
      status: "playing",
      score: this.keysGot * 50,
      objective: this.keysGot >= this.keysNeed ? "前往出口" : `钥匙 ${this.keysGot} / ${this.keysNeed}`,
    });
  }
}

export class CloudInterceptGame implements MiniGame {
  private ctx!: GameContext;
  private status: Run = "playing";
  private yaw = 0;
  private pitch = 0;
  private pos = new THREE.Vector3();
  private ship = new THREE.Group();
  private shots: Array<{ mesh: THREE.Mesh; dir: THREE.Vector3 }> = [];
  private targets: THREE.Mesh[] = [];
  private cd = 0;
  private hudAcc = 0;
  private score = 0;

  mount(ctx: GameContext) {
    this.ctx = ctx;
    installLook(ctx.engine, { accent: NEON.indigo, bg: 0x0a1224 });
    this.ship = new THREE.Group();
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.8, 8), neonMat(NEON.cyan, 0.85));
    body.rotation.x = Math.PI / 2;
    this.ship.add(body);
    ctx.engine.scene.add(this.ship);
    ctx.emitHud({ status: "ready", score: 0, objective: "击落 12 个浮空靶" });
  }

  start() {
    this.status = "playing";
    this.yaw = 0;
    this.pitch = 0.05;
    this.pos.set(0, 8, 18);
    this.score = 0;
    this.cd = 0;
    this.clear();
    for (let i = 0; i < 12; i++) this.spawnTarget();
    this.ctx.emitHud({ status: "playing", score: 0, objective: "击落 12 个浮空靶", toast: "起飞" });
  }

  pause() {}
  resume() {}
  dispose() {
    this.clear();
  }

  update(dt: number) {
    if (this.status !== "playing") return;
    const axis = this.ctx.engine.axis();
    this.yaw -= axis.x * 1.4 * dt;
    this.pitch = clamp(this.pitch + axis.y * 1.1 * dt, -0.7, 0.7);
    const forward = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    this.pos.addScaledVector(forward, 16 * dt);
    this.pos.y = clamp(this.pos.y, 3, 22);
    this.ship.position.copy(this.pos);
    this.ship.rotation.set(this.pitch, this.yaw, -axis.x * 0.3);
    this.ctx.engine.camera.position.copy(this.pos).addScaledVector(forward, -7).add(new THREE.Vector3(0, 2.2, 0));
    this.ctx.engine.camera.lookAt(this.pos.clone().add(forward));

    this.cd = Math.max(0, this.cd - dt);
    if ((this.ctx.engine.firePressed() || this.ctx.engine.jumpPressed()) && this.cd <= 0) {
      this.cd = 0.18;
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 6), neonMat(NEON.amber, 1));
      mesh.position.copy(this.pos).addScaledVector(forward, 1.4);
      this.ctx.engine.scene.add(mesh);
      this.shots.push({ mesh, dir: forward.clone() });
    }
    this.shots = this.shots.filter((shot) => {
      shot.mesh.position.addScaledVector(shot.dir, 42 * dt);
      const hit = this.targets.find((t) => t.position.distanceTo(shot.mesh.position) < 1.1);
      if (hit) {
        this.targets = this.targets.filter((t) => t !== hit);
        killMesh(this.ctx.engine.scene, hit);
        killMesh(this.ctx.engine.scene, shot.mesh);
        this.score += 1;
        if (this.score >= 12) {
          this.status = "won";
      lookOf(this.ctx.engine).sfx(523, 0.28, "triangle", 0.05, 220);
      lookOf(this.ctx.engine).shockwave(new THREE.Vector3(), lookOf(this.ctx.engine).accent, 1.2);
          this.ctx.emitHud({ status: "won", score: 12, objective: "截击完成", toast: "空域肃清" });
        }
        return false;
      }
      if (shot.mesh.position.distanceTo(this.pos) > 80) {
        killMesh(this.ctx.engine.scene, shot.mesh);
        return false;
      }
      return true;
    });
    this.pushHud();
  }

  private spawnTarget() {
    const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.7), neonMat(NEON.orange, 0.8));
    mesh.position.set((Math.random() - 0.5) * 40, 6 + Math.random() * 10, -10 - Math.random() * 40);
    this.ctx.engine.scene.add(mesh);
    this.targets.push(mesh);
  }

  private clear() {
    this.shots.forEach((s) => killMesh(this.ctx.engine.scene, s.mesh));
    this.shots = [];
    this.targets.forEach((t) => killMesh(this.ctx.engine.scene, t));
    this.targets = [];
  }

  private pushHud() {
    this.hudAcc += 0.016;
    if (this.hudAcc < 0.18) return;
    this.hudAcc = 0;
    this.ctx.emitHud({ status: "playing", score: this.score, objective: `击落 ${this.score} / 12` });
  }
}

export class GalaxyStrafeGame implements MiniGame {
  private ctx!: GameContext;
  private status: Run = "playing";
  private ship = new THREE.Mesh();
  private x = 0;
  private y = 0;
  private z = 0;
  private shots: THREE.Mesh[] = [];
  private foes: Array<{ mesh: THREE.Mesh; hp: number }> = [];
  private cd = 0;
  private spawn = 0;
  private killed = 0;
  private lives = 3;
  private hudAcc = 0;
  private hurt = 0;

  mount(ctx: GameContext) {
    this.ctx = ctx;
    installLook(ctx.engine, { accent: NEON.violet, bg: 0x050816 });
    this.ship = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.35, 1.4), neonMat(NEON.cyan, 0.9));
    ctx.engine.scene.add(this.ship);
    ctx.emitHud({ status: "ready", score: 0, lives: 3, objective: "轨道扫射，击毁 20 个目标" });
  }

  start() {
    this.status = "playing";
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.killed = 0;
    this.lives = 3;
    this.cd = 0;
    this.spawn = 0;
    this.hurt = 0;
    this.clear();
    this.ctx.emitHud({ status: "playing", score: 0, lives: 3, objective: "击毁 20 个目标", toast: "进入轨道" });
  }

  pause() {}
  resume() {}
  dispose() {
    this.clear();
  }

  update(dt: number) {
    if (this.status !== "playing") return;
    const axis = this.ctx.engine.axis();
    this.x = clamp(this.x + axis.x * 10 * dt, -6, 6);
    this.y = clamp(this.y + axis.y * 8 * dt, -3, 4);
    this.z += 14 * dt;
    this.ship.position.set(this.x, this.y, this.z);
    this.ctx.engine.camera.position.set(this.x * 0.4, this.y + 3.2, this.z - 9);
    this.ctx.engine.camera.lookAt(this.x, this.y, this.z + 8);
    this.cd = Math.max(0, this.cd - dt);
    this.hurt = Math.max(0, this.hurt - dt);
    if ((this.ctx.engine.firePressed() || this.ctx.engine.jumpPressed()) && this.cd <= 0) {
      this.cd = 0.16;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.7), neonMat(NEON.amber, 1));
      mesh.position.set(this.x, this.y, this.z + 1.2);
      this.ctx.engine.scene.add(mesh);
      this.shots.push(mesh);
    }
    this.spawn -= dt;
    if (this.spawn <= 0) {
      this.spawn = 0.55;
      const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.5), neonMat(NEON.rose, 0.8));
      mesh.position.set((Math.random() - 0.5) * 10, (Math.random() - 0.3) * 4, this.z + 28);
      this.ctx.engine.scene.add(mesh);
      this.foes.push({ mesh, hp: 1 });
    }
    this.shots = this.shots.filter((s) => {
      s.position.z += 40 * dt;
      const hit = this.foes.find((f) => f.mesh.position.distanceTo(s.position) < 0.7);
      if (hit || s.position.z > this.z + 40) {
        if (hit) {
          this.killed += 1;
          this.foes = this.foes.filter((f) => f !== hit);
          killMesh(this.ctx.engine.scene, hit.mesh);
          if (this.killed >= 20) {
            this.status = "won";
      lookOf(this.ctx.engine).sfx(523, 0.28, "triangle", 0.05, 220);
      lookOf(this.ctx.engine).shockwave(new THREE.Vector3(), lookOf(this.ctx.engine).accent, 1.2);
            this.ctx.emitHud({ status: "won", score: this.killed, objective: "轨道肃清", toast: "扫射完成" });
          }
        }
        killMesh(this.ctx.engine.scene, s);
        return false;
      }
      return true;
    });
    this.foes = this.foes.filter((f) => {
      if (f.mesh.position.distanceTo(this.ship.position) < 1.0 && this.hurt <= 0) {
        this.lives -= 1;
        this.hurt = 0.7;
        if (this.lives <= 0) {
          this.status = "lost";
      lookOf(this.ctx.engine).sfx(90, 0.22, "sawtooth", 0.05, -50);
          this.ctx.emitHud({ status: "lost", lives: 0, score: this.killed, objective: "舰体解体", toast: "撞毁" });
        }
      }
      if (f.mesh.position.z < this.z - 8) {
        killMesh(this.ctx.engine.scene, f.mesh);
        return false;
      }
      return true;
    });
    this.pushHud();
  }

  private clear() {
    this.shots.forEach((s) => killMesh(this.ctx.engine.scene, s));
    this.shots = [];
    this.foes.forEach((f) => killMesh(this.ctx.engine.scene, f.mesh));
    this.foes = [];
  }

  private pushHud() {
    this.hudAcc += 0.016;
    if (this.hudAcc < 0.16) return;
    this.hudAcc = 0;
    this.ctx.emitHud({ status: "playing", score: this.killed, lives: this.lives, objective: `击毁 ${this.killed} / 20` });
  }
}

export class ShadowInfiltrateGame implements MiniGame {
  private ctx!: GameContext;
  private status: Run = "playing";
  private player = new THREE.Mesh();
  private exit = new THREE.Mesh();
  private walls: Array<{ x: number; z: number; w: number; d: number }> = [];
  private wallMeshes: THREE.Mesh[] = [];
  private guards: Array<{ mesh: THREE.Mesh; origin: THREE.Vector3; dir: number; span: number }> = [];
  private hudAcc = 0;

  mount(ctx: GameContext) {
    this.ctx = ctx;
    installLook(ctx.engine, { accent: NEON.violet, bg: 0x0a0c12 });
    ctx.engine.scene.add(circuitFloor(32, lookOf(ctx.engine)));
    this.player = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.9, 10), neonMat(NEON.cyan, 0.85));
    this.exit = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.2, 1.4), neonMat(NEON.emerald, 0.7));
    ctx.engine.scene.add(this.player, this.exit);
    ctx.engine.camera.position.set(0, 22, 16);
    ctx.engine.camera.lookAt(0, 0, 0);
    ctx.emitHud({ status: "ready", score: 0, objective: "避开视野锥，摸到绿垫" });
  }

  start() {
    this.status = "playing";
    this.player.position.set(-10, 0.45, 8);
    this.exit.position.set(10, 0.12, -8);
    this.build();
    this.ctx.emitHud({ status: "playing", score: 0, objective: "避开视野锥，摸到绿垫", toast: "潜入" });
  }

  pause() {}
  resume() {}
  dispose() {
    this.clearGuards();
  }

  update(dt: number) {
    if (this.status !== "playing") return;
    const axis = this.ctx.engine.axis();
    const nx = clamp(this.player.position.x + axis.x * 6.5 * dt, -14, 14);
    const nz = clamp(this.player.position.z - axis.y * 6.5 * dt, -14, 14);
    if (!this.blocked(nx, this.player.position.z)) this.player.position.x = nx;
    if (!this.blocked(this.player.position.x, nz)) this.player.position.z = nz;
    for (const g of this.guards) {
      g.dir += dt * 0.7;
      const gx = g.origin.x + Math.cos(g.dir) * g.span;
      const gz = g.origin.z + Math.sin(g.dir) * g.span;
      g.mesh.position.set(gx, 0.5, gz);
      const toP = new THREE.Vector3(this.player.position.x - gx, 0, this.player.position.z - gz);
      const look = new THREE.Vector3(Math.cos(g.dir + Math.PI / 2), 0, Math.sin(g.dir + Math.PI / 2));
      const dist = toP.length();
      if (dist < 6 && dist > 0.01) {
        toP.multiplyScalar(1 / dist);
        if (toP.dot(look) > 0.62) {
          this.status = "lost";
      lookOf(this.ctx.engine).sfx(90, 0.22, "sawtooth", 0.05, -50);
          this.ctx.emitHud({ status: "lost", objective: "被探灯锁定", toast: "暴露" });
          return;
        }
      }
    }
    if (this.player.position.distanceTo(this.exit.position) < 1.1) {
      this.status = "won";
      lookOf(this.ctx.engine).sfx(523, 0.28, "triangle", 0.05, 220);
      lookOf(this.ctx.engine).shockwave(new THREE.Vector3(), lookOf(this.ctx.engine).accent, 1.2);
      this.ctx.emitHud({ status: "won", score: 100, objective: "潜入完成", toast: "撤离" });
      return;
    }
    this.ctx.engine.camera.position.lerp(new THREE.Vector3(this.player.position.x, 20, this.player.position.z + 14), 1 - Math.exp(-3 * dt));
    this.ctx.engine.camera.lookAt(this.player.position.x, 0, this.player.position.z);
    this.pushHud();
  }

  private build() {
    this.clearGuards();
    this.walls = [
      { x: 0, z: 0, w: 10, d: 1.2 },
      { x: -6, z: -4, w: 1.2, d: 8 },
      { x: 6, z: 4, w: 1.2, d: 8 },
      { x: 2, z: 8, w: 8, d: 1.2 },
    ];
    this.walls.forEach((w) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w.w, 1.6, w.d), matteMat(0x1e293b, 0.2));
      mesh.position.set(w.x, 0.8, w.z);
      this.ctx.engine.scene.add(mesh);
      this.wallMeshes.push(mesh);
    });
    [
      { o: new THREE.Vector3(-2, 0, -2), span: 3 },
      { o: new THREE.Vector3(4, 0, 2), span: 2.4 },
    ].forEach((g, i) => {
      const mesh = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1, 6), neonMat(NEON.rose, 0.85));
      this.ctx.engine.scene.add(mesh);
      this.guards.push({ mesh, origin: g.o, dir: i, span: g.span });
    });
  }

  private blocked(x: number, z: number) {
    return this.walls.some((w) => Math.abs(x - w.x) < w.w * 0.5 + 0.35 && Math.abs(z - w.z) < w.d * 0.5 + 0.35);
  }

  private clearGuards() {
    this.guards.forEach((g) => killMesh(this.ctx.engine.scene, g.mesh));
    this.guards = [];
    this.wallMeshes.forEach((w) => killMesh(this.ctx.engine.scene, w));
    this.wallMeshes = [];
  }

  private pushHud() {
    this.hudAcc += 0.016;
    if (this.hudAcc < 0.2) return;
    this.hudAcc = 0;
    this.ctx.emitHud({ status: "playing", score: 0, objective: "待在探灯锥角之外" });
  }
}
