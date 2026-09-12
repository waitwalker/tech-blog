"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Pause,
  Play,
  RotateCcw,
  Volume2,
  VolumeX,
  Sparkles,
  Shield,
  Zap,
  Star,
  Lock,
  ChevronRight,
  Layers,
  Crosshair,
  Award,
} from "lucide-react";
import { GameEngine } from "@/lib/games/engine";
import { createGame, getGame } from "@/lib/games/registry";
import { sound } from "@/lib/games/audio";
import { PULSE_LEVELS, loadGameProgress } from "@/lib/games/levels";
import type { GameStatus, HudSnapshot, TouchLayout, WeaponType } from "@/lib/games/types";
import "./games.css";

const INITIAL: HudSnapshot = {
  status: "ready",
  score: 0,
  objective: "",
};

export function GameShell({ slug }: { slug: string }) {
  const meta = getGame(slug);
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const gameRef = useRef<ReturnType<typeof createGame> | null>(null);
  const statusRef = useRef<GameStatus>("ready");
  
  const [hud, setHud] = useState<HudSnapshot>(INITIAL);
  const [ready, setReady] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [quality, setQuality] = useState<"high" | "low">("high");
  const [showLevelModal, setShowLevelModal] = useState(false);
  const [progress, setProgress] = useState(() => loadGameProgress(slug));

  const emitHud = useCallback((patch: Partial<HudSnapshot>) => {
    setHud((prev) => {
      const next = { ...prev, ...patch };
      statusRef.current = next.status;
      return next;
    });
  }, []);

  useEffect(() => {
    if (!meta || !hostRef.current) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const engine = new GameEngine({ container: hostRef.current });
    const game = createGame(meta.id);
    engineRef.current = engine;
    gameRef.current = game;
    statusRef.current = "ready";
    setHud({ ...INITIAL, objective: meta.blurb });
    game.mount({ engine, emitHud });

    engine.onPointerLock = (locked) => {
      if (!locked && statusRef.current === "playing" && engine.pointerLockWanted) {
        statusRef.current = "paused";
        game.pause();
        engine.setPointerLock(false);
        setHud((prev) => ({ ...prev, status: "paused" }));
      }
    };

    engine.start((dt) => {
      if (statusRef.current === "playing") game.update(dt);
    });
    setReady(true);

    const onKey = (event: KeyboardEvent) => {
      if (event.code === "Escape" || event.code === "KeyP") {
        if (statusRef.current === "playing") {
          statusRef.current = "paused";
          game.pause();
          engine.setPointerLock(false);
          setHud((prev) => ({ ...prev, status: "paused" }));
        } else if (statusRef.current === "paused") {
          statusRef.current = "playing";
          game.resume();
          setHud((prev) => ({ ...prev, status: "playing" }));
        }
      }
      if (event.code === "KeyR" && (statusRef.current === "won" || statusRef.current === "lost" || statusRef.current === "paused")) {
        restart();
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      game.dispose();
      engine.dispose();
      engineRef.current = null;
      gameRef.current = null;
    };
  }, [meta, emitHud]);

  useEffect(() => {
    if (!hud.toast) return;
    const id = window.setTimeout(() => setHud((prev) => ({ ...prev, toast: undefined })), 1800);
    return () => window.clearTimeout(id);
  }, [hud.toast]);

  useEffect(() => {
    if (!hud.hitFlash && !hud.hurtFlash) return;
    const id = window.setTimeout(() => setHud((prev) => ({ ...prev, hitFlash: false, hurtFlash: false })), 140);
    return () => window.clearTimeout(id);
  }, [hud.hitFlash, hud.hurtFlash]);

  // 通关时自动同步最新关卡进度
  useEffect(() => {
    if (hud.status === "won") {
      setProgress(loadGameProgress(slug));
    }
  }, [hud.status, slug]);

  const start = () => {
    if (!gameRef.current) return;
    statusRef.current = "playing";
    gameRef.current.start();
    setHud((prev) => ({ ...prev, status: "playing" }));
  };

  const pause = () => {
    if (statusRef.current !== "playing" || !gameRef.current) return;
    statusRef.current = "paused";
    gameRef.current.pause();
    engineRef.current?.setPointerLock(false);
    setHud((prev) => ({ ...prev, status: "paused" }));
  };

  const resume = () => {
    if (statusRef.current !== "paused" || !gameRef.current) return;
    statusRef.current = "playing";
    gameRef.current.resume();
    setHud((prev) => ({ ...prev, status: "playing" }));
  };

  const restart = () => {
    if (!gameRef.current) return;
    statusRef.current = "playing";
    gameRef.current.start();
    setHud((prev) => ({ ...prev, status: "playing" }));
  };

  const handleSelectLevel = (levelId: number) => {
    if (!gameRef.current || !gameRef.current.selectLevel) return;
    setShowLevelModal(false);
    statusRef.current = "playing";
    gameRef.current.selectLevel(levelId);
    setHud((prev) => ({ ...prev, status: "playing" }));
  };

  const toggleSound = () => {
    const muted = sound.toggleMute();
    setIsMuted(muted);
  };

  const toggleQuality = () => {
    const nextQ = quality === "high" ? "low" : "high";
    setQuality(nextQ);
    engineRef.current?.setQuality(nextQ);
  };

  if (!meta) return null;

  const overlay = hud.status !== "playing";
  const overlayTitle =
    hud.status === "ready"
      ? meta.title
      : hud.status === "paused"
      ? "战役已暂停"
      : hud.status === "won"
      ? "战役大捷 · 达成目标"
      : hud.status === "lost"
      ? "机体损毁 · 战役失败"
      : "";

  return (
    <div className="game-shell">
      {/* 3D WebGL 画布容器 */}
      <div ref={hostRef} className="absolute inset-0" />

      {/* 第一人称赛博准星 */}
      {meta.touch === "fps" && hud.status === "playing" ? (
        <div className="game-crosshair">
          <span className="ch-n" />
          <span className="ch-s" />
          <span className="ch-e" />
          <span className="ch-w" />
          <span className="ch-dot" />
        </div>
      ) : null}

      {/* 视觉滤镜与受击/命中闪烁 */}
      {hud.status === "playing" ? <div className="game-vignette" /> : null}
      {hud.status === "playing" && hud.hurtFlash ? <div className="game-hurt" /> : null}
      {hud.status === "playing" && hud.hitFlash ? <div className="game-hit" /> : null}

      {/* 连击荣誉横幅 */}
      {hud.status === "playing" && hud.comboBanner ? (
        <div className="game-combo-badge animate-bounce">{hud.comboBanner}</div>
      ) : null}

      {/* 顶部全局控制与战役信息栏 */}
      <header className="absolute top-0 inset-x-0 z-20 flex items-center justify-between gap-3 px-4 py-3 bg-gradient-to-b from-black/85 via-black/40 to-transparent">
        <div className="flex items-center gap-3">
          <Link
            href="/games"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900/80 border border-slate-800 text-xs font-mono text-slate-300 hover:text-cyan-300 hover:border-cyan-500/30 transition-all"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>返回大厅</span>
          </Link>

          {/* 关卡选择大厅入口按钮 */}
          {hud.levelId ? (
            <button
              type="button"
              onClick={() => setShowLevelModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-xs font-mono hover:bg-cyan-500/20 transition-all"
            >
              <Layers className="w-3.5 h-3.5" />
              <span>关卡 {hud.levelId}/{hud.levelTotal ?? 10} ▾</span>
            </button>
          ) : null}
        </div>

        {/* 关卡名与当前目标 */}
        <div className="text-center hidden md:block">
          <div className="text-sm font-bold text-white tracking-wide">{hud.levelName ?? meta.title}</div>
          <div className="text-[11px] font-mono text-slate-400">{hud.objective}</div>
        </div>

        {/* 控制按钮组：音效、画质、暂停 */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleSound}
            title="音效切换"
            className="p-2 rounded-xl bg-slate-900/80 border border-slate-800 text-slate-300 hover:text-cyan-300 transition-colors"
          >
            {isMuted ? <VolumeX className="w-3.5 h-3.5 text-rose-400" /> : <Volume2 className="w-3.5 h-3.5" />}
          </button>

          <button
            type="button"
            onClick={toggleQuality}
            title="辉光画质切换"
            className={`px-2.5 py-1.5 rounded-xl border text-xs font-mono flex items-center gap-1 transition-all ${
              quality === "high"
                ? "bg-amber-500/10 border-amber-500/40 text-amber-300"
                : "bg-slate-900/80 border-slate-800 text-slate-400"
            }`}
          >
            <Sparkles className="w-3 h-3" />
            <span className="hidden sm:inline">{quality === "high" ? "辉光:高" : "辉光:低"}</span>
          </button>

          {hud.status === "playing" ? (
            <button
              type="button"
              onClick={pause}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-slate-900/80 border border-slate-800 text-xs font-mono text-slate-300 hover:text-white"
            >
              <Pause className="w-3.5 h-3.5" /> 暂停
            </button>
          ) : hud.status === "paused" ? (
            <button
              type="button"
              onClick={resume}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-cyan-500/20 border border-cyan-500/40 text-xs font-mono text-cyan-300"
            >
              <Play className="w-3.5 h-3.5" /> 继续
            </button>
          ) : null}
        </div>
      </header>

      {/* 顶部 BOSS 巨型血条 */}
      {hud.status === "playing" && hud.bossHp !== undefined && hud.bossMaxHp ? (
        <div className="game-boss-hud animate-pulse">
          <div className="flex items-center justify-between text-xs font-mono">
            <span className="text-rose-400 font-bold tracking-wider">⚠️ {hud.bossName ?? "主宰级机械巨兽"}</span>
            <span className="text-slate-300 font-bold">{hud.bossHp} / {hud.bossMaxHp}</span>
          </div>
          <div className="game-boss-bar-bg">
            <div
              className="game-boss-bar-fill"
              style={{ width: `${Math.max(0, (hud.bossHp / hud.bossMaxHp) * 100)}%` }}
            />
          </div>
        </div>
      ) : null}

      {/* 左上角战术状态 Pod (生命值、护盾值、EMP技能) */}
      {hud.status === "playing" && hud.hp !== undefined && hud.hpMax ? (
        <div className="absolute top-16 left-4 z-20 space-y-2 p-3.5 rounded-2xl bg-slate-950/70 backdrop-blur-md border border-slate-800/80 text-xs font-mono min-w-[210px]">
          {/* 生命血条 */}
          <div>
            <div className="flex justify-between text-[11px] mb-1">
              <span className="text-emerald-400 flex items-center gap-1"><Zap className="w-3 h-3" /> 机体完整度</span>
              <span className="text-slate-300">{hud.hp} / {hud.hpMax}</span>
            </div>
            <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-all duration-150"
                style={{ width: `${Math.max(0, (hud.hp / hud.hpMax) * 100)}%` }}
              />
            </div>
          </div>

          {/* 能量护盾条 */}
          {hud.shield !== undefined && hud.shieldMax ? (
            <div>
              <div className="flex justify-between text-[11px] mb-1">
                <span className="text-cyan-400 flex items-center gap-1"><Shield className="w-3 h-3" /> 偏振护盾</span>
                <span className="text-slate-300">{hud.shield} / {hud.shieldMax}</span>
              </div>
              <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-cyan-400 shadow-[0_0_8px_#22d3ee] transition-all duration-150"
                  style={{ width: `${Math.max(0, (hud.shield / hud.shieldMax) * 100)}%` }}
                />
              </div>
            </div>
          ) : null}

          {/* E 键 EMP 战术技能冷却 */}
          {hud.empCd !== undefined ? (
            <div className="pt-1 flex items-center justify-between text-[11px]">
              <span className="text-indigo-300 flex items-center gap-1">
                <span className="px-1 py-0.2 bg-indigo-500/20 border border-indigo-500/40 rounded text-[10px]">E</span> EMP 冲击波
              </span>
              <span className={hud.empCd === 0 ? "text-emerald-400 font-bold" : "text-slate-500"}>
                {hud.empCd === 0 ? "READY" : `${hud.empCd}s`}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 右上角全息小雷达 Pod */}
      {hud.status === "playing" && hud.radarDots ? (
        <div className="absolute top-16 right-4 z-20 flex flex-col items-end gap-2">
          <div className="game-radar">
            <div className="game-radar-sweep" />
            {/* 雷达中心玩家十字 */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1.5 h-1.5 bg-cyan-400 rounded-full shadow-[0_0_6px_#22d3ee]" />
            {/* 敌人与 BOSS 投影点 */}
            {hud.radarDots.map((dot, idx) => (
              <div
                key={idx}
                className="absolute rounded-full -translate-x-1/2 -translate-y-1/2 transition-transform duration-100"
                style={{
                  left: `${50 + dot.x * 42}%`,
                  top: `${50 + dot.y * 42}%`,
                  width: dot.type === "boss" ? "8px" : "5px",
                  height: dot.type === "boss" ? "8px" : "5px",
                  background: dot.type === "boss" ? "#ef4444" : dot.type === "shield" ? "#818cf8" : dot.type === "sniper" ? "#f43f5e" : "#fbbf24",
                  boxShadow: `0 0 6px ${dot.type === "boss" ? "#ef4444" : "#fbbf24"}`,
                }}
              />
            ))}
          </div>

          <div className="text-right text-[11px] font-mono text-slate-400">
            <div>得分: <span className="text-cyan-300 font-bold">{hud.score}</span></div>
            {hud.timeSec !== undefined ? <div>耗时: <span className="text-slate-300">{hud.timeSec}s</span></div> : null}
            {hud.enemiesLeft !== undefined ? <div>剩余目标: <span className="text-rose-400">{hud.enemiesLeft}</span></div> : null}
          </div>
        </div>
      ) : null}

      {/* 底部武器快速切换托盘 (1 / 2 / 3 键) */}
      {hud.status === "playing" && hud.currentWeapon ? (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 px-4 py-2 rounded-2xl bg-slate-950/70 backdrop-blur-md border border-slate-800/80">
          {(["pulse", "shotgun", "railgun"] as WeaponType[]).map((w, idx) => {
            const isActive = hud.currentWeapon === w;
            const name = w === "pulse" ? "脉冲步枪" : w === "shotgun" ? "等离子霰弹" : "离子轨道炮";
            return (
              <button
                key={w}
                type="button"
                onClick={() => {
                  if (gameRef.current && "switchWeapon" in gameRef.current) {
                    (gameRef.current as any).switchWeapon(w);
                  }
                }}
                className={`game-weapon-slot px-3 py-1.5 rounded-xl border text-xs font-mono flex items-center gap-1.5 ${
                  isActive
                    ? "active bg-cyan-500/20 border-cyan-400 text-cyan-200"
                    : "border-slate-800 bg-slate-900/60 text-slate-400 hover:text-white"
                }`}
              >
                <span className="w-4 h-4 rounded bg-slate-800/80 flex items-center justify-center text-[10px] font-bold">
                  {idx + 1}
                </span>
                <span>{name}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {/* Toast 飘字通知 */}
      {hud.toast ? (
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 z-30 px-5 py-2.5 rounded-full bg-cyan-500/20 border border-cyan-400/50 text-cyan-200 text-sm font-mono backdrop-blur-md shadow-[0_0_20px_rgba(34,211,238,0.3)]">
          {hud.toast}
        </div>
      ) : null}

      {/* 战役关卡大厅选择模态窗 (Stage Select Modal) */}
      {showLevelModal ? (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
          <div className="game-overlay-card w-full max-w-2xl rounded-3xl p-6 sm:p-8 space-y-6">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div>
                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                  <Layers className="w-5 h-5 text-cyan-400" />
                  战役关卡选择大厅
                </h2>
                <p className="text-xs text-slate-400 mt-1 font-mono">
                  全 10 大战役关卡 · 达成挑战解锁后续章节与最高 3 星评级
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowLevelModal(false)}
                className="px-3 py-1.5 rounded-xl border border-slate-700 text-xs font-mono text-slate-400 hover:text-white"
              >
                关闭
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[60vh] overflow-y-auto pr-1">
              {PULSE_LEVELS.map((lvl) => {
                const p = progress[lvl.id] || { unlocked: lvl.id === 1, completed: false, stars: 0, highScore: 0, bestTimeSec: 0 };
                const isCurrent = hud.levelId === lvl.id;
                return (
                  <button
                    key={lvl.id}
                    type="button"
                    disabled={!p.unlocked}
                    onClick={() => handleSelectLevel(lvl.id)}
                    className={`level-card text-left p-4 rounded-2xl border transition-all ${
                      !p.unlocked
                        ? "opacity-40 border-slate-800/80 bg-slate-950/40 cursor-not-allowed"
                        : isCurrent
                        ? "border-cyan-400 bg-cyan-500/10 shadow-[0_0_15px_rgba(34,211,238,0.2)]"
                        : "border-slate-800 bg-slate-900/60 hover:border-slate-700 hover:bg-slate-900"
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="text-xs font-mono text-cyan-400 font-bold">第 {lvl.id} 关</div>
                      <div className="flex items-center gap-0.5">
                        {[1, 2, 3].map((starIdx) => (
                          <Star
                            key={starIdx}
                            className={`w-3.5 h-3.5 ${
                              starIdx <= p.stars
                                ? "text-amber-400 fill-amber-400"
                                : "text-slate-700"
                            }`}
                          />
                        ))}
                      </div>
                    </div>
                    <div className="font-bold text-white text-sm mt-1">{lvl.name}</div>
                    <div className="text-xs text-slate-400 line-clamp-1 mt-1">{lvl.subtitle}</div>
                    {p.unlocked ? (
                      <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 mt-2.5 pt-2 border-t border-slate-800/60">
                        <span>3星时限: {lvl.parTimeSec}s</span>
                        <span className="text-cyan-400 inline-flex items-center">
                          挑战 <ChevronRight className="w-3 h-3" />
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1 text-[11px] font-mono text-slate-500 mt-2">
                        <Lock className="w-3 h-3" /> 前置关卡未通关
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}

      {/* 遮罩大屏：开始、暂停、通关胜利与失败结算 */}
      {overlay ? (
        <div className="game-overlay absolute inset-0 z-30 flex items-center justify-center px-6">
          <div className="game-overlay-card w-full max-w-md rounded-3xl p-8 text-center space-y-5">
            {/* 胜利结算大屏 */}
            {hud.status === "won" && hud.levelResult ? (
              <div className="space-y-4">
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/20 text-amber-300 text-xs font-mono border border-amber-500/40">
                  <Award className="w-3.5 h-3.5" /> 战役完成 · 评级结算
                </div>
                <h1 className="text-2xl sm:text-3xl font-black text-white">MISSION ACCOMPLISHED</h1>

                {/* 3 星大图标动画展示 */}
                <div className="flex items-center justify-center gap-2 py-2">
                  {[1, 2, 3].map((s) => (
                    <Star
                      key={s}
                      className={`w-8 h-8 transition-all duration-300 ${
                        s <= hud.levelResult!.stars
                          ? "text-amber-400 fill-amber-400 scale-110 drop-shadow-[0_0_12px_#f59e0b]"
                          : "text-slate-700"
                      }`}
                    />
                  ))}
                </div>

                <div className="grid grid-cols-2 gap-3 py-2 text-xs font-mono bg-slate-900/60 rounded-xl p-3 border border-slate-800">
                  <div>
                    <div className="text-slate-400">战役得分</div>
                    <div className="text-lg font-bold text-cyan-300 mt-0.5">{hud.levelResult.score}</div>
                  </div>
                  <div>
                    <div className="text-slate-400">通关用时</div>
                    <div className="text-lg font-bold text-white mt-0.5">{hud.levelResult.timeSec} 秒</div>
                  </div>
                </div>

                <div className="flex flex-wrap justify-center gap-3 pt-2">
                  {hud.levelResult.nextLevelId ? (
                    <button
                      type="button"
                      onClick={() => handleSelectLevel(hud.levelResult!.nextLevelId!)}
                      className="game-cta px-6 py-2.5 rounded-xl text-slate-950 text-sm font-bold inline-flex items-center gap-2"
                    >
                      <span>下一关</span> <ChevronRight className="w-4 h-4" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={restart}
                    className="px-4 py-2.5 rounded-xl border border-slate-700 text-sm text-slate-300 hover:text-white"
                  >
                    重战本关
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowLevelModal(true)}
                    className="px-4 py-2.5 rounded-xl border border-slate-700 text-sm text-cyan-400 hover:text-cyan-300"
                  >
                    关卡大厅
                  </button>
                </div>
              </div>
            ) : (
              /* 普通待机 / 暂停 / 失败大屏 */
              <div className="space-y-4">
                <div className="text-[11px] font-mono text-cyan-400 tracking-wider">
                  {hud.levelName ? `战役模式 · ${hud.levelName}` : meta.genre}
                </div>
                <h1 className="text-2xl sm:text-3xl font-black text-white">{overlayTitle}</h1>
                <p className="text-sm text-slate-300 leading-relaxed">
                  {hud.status === "ready" ? meta.blurb : hud.objective}
                </p>
                <p className="text-xs font-mono text-slate-500">{meta.controls}</p>

                <div className="flex flex-wrap justify-center gap-3 pt-3">
                  {hud.status === "paused" ? (
                    <button
                      type="button"
                      onClick={resume}
                      className="game-cta px-5 py-2.5 rounded-xl text-slate-950 text-sm font-semibold inline-flex items-center gap-2"
                    >
                      <Play className="w-4 h-4" /> 继续
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={hud.status === "ready" ? start : restart}
                      className="game-cta px-5 py-2.5 rounded-xl text-slate-950 text-sm font-semibold inline-flex items-center gap-2"
                    >
                      <Play className="w-4 h-4" /> {hud.status === "ready" ? "开始战役" : "再试一次 (R)"}
                    </button>
                  )}

                  {hud.status !== "ready" ? (
                    <button
                      type="button"
                      onClick={restart}
                      className="px-4 py-2.5 rounded-xl border border-slate-700 text-sm text-slate-200 inline-flex items-center gap-2 hover:border-slate-600"
                    >
                      <RotateCcw className="w-4 h-4" /> 重开
                    </button>
                  ) : null}

                  {hud.levelId ? (
                    <button
                      type="button"
                      onClick={() => setShowLevelModal(true)}
                      className="px-4 py-2.5 rounded-xl border border-cyan-500/40 text-sm text-cyan-300 hover:bg-cyan-500/10"
                    >
                      选择关卡
                    </button>
                  ) : null}

                  <Link
                    href="/games"
                    className="px-4 py-2.5 rounded-xl border border-slate-700 text-sm text-slate-300 hover:text-white"
                  >
                    返回大厅
                  </Link>
                </div>
                {!ready ? <p className="text-xs font-mono text-slate-500">正在初始化 WebGL 与高精度辉光管线…</p> : null}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/* 移动端触摸虚拟摇杆与按键 */}
      {hud.status === "playing" ? <TouchPad layout={meta.touch} engineRef={engineRef} /> : null}
    </div>
  );
}

function TouchPad({ layout, engineRef }: { layout: TouchLayout; engineRef: RefObject<GameEngine | null> }) {
  if (layout === "none") return null;
  const hold = (patch: Partial<GameEngine["virtual"]>, value: Partial<GameEngine["virtual"]>) => ({
    onPointerDown: (event: PointerEvent) => {
      event.preventDefault();
      Object.assign(engineRef.current?.virtual ?? {}, patch);
    },
    onPointerUp: (event: PointerEvent) => {
      event.preventDefault();
      Object.assign(engineRef.current?.virtual ?? {}, value);
    },
    onPointerCancel: () => Object.assign(engineRef.current?.virtual ?? {}, value),
  });
  const tap = (patch: Partial<GameEngine["virtual"]>) => ({
    onPointerDown: (event: PointerEvent) => {
      event.preventDefault();
      Object.assign(engineRef.current?.virtual ?? {}, patch);
    },
  });

  return (
    <div className="absolute bottom-4 inset-x-0 z-20 flex justify-between px-4 sm:hidden pointer-events-none">
      <div className="flex gap-2 pointer-events-auto">
        <button type="button" className="game-touch-btn" {...hold({ x: -1 }, { x: 0 })}>
          左
        </button>
        <button type="button" className="game-touch-btn" {...hold({ x: 1 }, { x: 0 })}>
          右
        </button>
      </div>
      <div className="flex gap-2 pointer-events-auto">
        <button type="button" className="game-touch-btn" {...hold({ y: 1 }, { y: 0 })}>
          前
        </button>
        <button type="button" className="game-touch-btn" {...hold({ y: -1 }, { y: 0 })}>
          后
        </button>
        <button type="button" className="game-touch-btn bg-cyan-600/60" {...tap({ fire: true })}>
          射击
        </button>
        <button type="button" className="game-touch-btn bg-indigo-600/60" {...tap({ skillEmp: true })}>
          EMP
        </button>
      </div>
    </div>
  );
}
