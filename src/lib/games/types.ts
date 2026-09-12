import type { GameEngine } from "./engine";

export type GameId =
  | "pulse-clearance"
  | "ion-circuit"
  | "lattice-jump"
  | "node-defense"
  | "gravity-vault"
  | "void-dash"
  | "stardust-sweep"
  | "fog-keyhunt"
  | "cloud-intercept"
  | "prism-snake"
  | "photon-breakout"
  | "orbit-putt"
  | "quantum-pool"
  | "stack-matrix"
  | "shadow-infiltrate"
  | "arc-battery"
  | "gyro-labyrinth"
  | "light-duel"
  | "lattice-blast"
  | "cube-shove"
  | "galaxy-strafe"
  | "ring-clash"
  | "crescent-shot"
  | "phase-crossing"
  | "wormhole-dive"
  | "arc-slice";

export type GameStatus = "ready" | "playing" | "paused" | "won" | "lost";

export type TouchLayout = "fps" | "steer" | "jump-move" | "lanes" | "gravity" | "none" | "dpad" | "dpad-fire" | "paddle";

export type WeaponType = "pulse" | "shotgun" | "railgun";

export type RadarDot = {
  x: number; // -1 ~ 1 相对玩家归一化坐标
  y: number; // -1 ~ 1
  type: "enemy" | "shield" | "sniper" | "boss" | "orb";
};

export type LevelSummary = {
  stars: number;
  score: number;
  timeSec: number;
  isNewUnlock: boolean;
  nextLevelId: number | null;
};

export type HudSnapshot = {
  status: GameStatus;
  score: number;
  lives?: number;
  wave?: number;
  lap?: string;
  time?: string;
  timeSec?: number;
  objective: string;
  toast?: string;
  
  // 战役与关卡信息
  levelId?: number;
  levelName?: string;
  levelTotal?: number;
  levelResult?: LevelSummary | null;

  // 核心机体生命与能量护盾
  hp?: number;
  hpMax?: number;
  shield?: number;
  shieldMax?: number;
  hitFlash?: boolean;
  hurtFlash?: boolean;

  // 武器与战术技能
  currentWeapon?: WeaponType;
  empCd?: number;
  empMaxCd?: number;

  // 连击与荣誉评定
  combo?: number;
  comboBanner?: string;

  // BOSS 战状态
  bossName?: string;
  bossHp?: number;
  bossMaxHp?: number;
  enemiesLeft?: number;

  // 全息雷达
  radarDots?: RadarDot[];
};

export type GameMeta = {
  id: GameId;
  title: string;
  genre: string;
  blurb: string;
  controls: string;
  touch: TouchLayout;
  accent: string;
  fog: number;
};

export type GameContext = {
  engine: GameEngine;
  emitHud: (patch: Partial<HudSnapshot>) => void;
};

export interface MiniGame {
  mount(ctx: GameContext): void;
  start(): void;
  pause(): void;
  resume(): void;
  update(dt: number): void;
  dispose(): void;
  selectLevel?(levelId: number): void;
}
