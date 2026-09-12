import * as THREE from "three";
import { NEON, neonMat, matteMat } from "./engine";
import { addMat, installLook, lookOf } from "./look";
import { aabbOverlap } from "./math";
import type { GameContext, MiniGame } from "./types";

type Plat = {
  mesh: THREE.Mesh;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  move?: { axis: "x" | "z"; amp: number; speed: number };
  phase?: number;
  prevX: number;
  prevZ: number;
  goal?: boolean;
};

type Crystal = { mesh: THREE.Mesh; taken: boolean };

export class LatticeJumpGame implements MiniGame {
  private ctx!: GameContext;
  private plats: Plat[] = [];
  private crystals: Crystal[] = [];
  private portal!: THREE.Mesh;
  private player = new THREE.Mesh();
  private vel = new THREE.Vector3();
  private grounded = false;
  private lives = 3;
  private collected = 0;
  private total = 0;
  private status: "playing" | "won" | "lost" = "playing";
  private spawn = new THREE.Vector3(0, 2.2, 0);
  private hudAcc = 0;
  private t = 0;

  mount(ctx: GameContext) {
    this.ctx = ctx;
    const { scene, camera } = ctx.engine;
    installLook(ctx.engine, { accent: NEON.emerald, bg: 0x03140c });

    const defs: Array<Omit<Plat, "mesh" | "prevX" | "prevZ">> = [
      { x: 0, y: 0, z: 0, w: 8, h: 1, d: 8 },
      { x: 0, y: 0, z: 12, w: 4.2, h: 1, d: 4.2 },
      { x: 6.2, y: 1.3, z: 21, w: 3.6, h: 1, d: 3.6 },
      { x: -6.2, y: 2.4, z: 30, w: 3.6, h: 1, d: 3.6 },
      { x: 0, y: 3.4, z: 40, w: 4, h: 1, d: 4, move: { axis: "x", amp: 5.2, speed: 1.05 } },
      { x: 0, y: 4.6, z: 52, w: 5, h: 1, d: 5 },
      { x: 0, y: 4.6, z: 64, w: 6, h: 1, d: 6, goal: true },
    ];

    defs.forEach((def) => {
      const mat = def.goal ? neonMat(NEON.amber, 0.7) : neonMat(def.move ? NEON.cyan : NEON.emerald, def.move ? 0.55 : 0.28);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(def.w, def.h, def.d), mat);
      mesh.position.set(def.x, def.y, def.z);
      const rim = new THREE.Mesh(new THREE.BoxGeometry(def.w + 0.08, 0.06, def.d + 0.08), addMat(def.goal ? NEON.amber : NEON.cyan, 0.8));
      rim.position.set(def.x, def.y + def.h * 0.5 + 0.02, def.z);
      scene.add(mesh, rim);
      this.plats.push({ ...def, mesh, prevX: def.x, prevZ: def.z, phase: Math.random() * Math.PI });
    });

