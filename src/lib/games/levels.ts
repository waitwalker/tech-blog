export type EnemyType = "swarmer" | "shield" | "sniper" | "boss_colossus" | "boss_overlord";

export interface LevelTheme {
  accent: number;
  bg: number;
  gridLine: number;
  wall: number;
  fogNear: number;
  fogFar: number;
}

export interface LevelConfig {
  id: number;
  name: string;
  subtitle: string;
  brief: string;
  arenaRadius: number;
  targetKills: number;
  waves: number;
  hasBoss: boolean;
  bossType?: "colossus" | "overlord";
  hasLaserTraps?: boolean;
  enemyPool: EnemyType[];
  parTimeSec: number; // 3星时限
  theme: LevelTheme;
}

export interface LevelProgress {
  unlocked: boolean;
  completed: boolean;
  stars: number; // 0 ~ 3
  highScore: number;
  bestTimeSec: number;
}

export const PULSE_LEVELS: LevelConfig[] = [
  {
    id: 1,
    name: "虚拟靶场·初阶连结",
    subtitle: "基础移动与多模式射击适应",
    brief: "适应脉冲步枪与散射霰弹，击破 18 具基础迅捷蜂群无人机。",
    arenaRadius: 16,
    targetKills: 18,
    waves: 3,
    hasBoss: false,
    enemyPool: ["swarmer"],
    parTimeSec: 45,
    theme: {
      accent: 0x22d3ee, // 亮青
      bg: 0x07111e,
      gridLine: 0x0284c7,
      wall: 0x0c1e33,
      fogNear: 15,
      fogFar: 65,
    },
  },
  {
    id: 2,
    name: "回廊伏击·护盾突围",
    subtitle: "重型装甲巡游体初登场",
    brief: "装甲蜂带有正面防弹护盾，利用霰弹近距离穿透或绕后精准点杀。",
    arenaRadius: 18,
    targetKills: 26,
    waves: 3,
    hasBoss: false,
    enemyPool: ["swarmer", "shield"],
    parTimeSec: 60,
    theme: {
      accent: 0x818cf8, // 靛蓝
      bg: 0x090a1f,
      gridLine: 0x4f46e5,
      wall: 0x131438,
      fogNear: 18,
      fogFar: 75,
    },
  },
  {
    id: 3,
    name: "反应堆外环·激光矩阵",
    subtitle: "动态致命陷阱与战术机动",
    brief: "地图中央存在周期旋转的电离激光线，避开激光同时歼灭混合敌群。",
    arenaRadius: 20,
    targetKills: 32,
    waves: 4,
    hasBoss: false,
    hasLaserTraps: true,
    enemyPool: ["swarmer", "shield"],
    parTimeSec: 75,
    theme: {
      accent: 0xf59e0b, // 琥珀金
      bg: 0x170f05,
      gridLine: 0xd97706,
      wall: 0x2b1c08,
      fogNear: 18,
      fogFar: 80,
    },
  },
  {
    id: 4,
    name: "军械机库·远距压制",
    subtitle: "高威胁红外狙击机甲突袭",
    brief: "狙击体会发射致命红外蓄力光束！使用电磁轨道炮超远距离对狙拔除。",
    arenaRadius: 22,
    targetKills: 38,
    waves: 4,
    hasBoss: false,
    enemyPool: ["swarmer", "shield", "sniper"],
    parTimeSec: 90,
    theme: {
      accent: 0xf43f5e, // 绯红
      bg: 0x1c080e,
      gridLine: 0xe11d48,
      wall: 0x330f1b,
      fogNear: 20,
      fogFar: 85,
    },
  },
  {
    id: 5,
    name: "【BOSS战】机械要塞·零号守护者",
    subtitle: "遭遇第一阶段三形态钢铁巨兽",
    brief: "零号巨兽拥有极厚护盾与飞弹齐射能力。摧毁其浮游充能球后集火斩杀！",
    arenaRadius: 26,
    targetKills: 20,
    waves: 2,
    hasBoss: true,
    bossType: "colossus",
    enemyPool: ["swarmer", "shield", "boss_colossus"],
    parTimeSec: 120,
    theme: {
      accent: 0x10b981, // 翡翠绿
      bg: 0x051a14,
      gridLine: 0x059669,
      wall: 0x0b2e23,
      fogNear: 22,
      fogFar: 95,
    },
  },
  {
    id: 6,
    name: "重力塌陷·深渊浮岛",
    subtitle: "开阔虚空悬崖与机动跳跃",
    brief: "边缘即是虚空！利用超频冲刺在悬浮立柱间机动，击退空中蜂群。",
    arenaRadius: 20,
    targetKills: 40,
    waves: 4,
    hasBoss: false,
    enemyPool: ["swarmer", "sniper"],
    parTimeSec: 80,
    theme: {
      accent: 0xa855f7, // 霓虹紫
      bg: 0x14071f,
      gridLine: 0x9333ea,
      wall: 0x270f3d,
      fogNear: 18,
      fogFar: 80,
    },
  },
  {
    id: 7,
    name: "生化核心·纳米暗流",
    subtitle: "毒性脉冲地表与快速猎杀",
    brief: "污染区敌人移速与攻击大幅提升，合理利用 E 键全向 EMP 控场与自保。",
    arenaRadius: 22,
    targetKills: 46,
    waves: 4,
    hasBoss: false,
    enemyPool: ["swarmer", "shield", "sniper"],
    parTimeSec: 90,
    theme: {
      accent: 0x84cc16, // 酸性绿
      bg: 0x0d1c05,
      gridLine: 0x65a30d,
      wall: 0x182e0a,
      fogNear: 20,
      fogFar: 85,
    },
  },
  {
    id: 8,
    name: "电磁风暴·高能盲区",
    subtitle: "强干扰雷暴与高密度交火",
    brief: "闪电周期性遮蔽视线，敌人隐匿于雷云阴影中，盯紧枪火与小地图雷达！",
    arenaRadius: 24,
    targetKills: 52,
    waves: 5,
    hasBoss: false,
    hasLaserTraps: true,
    enemyPool: ["swarmer", "shield", "sniper"],
    parTimeSec: 105,
    theme: {
      accent: 0x06b6d4, // 青蓝
      bg: 0x04161a,
      gridLine: 0x0891b2,
      wall: 0x0a2a30,
      fogNear: 16,
      fogFar: 75,
    },
  },
  {
    id: 9,
    name: "传送要塞·全线突破",
    subtitle: "四方跃迁传送门全面暴走",
    brief: "四大传送门高频刷新精英混编兵团，极限考验弹药控制与走位生存能力。",
    arenaRadius: 26,
    targetKills: 64,
    waves: 5,
    hasBoss: false,
    enemyPool: ["swarmer", "shield", "sniper"],
    parTimeSec: 120,
    theme: {
      accent: 0xf97316, // 炽烈橙
      bg: 0x1c0e04,
      gridLine: 0xea580c,
      wall: 0x331908,
      fogNear: 20,
      fogFar: 90,
    },
  },
  {
    id: 10,
    name: "【终极决战】主脑中枢·终焉裁决者",
    subtitle: "主宰级机械蜂后毁灭之战",
    brief: "终极 BOSS 掌控全场电磁死光、分身召唤与致命地毯式轰炸，决战赛博巅峰！",
    arenaRadius: 30,
    targetKills: 35,
    waves: 3,
    hasBoss: true,
    bossType: "overlord",
    enemyPool: ["swarmer", "shield", "sniper", "boss_overlord"],
    parTimeSec: 150,
    theme: {
      accent: 0xec4899, // 赛博粉
      bg: 0x1f0714,
      gridLine: 0xdb2777,
      wall: 0x3b0e27,
      fogNear: 25,
      fogFar: 110,
    },
  },
];

