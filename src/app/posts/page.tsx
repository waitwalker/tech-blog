import React from 'react';
import { posts } from '@/data/posts';
import { PostCard } from '@/components/PostCard';
import { BookOpen } from 'lucide-react';

export default function PostsIndexPage() {
  return (
    <div className="space-y-10">
      <div className="border-b border-slate-800 pb-6">
        <h1 className="text-3xl font-bold text-white flex items-center gap-3">
          <BookOpen className="w-8 h-8 text-indigo-400" />
          全部文章归档
        </h1>
        <p className="text-slate-400 text-sm mt-2">共 {posts.length} 篇技术深度文章</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {posts.map((post) => (
          <PostCard key={post.slug} post={post} />
        ))}
      </div>
    </div>
  );
}
