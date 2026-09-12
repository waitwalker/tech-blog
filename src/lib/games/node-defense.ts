import * as THREE from "three";
import { NEON, neonMat, matteMat } from "./engine";
import { addMat, circuitFloor, installLook, lookOf } from "./look";
import type { GameContext, MiniGame } from "./types";

type Creep = { mesh: THREE.Mesh; hp: number; max: number; speed: number; seg: number; t: number; reward: number };
type Tower = { mesh: THREE.Group; x: number; z: number; range: number; cd: number; dmg: number };
type Pad = { mesh: THREE.Mesh; x: number; z: number; used: boolean };

const PATH: Array<[number, number]> = [
  [-14, -10],
  [12, -10],
  [12, 0],
  [-8, 0],
  [-8, 10],
  [14, 10],
];

export class NodeDefenseGame implements MiniGame {
  private ctx!: GameContext;
  private pads: Pad[] = [];
  private towers: Tower[] = [];
  private creeps: Creep[] = [];
  private beams: THREE.Line[] = [];
  private gold = 80;
  private lives = 10;
  private wave = 0;
  private toSpawn = 0;
  private spawnCd = 0;
  private between = 1.2;
  private status: "playing" | "won" | "lost" = "playing";
  private hudAcc = 0;
  private pathPts: THREE.Vector3[] = [];

