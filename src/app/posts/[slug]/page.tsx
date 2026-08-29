import React from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { posts } from '@/data/posts';
import { ArrowLeft, Calendar, Clock, User, Tag } from 'lucide-react';

// 静态导出必备：预先生成所有静态路由路径
export async function generateStaticParams() {
  return posts.map((post) => ({
    slug: post.slug,
  }));
}

export default async function PostDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = posts.find((p) => p.slug === slug);

  if (!post) {
    notFound();
  }

  return (
    <article className="max-w-3xl mx-auto space-y-10">
      <Link href="/" className="inline-flex items-center gap-1 text-sm font-mono text-slate-400 hover:text-indigo-400 transition-colors">
        <ArrowLeft className="w-4 h-4" /> 返回首页
      </Link>

      <div className="space-y-4 border-b border-slate-800 pb-8">
        <span className="px-3 py-1 rounded-full text-xs font-mono font-medium border bg-indigo-500/10 text-indigo-400 border-indigo-500/20">
          {post.category}
        </span>
        <h1 className="text-3xl sm:text-4xl font-extrabold text-white leading-tight tracking-tight">
          {post.title}
        </h1>

        <div className="flex flex-wrap items-center gap-4 text-xs font-mono text-slate-400 pt-2">
          <span className="flex items-center gap-1.5"><User className="w-3.5 h-3.5 text-slate-500" />{post.author}</span>
          <span className="flex items-center gap-1.5"><Calendar className="w-3.5 h-3.5 text-slate-500" />{post.date}</span>
          <span className="flex items-center gap-1.5"><Clock className="w-3.5 h-3.5 text-slate-500" />{post.readTime}</span>
        </div>
      </div>

      {/* 博文主体内容 */}
      <div className="glass-card rounded-2xl p-8 sm:p-10 space-y-6 text-slate-300 leading-relaxed text-base">
        <div className="whitespace-pre-line prose prose-invert max-w-none">
          {post.content}
        </div>
      </div>

      <div className="pt-6 border-t border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Tag className="w-4 h-4 text-slate-500" />
          {post.tags.map((t) => (
            <span key={t} className="text-xs font-mono text-slate-400 bg-slate-800/80 px-2.5 py-1 rounded">
              #{t}
            </span>
          ))}
        </div>
        <Link href="/" className="text-sm font-mono text-indigo-400 hover:text-indigo-300">
          回到文章列表 →
        </Link>
      </div>
    </article>
  );
}
