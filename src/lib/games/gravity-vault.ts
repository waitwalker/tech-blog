import * as THREE from "three";
import { NEON, neonMat, matteMat } from "./engine";
import { addMat, installLook, lookOf } from "./look";
import { cellKey } from "./math";
import type { GameContext, MiniGame } from "./types";

type Level = { size: number; solids: Set<string>; start: [number, number, number]; goal: [number, number, number] };

function room(size: number) {
  const solids = new Set<string>();
  for (let i = 0; i <= size; i++) {
    for (let j = 0; j <= size; j++) {
      solids.add(cellKey(i, 0, j));
      solids.add(cellKey(i, size, j));
      solids.add(cellKey(0, i, j));
      solids.add(cellKey(size, i, j));
      solids.add(cellKey(i, j, 0));
      solids.add(cellKey(i, j, size));
    }
  }
  return solids;
}

function makeLevels(): Level[] {
  const a = room(6);
  const b = room(8);
  for (let y = 1; y <= 7; y++) {
    for (let z = 1; z <= 7; z++) {
      if (y <= 2 && z === 4) continue;
      b.add(cellKey(4, y, z));
    }
  }
  const c = room(8);
  for (let x = 1; x <= 3; x++) {
    for (let z = 1; z <= 3; z++) c.add(cellKey(x, 3, z));
  }
  for (let x = 5; x <= 7; x++) c.add(cellKey(x, 1, 5));
  return [
    { size: 6, solids: a, start: [3, 1, 3], goal: [3, 5, 3] },
    { size: 8, solids: b, start: [2, 1, 4], goal: [6, 7, 4] },
    { size: 8, solids: c, start: [2, 1, 2], goal: [6, 4, 7] },
  ];
}

export class GravityVaultGame implements MiniGame {
  private ctx!: GameContext;
  private levels = makeLevels();
  private level = 0;
  private solids = new Set<string>();
  private size = 6;
  private cell = new THREE.Vector3();
  private gravity = new THREE.Vector3(0, -1, 0);
  private player = new THREE.Mesh();
  private goal = new THREE.Mesh();
  private world = new THREE.Group();
  private anim: { from: THREE.Vector3; to: THREE.Vector3; t: number } | null = null;
  private moveCd = 0;
  private status: "playing" | "won" | "lost" = "playing";
  private hudAcc = 0;

