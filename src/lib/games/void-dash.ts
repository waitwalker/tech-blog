import * as THREE from "three";
import { NEON, neonMat, matteMat } from "./engine";
import { addMat, installLook, lookOf } from "./look";
import { clamp } from "./math";
import type { GameContext, MiniGame } from "./types";

type Obstacle = { mesh: THREE.Mesh; lane: number; z: number; tall: boolean; hit: boolean };

const LANES = [-2.4, 0, 2.4];

export class VoidDashGame implements MiniGame {
  private ctx!: GameContext;
  private player = new THREE.Mesh();
  private lane = 1;
  private y = 0.7;
  private vy = 0;
  private z = 0;
  private speed = 18;
  private obstacles: Obstacle[] = [];
  private nextZ = 28;
  private status: "playing" | "won" | "lost" = "playing";
  private hudAcc = 0;
  private best = 0;
  private floor!: THREE.Mesh;

  mount(ctx: GameContext) {
    this.ctx = ctx;
    const { scene, camera } = ctx.engine;
    installLook(ctx.engine, { accent: NEON.cyan, bg: 0x030712 });

    this.floor = new THREE.Mesh(new THREE.BoxGeometry(9.2, 0.4, 220), matteMat(0x0f172a, 0.16));
    this.floor.position.set(0, -0.2, 80);
    scene.add(this.floor);
    const left = new THREE.Mesh(new THREE.BoxGeometry(0.22, 2.4, 220), addMat(NEON.indigo, 0.75));
    const right = left.clone();
    left.position.set(-4.7, 0.9, 80);
    right.position.set(4.7, 0.9, 80);
    scene.add(left, right);

    this.player = new THREE.Mesh(new THREE.CapsuleGeometry(0.38, 0.55, 4, 10), neonMat(NEON.cyan, 0.9));
    scene.add(this.player);
    camera.position.set(0, 4.2, -8);
    this.resetRun();
    this.best = this.readBest();
    this.ctx.emitHud({ status: "ready", score: 0, objective: `最远 ${this.best} m` });
  }

  start() {
    this.status = "playing";
    this.resetRun();
    this.ctx.emitHud({ status: "playing", score: 0, objective: "别撞", toast: "起跑" });
  }

  pause() {}
  resume() {}

  update(dt: number) {
    if (this.status !== "playing") return;
    const engine = this.ctx.engine;
    if (engine.justPressed.has("KeyA") || engine.justPressed.has("ArrowLeft") || engine.virtual.x < -0.5) {
      this.lane = Math.max(0, this.lane - 1);
      if (engine.virtual.x < -0.5) engine.virtual.x = 0;
    }
    if (engine.justPressed.has("KeyD") || engine.justPressed.has("ArrowRight") || engine.virtual.x > 0.5) {
      this.lane = Math.min(2, this.lane + 1);
      if (engine.virtual.x > 0.5) engine.virtual.x = 0;
    }
    if (this.y <= 0.71 && engine.jumpPressed()) this.vy = 8.6;

    this.speed = clamp(18 + this.z * 0.035, 18, 36);
    this.z += this.speed * dt;
    this.vy -= 26 * dt;
    this.y += this.vy * dt;
    if (this.y < 0.7) {
      this.y = 0.7;
      this.vy = 0;
    }

    const targetX = LANES[this.lane];
    const x = this.player.position.x + (targetX - this.player.position.x) * (1 - Math.exp(-14 * dt));
    this.player.position.set(x, this.y, this.z);
    this.player.rotation.x = this.y > 0.75 ? -0.2 : 0;

    while (this.nextZ < this.z + 70) {
      this.spawnObstacle(this.nextZ);
      this.nextZ += 11 + Math.random() * 5;
    }

    this.obstacles = this.obstacles.filter((obs) => {
      if (obs.z >= this.z - 12) return true;
      this.ctx.engine.scene.remove(obs.mesh);
      obs.mesh.geometry.dispose();
      (obs.mesh.material as THREE.Material).dispose();
      return false;
    });

    for (const obs of this.obstacles) {
      if (obs.hit) continue;
      if (obs.z < this.z - 8) continue;
      const sameLane = obs.lane === this.lane && Math.abs(this.player.position.x - LANES[obs.lane]) < 0.7;
      const near = Math.abs(obs.z - this.z) < (obs.tall ? 0.7 : 0.85);
      const lowHit = !obs.tall && this.y < 1.35;
      if (sameLane && near && (obs.tall || lowHit)) {
        this.status = "lost";
        lookOf(this.ctx.engine).burst(this.player.position, NEON.rose, 18);
        lookOf(this.ctx.engine).sfx(90, 0.25, "sawtooth", 0.06, -40);
        const dist = Math.floor(this.z);
        if (dist > this.best) {
          this.best = dist;
          this.writeBest(dist);
        }
        this.ctx.emitHud({ status: "lost", score: dist, objective: `最远 ${this.best} m`, toast: "撞障" });
        return;
      }
    }

    this.floor.position.z = this.z + 70;
    const cam = this.ctx.engine.camera;
    cam.position.lerp(new THREE.Vector3(this.player.position.x * 0.35, 3.8, this.z - 9), 1 - Math.exp(-6 * dt));
    cam.lookAt(this.player.position.x, 1.1, this.z + 6);
    this.pushHud();
  }

  dispose() {
    this.clearObstacles();
  }

  private resetRun() {
    this.lane = 1;
    this.y = 0.7;
    this.vy = 0;
    this.z = 0;
    this.speed = 18;
    this.nextZ = 26;
    this.player.position.set(0, 0.7, 0);
    this.clearObstacles();
  }

  private spawnObstacle(z: number) {
    const lane = Math.floor(Math.random() * 3);
    const tall = Math.random() > 0.55;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, tall ? 2.4 : 0.9, 1.1),
      neonMat(tall ? NEON.rose : NEON.amber, 0.7),
    );
    mesh.position.set(LANES[lane], tall ? 1.2 : 0.45, z);
    this.ctx.engine.scene.add(mesh);
    this.obstacles.push({ mesh, lane, z, tall, hit: false });
  }

  private clearObstacles() {
    this.obstacles.forEach((obs) => {
      this.ctx.engine.scene.remove(obs.mesh);
      obs.mesh.geometry.dispose();
      (obs.mesh.material as THREE.Material).dispose();
    });
    this.obstacles = [];
  }

  private pushHud() {
    this.hudAcc += 0.016;
    if (this.hudAcc < 0.12) return;
    this.hudAcc = 0;
    const dist = Math.floor(this.z);
    this.ctx.emitHud({
      status: "playing",
      score: dist,
      objective: `${dist} m · 最远 ${this.best} m`,
    });
  }

  private readBest() {
    try {
      return Number(localStorage.getItem("mai-game-best-void-dash")) || 0;
    } catch {
      return 0;
    }
  }

  private writeBest(value: number) {
    try {
      localStorage.setItem("mai-game-best-void-dash", String(value));
    } catch {
      /* ignore quota */
    }
  }
}
