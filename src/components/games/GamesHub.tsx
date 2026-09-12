import Link from "next/link";
import { ArrowRight, Gamepad2 } from "lucide-react";
import { GAMES } from "@/lib/games/registry";

export function GamesHub() {
  return (
    <div className="space-y-10 pb-10">
      <section className="glass-panel rounded-3xl p-8 sm:p-10 border border-slate-800/80">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs font-mono">
          <Gamepad2 className="w-3.5 h-3.5" />
          Three.js 即时游玩 · 无需安装
        </div>
        <h1 className="mt-5 text-3xl sm:text-4xl font-black text-white tracking-tight">3D 游戏实验室</h1>
        <p className="mt-3 text-slate-300 max-w-2xl leading-relaxed">
          二十六种互不重复的镜头与胜负条件，全部跑在浏览器里，静态导出可离线打开。
        </p>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {GAMES.map((game, index) => (
          <Link
            key={game.id}
            href={`/games/${game.id}`}
            className="glass-card rounded-3xl p-6 sm:p-7 border border-slate-800 group block"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[11px] font-mono text-slate-500">{String(index + 1).padStart(2, "0")} · {game.genre}</div>
                <h2 className="mt-2 text-2xl font-bold text-white group-hover:text-cyan-300 transition-colors">{game.title}</h2>
              </div>
              <span className="w-10 h-10 rounded-2xl flex items-center justify-center" style={{ background: `${game.accent}22`, color: game.accent }}>
                <Gamepad2 className="w-5 h-5" />
              </span>
            </div>
            <p className="mt-3 text-sm text-slate-400 leading-relaxed">{game.blurb}</p>
            <p className="mt-4 text-[11px] font-mono text-slate-500">{game.controls}</p>
            <div className="mt-5 inline-flex items-center gap-1 text-sm text-cyan-400 font-medium">
              进入游戏 <ArrowRight className="w-4 h-4" />
            </div>
          </Link>
        ))}
      </section>
    </div>
  );
}
