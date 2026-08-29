"use client";

import React, { useEffect, useState } from "react";
import { 
  FileText, 
  Trash2, 
  Edit, 
  Globe, 
  Lock, 
  Key, 
  Pin, 
  Plus, 
  Search,
  ExternalLink
} from "lucide-react";
import { fetchWithAuth } from "@/lib/api";

export default function PostsManagementPage() {
  const [posts, setPosts] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  const loadPosts = async () => {
    try {
      const res = await fetchWithAuth("/posts?page_size=50");
      const json = await res.json();
      if (json.code === 200) {
        setPosts(json.data);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPosts();
  }, []);

  const handleDelete = async (id: string) => {
    if (!confirm("确定要删除此文章吗？")) return;
    try {
      await fetchWithAuth(`/posts/manage/${id}`, { method: "DELETE" });
      setPosts(posts.filter((p) => p.id !== id));
    } catch (e) {
      alert("删除失败");
    }
  };

  const filteredPosts = posts.filter((p) =>
    p.title.toLowerCase().includes(search.toLowerCase()) ||
    p.slug.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">文章管理中心</h1>
          <p className="text-xs text-zinc-400 mt-1">管理所有公开、私密与加密技术博文</p>
        </div>
        <a
          href="/admin/editor"
          className="flex items-center gap-2 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 px-4 py-2 rounded-xl text-xs font-semibold shadow-md shadow-emerald-500/20 transition-all self-start sm:self-auto"
        >
          <Plus className="w-4 h-4" />
          <span>撰写新文章</span>
        </a>
      </div>

      {/* 搜索过滤栏 */}
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="根据文章标题或 Slug 快速搜索..."
          className="w-full bg-zinc-900/60 border border-zinc-800 rounded-xl pl-10 pr-4 py-2.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500"
        />
      </div>

      {/* 文章表格/列表 */}
      <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl overflow-hidden backdrop-blur-sm">
        {loading ? (
          <div className="p-12 text-center text-xs text-zinc-500">正在拉取文章列表中...</div>
        ) : filteredPosts.length === 0 ? (
          <div className="p-12 text-center text-xs text-zinc-500">
            暂无匹配文章，点击右上角「撰写新文章」开启第一篇创作！
          </div>
        ) : (
          <div className="divide-y divide-zinc-800/60">
            {filteredPosts.map((post) => (
              <div
                key={post.id}
                className="p-4 sm:p-5 flex items-center justify-between gap-4 hover:bg-zinc-800/30 transition-all"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    {post.pinned && <Pin className="w-3.5 h-3.5 text-amber-400 shrink-0" />}
                    <h3 className="text-sm font-semibold text-zinc-200 truncate">{post.title}</h3>
                    {/* 状态徽章 */}
                    {post.visibility === "public" && (
                      <span className="px-2 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] flex items-center gap-1">
                        <Globe className="w-3 h-3" /> 公开
                      </span>
                    )}
                    {post.visibility === "private" && (
                      <span className="px-2 py-0.5 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300 text-[10px] flex items-center gap-1">
                        <Lock className="w-3 h-3" /> 仅我可见
                      </span>
                    )}
                    {post.visibility === "encrypted" && (
                      <span className="px-2 py-0.5 rounded-md bg-blue-500/10 border border-blue-500/20 text-blue-400 text-[10px] flex items-center gap-1">
                        <Key className="w-3 h-3" /> AES加密
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-zinc-500 font-mono">/posts/{post.slug}</p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <a
                    href={`/posts/${post.slug}`}
                    target="_blank"
                    className="p-2 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-colors"
                    title="在前端预览"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </a>
                  <button
                    onClick={() => handleDelete(post.id)}
                    className="p-2 text-zinc-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                    title="删除文章"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
