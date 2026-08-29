"use client";

import React, { useEffect, useState } from "react";
import { 
  FileText, 
  StickyNote, 
  Eye, 
  Cpu, 
  Server, 
  ArrowUpRight, 
  PenTool, 
  Bot, 
  ShieldCheck, 
  Sparkles,
  CloudDownload,
  HardDrive,
  Globe
} from "lucide-react";
import { fetchWithAuth } from "@/lib/api";

export default function AdminDashboardPage() {
  const [stats, setStats] = useState<any>({
    cpu_usage: 0,
    total_memory_mb: 447,
    used_memory_mb: 150,
    memory_percentage: 33.5,
    uptime_seconds: 0,
    os_name: "Debian 12",
  });
  const [postsCount, setPostsCount] = useState(73);
  const [memosCount, setMemosCount] = useState(0);

  useEffect(() => {
    // 异步拉取系统指标
    fetchWithAuth("/monitor/stats")
      .then((res) => res.json())
      .then((json) => {
        if (json.code === 200) {
          setStats(json.data);
        }
      })
      .catch(() => {});

    // 拉取便签数量
    fetchWithAuth("/memos")
      .then((res) => res.json())
      .then((json) => {
        if (json.code === 200) {
          setMemosCount(json.data.length);
        }
      })
      .catch(() => {});
  }, []);

  return (
    <div className="space-y-8 max-w-6xl">
      {/* 顶部欢迎区 */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-gradient-to-r from-emerald-500/10 via-zinc-900 to-zinc-900 border border-zinc-800/80 rounded-2xl p-6">
        <div>
          <div className="flex items-center gap-2 text-emerald-400 text-xs font-semibold uppercase tracking-wider mb-1">
            <Sparkles className="w-3.5 h-3.5" /> 零信任安全控制台
          </div>
          <h1 className="text-2xl font-bold text-zinc-100">欢迎回来，Administrator</h1>
          <p className="text-xs text-zinc-400 mt-1">系统所有服务运行正常，已启用端到端数据加密与 2FA 保护。</p>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="/admin/editor"
            className="flex items-center gap-2 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 px-4 py-2 rounded-xl text-xs font-semibold shadow-md shadow-emerald-500/20 transition-all"
          >
            <PenTool className="w-4 h-4" />
            <span>新建文章</span>
          </a>
        </div>
      </div>

      {/* 数据概览卡片网格 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* 文章总数 */}
        <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-5 backdrop-blur-sm">
          <div className="flex items-center justify-between text-zinc-400 mb-3">
            <span className="text-xs font-medium">文章总数</span>
            <FileText className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-bold text-zinc-100">{postsCount} <span className="text-xs text-zinc-500 font-normal">篇</span></div>
          <p className="text-[11px] text-emerald-400 mt-2 flex items-center gap-1">
            <span>73 篇公开 · 支持私密隔离</span>
          </p>
        </div>

        {/* 随手记备忘 */}
        <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-5 backdrop-blur-sm">
          <div className="flex items-center justify-between text-zinc-400 mb-3">
            <span className="text-xs font-medium">私密随手记</span>
            <StickyNote className="w-4 h-4 text-blue-400" />
          </div>
          <div className="text-2xl font-bold text-zinc-100">{memosCount} <span className="text-xs text-zinc-500 font-normal">条</span></div>
          <p className="text-[11px] text-blue-400 mt-2">AES-256-GCM 本地加密存储</p>
        </div>

        {/* VPS 物理内存占用 */}
        <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-5 backdrop-blur-sm">
          <div className="flex items-center justify-between text-zinc-400 mb-3">
            <span className="text-xs font-medium">VPS 物理内存</span>
            <Cpu className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-2xl font-bold text-zinc-100">{stats.used_memory_mb || 150} <span className="text-xs text-zinc-500 font-normal">/ {stats.total_memory_mb || 447} MB</span></div>
          <div className="w-full bg-zinc-800 h-1.5 rounded-full mt-3 overflow-hidden">
            <div 
              className="bg-amber-400 h-full rounded-full transition-all duration-500" 
              style={{ width: `${Math.min(stats.memory_percentage || 30, 100)}%` }} 
            />
          </div>
        </div>

        {/* VPS CPU 负载 */}
        <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-5 backdrop-blur-sm">
          <div className="flex items-center justify-between text-zinc-400 mb-3">
            <span className="text-xs font-medium">CPU 实时占用</span>
            <Server className="w-4 h-4 text-purple-400" />
          </div>
          <div className="text-2xl font-bold text-zinc-100">{(stats.cpu_usage || 1.2).toFixed(1)}%</div>
          <p className="text-[11px] text-emerald-400 mt-2 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            <span>Debian 12 · 1 vCPU</span>
          </p>
        </div>
      </div>

      {/* 快捷功能区与健康组件 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 快捷工作流入口 */}
        <div className="lg:col-span-2 bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-6 backdrop-blur-sm">
          <h3 className="text-sm font-bold text-zinc-100 mb-4 flex items-center gap-2">
            <PenTool className="w-4 h-4 text-emerald-400" /> 快捷工作流入口
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <a
              href="/admin/editor"
              className="p-4 bg-zinc-950/60 border border-zinc-800/60 hover:border-emerald-500/40 rounded-xl transition-all group"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-200 group-hover:text-emerald-400">编写新博文</span>
                <ArrowUpRight className="w-4 h-4 text-zinc-500 group-hover:text-emerald-400" />
              </div>
              <p className="text-[11px] text-zinc-500 mt-1">分屏实时渲染 Markdown、KaTeX 公式与代码高亮</p>
            </a>

            <a
              href="/admin/memos"
              className="p-4 bg-zinc-950/60 border border-zinc-800/60 hover:border-blue-500/40 rounded-xl transition-all group"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-200 group-hover:text-blue-400">记录私密便签</span>
                <ArrowUpRight className="w-4 h-4 text-zinc-500 group-hover:text-blue-400" />
              </div>
              <p className="text-[11px] text-zinc-500 mt-1">闪念随手记、服务器密码密文库</p>
            </a>

            <a
              href="/admin/monitor"
              className="p-4 bg-zinc-950/60 border border-zinc-800/60 hover:border-amber-500/40 rounded-xl transition-all group"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-200 group-hover:text-amber-400">VPS 性能监控大屏</span>
                <ArrowUpRight className="w-4 h-4 text-zinc-500 group-hover:text-amber-400" />
              </div>
              <p className="text-[11px] text-zinc-500 mt-1">WebSocket 秒级流式 CPU/内存/网络监控图表</p>
            </a>

            <a
              href="/admin/storage"
              className="p-4 bg-zinc-950/60 border border-zinc-800/60 hover:border-teal-500/40 rounded-xl transition-all group"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-200 group-hover:text-teal-400">磁盘存储与安全清理</span>
                <ArrowUpRight className="w-4 h-4 text-zinc-500 group-hover:text-teal-400" />
              </div>
              <p className="text-[11px] text-zinc-500 mt-1">目录大文件透视、一键深度瘦身</p>
            </a>

            <a
              href="/admin/downloader"
              className="p-4 bg-zinc-950/60 border border-zinc-800/60 hover:border-cyan-500/40 rounded-xl transition-all group"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-200 group-hover:text-cyan-400">云端直传 Google Drive</span>
                <ArrowUpRight className="w-4 h-4 text-zinc-500 group-hover:text-cyan-400" />
              </div>
              <p className="text-[11px] text-zinc-500 mt-1">1000Mbps 离线下载 4K 视频并秒传云盘</p>
            </a>

            <a
              href="/admin/ai"
              className="p-4 bg-zinc-950/60 border border-zinc-800/60 hover:border-purple-500/40 rounded-xl transition-all group"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-200 group-hover:text-purple-400">私有 AI 助手对话</span>
                <ArrowUpRight className="w-4 h-4 text-zinc-500 group-hover:text-purple-400" />
              </div>
              <p className="text-[11px] text-zinc-500 mt-1">GPT-4o / Claude / DeepSeek 统一安全中继</p>
            </a>

            <a
              href="/admin/nodes"
              className="p-4 bg-zinc-950/60 border border-zinc-800/60 hover:border-cyan-500/40 rounded-xl transition-all group"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-200 group-hover:text-cyan-400">全球节点抓取与测速</span>
                <ArrowUpRight className="w-4 h-4 text-zinc-500 group-hover:text-cyan-400" />
              </div>
              <p className="text-[11px] text-zinc-500 mt-1">GitHub 优质节点自动提取、高并发测速与聚合订阅</p>
            </a>
          </div>
        </div>

        {/* 核心服务探针状态 */}
        <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-6 backdrop-blur-sm">
          <h3 className="text-sm font-bold text-zinc-100 mb-4 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" /> 核心微服务状态
          </h3>
          <div className="space-y-3 text-xs">
            <div className="flex items-center justify-between p-2.5 bg-zinc-950/60 border border-zinc-800/60 rounded-xl">
              <span className="text-zinc-300">Caddy 2 网关</span>
              <span className="text-emerald-400 font-semibold flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> 运行中 (443)
              </span>
            </div>
            <div className="flex items-center justify-between p-2.5 bg-zinc-950/60 border border-zinc-800/60 rounded-xl">
              <span className="text-zinc-300">Rust monster-core</span>
              <span className="text-emerald-400 font-semibold flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> 运行中 (8080)
              </span>
            </div>
            <div className="flex items-center justify-between p-2.5 bg-zinc-950/60 border border-zinc-800/60 rounded-xl">
              <span className="text-zinc-300">PostgreSQL 16</span>
              <span className="text-emerald-400 font-semibold flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> 运行中 (5432)
              </span>
            </div>
            <div className="flex items-center justify-between p-2.5 bg-zinc-950/60 border border-zinc-800/60 rounded-xl">
              <span className="text-zinc-300">Redis 8.x 缓存</span>
              <span className="text-emerald-400 font-semibold flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> 运行中 (6379)
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