const STORAGE_KEY_PREFIX = "monster_game_progress_";

export function loadGameProgress(gameId: string): Record<number, LevelProgress> {
  if (typeof window === "undefined") return { 1: { unlocked: true, completed: false, stars: 0, highScore: 0, bestTimeSec: 0 } };
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}${gameId}`);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch {
    /* fallback to default */
  }

  // 默认只有第 1 关解锁
  const initial: Record<number, LevelProgress> = {};
  PULSE_LEVELS.forEach((lvl) => {
    initial[lvl.id] = {
      unlocked: lvl.id === 1,
      completed: false,
      stars: 0,
      highScore: 0,
      bestTimeSec: 0,
    };
  });
  return initial;
}

export function saveGameLevelResult(
  gameId: string,
  levelId: number,
  score: number,
  timeSec: number,
  hpRemainPercent: number
): { stars: number; isNewUnlock: boolean; nextLevelId: number | null } {
  const current = loadGameProgress(gameId);
  const cfg = PULSE_LEVELS.find((l) => l.id === levelId) || PULSE_LEVELS[0];

  // 星级算法:
  // ★1: 成功通关
  // ★2: 剩余生命 >= 50%
  // ★3: 通关耗时 <= parTimeSec
  let stars = 1;
  if (hpRemainPercent >= 0.5) stars++;
  if (timeSec <= cfg.parTimeSec) stars++;

  const prev = current[levelId] || { unlocked: true, completed: false, stars: 0, highScore: 0, bestTimeSec: 0 };
  const bestStars = Math.max(prev.stars, stars);
  const highScore = Math.max(prev.highScore, score);
  const bestTime = prev.bestTimeSec > 0 ? Math.min(prev.bestTimeSec, timeSec) : timeSec;

  current[levelId] = {
    unlocked: true,
    completed: true,
    stars: bestStars,
    highScore,
    bestTimeSec: bestTime,
  };

  // 解锁下一关
  let isNewUnlock = false;
  const nextId = levelId + 1;
  if (nextId <= PULSE_LEVELS.length) {
    if (!current[nextId] || !current[nextId].unlocked) {
      current[nextId] = {
        unlocked: true,
        completed: false,
        stars: 0,
        highScore: 0,
        bestTimeSec: 0,
      };
      isNewUnlock = true;
    }
  }

  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(`${STORAGE_KEY_PREFIX}${gameId}`, JSON.stringify(current));
    } catch {
      /* ignore */
    }
  }

  return {
    stars,
    isNewUnlock,
    nextLevelId: nextId <= PULSE_LEVELS.length ? nextId : null,
  };
}
