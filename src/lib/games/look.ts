import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { GameEngine } from "./engine";

export type LookOpts = {
  accent: number;
  bg?: number;
  bloom?: number;
  threshold?: number;
  fog?: number;
  dust?: number;
};

type Spark = { sprite: THREE.Sprite; vel: THREE.Vector3; life: number; max: number };
type Wave = { mesh: THREE.Mesh; life: number; max: number };
type Beam = { mesh: THREE.Mesh; life: number };

function canvasTex(size: number, paint: (ctx: CanvasRenderingContext2D, size: number) => void) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new THREE.Texture();
  paint(ctx, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

function glowTex(rgb: string) {
  return canvasTex(128, (g, s) => {
    const grd = g.createRadialGradient(s / 2, s / 2, 2, s / 2, s / 2, s / 2);
    grd.addColorStop(0, `rgba(${rgb},1)`);
    grd.addColorStop(0.28, `rgba(${rgb},0.5)`);
    grd.addColorStop(0.62, `rgba(${rgb},0.1)`);
    grd.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  });
}

function gridTex() {
  const tex = canvasTex(1024, (g, s) => {
    g.fillStyle = "#121a2c";
    g.fillRect(0, 0, s, s);
    g.strokeStyle = "rgba(148, 197, 232, 0.28)";
    g.lineWidth = 1;
    for (let i = 0; i <= s; i += 32) {
      g.beginPath();
      g.moveTo(i, 0);
      g.lineTo(i, s);
      g.stroke();
      g.beginPath();
      g.moveTo(0, i);
      g.lineTo(s, i);
      g.stroke();
    }
    g.strokeStyle = "rgba(56, 189, 248, 0.95)";
    g.lineWidth = 2;
    for (let i = 0; i <= s; i += 128) {
      g.beginPath();
      g.moveTo(i, 0);
      g.lineTo(i, s);
      g.stroke();
      g.beginPath();
      g.moveTo(0, i);
      g.lineTo(s, i);
      g.stroke();
    }
    g.fillStyle = "#7dd3fc";
    for (let i = 0; i <= s; i += 128) {
      for (let j = 0; j <= s; j += 128) {
        g.beginPath();
        g.arc(i, j, 3, 0, Math.PI * 2);
        g.fill();
      }
    }
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.repeat.set(6, 6);
  return tex;
}

let audio: AudioContext | null = null;

export function sfx(freq: number, dur = 0.08, type: OscillatorType = "square", vol = 0.045, slide = 0) {
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume();
    const t = audio.currentTime;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + dur);
  } catch {
    /* autoplay */
  }
}

export function addMat(color: number, opacity = 0.9) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

const kits = new WeakMap<GameEngine, LookKit>();

export function lookOf(engine: GameEngine) {
  const kit = kits.get(engine);
  if (!kit) throw new Error("LookKit missing — call installLook in mount");
  return kit;
}

export type LookKit = {
  accent: number;
  glow: THREE.Texture;
  glowHot: THREE.Texture;
  grid: THREE.Texture;
  sfx: typeof sfx;
  burst: (p: THREE.Vector3, color?: number, n?: number) => void;
  shockwave: (p: THREE.Vector3, color?: number, scale?: number) => void;
  tracer: (from: THREE.Vector3, to: THREE.Vector3, color?: number) => void;
  pulseFloor: (mesh: THREE.Mesh) => void;
  dispose: () => void;
};

export function installLook(engine: GameEngine, opts: LookOpts): LookKit {
  const bg = opts.bg ?? 0x030712;
  const accent = opts.accent;
  const { scene, camera, renderer } = engine;

  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  scene.background = new THREE.Color(bg);
  scene.fog = new THREE.Fog(bg, 50, 150);
  scene.add(new THREE.AmbientLight(0x9bb4d0, 0.38));
  scene.add(new THREE.HemisphereLight(0xc7d8f0, 0x1a1420, 0.42));
  const key = new THREE.DirectionalLight(0xf8fbff, 1.55);
  key.position.set(8, 16, 10);
  scene.add(key);
  const fill = new THREE.DirectionalLight(accent, 0.35);
  fill.position.set(-8, 6, -6);
  scene.add(fill);

  const glow = glowTex("125,211,252");
  const glowHot = glowTex("253,224,71");
  const grid = gridTex();

  const dustN = opts.dust ?? 48;
  const dustGeo = new THREE.BufferGeometry();
  const dustPos = new Float32Array(dustN * 3);
  for (let i = 0; i < dustN; i++) {
    dustPos[i * 3] = (Math.random() - 0.5) * 70;
    dustPos[i * 3 + 1] = Math.random() * 16;
    dustPos[i * 3 + 2] = (Math.random() - 0.5) * 70;
  }
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(
    dustGeo,
    new THREE.PointsMaterial({
      map: glow,
      color: accent,
      size: 0.07,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  scene.add(dust);

  const sparks: Spark[] = [];
  const waves: Wave[] = [];
  const beams: Beam[] = [];
  const fxRoot = new THREE.Group();
  scene.add(fxRoot);

  const size = new THREE.Vector2();
  renderer.getSize(size);
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(size.clone(), opts.bloom ?? 0.22, 0.28, opts.threshold ?? 0.62);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  let last = performance.now();
  let dead = false;
  const prevRender = engine.customRender;
  engine.customRender = () => {
    const now = performance.now();
    tick((now - last) / 1000);
    last = now;
    prevRender?.();
    composer.render();
  };
  const prevResize = engine.onResize;
  engine.onResize = (w, h) => {
    prevResize?.(w, h);
    composer.setSize(w, h);
    bloom.setSize(w, h);
  };

  function tick(dt: number) {
    const d = Math.min(0.05, Math.max(0, dt));
    dust.rotation.y += d * 0.02;
    grid.offset.y -= d * 0.018;
    sparks.splice(
      0,
      sparks.length,
      ...sparks.filter((s) => {
        s.life -= d;
        s.vel.y -= 8 * d;
        s.sprite.position.addScaledVector(s.vel, d);
        s.sprite.material.opacity = Math.max(0, s.life / s.max);
        s.sprite.scale.multiplyScalar(0.985);
        if (s.life > 0) return true;
        fxRoot.remove(s.sprite);
        s.sprite.material.dispose();
        return false;
      }),
    );
    waves.splice(
      0,
      waves.length,
      ...waves.filter((w) => {
        w.life -= d;
        w.mesh.scale.addScalar(d * 7);
        (w.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, w.life / w.max);
        if (w.life > 0) return true;
        fxRoot.remove(w.mesh);
        w.mesh.geometry.dispose();
        (w.mesh.material as THREE.Material).dispose();
        return false;
      }),
    );
    beams.splice(
      0,
      beams.length,
      ...beams.filter((b) => {
        b.life -= d;
        (b.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, b.life * 8);
        if (b.life > 0) return true;
        fxRoot.remove(b.mesh);
        b.mesh.geometry.dispose();
        (b.mesh.material as THREE.Material).dispose();
        return false;
      }),
    );
  }

  const kit: LookKit = {
    accent,
    glow,
    glowHot,
    grid,
    sfx,
    burst(p, color = accent, n = 10) {
      for (let i = 0; i < n; i++) {
        const mat = new THREE.SpriteMaterial({
          map: glowHot,
          color,
          blending: THREE.AdditiveBlending,
          transparent: true,
          depthWrite: false,
          opacity: 1,
        });
        const sprite = new THREE.Sprite(mat);
        sprite.position.copy(p);
        const sc = 0.16 + Math.random() * 0.22;
        sprite.scale.set(sc, sc, 1);
        fxRoot.add(sprite);
        sparks.push({
          sprite,
          vel: new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9, Math.random() - 0.5).multiplyScalar(7),
          life: 0.28 + Math.random() * 0.16,
          max: 0.45,
        });
      }
      while (sparks.length > 96) {
        const old = sparks.shift();
        if (!old) break;
        fxRoot.remove(old.sprite);
        old.sprite.material.dispose();
      }
    },
    shockwave(p, color = accent, scale = 0.6) {
      const mesh = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.2, 28), addMat(color, 0.9));
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.copy(p);
      mesh.scale.setScalar(scale);
      fxRoot.add(mesh);
      waves.push({ mesh, life: 0.32, max: 0.32 });
    },
    tracer(from, to, color = 0x7dd3fc) {
      const dir = to.clone().sub(from);
      const len = Math.max(0.15, dir.length());
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.008, 1, 6, 1, true), addMat(color, 0.95));
      mesh.position.copy(from).add(to).multiplyScalar(0.5);
      mesh.scale.set(1, len, 1);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      fxRoot.add(mesh);
      beams.push({ mesh, life: 0.12 });
    },
    pulseFloor(mesh) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (mat.emissiveMap) mat.emissiveMap.offset.y = grid.offset.y;
      mat.emissiveIntensity = 0.1 + Math.sin(performance.now() * 0.002) * 0.03;
    },
    dispose() {
      if (dead) return;
      dead = true;
      engine.customRender = prevRender;
      engine.onResize = prevResize;
      composer.dispose();
      scene.remove(dust, fxRoot, fill, key);
      dustGeo.dispose();
      (dust.material as THREE.Material).dispose();
      glow.dispose();
      glowHot.dispose();
      grid.dispose();
      sparks.forEach((s) => s.sprite.material.dispose());
      waves.forEach((w) => {
        w.mesh.geometry.dispose();
        (w.mesh.material as THREE.Material).dispose();
      });
      beams.forEach((b) => {
        b.mesh.geometry.dispose();
        (b.mesh.material as THREE.Material).dispose();
      });
    },
  };

  const prevDispose = engine.onDispose;
  engine.onDispose = () => {
    kit.dispose();
    prevDispose?.();
  };
  kits.set(engine, kit);

  return kit;
}

export function circuitFloor(size: number, look: LookKit, y = 0) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xe2e8f0,
    map: look.grid,
    emissive: look.accent,
    emissiveMap: look.grid,
    emissiveIntensity: 0.1,
    roughness: 0.62,
    metalness: 0.18,
  });
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(size * 0.5, 64), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  return mesh;
}

export function neonRim(radius: number, color: number, y = 0.05) {
  const mesh = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.07, 8, 64), addMat(color));
  mesh.rotation.x = Math.PI / 2;
  mesh.position.y = y;
  return mesh;
}
