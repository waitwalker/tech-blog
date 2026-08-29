"use client";

import React, { useEffect, useState } from "react";
import { 
  StickyNote, 
  Plus, 
  Lock, 
  Trash2, 
  Pin, 
  Key, 
  ShieldCheck, 
  Send,
  Sparkles
} from "lucide-react";
import { fetchWithAuth } from "@/lib/api";

export default function MemosPage() {
  const [memos, setMemos] = useState<any[]>([]);
  const [content, setContent] = useState("");
  const [isEncrypted, setIsEncrypted] = useState(false);
  const [tags, setTags] = useState("#TODO");
  const [loading, setLoading] = useState(false);

  const loadMemos = async () => {
    try {
      const res = await fetchWithAuth("/memos");
      const json = await res.json();
      if (json.code === 200) {
        setMemos(json.data);
      }
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    loadMemos();
  }, []);

  const handleCreateMemo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;

    setLoading(true);
    try {
      const res = await fetchWithAuth("/memos", {
        method: "POST",
        body: JSON.stringify({
          content,
          is_encrypted: isEncrypted,
          tags,
          pinned: false,
        }),
      });
      const json = await res.json();
      if (json.code === 200) {
        setContent("");
        setMemos([json.data, ...memos]);
      }
    } catch (e) {
      alert("发布便签失败");
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await fetchWithAuth(`/memos/${id}`, { method: "DELETE" });
      setMemos(memos.filter((m) => m.id !== id));
    } catch (e) {
      alert("删除失败");
    }
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold text-zinc-100">私密随手记与个人密文库</h1>
        <p className="text-xs text-zinc-400 mt-1">闪念记事、临时代码片段、服务器配置备忘录 (仅管理员可见)</p>
      </div>

      {/* 快捷发布便签卡片 */}
      <form onSubmit={handleCreateMemo} className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-5 backdrop-blur-sm space-y-4">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="随时记录灵感、待办清单或密码备忘..."
          className="w-full bg-zinc-950/60 border border-zinc-800 rounded-xl p-3.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500 min-h-[90px] resize-none"
        />

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div className="flex items-center gap-3 text-xs">
            {/* 标签 */}
            <input
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="#标签"
              className="bg-zinc-950/60 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs text-emerald-400 font-mono focus:outline-none focus:border-emerald-500 w-24"
            />

            {/* 端到端加密勾选 */}
            <label className="flex items-center gap-1.5 text-zinc-400 hover:text-zinc-200 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={isEncrypted}
                onChange={(e) => setIsEncrypted(e.target.checked)}
                className="rounded border-zinc-700 bg-zinc-950 text-emerald-500 focus:ring-emerald-500 focus:ring-offset-0"
              />
              <Key className="w-3.5 h-3.5 text-blue-400" />
              <span>AES-256 密文存储</span>
            </label>
          </div>

          <button
            type="submit"
            disabled={loading || !content.trim()}
            className="flex items-center gap-1.5 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 px-4 py-1.5 rounded-xl text-xs font-semibold shadow-md shadow-emerald-500/20 disabled:opacity-50 transition-all"
          >
            <Send className="w-3.5 h-3.5" />
            <span>{loading ? "发送中..." : "记录"}</span>
          </button>
        </div>
      </form>

      {/* 便签瀑布流列表 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {memos.length === 0 ? (
          <div className="col-span-full p-12 text-center text-xs text-zinc-500 bg-zinc-900/30 border border-zinc-800/40 rounded-2xl">
            暂无随手记，在上方输入框记录你的第一条闪念！
          </div>
        ) : (
          memos.map((memo) => (
            <div
              key={memo.id}
              className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-5 backdrop-blur-sm flex flex-col justify-between space-y-4 hover:border-zinc-700/80 transition-all group"
            >
              <div className="space-y-2">
                <div className="flex items-center justify-between text-[11px] text-zinc-500">
                  <span className="font-mono">{memo.created_at ? new Date(memo.created_at).toLocaleString() : "刚刚"}</span>
                  <div className="flex items-center gap-1.5">
                    {memo.is_encrypted && (
                      <span className="px-2 py-0.5 rounded-md bg-blue-500/10 border border-blue-500/20 text-blue-400 text-[10px] flex items-center gap-1">
                        <Key className="w-3 h-3" /> 密文
                      </span>
                    )}
                    {memo.tags && (
                      <span className="px-2 py-0.5 rounded-md bg-zinc-800 text-emerald-400 font-mono text-[10px]">
                        {memo.tags}
                      </span>
                    )}
                  </div>
                </div>
                <p className="text-xs text-zinc-200 whitespace-pre-wrap leading-relaxed">
                  {memo.content}
                </p>
              </div>

              <div className="flex items-center justify-end pt-2 border-t border-zinc-800/60 opacity-60 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => handleDelete(memo.id)}
                  className="text-zinc-500 hover:text-red-400 p-1.5 rounded-lg hover:bg-red-500/10 transition-colors"
                  title="删除"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