  mount(ctx: GameContext) {
    this.ctx = ctx;
    const { scene, camera } = ctx.engine;
    const look = installLook(ctx.engine, { accent: NEON.amber, bg: 0x100805 });
    scene.add(circuitFloor(48, look, -0.35));

    const board = new THREE.Mesh(new THREE.BoxGeometry(36, 0.18, 28), matteMat(0x1c1917, 0.12));
    board.position.y = -0.08;
    scene.add(board);

    this.pathPts = PATH.map(([x, z]) => new THREE.Vector3(x, 0.12, z));
    for (let i = 0; i < this.pathPts.length - 1; i++) {
      const a = this.pathPts[i];
      const b = this.pathPts[i + 1];
      const len = a.distanceTo(b);
      const strip = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(a.x - b.x) < 0.1 ? 1.6 : len, 0.08, Math.abs(a.z - b.z) < 0.1 ? 1.6 : len), neonMat(0x92400e, 0.2));
      strip.position.set((a.x + b.x) / 2, 0.06, (a.z + b.z) / 2);
      scene.add(strip);
    }

    const padPos: Array<[number, number]> = [
      [-10, -7],
      [-2, -7],
      [6, -7],
      [9, -4],
      [9, 3],
      [2, 3],
      [-4, 3],
      [-5, 7],
      [0, 7],
      [8, 7],
      [-11, -3],
      [4, -13],
    ];
    padPos.forEach(([x, z]) => {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.05, 0.18, 12), neonMat(NEON.indigo, 0.35));
      mesh.position.set(x, 0.12, z);
      scene.add(mesh);
      this.pads.push({ mesh, x, z, used: false });
    });

    camera.position.set(0, 24, 22);
    camera.lookAt(0, 0, 0);
    this.ctx.emitHud({ status: "ready", score: 80, lives: 10, wave: 0, objective: "点击空垫放置防御塔" });
  }

  start() {
    this.gold = 80;
    this.lives = 10;
    this.wave = 0;
    this.toSpawn = 0;
    this.between = 1.0;
    this.status = "playing";
    this.clearCreeps();
    this.towers.forEach((tower) => this.ctx.engine.scene.remove(tower.mesh));
    this.towers = [];
    this.pads.forEach((pad) => {
      pad.used = false;
      (pad.mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.35;
    });
    this.ctx.emitHud({ status: "playing", score: this.gold, lives: 10, wave: 1, objective: "准备第 1 波", toast: "链路已激活" });
  }

  pause() {}
  resume() {}

  update(dt: number) {
    if (this.status !== "playing") return;
    this.handleClick();
    this.spawnFlow(dt);
    this.moveCreeps(dt);
    this.tickTowers(dt);
    this.fadeBeams(dt);

    if (this.lives <= 0) {
      this.status = "lost";
      lookOf(this.ctx.engine).sfx(90, 0.22, "sawtooth", 0.05, -50);
      this.ctx.emitHud({ status: "lost", lives: 0, objective: "核心被突破", toast: "防线失守" });
      return;
    }
    if (this.wave >= 5 && this.toSpawn <= 0 && this.creeps.length === 0) {
      this.status = "won";
      lookOf(this.ctx.engine).sfx(523, 0.28, "triangle", 0.05, 220);
      lookOf(this.ctx.engine).shockwave(new THREE.Vector3(), lookOf(this.ctx.engine).accent, 1.2);
      this.ctx.emitHud({ status: "won", score: this.gold + this.lives * 20, lives: this.lives, wave: 5, objective: "链路守住", toast: "防御成功" });
      return;
    }
    this.pushHud();
  }

  dispose() {
    this.clearCreeps();
  }

  private handleClick() {
    const click = this.ctx.engine.click;
    if (!click) return;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(click.ndcX, click.ndcY), this.ctx.engine.camera);
    const hits = ray.intersectObjects(
      this.pads.map((p) => p.mesh),
      false,
    );
    if (!hits.length) return;
    const pad = this.pads.find((p) => p.mesh === hits[0].object);
    if (!pad || pad.used) return;
    if (this.gold < 40) {
      this.ctx.emitHud({ toast: "能量不足" });
      return;
    }
    this.gold -= 40;
    pad.used = true;
    (pad.mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.08;
    const group = new THREE.Group();
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.7, 0.7, 8), neonMat(NEON.amber, 0.7));
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.32, 10, 8), neonMat(NEON.cyan, 0.9));
    head.position.y = 0.7;
    group.add(base, head);
    group.position.set(pad.x, 0.4, pad.z);
    this.ctx.engine.scene.add(group);
    this.towers.push({ mesh: group, x: pad.x, z: pad.z, range: 6.2, cd: 0, dmg: 1 });
  }

  private spawnFlow(dt: number) {
    if (this.toSpawn > 0) {
      this.spawnCd -= dt;
      if (this.spawnCd <= 0) {
        this.spawnCreep();
        this.toSpawn -= 1;
        this.spawnCd = this.wave >= 5 ? 0.45 : 0.7;
      }
      return;
    }
    if (this.creeps.length > 0 || this.wave >= 5) return;
    this.between -= dt;
    if (this.between <= 0) {
      this.wave += 1;
      this.toSpawn = this.wave === 5 ? 12 : 4 + this.wave * 2;
      this.spawnCd = 0.2;
      this.between = 2.2;
      this.ctx.emitHud({ toast: `第 ${this.wave} 波`, wave: this.wave });
    }
  }

  private spawnCreep() {
    const boss = this.wave === 5 && this.toSpawn === 1;
    const hp = boss ? 28 : 2 + this.wave * 2;
    const mesh = new THREE.Mesh(
      new THREE.OctahedronGeometry(boss ? 0.7 : 0.42),
      neonMat(boss ? NEON.rose : NEON.orange, 0.85),
    );
    mesh.position.copy(this.pathPts[0]).setY(0.7);
    this.ctx.engine.scene.add(mesh);
    this.creeps.push({
      mesh,
      hp,
      max: hp,
      speed: boss ? 1.5 : 2.1 + this.wave * 0.12,
      seg: 0,
      t: 0,
      reward: boss ? 50 : 10,
    });
  }

  private moveCreeps(dt: number) {
    for (const creep of [...this.creeps]) {
      const a = this.pathPts[creep.seg];
      const b = this.pathPts[creep.seg + 1];
      if (!b) {
        this.lives -= 1;
        this.removeCreep(creep);
        continue;
      }
      const len = a.distanceTo(b);
      creep.t += (creep.speed * dt) / Math.max(0.001, len);
      if (creep.t >= 1) {
        creep.seg += 1;
        creep.t = 0;
      } else {
        creep.mesh.position.lerpVectors(a, b, creep.t);
        creep.mesh.position.y = 0.7;
      }
      creep.mesh.rotation.y += dt * 3;
    }
  }

  private tickTowers(dt: number) {
    for (const tower of this.towers) {
      tower.cd -= dt;
      if (tower.cd > 0) continue;
      let best: Creep | null = null;
      let bestD = tower.range;
      for (const creep of this.creeps) {
        const d = Math.hypot(creep.mesh.position.x - tower.x, creep.mesh.position.z - tower.z);
        if (d < bestD) {
          bestD = d;
          best = creep;
        }
      }
      if (!best) continue;
      tower.cd = 0.42;
      best.hp -= tower.dmg;
      lookOf(this.ctx.engine).tracer(tower.mesh.position.clone().setY(1.1), best.mesh.position.clone().setY(0.7), NEON.cyan);
      if (best.hp <= 0) {
        lookOf(this.ctx.engine).burst(best.mesh.position, NEON.orange, 12);
        lookOf(this.ctx.engine).sfx(520, 0.08, "square", 0.04, 180);
        this.gold += best.reward;
        this.removeCreep(best);
      }
    }
  }

  private flashBeam(from: THREE.Vector3, to: THREE.Vector3) {
    const geo = new THREE.BufferGeometry().setFromPoints([from.clone().setY(1.1), to.clone().setY(0.7)]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: NEON.cyan, transparent: true, opacity: 0.9 }));
    this.ctx.engine.scene.add(line);
    this.beams.push(line);
  }

  private fadeBeams(dt: number) {
    this.beams = this.beams.filter((line) => {
      const mat = line.material as THREE.LineBasicMaterial;
      mat.opacity -= dt * 4;
      if (mat.opacity > 0) return true;
      this.ctx.engine.scene.remove(line);
      line.geometry.dispose();
      mat.dispose();
      return false;
    });
  }

  private removeCreep(creep: Creep) {
    this.ctx.engine.scene.remove(creep.mesh);
    creep.mesh.geometry.dispose();
    (creep.mesh.material as THREE.Material).dispose();
    this.creeps = this.creeps.filter((item) => item !== creep);
  }

  private clearCreeps() {
    [...this.creeps].forEach((c) => this.removeCreep(c));
  }

  private pushHud() {
    this.hudAcc += 0.016;
    if (this.hudAcc < 0.18) return;
    this.hudAcc = 0;
    this.ctx.emitHud({
      status: "playing",
      score: this.gold,
      lives: this.lives,
      wave: Math.max(1, this.wave),
      objective: `能量 ${this.gold} · 线上 ${this.creeps.length} 个目标`,
    });
  }
}
