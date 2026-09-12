import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

export const NEON = {
  cyan: 0x22d3ee,
  indigo: 0x6366f1,
  emerald: 0x34d399,
  rose: 0xfb7185,
  amber: 0xfbbf24,
  violet: 0xa78bfa,
  orange: 0xfb923c,
  pink: 0xf472b6,
  slate: 0x1e293b,
};

export type VirtualStick = {
  x: number;
  y: number;
  jump: boolean;
  fire: boolean;
  gravQ: boolean;
  gravE: boolean;
  weaponSlot?: 1 | 2 | 3;
  skillEmp?: boolean;
};

export type CanvasClick = { ndcX: number; ndcY: number };

function disposeObject(root: THREE.Object3D) {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh) && !(child instanceof THREE.Points) && !(child instanceof THREE.Line)) return;
    child.geometry?.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => {
      if (!material) return;
      Object.values(material).forEach((value) => {
        if (value instanceof THREE.Texture) value.dispose();
      });
      material.dispose();
    });
  });
}

export function neonMat(color: number, intensity = 0.85) {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: intensity,
    roughness: 0.22,
    metalness: 0.45,
  });
}

export function matteMat(color: number, emissive = 0.05) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.72,
    metalness: 0.18,
    emissive: color,
    emissiveIntensity: emissive,
  });
}

export function addNeonLights(scene: THREE.Scene, accent: number) {
  // 环境底光
  const ambient = new THREE.AmbientLight(0x0a1526, 0.45);
  scene.add(ambient);

  // 天空半球漫反射光
  const hemi = new THREE.HemisphereLight(accent, 0x050811, 0.65);
  scene.add(hemi);

  // 主定向光（投射高精度柔和阴影）
  const key = new THREE.DirectionalLight(0xf0f7ff, 1.45);
  key.position.set(16, 28, 18);
  key.castShadow = true;
  key.shadow.mapSize.width = 2048;
  key.shadow.mapSize.height = 2048;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 120;
  key.shadow.camera.left = -30;
  key.shadow.camera.right = 30;
  key.shadow.camera.top = 30;
  key.shadow.camera.bottom = -30;
  key.shadow.bias = -0.0004;
  scene.add(key);

  // 侧翼轮廓聚光灯（增添边缘反光）
  const rim = new THREE.DirectionalLight(accent, 0.95);
  rim.position.set(-18, 12, -14);
  scene.add(rim);
}

export function addStarfield(scene: THREE.Scene, count = 350, spread = 180) {
  const geo = new THREE.BufferGeometry();
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    arr[i * 3] = (Math.random() - 0.5) * spread;
    arr[i * 3 + 1] = Math.random() * 65 + 4;
    arr[i * 3 + 2] = (Math.random() - 0.5) * spread;
  }
  geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0x93c5fd, size: 0.12, transparent: true, opacity: 0.9 })));
}