    const crystalSpots = [
      [0, 1.6, 12],
      [6.2, 2.9, 21],
      [-6.2, 4.0, 30],
      [0, 5.2, 40],
      [1.6, 6.4, 52],
      [-1.6, 6.4, 52],
    ];
    crystalSpots.forEach(([x, y, z]) => {
      const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.38), neonMat(NEON.amber, 1));
      mesh.position.set(x, y, z);
      scene.add(mesh);
      this.crystals.push({ mesh, taken: false });
    });
    this.total = this.crystals.length;

    this.portal = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.1, 10, 32), addMat(NEON.violet));
    this.portal.position.set(0, 6.4, 64);
    scene.add(this.portal);

    this.player = new THREE.Mesh(new THREE.CapsuleGeometry(0.38, 0.7, 4, 10), neonMat(NEON.cyan, 0.8));
    scene.add(this.player);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(30, 120), matteMat(0x022c22, 0.04));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, -8, 36);
    scene.add(ground);

    camera.position.set(0, 8, 12);
    this.resetPlayer();
    this.ctx.emitHud({ status: "ready", score: 0, lives: 3, objective: `收集 ${this.total} 枚晶体` });
  }

  start() {
    this.lives = 3;
    this.collected = 0;
    this.vel.set(0, 0, 0);
    this.status = "playing";
    this.crystals.forEach((c) => {
      c.taken = false;
      c.mesh.visible = true;
    });
    this.resetPlayer();
    lookOf(this.ctx.engine).sfx(240, 0.12, "triangle", 0.04, 180);
    this.ctx.emitHud({ status: "playing", score: 0, lives: 3, objective: `晶体 0 / ${this.total}`, toast: "起跳" });
  }

  pause() {}
  resume() {}

  update(dt: number) {
    if (this.status !== "playing") return;
    this.t += dt;
    this.movePlatforms();

    const axis = this.ctx.engine.axis();
    const accel = 22;
    this.vel.x = axis.x * accel * 0.42;
    this.vel.z = -axis.y * accel * 0.42;
    this.vel.y -= 28 * dt;
    if (this.grounded && this.ctx.engine.jumpPressed()) this.vel.y = 11.2;

    const prevY = this.player.position.y;
    this.player.position.x += this.vel.x * dt;
    this.player.position.y += this.vel.y * dt;
    this.player.position.z += this.vel.z * dt;
    this.collide(prevY);

    this.crystals.forEach((crystal) => {
      if (crystal.taken) return;
      crystal.mesh.rotation.y += dt * 2.2;
      crystal.mesh.position.y += Math.sin(this.t * 3) * 0.002;
      if (crystal.mesh.position.distanceTo(this.player.position) < 1.05) {
        crystal.taken = true;
        crystal.mesh.visible = false;
        this.collected += 1;
        lookOf(this.ctx.engine).burst(crystal.mesh.position, NEON.amber, 14);
        lookOf(this.ctx.engine).sfx(740, 0.1, "triangle", 0.045, 220);
        this.ctx.emitHud({ toast: "晶体 +1", score: this.collected * 100 });
      }
    });

    this.portal.rotation.y += dt * 1.4;
    (this.portal.material as THREE.MeshStandardMaterial).emissiveIntensity = this.collected >= this.total ? 1.1 : 0.25;

    if (this.collected >= this.total && this.player.position.distanceTo(this.portal.position) < 1.6) {
      this.status = "won";
      lookOf(this.ctx.engine).sfx(523, 0.28, "triangle", 0.05, 220);
      lookOf(this.ctx.engine).shockwave(new THREE.Vector3(), lookOf(this.ctx.engine).accent, 1.2);
      this.ctx.emitHud({ status: "won", score: this.collected * 100 + this.lives * 50, lives: this.lives, objective: "传送完成", toast: "跃迁成功" });
      return;
    }

    if (this.player.position.y < -6) {
      this.lives -= 1;
      if (this.lives <= 0) {
        this.status = "lost";
      lookOf(this.ctx.engine).sfx(90, 0.22, "sawtooth", 0.05, -50);
        this.ctx.emitHud({ status: "lost", lives: 0, objective: "跌出晶格", toast: "坠落" });
        return;
      }
      this.resetPlayer();
      this.ctx.emitHud({ toast: "回锚点", lives: this.lives });
    }

    this.followCamera(dt);
    this.pushHud();
  }

  dispose() {}

  private resetPlayer() {
    this.player.position.copy(this.spawn);
    this.vel.set(0, 0, 0);
    this.grounded = true;
  }

  private movePlatforms() {
    this.plats.forEach((plat) => {
      plat.prevX = plat.x;
      plat.prevZ = plat.z;
      if (!plat.move) return;
      const offset = Math.sin(this.t * plat.move.speed + (plat.phase ?? 0)) * plat.move.amp;
      if (plat.move.axis === "x") plat.x = offset;
      else plat.z = 40 + offset;
      plat.mesh.position.set(plat.x, plat.y, plat.z);
    });
  }

  private collide(prevY: number) {
    const hw = 0.4;
    const hh = 0.75;
    const hd = 0.4;
    this.grounded = false;
    for (const plat of this.plats) {
      if (!aabbOverlap(this.player.position.x, this.player.position.y, this.player.position.z, hw * 2, hh * 2, hd * 2, plat.x, plat.y, plat.z, plat.w, plat.h, plat.d)) {
        continue;
      }
      const top = plat.y + plat.h * 0.5;
      const bottom = prevY - hh;
      if (this.vel.y <= 0 && bottom >= top - 0.35) {
        this.player.position.y = top + hh;
        this.vel.y = 0;
        this.grounded = true;
        this.player.position.x += plat.x - plat.prevX;
        this.player.position.z += plat.z - plat.prevZ;
      }
    }
  }

  private followCamera(dt: number) {
    const cam = this.ctx.engine.camera;
    const p = this.player.position;
    const desired = new THREE.Vector3(p.x, p.y + 5.6, p.z + 11);
    cam.position.lerp(desired, 1 - Math.exp(-3.8 * dt));
    cam.lookAt(p.x, p.y + 0.7, p.z);
  }

  private pushHud() {
    this.hudAcc += 0.016;
    if (this.hudAcc < 0.18) return;
    this.hudAcc = 0;
    this.ctx.emitHud({
      status: "playing",
      score: this.collected * 100,
      lives: this.lives,
      objective: this.collected >= this.total ? "进入金色传送门" : `晶体 ${this.collected} / ${this.total}`,
    });
  }
}