  mount(ctx: GameContext) {
    this.ctx = ctx;
    const { scene, camera } = ctx.engine;
    installLook(ctx.engine, { accent: NEON.violet, bg: 0x0a0614 });
    scene.add(this.world);
    this.player = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.72, 0.72), neonMat(NEON.cyan, 1.15));
    this.goal = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.62, 0.62), addMat(NEON.emerald));
    scene.add(this.player, this.goal);
    camera.position.set(12, 10, 12);
    this.loadLevel(0, false);
    this.ctx.emitHud({ status: "ready", score: 0, wave: 1, objective: "把青色方块摔到绿光格" });
  }

  start() {
    this.level = 0;
    this.status = "playing";
    this.loadLevel(0, true);
    this.ctx.emitHud({ status: "playing", score: 0, wave: 1, objective: "密室 1 / 3", toast: "重力已上线" });
  }

  pause() {}
  resume() {}

  update(dt: number) {
    if (this.status !== "playing") return;
    this.goal.rotation.y += dt * 1.6;
    this.moveCd = Math.max(0, this.moveCd - dt);

    if (this.anim) {
      this.anim.t += dt / 0.14;
      const k = Math.min(1, this.anim.t);
      this.player.position.lerpVectors(this.worldPos(this.anim.from), this.worldPos(this.anim.to), k);
      if (k >= 1) {
        this.cell.copy(this.anim.to);
        this.anim = null;
      }
      this.followCamera(dt);
      this.checkWin();
      return;
    }

    const below = this.cell.clone().add(this.gravity);
    if (!this.solid(below)) {
      this.anim = { from: this.cell.clone(), to: below, t: 0 };
      this.followCamera(dt);
      return;
    }

    if (this.ctx.engine.justPressed.has("KeyQ") || this.ctx.engine.virtual.gravQ) this.rotateGravity("q");
    if (this.ctx.engine.justPressed.has("KeyE") || this.ctx.engine.virtual.gravE) this.rotateGravity("e");

    if (this.moveCd <= 0) {
      const step = this.walkStep();
      if (step) {
        const next = this.cell.clone().add(step);
        if (!this.solid(next)) {
          this.anim = { from: this.cell.clone(), to: next, t: 0 };
          this.moveCd = 0.08;
        }
      }
    }

    this.player.position.copy(this.worldPos(this.cell));
    this.followCamera(dt);
    this.checkWin();
    this.pushHud();
  }

  dispose() {
    this.world.clear();
  }

  private loadLevel(index: number, playing: boolean) {
    const level = this.levels[index];
    this.size = level.size;
    this.solids = level.solids;
    this.cell.set(...level.start);
    this.gravity.set(0, -1, 0);
    this.anim = null;
    while (this.world.children.length) {
      const child = this.world.children[0];
      this.world.remove(child);
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
    const geo = new THREE.BoxGeometry(0.92, 0.92, 0.92);
    const mat = matteMat(0x2e1065, 0.18);
    const mesh = new THREE.InstancedMesh(geo, mat, this.solids.size);
    let i = 0;
    const dummy = new THREE.Object3D();
    this.solids.forEach((key) => {
      const [x, y, z] = key.split(",").map(Number);
      dummy.position.copy(this.worldPos(new THREE.Vector3(x, y, z)));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      i += 1;
    });
    mesh.instanceMatrix.needsUpdate = true;
    this.world.add(mesh);
    this.player.position.copy(this.worldPos(this.cell));
    this.goal.position.copy(this.worldPos(new THREE.Vector3(...level.goal)));
    if (playing) this.ctx.emitHud({ wave: index + 1, objective: `密室 ${index + 1} / 3` });
  }

  private worldPos(cell: THREE.Vector3) {
    const c = this.size / 2;
    return new THREE.Vector3(cell.x - c, cell.y - c, cell.z - c);
  }

  private solid(cell: THREE.Vector3) {
    if (cell.x < 0 || cell.y < 0 || cell.z < 0 || cell.x > this.size || cell.y > this.size || cell.z > this.size) return true;
    return this.solids.has(cellKey(cell.x, cell.y, cell.z));
  }

  private rotateGravity(which: "q" | "e") {
    const { x, y, z } = this.gravity;
    if (which === "q") this.gravity.set(-y, x, z);
    else this.gravity.set(x, -z, y);
    this.gravity.x = Math.round(this.gravity.x);
    this.gravity.y = Math.round(this.gravity.y);
    this.gravity.z = Math.round(this.gravity.z);
    this.ctx.emitHud({ toast: `重力 → (${this.gravity.x},${this.gravity.y},${this.gravity.z})` });
  }

  private walkStep() {
    const axis = this.ctx.engine.axis();
    if (!axis.x && !axis.y) return null;
    const up = this.gravity.clone().multiplyScalar(-1);
    const look = new THREE.Vector3();
    this.ctx.engine.camera.getWorldDirection(look);
    look.projectOnPlane(up);
    if (look.lengthSq() < 0.001) {
      look.crossVectors(up, new THREE.Vector3(0, 0, 1));
      if (look.lengthSq() < 0.001) look.crossVectors(up, new THREE.Vector3(1, 0, 0));
    }
    look.normalize();
    const right = new THREE.Vector3().crossVectors(look, up).normalize();
    const wish = look.multiplyScalar(axis.y).add(right.multiplyScalar(axis.x));
    const ax = Math.abs(wish.x);
    const ay = Math.abs(wish.y);
    const az = Math.abs(wish.z);
    if (ax >= ay && ax >= az && ax > 0.2) return new THREE.Vector3(Math.sign(wish.x), 0, 0);
    if (ay >= ax && ay >= az && ay > 0.2) return new THREE.Vector3(0, Math.sign(wish.y), 0);
    if (az > 0.2) return new THREE.Vector3(0, 0, Math.sign(wish.z));
    return null;
  }

  private followCamera(dt: number) {
    const cam = this.ctx.engine.camera;
    const up = this.gravity.clone().multiplyScalar(-1).normalize();
    const target = this.player.position;
    let along = new THREE.Vector3().crossVectors(up, new THREE.Vector3(1, 0, 0));
    if (along.lengthSq() < 0.2) along = new THREE.Vector3().crossVectors(up, new THREE.Vector3(0, 0, 1));
    along.normalize();
    const desired = target.clone().add(up.multiplyScalar(9)).add(along.multiplyScalar(-10));
    cam.up.copy(this.gravity.clone().multiplyScalar(-1));
    cam.position.lerp(desired, 1 - Math.exp(-3.2 * dt));
    cam.lookAt(target);
  }

  private checkWin() {
    const goal = this.levels[this.level].goal;
    if (this.cell.x !== goal[0] || this.cell.y !== goal[1] || this.cell.z !== goal[2]) return;
    if (this.anim) return;
    if (this.level >= this.levels.length - 1) {
      this.status = "won";
      lookOf(this.ctx.engine).sfx(523, 0.28, "triangle", 0.05, 220);
      lookOf(this.ctx.engine).shockwave(new THREE.Vector3(), lookOf(this.ctx.engine).accent, 1.2);
      this.ctx.emitHud({ status: "won", score: 300, wave: 3, objective: "三间密室已解开", toast: "重力归位" });
      return;
    }
    this.level += 1;
    this.loadLevel(this.level, true);
    this.ctx.emitHud({ toast: "下一间密室", score: this.level * 100, wave: this.level + 1 });
  }

  private pushHud() {
    this.hudAcc += 0.016;
    if (this.hudAcc < 0.2) return;
    this.hudAcc = 0;
    this.ctx.emitHud({
      status: "playing",
      score: this.level * 100,
      wave: this.level + 1,
      objective: `密室 ${this.level + 1} / 3 · 重力 (${this.gravity.x},${this.gravity.y},${this.gravity.z})`,
    });
  }
}