/** 动态赛博网格地面生成器 */
export function createCyberGridFloor(radius: number, accent: number, gridColor = 0x0284c7): THREE.Mesh {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1024;
  const g = canvas.getContext("2d");
  if (g) {
    g.fillStyle = "#060d17";
    g.fillRect(0, 0, 1024, 1024);

    // 大金属瓷砖接缝
    g.strokeStyle = "#0f1f33";
    g.lineWidth = 4;
    for (let x = 0; x <= 1024; x += 128) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, 1024);
      g.stroke();
      g.beginPath();
      g.moveTo(0, x);
      g.lineTo(1024, x);
      g.stroke();
    }

    // 细致高亮发光网格线
    g.strokeStyle = "rgba(14, 165, 233, 0.35)";
    g.lineWidth = 1.5;
    for (let x = 0; x <= 1024; x += 32) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, 1024);
      g.stroke();
      g.beginPath();
      g.moveTo(0, x);
      g.lineTo(1024, x);
      g.stroke();
    }

    // 赛博电路节点圆圈
    g.fillStyle = "#38bdf8";
    for (let x = 64; x < 1024; x += 128) {
      for (let y = 64; y < 1024; y += 128) {
        g.beginPath();
        g.arc(x, y, 3, 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(radius / 2.5, radius / 2.5);

  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    roughness: 0.28,
    metalness: 0.65,
    bumpMap: tex,
    bumpScale: 0.04,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2.2, radius * 2.2), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0;
  mesh.receiveShadow = true;
  return mesh;
}

export function setupArena(scene: THREE.Scene, fog: number, fogNear: number, fogFar: number, accent: number) {
  scene.background = new THREE.Color(fog);
  scene.fog = new THREE.Fog(fog, fogNear, fogFar);
  addNeonLights(scene, accent);
  addStarfield(scene);
}

type EngineOptions = {
  container: HTMLElement;
  fov?: number;
  near?: number;
  far?: number;
};

export class GameEngine {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  clock = new THREE.Clock();
  keys = new Set<string>();
  justPressed = new Set<string>();
  virtual: VirtualStick = { x: 0, y: 0, jump: false, fire: false, gravQ: false, gravE: false };
  click: CanvasClick | null = null;
  pointerNdc: CanvasClick = { ndcX: 0, ndcY: 0 };
  mouseDx = 0;
  mouseDy = 0;
  pointerLocked = false;
  pointerLockWanted = false;
  mouseHeld = false;
  onPointerLock: ((locked: boolean) => void) | null = null;
  customRender: (() => void) | null = null;
  onResize: ((width: number, height: number) => void) | null = null;
  onDispose: (() => void) | null = null;

  // 后处理与辉光管线
  composer: EffectComposer | null = null;
  bloomPass: UnrealBloomPass | null = null;
  quality: "high" | "low" = "high";

  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private raf = 0;
  private onFrame: ((dt: number) => void) | null = null;
  private disposed = false;
  private dragging = false;
  private unbind: Array<() => void> = [];
  private resizeObserver: ResizeObserver;

  constructor(opts: EngineOptions) {
    this.container = opts.container;
    const lowPower = window.matchMedia("(max-width: 780px)").matches || (navigator.hardwareConcurrency ?? 8) < 6;
    this.camera = new THREE.PerspectiveCamera(opts.fov ?? 68, 1, opts.near ?? 0.08, opts.far ?? 260);
    
    this.renderer = new THREE.WebGLRenderer({
      antialias: !lowPower,
      alpha: false,
      powerPreference: "high-performance",
      stencil: false,
      depth: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, lowPower ? 1.25 : 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    // 启用生产级高精度柔和阴影
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.canvas = this.renderer.domElement;
    this.canvas.className = "game-canvas";
    this.canvas.tabIndex = 0;
    this.container.appendChild(this.canvas);

    // 初始化后处理辉光管线 (UnrealBloomPass)
    try {
      this.composer = new EffectComposer(this.renderer);
      const renderPass = new RenderPass(this.scene, this.camera);
      this.composer.addPass(renderPass);

      // 辉光参数优化：仅高能发光材质辉光漫溢
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        1.25,  // strength
        0.42,  // radius
        0.26   // threshold
      );
      this.composer.addPass(this.bloomPass);
    } catch {
      this.composer = null;
    }

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();

    this.bind(window, "keydown", (event) => {
      const e = event as KeyboardEvent;
      if (e.repeat) return;
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
      this.justPressed.add(e.code);
    });
    this.bind(window, "keyup", (event) => {
      this.keys.delete((event as KeyboardEvent).code);
    });
    this.bind(this.canvas, "pointerdown", (event) => {
      const e = event as PointerEvent;
      if (e.button !== 0 && e.pointerType === "mouse") return;
      this.dragging = true;
      this.mouseHeld = true;
      if (!this.pointerLockWanted && !this.pointerLocked) {
        try {
          this.canvas.setPointerCapture(e.pointerId);
        } catch {
          /* lock takeover */
        }
      }
      const rect = this.canvas.getBoundingClientRect();
      this.click = {
        ndcX: ((e.clientX - rect.left) / rect.width) * 2 - 1,
        ndcY: -((e.clientY - rect.top) / rect.height) * 2 + 1,
      };
      this.pointerNdc = this.click;
      this.justPressed.add("Mouse0");
      if (this.pointerLockWanted && !this.pointerLocked) {
        this.canvas.requestPointerLock().catch(() => undefined);
      }
    });
    this.bind(this.canvas, "pointermove", (event) => {
      const e = event as PointerEvent;
      const rect = this.canvas.getBoundingClientRect();
      this.pointerNdc = {
        ndcX: ((e.clientX - rect.left) / rect.width) * 2 - 1,
        ndcY: -((e.clientY - rect.top) / rect.height) * 2 + 1,
      };
      if (this.pointerLocked || this.dragging) {
        this.mouseDx += e.movementX;
        this.mouseDy += e.movementY;
      }
    });
    this.bind(this.canvas, "pointerup", (event) => {
      const e = event as PointerEvent;
      this.dragging = false;
      this.mouseHeld = false;
      try {
        if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    });
    this.bind(this.canvas, "pointercancel", () => {
      this.dragging = false;
      this.mouseHeld = false;
    });
    this.bind(this.canvas, "contextmenu", (event) => event.preventDefault());
    this.bind(document, "pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      this.onPointerLock?.(this.pointerLocked);
    });
    this.bind(window, "blur", () => {
      this.keys.clear();
      this.dragging = false;
      this.mouseHeld = false;
    });
  }

  axis() {
    const left = this.keys.has("KeyA") || this.keys.has("ArrowLeft") || this.virtual.x < -0.4;
    const right = this.keys.has("KeyD") || this.keys.has("ArrowRight") || this.virtual.x > 0.4;
    const up = this.keys.has("KeyW") || this.keys.has("ArrowUp") || this.virtual.y > 0.4;
    const down = this.keys.has("KeyS") || this.keys.has("ArrowDown") || this.virtual.y < -0.4;
    return {
      x: (right ? 1 : 0) - (left ? 1 : 0),
      y: (up ? 1 : 0) - (down ? 1 : 0),
    };
  }

  jumpPressed() {
    return this.justPressed.has("Space") || this.virtual.jump;
  }

  firePressed() {
    return this.justPressed.has("Mouse0") || this.virtual.fire;
  }

  fireHeld() {
    return this.mouseHeld || this.virtual.fire;
  }

  weaponSlotPressed(): 1 | 2 | 3 | null {
    if (this.justPressed.has("Digit1") || this.virtual.weaponSlot === 1) return 1;
    if (this.justPressed.has("Digit2") || this.virtual.weaponSlot === 2) return 2;
    if (this.justPressed.has("Digit3") || this.virtual.weaponSlot === 3) return 3;
    return null;
  }

  skillEmpPressed(): boolean {
    return this.justPressed.has("KeyE") || !!this.virtual.skillEmp;
  }

  sprintHeld(): boolean {
    return this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
  }

  setQuality(q: "high" | "low") {
    this.quality = q;
  }

  setPointerLock(wanted: boolean) {
    this.pointerLockWanted = wanted;
    if (!wanted && this.pointerLocked) document.exitPointerLock();
    if (wanted && !this.pointerLocked) this.canvas.requestPointerLock().catch(() => undefined);
  }

  start(onFrame: (dt: number) => void) {
    this.onFrame = onFrame;
    this.clock.start();
    this.clock.getDelta();
    const loop = () => {
      if (this.disposed) return;
      const dt = Math.min(this.clock.getDelta(), 0.05);
      this.onFrame?.(dt);
      this.justPressed.clear();
      this.mouseDx = 0;
      this.mouseDy = 0;
      this.click = null;
      this.virtual.jump = false;
      this.virtual.fire = false;
      this.virtual.gravQ = false;
      this.virtual.gravE = false;
      this.virtual.weaponSlot = undefined;
      this.virtual.skillEmp = undefined;

      if (this.customRender) {
        this.customRender();
      } else if (this.quality === "high" && this.composer) {
        this.composer.render();
      } else {
        this.renderer.render(this.scene, this.camera);
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  resize() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.composer?.setSize(width, height);
    this.bloomPass?.resolution.set(width, height);
    this.onResize?.(width, height);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.onDispose?.();
    this.onDispose = null;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.unbind.forEach((fn) => fn());
    this.unbind = [];
    if (this.pointerLocked) document.exitPointerLock();
    disposeObject(this.scene);
    this.scene.clear();
    this.renderer.dispose();
    this.canvas.remove();
  }

  private bind(target: EventTarget, type: string, handler: EventListener) {
    target.addEventListener(type, handler);
    this.unbind.push(() => target.removeEventListener(type, handler));
  }
}
