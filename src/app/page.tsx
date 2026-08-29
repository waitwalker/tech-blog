import React from 'react';
import Link from 'next/link';
import { posts } from '@/data/posts';
import { PostCard } from '@/components/PostCard';
import { Sparkles, Code2, Cpu, Globe, Rocket, ArrowRight } from 'lucide-react';

export default function HomePage() {
  return (
    <div className="space-y-16">
      {/* Hero Section */}
      <section className="relative glass-panel rounded-3xl p-8 sm:p-12 overflow-hidden border border-slate-800/80">
        <div className="relative z-10 max-w-3xl space-y-6">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 text-xs font-mono">
            <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
            <span>2026 现代架构与系统工程实践</span>
          </div>

          <h1 className="text-3xl sm:text-5xl font-black text-white tracking-tight leading-tight">
            连接底层性能与 <span className="bg-gradient-to-r from-indigo-400 via-cyan-400 to-emerald-400 bg-clip-text text-transparent">现代跨端体验</span>
          </h1>

          <p className="text-slate-300 text-base sm:text-lg leading-relaxed">
            记录在 <strong>Flutter 跨端渲染</strong>、<strong>Rust 异步高并发</strong> 以及 <strong>Next.js 极速全栈</strong> 领域的架构探索与工程沉淀。
          </p>

          <div className="flex flex-wrap gap-4 pt-2">
            <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-800/80 border border-slate-700 text-xs font-mono text-slate-300">
              <Code2 className="w-4 h-4 text-cyan-400" />
              <span>Flutter 3.x Engine</span>
            </div>
            <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-800/80 border border-slate-700 text-xs font-mono text-slate-300">
              <Cpu className="w-4 h-4 text-amber-400" />
              <span>Rust Tokio 运行时</span>
            </div>
            <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-800/80 border border-slate-700 text-xs font-mono text-slate-300">
              <Globe className="w-4 h-4 text-indigo-400" />
              <span>Next.js App Router</span>
            </div>
          </div>
        </div>
      </section>

      {/* Featured Posts */}
      <section className="space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-white flex items-center gap-2">
              <Rocket className="w-6 h-6 text-indigo-400" />
              精选文章与手记
            </h2>
            <p className="text-slate-400 text-sm mt-1">深度剖析技术难点与最佳实践</p>
          </div>
          <Link href="/categories" className="text-sm text-indigo-400 hover:text-indigo-300 flex items-center gap-1 font-mono">
            查看所有分类 <ArrowRight className="w-4 h-4" />
          </Link>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {posts.map((post) => (
            <PostCard key={post.slug} post={post} />
          ))}
        </div>
      </section>
    </div>
  );
}
