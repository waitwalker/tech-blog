import React from 'react';
import Link from 'next/link';
import { Calendar, Clock, Tag, ArrowRight } from 'lucide-react';
import { Post } from '@/data/posts';

export const PostCard: React.FC<{ post: Post }> = ({ post }) => {
  const getCategoryColor = (cat: string) => {
    switch (cat) {
      case 'Flutter': return 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20';
      case 'Rust': return 'bg-orange-500/10 text-orange-400 border-orange-500/20';
      case 'Next.js': return 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20';
      default: return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
    }
  };

  return (
    <article className="glass-card rounded-2xl p-6 flex flex-col justify-between group">
      <div>
        <div className="flex items-center justify-between gap-2 mb-4">
          <span className={`px-3 py-1 rounded-full text-xs font-mono font-medium border ${getCategoryColor(post.category)}`}>
            {post.category}
          </span>
          <div className="flex items-center text-xs text-slate-400 space-x-3 font-mono">
            <span className="flex items-center gap-1"><Calendar className="w-3.5 h-3.5" />{post.date}</span>
            <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" />{post.readTime}</span>
          </div>
        </div>

        <Link href={`/posts/${post.slug}`}>
          <h2 className="text-xl font-bold text-white group-hover:text-indigo-400 transition-colors mb-3 leading-snug">
            {post.title}
          </h2>
        </Link>
        <p className="text-slate-400 text-sm leading-relaxed mb-6">
          {post.excerpt}
        </p>
      </div>

      <div className="flex items-center justify-between pt-4 border-t border-slate-800/60">
        <div className="flex items-center gap-2 flex-wrap">
          {post.tags.map((t) => (
            <span key={t} className="text-[11px] font-mono text-slate-400 bg-slate-800/80 px-2 py-0.5 rounded">
              #{t}
            </span>
          ))}
        </div>
        <Link href={`/posts/${post.slug}`} className="text-indigo-400 hover:text-indigo-300 text-xs font-mono flex items-center gap-1 group-hover:translate-x-1 transition-transform">
          阅读全文 <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>
    </article>
  );
};
