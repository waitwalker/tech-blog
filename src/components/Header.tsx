import React from 'react';
import Link from 'next/link';
import { Terminal, BookOpen, Layers, User, ExternalLink, Lock, Box, Gamepad2 } from 'lucide-react';

export const Header: React.FC = () => {
  return (
    <header className="sticky top-0 z-50 glass-panel border-b border-slate-800/80">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        <Link href="/" className="flex items-center space-x-3 group">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-cyan-500 flex items-center justify-center text-white shadow-lg shadow-indigo-500/20 group-hover:scale-105 transition-transform">
            <Terminal className="w-5 h-5" />
          </div>
          <div>
            <span className="font-bold text-lg text-white tracking-tight group-hover:text-indigo-400 transition-colors">
              MonsterAI <span className="text-cyan-400 font-mono text-sm">.Lab</span>
            </span>
            <p className="text-[11px] text-slate-400 font-mono">Flutter • Rust • Next.js</p>
          </div>
        </Link>

        <nav className="flex items-center space-x-1 sm:space-x-6 text-sm font-medium">
          <Link href="/" className="px-3 py-2 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800/60 transition-colors flex items-center gap-1.5">
            <BookOpen className="w-4 h-4 text-indigo-400" />
            <span>文章</span>
          </Link>
          <Link href="/categories" className="px-3 py-2 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800/60 transition-colors flex items-center gap-1.5">
            <Layers className="w-4 h-4 text-cyan-400" />
            <span>分类</span>
          </Link>
          <Link href="/anatomy" className="px-3 py-2 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800/60 transition-colors flex items-center gap-1.5">
            <Box className="w-4 h-4 text-pink-400" />
            <span>3D 实验室</span>
          </Link>
          <Link href="/games" className="px-3 py-2 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800/60 transition-colors flex items-center gap-1.5">
            <Gamepad2 className="w-4 h-4 text-amber-400" />
            <span>3D 游戏</span>
          </Link>
          <Link href="/about" className="px-3 py-2 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800/60 transition-colors flex items-center gap-1.5">
            <User className="w-4 h-4 text-emerald-400" />
            <span>关于</span>
          </Link>
          <Link href="/login" className="px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 text-xs font-semibold transition-all flex items-center gap-1.5 shadow-sm">
            <Lock className="w-3.5 h-3.5" />
            <span>管理中台</span>
          </Link>
        </nav>
      </div>
    </header>
  );
};
