export function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

export function damp(current: number, target: number, lambda: number, dt: number) {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds * 100) % 100);
  return `${m}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function cellKey(x: number, y: number, z: number) {
  return `${x},${y},${z}`;
}

export function aabbOverlap(
  ax: number,
  ay: number,
  az: number,
  aw: number,
  ah: number,
  ad: number,
  bx: number,
  by: number,
  bz: number,
  bw: number,
  bh: number,
  bd: number,
) {
  return Math.abs(ax - bx) < (aw + bw) * 0.5 && Math.abs(ay - by) < (ah + bh) * 0.5 && Math.abs(az - bz) < (ad + bd) * 0.5;
}
