import React from 'react';
import Link from 'next/link';
import { posts } from '@/data/posts';
import { PostCard } from '@/components/PostCard';
import { Layers, Code2, Cpu, Globe, Server } from 'lucide-react';

const CATEGORIES = [
  { name: 'Flutter' as const, icon: Code2, desc: '跨端高性能渲染引擎、Impeller 架构与状态管理实战' },
  { name: 'NestJS' as const, icon: Server, desc: '企业级 Node.js 渐进式服务端架构、IoC 依赖注入与微服务' },
  { name: 'Next.js' as const, icon: Globe, desc: 'React 19、App Router、RSC 与现代全栈 Web 架构' },
  { name: 'Rust' as const, icon: Cpu, desc: '内存安全系统级编程、所有权借用与 Tokio 异步高并发' },
];

export default function CategoriesPage() {
  return (
    <div className="space-y-12">
      <div className="border-b border-slate-800 pb-6">
        <h1 className="text-3xl font-bold text-white flex items-center gap-3">
          <Layers className="w-8 h-8 text-cyan-400" />
          技术分类专栏
        </h1>
        <p className="text-slate-400 text-sm mt-2">按专题阅读完整正文。Markdown 标题、列表与代码块会按文章格式渲染。</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {CATEGORIES.map((cat) => {
          const Icon = cat.icon;
          const count = posts.filter((p) => p.category === cat.name).length;
          return (
            <Link
              key={cat.name}
              href={`#${cat.name.replace(/\./g, "").toLowerCase()}`}
              className="glass-card rounded-2xl p-6 border border-slate-800 block"
            >
              <div className="flex items-center justify-between mb-4">
                <div className="p-3 rounded-xl bg-slate-800/80 text-cyan-400">
                  <Icon className="w-6 h-6" />
                </div>
                <span className="text-xs font-mono text-slate-400 bg-slate-800 px-2.5 py-1 rounded-full">
                  {count} 篇文章
                </span>
              </div>
              <h2 className="text-xl font-bold text-white mb-2">{cat.name}</h2>
              <p className="text-slate-400 text-xs leading-relaxed">{cat.desc}</p>
            </Link>
          );
        })}
      </div>

      {CATEGORIES.map((cat) => {
        const group = posts.filter((p) => p.category === cat.name);
        if (group.length === 0) return null;
        return (
          <section key={cat.name} id={cat.name.replace(/\./g, "").toLowerCase()} className="space-y-6 pt-4 scroll-mt-24">
            <div className="flex items-end justify-between border-b border-slate-800 pb-3">
              <h2 className="text-xl font-bold text-white">{cat.name}</h2>
              <span className="text-xs font-mono text-slate-500">{group.length} 篇</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {group.map((post) => (
                <PostCard key={post.slug} post={post} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
