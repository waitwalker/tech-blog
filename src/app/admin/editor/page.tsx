"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { 
  Save, 
  Send, 
  Eye, 
  Settings, 
  Lock, 
  Globe, 
  Key, 
  CheckCircle2, 
  AlertCircle 
} from "lucide-react";
import { fetchWithAuth } from "@/lib/api";

export default function EditorPage() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const [content, setContent] = useState("# 在此编写 Markdown 博文正文...\n\n支持代码高亮与 KaTeX 数学公式。");
  const [visibility, setVisibility] = useState<"public" | "private" | "encrypted">("public");
  const [category, setCategory] = useState("rust");
  const [readTime, setReadTime] = useState("8 min");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const handlePublish = async (isPublished: boolean = true) => {
    if (!title || !slug || !content) {
      setMessage({ type: "error", text: "请填写文章标题、自定义 Slug 与正文内容" });
      return;
    }

    setLoading(true);
    setMessage(null);

    try {
      const payload = {
        title,
        slug,
        excerpt: excerpt || title,
        content,
        read_time: readTime,
        visibility,
        is_published: isPublished,
        pinned: false,
      };

      const res = await fetchWithAuth("/posts", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      const json = await res.json();

      if (!res.ok || json.code !== 200) {
        throw new Error(json.message || "发布文章失败");
      }

      setMessage({ type: "success", text: "🎉 文章已成功发布至全站！" });
      setTimeout(() => {
        router.push("/admin/posts");
      }, 1500);
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "发布失败" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6 max-w-7xl">
      {/* 顶部工具栏 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-4 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <input
            type="text"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (!slug) {
                setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
              }
            }}
            placeholder="输入文章主标题..."
            className="bg-transparent text-lg font-bold text-zinc-100 placeholder:text-zinc-600 focus:outline-none w-full sm:w-96"
          />
        </div>

        <div className="flex items-center gap-2.5">
          {/* 可见性选择 */}
          <select
            value={visibility}
            onChange={(e: any) => setVisibility(e.target.value)}
            className="bg-zinc-950/80 border border-zinc-800 rounded-xl px-3 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500"
          >
            <option value="public">🌐 全网公开 (Public)</option>
            <option value="private">🔒 仅我可见 (Private)</option>
            <option value="encrypted">🔑 端到端加密 (Encrypted)</option>
          </select>

          {/* 保存草稿 */}
          <button
            onClick={() => handlePublish(false)}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-xl text-xs font-medium transition-all"
          >
            <Save className="w-3.5 h-3.5" />
            <span>存草稿</span>
          </button>

          {/* 立即发布 */}
          <button
            onClick={() => handlePublish(true)}
            disabled={loading}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 rounded-xl text-xs font-semibold shadow-md shadow-emerald-500/20 transition-all"
          >
            <Send className="w-3.5 h-3.5" />
            <span>{loading ? "发布中..." : "立即发布"}</span>
          </button>
        </div>
      </div>

      {/* 提示条 */}
      {message && (
        <div
          className={`p-3.5 rounded-xl text-xs flex items-center gap-2 ${
            message.type === "success"
              ? "bg-emerald-500/10 border border-emerald-500/30 text-emerald-400"
              : "bg-red-500/10 border border-red-500/30 text-red-400"
          }`}
        >
          {message.type === "success" ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          <span>{message.text}</span>
        </div>
      )}

      {/* 文章元数据配置小抽屉 */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 bg-zinc-900/40 border border-zinc-800/60 rounded-2xl p-4 text-xs">
        <div>
          <label className="block text-zinc-400 mb-1">自定义 Slug (URL路径)</label>
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="rust-core-guide"
            className="w-full bg-zinc-950/60 border border-zinc-800 rounded-xl px-3 py-2 text-zinc-200 font-mono focus:outline-none focus:border-emerald-500"
          />
        </div>
        <div>
          <label className="block text-zinc-400 mb-1">技术分类</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full bg-zinc-950/60 border border-zinc-800 rounded-xl px-3 py-2 text-zinc-200 focus:outline-none focus:border-emerald-500"
          >
            <option value="rust">Rust 架构与底层核心</option>
            <option value="flutter">Flutter 渲染引擎与混合架构</option>
            <option value="nextjs">Next.js 15 全栈与服务端组件</option>
            <option value="nestjs">NestJS 高并发企业级架构</option>
          </select>
        </div>
        <div>
          <label className="block text-zinc-400 mb-1">文章摘要 (Excerpt)</label>
          <input
            type="text"
            value={excerpt}
            onChange={(e) => setExcerpt(e.target.value)}
            placeholder="简要概括文章核心技术要点..."
            className="w-full bg-zinc-950/60 border border-zinc-800 rounded-xl px-3 py-2 text-zinc-200 focus:outline-none focus:border-emerald-500"
          />
        </div>
      </div>

      {/* 左右分屏编辑与实时预览 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 min-h-[60vh]">
        {/* 左侧 Markdown 编辑器 */}
        <div className="flex flex-col bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-4 backdrop-blur-sm">
          <div className="text-xs font-semibold text-zinc-400 mb-2">Markdown 源码输入</div>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="flex-1 w-full bg-transparent text-sm font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none resize-none min-h-[450px]"
          />
        </div>

        {/* 右侧实时渲染预览 */}
        <div className="flex flex-col bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-6 backdrop-blur-sm overflow-y-auto max-h-[600px]">
          <div className="text-xs font-semibold text-emerald-400 mb-4 pb-2 border-b border-zinc-800 flex items-center gap-1.5">
            <Eye className="w-4 h-4" /> 实时渲染预览
          </div>
          <div className="prose prose-invert prose-emerald max-w-none text-xs text-zinc-300 space-y-3 leading-relaxed whitespace-pre-wrap font-sans">
            {content}
          </div>
        </div>
      </div>
    </div>
  );
}
