"use client";

import React, { useEffect, useState } from "react";
import { 
  HardDrive, 
  Trash2, 
  RefreshCw, 
  Folder, 
  File, 
  ChevronRight, 
  ShieldCheck, 
  AlertTriangle, 
  Layers, 
  Sparkles, 
  Terminal, 
  CheckCircle2, 
  ArrowLeft,
  FolderOpen,
  Zap,
  Info
} from "lucide-react";
import { fetchWithAuth } from "@/lib/api";

interface DirectoryCategory {
  name: string;
  path: string;
  size_mb: number;
  safety_level: "safe" | "app" | "protected";
  description: string;
  cleanable: boolean;
}

interface FileItem {
  name: string;
  path: string;
  is_dir: boolean;
  size_bytes: number;
  size_formatted: string;
  modified_at: string;
  safety_level: string;
}

export default function StoragePage() {
  const [overview, setOverview] = useState<any>({
    total_disk_gb: 20.0,
    used_disk_gb: 9.7,
    free_disk_gb: 10.3,
    cleanable_estimated_mb: 1250.0,
    directories: [],
  });

  const [currentPath, setCurrentPath] = useState("/var");
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loadingExplorer, setLoadingExplorer] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [cleanResult, setCleanResult] = useState<any>(null);

  // 加载磁盘概览数据
  const loadOverview = async () => {
    try {
      const res = await fetchWithAuth("/storage/overview");
      const json = await res.json();
      if (json.code === 200 && json.data) {
        setOverview(json.data);
      }
    } catch (e) {}
  };

  // 加载目录文件列表
  const loadDirectory = async (path: string) => {
    setLoadingExplorer(true);
    try {
      const res = await fetchWithAuth(`/storage/explore?path=${encodeURIComponent(path)}`);
      const json = await res.json();
      if (json.code === 200 && json.data) {
        setCurrentPath(json.data.current_path);
        setParentPath(json.data.parent_path);
        setFiles(json.data.items);
      }
    } catch (e) {
    } finally {
      setLoadingExplorer(false);
    }
  };

  useEffect(() => {
    loadOverview();
    loadDirectory("/var");
  }, []);

  // 执行安全清理
  const handleClean = async (target: string) => {
    setCleaning(true);
    setCleanResult(null);
    try {
      const res = await fetchWithAuth("/storage/clean", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target }),
      });
      const json = await res.json();
      if (json.code === 200 && json.data) {
        setCleanResult(json.data);
        loadOverview();
        loadDirectory(currentPath);
      }
    } catch (err: any) {
      setCleanResult({
        success: false,
        message: err.message || "清理执行异常",
        log: String(err),
      });
    } finally {
      setCleaning(false);
    }
  };

  const usedPercentage = ((overview.used_disk_gb / overview.total_disk_gb) * 100).toFixed(1);

  return (
    <div className="space-y-8 max-w-6xl">
      {/* 顶部标题区 */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-gradient-to-r from-emerald-500/10 via-zinc-900 to-zinc-900 border border-zinc-800/80 rounded-2xl p-6">
        <div>
          <div className="flex items-center gap-2 text-emerald-400 text-xs font-semibold uppercase tracking-wider mb-1">
            <Sparkles className="w-3.5 h-3.5" /> NVMe 高速存储与缓存治理
          </div>
          <h1 className="text-2xl font-bold text-zinc-100 flex items-center gap-2.5">
            <HardDrive className="w-7 h-7 text-emerald-400" />
            磁盘存储透视与安全清理中枢
          </h1>
          <p className="text-xs text-zinc-400 mt-1">
            实时查看机器各目录磁盘占用，智能识别可安全清理的构建缓存、包残留与系统日志，一键安全瘦身。
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => handleClean("all")}
            disabled={cleaning}
            className="flex items-center gap-2 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-zinc-950 px-5 py-2.5 rounded-xl text-xs font-bold shadow-lg shadow-emerald-500/20 transition-all cursor-pointer disabled:opacity-50"
          >
            {cleaning ? (
              <RefreshCw className="w-4 h-4 animate-spin text-zinc-950" />
            ) : (
              <Zap className="w-4 h-4 text-zinc-950" />
            )}
            <span>⚡ 一键全盘安全深度清理</span>
          </button>
        </div>
      </div>

      {/* 全盘空间仪表卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* 磁盘使用率 */}
        <div className="md:col-span-2 bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-5 backdrop-blur-sm space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-300 flex items-center gap-2">
              <Layers className="w-4 h-4 text-emerald-400" /> 系统总空间 (NVMe SSD)
            </span>
            <span className="text-xs font-mono text-emerald-400">已使用 {usedPercentage}%</span>
          </div>

          <div className="flex items-baseline justify-between">
            <div className="text-3xl font-bold text-zinc-100 font-mono">
              {overview.used_disk_gb.toFixed(1)} <span className="text-sm font-normal text-zinc-500">/ {overview.total_disk_gb.toFixed(1)} GB</span>
            </div>
            <div className="text-xs text-emerald-400 font-mono font-semibold">
              剩余 {overview.free_disk_gb.toFixed(1)} GB 可用
            </div>
          </div>

          <div className="w-full bg-zinc-800 h-2 rounded-full overflow-hidden">
            <div
              className="bg-gradient-to-r from-emerald-500 to-teal-400 h-full rounded-full transition-all duration-500"
              style={{ width: `${usedPercentage}%` }}
            />
          </div>
        </div>

        {/* 可释放垃圾预估 */}
        <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-5 backdrop-blur-sm flex flex-col justify-between">
          <div className="flex items-center justify-between text-zinc-400 text-xs">
            <span>可安全清理缓存预估</span>
            <Trash2 className="w-4 h-4 text-cyan-400" />
          </div>
          <div>
            <div className="text-2xl font-bold text-cyan-400 font-mono mt-2">
              {(overview.cleanable_estimated_mb / 1024).toFixed(2)} <span className="text-xs font-normal text-zinc-500">GB</span>
            </div>
            <p className="text-[10px] text-zinc-400 mt-1">包含 APT 缓存、旧日志、临时分片</p>
          </div>
          <button
            onClick={() => handleClean("all")}
            disabled={cleaning}
            className="w-full mt-3 py-1.5 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 rounded-lg text-xs font-medium transition-colors"
          >
            立即释放
          </button>
        </div>
      </div>

      {/* 清理任务执行结果通知 */}
      {cleanResult && (
        <div className="p-4 bg-zinc-900/90 border border-emerald-500/40 rounded-2xl space-y-2 animate-in fade-in">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-emerald-400 flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4" /> {cleanResult.message}
            </span>
            <span className="text-[10px] text-zinc-400">已刷新最新磁盘数据</span>
          </div>
          {cleanResult.log && (
            <pre className="p-3 bg-zinc-950 border border-zinc-800 rounded-xl text-[10px] text-zinc-300 font-mono overflow-x-auto max-h-32">
              {cleanResult.log}
            </pre>
          )}
        </div>
      )}

      {/* 核心目录分类与安全级别卡片 */}
      <div className="space-y-3">
        <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
          <Layers className="w-3.5 h-3.5 text-emerald-400" /> 1. 核心目录与缓存分类治理
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {overview.directories.map((dir: DirectoryCategory, idx: number) => {
            const isSafe = dir.safety_level === "safe";
            const isProtected = dir.safety_level === "protected";

            return (
              <div
                key={idx}
                className={`bg-zinc-900/60 border rounded-2xl p-4.5 backdrop-blur-sm flex flex-col justify-between transition-all ${
                  isSafe 
                    ? "border-emerald-500/30 hover:border-emerald-500/60" 
                    : isProtected 
                    ? "border-red-500/20" 
                    : "border-blue-500/20"
                }`}
              >
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className={`text-[10px] px-2 py-0.5 rounded-md font-semibold ${
                      isSafe 
                        ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30" 
                        : isProtected 
                        ? "bg-red-500/10 text-red-400 border border-red-500/30" 
                        : "bg-blue-500/10 text-blue-400 border border-blue-500/30"
                    }`}>
                      {isSafe ? "🟢 可安全清理" : isProtected ? "🔴 核心保护" : "🟡 业务数据"}
                    </span>
                    <span className="text-xs font-mono font-bold text-zinc-200">{dir.size_mb} MB</span>
                  </div>

                  <h3 className="text-xs font-bold text-zinc-100">{dir.name}</h3>
                  <p className="text-[11px] text-zinc-500 font-mono truncate">{dir.path}</p>
                  <p className="text-[10px] text-zinc-400 leading-relaxed">{dir.description}</p>
                </div>

                <div className="pt-3 mt-3 border-t border-zinc-800/60 flex items-center justify-between gap-2">
                  <button
                    onClick={() => loadDirectory(dir.path)}
                    className="text-[11px] text-zinc-400 hover:text-zinc-200 flex items-center gap-1 transition-colors"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                    <span>浏览目录</span>
                  </button>

                  {dir.cleanable && (
                    <button
                      onClick={() => handleClean(dir.path.includes("tmp") ? "tmp" : dir.path.includes("apt") ? "apt" : "logs")}
                      disabled={cleaning}
                      className="text-[11px] text-emerald-400 hover:text-emerald-300 font-medium flex items-center gap-1 bg-emerald-500/10 hover:bg-emerald-500/20 px-2.5 py-1 rounded-lg transition-all cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" />
                      <span>清理</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 交互式目录与文件透视浏览器 */}
      <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-6 backdrop-blur-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-zinc-800/80">
          <div className="flex items-center gap-2">
            <Folder className="w-5 h-5 text-amber-400" />
            <h3 className="text-sm font-bold text-zinc-100">交互式文件与目录浏览器</h3>
          </div>

          {/* 路径导航 */}
          <div className="flex items-center gap-2 text-xs font-mono bg-zinc-950/80 border border-zinc-800 px-3 py-1.5 rounded-xl">
            {parentPath && (
              <button
                onClick={() => loadDirectory(parentPath)}
                className="text-zinc-400 hover:text-zinc-200 flex items-center gap-1 mr-1.5"
              >
                <ArrowLeft className="w-3.5 h-3.5" /> 上一级
              </button>
            )}
            <span className="text-emerald-400 font-bold">{currentPath}</span>
          </div>
        </div>

        {/* 文件列表表格 */}
        <div className="overflow-x-auto">
          {loadingExplorer ? (
            <div className="py-12 flex items-center justify-center gap-2 text-xs text-zinc-500">
              <RefreshCw className="w-4 h-4 animate-spin text-emerald-400" />
              <span>正在扫描目录结构与占用空间...</span>
            </div>
          ) : files.length === 0 ? (
            <div className="py-8 text-center text-xs text-zinc-500">该目录下暂无文件或为空目录</div>
          ) : (
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-zinc-500 border-b border-zinc-800/60 font-medium">
                  <th className="pb-3 pl-2">名称</th>
                  <th className="pb-3">安全分类</th>
                  <th className="pb-3">占用大小</th>
                  <th className="pb-3">最后修改时间</th>
                  <th className="pb-3 text-right pr-2">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/40 font-mono">
                {files.map((file, idx) => (
                  <tr key={idx} className="hover:bg-zinc-800/30 transition-colors group">
                    <td className="py-2.5 pl-2 flex items-center gap-2.5 text-zinc-200">
                      {file.is_dir ? (
                        <Folder className="w-4 h-4 text-amber-400 shrink-0" />
                      ) : (
                        <File className="w-4 h-4 text-zinc-400 shrink-0" />
                      )}
                      <span className="font-sans font-medium text-xs text-zinc-200">{file.name}</span>
                    </td>
                    <td className="py-2.5">
                      <span className={`text-[10px] px-2 py-0.5 rounded-md ${
                        file.safety_level === "safe"
                          ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                          : file.safety_level === "protected"
                          ? "bg-red-500/10 text-red-400 border border-red-500/20"
                          : "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                      }`}>
                        {file.safety_level === "safe" ? "安全缓存" : file.safety_level === "protected" ? "受保护" : "业务数据"}
                      </span>
                    </td>
                    <td className="py-2.5 text-zinc-300 font-semibold">{file.size_formatted}</td>
                    <td className="py-2.5 text-zinc-500 text-[11px]">{file.modified_at}</td>
                    <td className="py-2.5 text-right pr-2">
                      {file.is_dir && (
                        <button
                          onClick={() => loadDirectory(file.path)}
                          className="text-xs text-emerald-400 hover:text-emerald-300 font-sans font-medium flex items-center gap-1 ml-auto"
                        >
                          <span>进入</span>
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
