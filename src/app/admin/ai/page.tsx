"use client";

import React, { useState } from "react";
import { 
  Bot, 
  Send, 
  Sparkles, 
  User, 
  Code2, 
  Wand2, 
  Trash2 
} from "lucide-react";
import { fetchWithAuth } from "@/lib/api";

export default function AiPlaygroundPage() {
  const [messages, setMessages] = useState<any[]>([
    {
      role: "assistant",
      content: "👋 您好！我是 MonsterAI 私有大模型安全中台助手。我可以帮您润色文章、分析架构、排查 Rust / Flutter 代码异常或编写系统设计方案。请问有什么可以协助您？",
    },
  ]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState("gpt-4o");
  const [loading, setLoading] = useState(false);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const userMsg = { role: "user", content: input };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetchWithAuth("/ai/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model,
          messages: [...messages, userMsg],
        }),
      });
      const json = await res.json();
      if (json.code === 200) {
        const reply = json.data.choices[0].message.content;
        setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
      }
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "⚠️ AI 网关响应超时或异常，请检查配置。" },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-[85vh] max-w-5xl bg-zinc-900/60 border border-zinc-800/80 rounded-2xl backdrop-blur-sm overflow-hidden">
      {/* 顶部模型切换栏 */}
      <div className="p-4 border-b border-zinc-800/80 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-purple-500/20 border border-purple-500/30 flex items-center justify-center text-purple-400">
            <Bot className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-zinc-100">私有大模型 AI 工作区</h2>
            <p className="text-[10px] text-zinc-500">统一密钥池管理 · 隐藏真实 API Key</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-1.5 text-xs text-zinc-300 focus:outline-none focus:border-purple-500"
          >
            <option value="gpt-4o">OpenAI GPT-4o</option>
            <option value="claude-3-5-sonnet">Claude 3.5 Sonnet</option>
            <option value="deepseek-v3">DeepSeek-V3 极速推理</option>
          </select>
        </div>
      </div>

      {/* 聊天消息流 */}
      <div className="flex-1 p-6 overflow-y-auto space-y-4">
        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`flex items-start gap-3 ${
              msg.role === "user" ? "flex-row-reverse" : "flex-row"
            }`}
          >
            <div
              className={`w-7 h-7 rounded-xl flex items-center justify-center shrink-0 ${
                msg.role === "user"
                  ? "bg-emerald-500 text-zinc-950"
                  : "bg-purple-500/20 border border-purple-500/30 text-purple-400"
              }`}
            >
              {msg.role === "user" ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
            </div>

            <div
              className={`max-w-2xl rounded-2xl p-4 text-xs leading-relaxed ${
                msg.role === "user"
                  ? "bg-emerald-500/10 border border-emerald-500/30 text-zinc-100"
                  : "bg-zinc-950/80 border border-zinc-800/80 text-zinc-200"
              }`}
            >
              <div className="whitespace-pre-wrap font-sans">{msg.content}</div>
            </div>
          </div>
        ))}
      </div>

      {/* 底部输入框 */}
      <form onSubmit={handleSend} className="p-4 border-t border-zinc-800/80 bg-zinc-950/40 flex items-center gap-3">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="向 AI 助手提问或要求润色文章..."
          className="flex-1 bg-zinc-900/80 border border-zinc-800 rounded-xl px-4 py-2.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-purple-500"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="bg-purple-500 hover:bg-purple-400 text-zinc-950 px-4 py-2.5 rounded-xl text-xs font-semibold shadow-md shadow-purple-500/20 disabled:opacity-50 transition-all flex items-center gap-1.5"
        >
          <Send className="w-3.5 h-3.5" />
          <span>{loading ? "思考中..." : "发送"}</span>
        </button>
      </form>
    </div>
  );
}
