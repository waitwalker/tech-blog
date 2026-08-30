"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { ArrowLeft, Sparkles, Box } from "lucide-react";

// Dynamic import with SSR disabled for Three.js WebGL canvas
const AnatomyApp = dynamic(
  () => import("@/components/anatomy/AnatomyApp").then((mod) => mod.AnatomyApp),
  {
    ssr: false,
    loading: () => (
      <div className="min-h-screen bg-[#121214] flex flex-col items-center justify-center text-zinc-400 gap-4">
        <div className="w-10 h-10 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
        <div className="flex items-center gap-2 text-sm font-mono text-emerald-400">
          <Box className="w-4 h-4 animate-bounce" />
          <span>正在加载 3D 生物解剖交互实验室引擎...</span>
        </div>
      </div>
    ),
  }
);

export default function AnatomyPage() {
  return (
    <div className="min-h-screen bg-[#1c1917] text-zinc-100 flex flex-col selection:bg-emerald-500/30 selection:text-emerald-300">
      {/* 顶部返回导航条 */}
      <div className="h-12 border-b border-zinc-800/80 bg-zinc-950/70 backdrop-blur-md px-4 sm:px-6 flex items-center justify-between z-50 sticky top-0">
        <Link
          href="/"
          className="flex items-center gap-2 text-xs text-zinc-400 hover:text-emerald-400 transition-colors font-mono"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>返回技术博客首页</span>
        </Link>
        <div className="flex items-center gap-2 text-xs font-mono text-zinc-500">
          <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
          <span className="text-zinc-300">MonsterAI 极客 3D 实验室</span>
          <span className="hidden sm:inline text-zinc-600">|</span>
          <span className="hidden sm:inline text-zinc-500">Three.js + Draco 3D Engine</span>
        </div>
      </div>

      {/* 3D 交互主应用容器 */}
      <div className="flex-1 w-full bg-[#f7f1e8] text-[#2f2a27]">
        <AnatomyApp initialLocale="zh" />
      </div>
    </div>
  );
}
