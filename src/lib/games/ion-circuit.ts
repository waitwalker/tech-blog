import * as THREE from "three";
import { NEON, neonMat } from "./engine";
import { addMat, circuitFloor, installLook, lookOf, neonRim } from "./look";
import { clamp, formatTime } from "./math";
import type { GameContext, MiniGame } from "./types";

const LAPS = 3;
const CHECKPOINTS = 8;

export class IonCircuitGame implements MiniGame {
  private ctx!: GameContext;
  private path!: THREE.CatmullRomCurve3;
  private samples: THREE.Vector3[] = [];
  private car = new THREE.Group();
  private hoop = new THREE.Mesh();
  private heading = 0;
  private speed = 0;
  private lap = 1;
  private nextCp = 1;
  private elapsed = 0;
  private status: "playing" | "won" | "lost" = "playing";
  private hudAcc = 0;
  private offTrack = false;

  mount(ctx: GameContext) {
    this.ctx = ctx;
    const { scene, camera } = ctx.engine;
    const look = installLook(ctx.engine, { accent: NEON.indigo, bg: 0x05060f });
    scene.add(circuitFloor(88, look, -0.55));
    scene.add(neonRim(38, NEON.indigo, -0.28));

    const curve = new THREE.EllipseCurve(0, 0, 26, 16, 0, Math.PI * 2, false, 0);
    const pts = curve.getSpacedPoints(160).map((p) => new THREE.Vector3(p.x, 0, p.y));
    this.path = new THREE.CatmullRomCurve3(pts, true);
    this.samples = this.path.getSpacedPoints(80);

    const track = new THREE.Mesh(
      new THREE.TubeGeometry(this.path, 180, 3.35, 12, true),
      new THREE.MeshStandardMaterial({ color: 0xc7d2fe, emissive: 0x4338ca, emissiveIntensity: 0.12, roughness: 0.45, metalness: 0.35, map: look.grid }),
    );
    scene.add(track);
    const rail = new THREE.Mesh(new THREE.TubeGeometry(this.path, 180, 3.58, 8, true), addMat(NEON.cyan, 0.55));
    rail.scale.set(1, 0.06, 1);
    scene.add(rail);
    const inner = new THREE.Mesh(new THREE.TubeGeometry(this.path, 120, 0.12, 8, true), addMat(NEON.amber, 0.8));
    inner.position.y = 0.05;
    scene.add(inner);

    this.car = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.32, 2.7), neonMat(NEON.cyan, 0.85));
    body.position.y = 0.42;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.34, 1.15), neonMat(NEON.indigo, 0.7));
    cabin.position.set(0, 0.74, -0.15);
    const wingL = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.06, 1.1), addMat(NEON.cyan, 0.7));
    const wingR = wingL.clone();
    wingL.position.set(-0.95, 0.38, 0.1);
    wingR.position.set(0.95, 0.38, 0.1);
    const lightL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.08), addMat(0xfef08a));
    const lightR = lightL.clone();
    lightL.position.set(-0.45, 0.4, 1.35);
    lightR.position.set(0.45, 0.4, 1.35);
    this.car.add(body, cabin, wingL, wingR, lightL, lightR);
    scene.add(this.car);

    this.hoop = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.08, 10, 32), addMat(NEON.amber));
    scene.add(this.hoop);

    camera.position.set(0, 8, 16);
    this.resetCar();
    this.placeHoop();
    this.ctx.emitHud({ status: "ready", score: 0, lap: "1 / 3", time: "0:00.00", objective: "完成 3 圈" });
  }

  start() {
    this.speed = 0;
    this.lap = 1;
    this.nextCp = 1;
    this.elapsed = 0;
    this.status = "playing";
    this.resetCar();
    this.placeHoop();
    lookOf(this.ctx.engine).sfx(180, 0.2, "sawtooth", 0.05, 120);
    this.ctx.emitHud({ status: "playing", score: 0, lap: "1 / 3", time: "0:00.00", objective: "下一检查点 1 / 8", toast: "发车" });
  }

  pause() {}
  resume() {}

  update(dt: number) {
    if (this.status !== "playing") return;
    const axis = this.ctx.engine.axis();
    const accel = axis.y > 0 ? 34 : axis.y < 0 ? -22 : 0;
    this.speed += accel * dt;
    this.speed *= Math.exp(-1.35 * dt);
    this.speed = clamp(this.speed, -9, this.offTrack ? 11 : 32);
    if (Math.abs(this.speed) > 0.4) this.heading -= axis.x * dt * 1.85 * Math.sign(this.speed);

    this.car.position.x += Math.sin(this.heading) * this.speed * dt;
    this.car.position.z += Math.cos(this.heading) * this.speed * dt;
    this.car.position.y = 0.2;
    this.car.rotation.y = this.heading;

    const nearest = this.nearestPoint(this.car.position);
    this.offTrack = nearest.distanceTo(this.car.position) > 3.7;
    if (this.offTrack) {
      this.speed *= Math.exp(-1.8 * dt);
      if (Math.random() < dt * 14) lookOf(this.ctx.engine).burst(this.car.position, NEON.orange, 2);
    }
    this.hoop.rotation.z += dt * 2.4;
    if (Math.abs(this.speed) > 12 && Math.random() < dt * 10) {
      lookOf(this.ctx.engine).burst(this.car.position.clone().setY(0.2), NEON.cyan, 1);
    }

    const cp = this.path.getPointAt(this.nextCp / CHECKPOINTS);
    if (this.car.position.distanceTo(cp) < 5.2) {
      lookOf(this.ctx.engine).shockwave(cp.clone().setY(0.2), NEON.amber, 1.4);
      lookOf(this.ctx.engine).sfx(620, 0.08, "triangle", 0.04, 200);
      if (this.nextCp === 0) {
        this.lap += 1;
        if (this.lap > LAPS) {
          this.status = "won";
          lookOf(this.ctx.engine).sfx(523, 0.35, "triangle", 0.055, 240);
          lookOf(this.ctx.engine).shockwave(this.car.position, NEON.amber, 1.6);
          this.ctx.emitHud({
            status: "won",
            score: Math.max(0, Math.round(4000 - this.elapsed * 40)),
            lap: `${LAPS} / ${LAPS}`,
            time: formatTime(this.elapsed),
            objective: "完赛",
            toast: "冲线",
          });
          return;
        }
      }
      this.nextCp = (this.nextCp + 1) % CHECKPOINTS;
      this.placeHoop();
    }

    this.elapsed += dt;
    this.followCamera(dt);
    this.pushHud();
  }

  dispose() {}

  private resetCar() {
    const p = this.path.getPointAt(0);
    const t = this.path.getTangentAt(0);
    this.car.position.set(p.x, 0.2, p.z);
    this.heading = Math.atan2(t.x, t.z);
    this.car.rotation.y = this.heading;
  }

  private placeHoop() {
    const t = this.nextCp / CHECKPOINTS;
    const p = this.path.getPointAt(t);
    const tan = this.path.getTangentAt(t);
    this.hoop.position.set(p.x, 1.6, p.z);
    this.hoop.lookAt(p.x + tan.x, 1.6, p.z + tan.z);
  }

  private nearestPoint(pos: THREE.Vector3) {
    let best = this.samples[0];
    let bestD = Infinity;
    for (const sample of this.samples) {
      const d = sample.distanceToSquared(pos);
      if (d < bestD) {
        bestD = d;
        best = sample;
      }
    }
    return best;
  }

  private followCamera(dt: number) {
    const cam = this.ctx.engine.camera;
    const back = 11;
    const desired = new THREE.Vector3(
      this.car.position.x - Math.sin(this.heading) * back,
      5.4,
      this.car.position.z - Math.cos(this.heading) * back,
    );
    cam.position.lerp(desired, 1 - Math.exp(-4.8 * dt));
    cam.lookAt(this.car.position.x, 0.9, this.car.position.z);
  }

  private pushHud() {
    this.hudAcc += 0.016;
    if (this.hudAcc < 0.16) return;
    this.hudAcc = 0;
    this.ctx.emitHud({
      status: "playing",
      score: Math.max(0, Math.round(this.speed * 8)),
      lap: `${this.lap} / ${LAPS}`,
      time: formatTime(this.elapsed),
      objective: this.offTrack ? "回到赛道" : `检查点 ${this.nextCp} / ${CHECKPOINTS}`,
    });
  }
}
