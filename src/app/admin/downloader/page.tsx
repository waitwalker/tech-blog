"use client";

import React, { useState, useRef, useEffect } from "react";
import { 
  CloudDownload, 
  HardDrive, 
  Zap, 
  FolderCheck, 
  ExternalLink, 
  Sparkles, 
  Play, 
  CheckCircle2, 
  AlertCircle, 
  Terminal,
  Wifi,
  Copy,
  Check,
  ArrowRight,
  RefreshCw,
  Trash2
} from "lucide-react";
import { getToken, fetchWithAuth } from "@/lib/api";

interface ProgressState {
  phase: "init" | "downloading" | "uploading" | "cleaning" | "done" | "error";
  download_pct: number;
  download_speed: string;
  download_eta: string;
  upload_pct: number;
  upload_speed: string;
  upload_eta: string;
  total_size: string;
  line: string;
  is_error: boolean;
}

export default function DownloaderPage() {
  const [url, setUrl] = useState("");
  const [folder, setFolder] = useState("MonsterAI_Downloads");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  
  // Cookie 管理状态
  const [showCookieBox, setShowCookieBox] = useState(false);
  const [cookieText, setCookieText] = useState("");
  const [cookieSaving, setCookieSaving] = useState(false);
  const [cookieMsg, setCookieMsg] = useState("");
  
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const handleSaveCookie = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cookieText.trim() || cookieSaving) return;

    setCookieSaving(true);
    setCookieMsg("");

    try {
      const res = await fetchWithAuth("/tools/cookie", {
        method: "POST",
        body: JSON.stringify({ cookies: cookieText.trim() }),
      });
      const data = await res.json();
      if (data.code === 200) {
        setCookieMsg("🎉 Cookie 更新成功！已即时激活。");
        setCookieText("");
        setTimeout(() => setShowCookieBox(false), 2000);
      } else {
        setCookieMsg(`❌ 保存失败: ${data.message}`);
      }
    } catch (err: any) {
      setCookieMsg(`❌ 网络错误: ${err.message || String(err)}`);
    } finally {
      setCookieSaving(false);
    }
  };

  const handleCopyLog = () => {
    const fullLog = logs.join("\n");
    if (!fullLog) return;
    navigator.clipboard.writeText(fullLog);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const handleStartDownload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || loading) return;

    setLoading(true);
    setLogs(["[00:00:00] 正在连接云端千兆转存中枢..."]);
    setProgress({
      phase: "init",
      download_pct: 0,
      download_speed: "-",
      download_eta: "-",
      upload_pct: 0,
      upload_speed: "-",
      upload_eta: "-",
      total_size: "-",
      line: "正在建立流式传输隧道...",
      is_error: false,
    });

    const token = getToken();
    const apiUrl = `/api/v1/tools/download?url=${encodeURIComponent(url.trim())}&folder=${encodeURIComponent(folder.trim())}`;

    try {
      const response = await fetch(apiUrl, {
        method: "GET",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });

      if (!response.ok || !response.body) {
        throw new Error(`HTTP 请求异常: 状态码 ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data:")) {
            const jsonStr = trimmed.replace(/^data:\s*/, "");
            try {
              const data: ProgressState = JSON.parse(jsonStr);
              setProgress((prev) => ({
                ...prev,
                ...data,
                download_pct: Math.min(100, Math.max(prev?.download_pct || 0, data.download_pct)),
                upload_pct: Math.min(100, Math.max(prev?.upload_pct || 0, data.upload_pct)),
              }));

              if (data.line) {
                setLogs((prevLogs) => [...prevLogs, data.line]);
              }

              if (data.phase === "done" || data.phase === "error" || data.is_error) {
                if (data.phase === "done") {
                  setLoading(false);
                }
              }
            } catch (err) {
              // 忽略非 JSON 行
            }
          }
        }
      }
    } catch (err: any) {
      const errMsg = `❌ 请求异常: ${err.message || String(err)}`;
      setLogs((prev) => [...prev, errMsg]);
      setProgress((prev) => ({
        phase: "error",
        download_pct: prev?.download_pct || 0,
        download_speed: "-",
        download_eta: "-",
        upload_pct: prev?.upload_pct || 0,
        upload_speed: "-",
        upload_eta: "-",
        total_size: prev?.total_size || "-",
        line: errMsg,
        is_error: true,
      }));
    } finally {
      setLoading(false);
    }
  };

  const getEmbedInfo = (rawUrl: string) => {
    if (!rawUrl) return null;
    const cleanUrl = rawUrl.trim();

    // YouTube
    const ytMatch = cleanUrl.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
    if (ytMatch && ytMatch[1]) {
      const vid = ytMatch[1];
      return {
        type: "youtube",
        title: "YouTube 官方高清视频",
        vid,
        embedUrl: `https://www.youtube-nocookie.com/embed/${vid}?autoplay=0&rel=0`,
      };
    }

    // Bilibili
    const biliMatch = cleanUrl.match(/(?:bilibili\.com\/video\/)(BV[a-zA-Z0-9]+)/i);
    if (biliMatch && biliMatch[1]) {
      return {
        type: "bilibili",
        title: "哔哩哔哩 Bilibili 视频",
        vid: biliMatch[1],
        embedUrl: `https://player.bilibili.com/player.html?bvid=${biliMatch[1]}&page=1&high_quality=1&as_wide=1`,
      };
    }

    // Direct MP4 / WebM / OGG
    if (cleanUrl.match(/\.(mp4|webm|ogg|m4v)(\?.*)?$/i)) {
      return {
        type: "direct",
        title: "HTML5 原生流媒体直链",
        vid: "",
        embedUrl: cleanUrl,
      };
    }

    return null;
  };

  const embedInfo = getEmbedInfo(url);

  return (
    <div className="space-y-8 max-w-5xl">
      {/* 顶部标题区 */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-gradient-to-r from-cyan-500/10 via-zinc-900 to-zinc-900 border border-zinc-800/80 rounded-2xl p-6">
        <div>
          <div className="flex items-center gap-2 text-cyan-400 text-xs font-semibold uppercase tracking-wider mb-1">
            <Sparkles className="w-3.5 h-3.5" /> 云对云千兆高速直传管道 (带内置播放器)
          </div>
          <h1 className="text-2xl font-bold text-zinc-100 flex items-center gap-2.5">
            <CloudDownload className="w-7 h-7 text-cyan-400" />
            云端离线下载与 Google Drive 直传
          </h1>
          <p className="text-xs text-zinc-400 mt-1">
            支持网页内置播放器即时试播预览，海外 VPS 骨干网千兆极速下载 4K/1080P 视频并推流存入你的 Google Drive。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowCookieBox(!showCookieBox)}
            className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 px-4 py-2 rounded-xl text-xs font-medium border border-zinc-700 transition-all cursor-pointer"
          >
            <span>🍪 {showCookieBox ? "收起 Cookie 设置" : "YouTube Cookie 设置"}</span>
          </button>

          <a
            href="https://drive.google.com"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 px-4 py-2 rounded-xl text-xs font-medium border border-zinc-700 transition-all"
          >
            <ExternalLink className="w-3.5 h-3.5 text-cyan-400" />
            <span>打开 Google Drive</span>
          </a>
        </div>
      </div>

      {/* YouTube Cookie 快捷配置卡片 (可折叠) */}
      {showCookieBox && (
        <div className="bg-amber-500/5 border border-amber-500/20 rounded-2xl p-6 backdrop-blur-sm space-y-4 animate-in fade-in duration-200">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-amber-300 flex items-center gap-2">
              <span>🍪 YouTube 登录凭证配置 (解决机房 IP 机器人风控)</span>
            </h3>
            <span className="text-[11px] text-zinc-400">非 YouTube 视频（如 B站/Twitter/TikTok）无需配置</span>
          </div>

          <p className="text-xs text-zinc-400 leading-relaxed">
            YouTube 会对全球云服务商机房 IP 实施防爬拦截。若提示 <code>Sign in to confirm you’re not a bot</code>，只需在此粘贴一份来自浏览器的最新 YouTube Cookie 文本并保存，VPS 将以此身份永久全速直传！
          </p>

          <form onSubmit={handleSaveCookie} className="space-y-3">
            <textarea
              rows={4}
              required
              value={cookieText}
              onChange={(e) => setCookieText(e.target.value)}
              placeholder="在此粘贴 Netscape 格式的 Cookie 文本或 F12 导出的 Cookie 字符串..."
              className="w-full bg-zinc-950/90 border border-zinc-800 focus:border-amber-500/50 rounded-xl p-3 text-xs text-zinc-200 font-mono focus:outline-none placeholder-zinc-600 leading-relaxed"
            />

            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-emerald-400">{cookieMsg}</span>
              <button
                type="submit"
                disabled={cookieSaving}
                className="flex items-center gap-2 bg-amber-500 hover:bg-amber-400 text-black font-bold px-5 py-2 rounded-xl text-xs transition-all cursor-pointer disabled:opacity-50"
              >
                {cookieSaving ? "正在保存..." : "保存并激活 Cookie"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* 核心特性与状态栏 */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="p-4 bg-zinc-900/60 border border-zinc-800/80 rounded-2xl flex items-center gap-3.5 backdrop-blur-sm">
          <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400 shrink-0">
            <Wifi className="w-5 h-5" />
          </div>
          <div>
            <div className="text-xs font-semibold text-zinc-200">1000Mbps+ 骨干网络</div>
            <div className="text-[11px] text-zinc-400 mt-0.5">美西 AWS 与 Google 内网直连</div>
          </div>
        </div>

        <div className="p-4 bg-zinc-900/60 border border-zinc-800/80 rounded-2xl flex items-center gap-3.5 backdrop-blur-sm">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 shrink-0">
            <Zap className="w-5 h-5" />
          </div>
          <div>
            <div className="text-xs font-semibold text-zinc-200">yt-dlp + Deno + FFmpeg</div>
            <div className="text-[11px] text-zinc-400 mt-0.5">自动绕过机房风控与 4K 封装</div>
          </div>
        </div>

        <div className="p-4 bg-zinc-900/60 border border-zinc-800/80 rounded-2xl flex items-center gap-3.5 backdrop-blur-sm">
          <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 shrink-0">
            <HardDrive className="w-5 h-5" />
          </div>
          <div>
            <div className="text-xs font-semibold text-zinc-200">Google Drive 已认证绑定</div>
            <div className="text-[11px] text-emerald-400 mt-0.5 font-mono">rclone 云端推流就绪</div>
          </div>
        </div>
      </div>

      {/* 离线下载任务提交表单 */}
      <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-6 backdrop-blur-sm space-y-6">
        <h2 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
          <Play className="w-4 h-4 text-cyan-400" /> 发起新下载转存任务
        </h2>

        <form onSubmit={handleStartDownload} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1.5">
              视频或媒体链接 (URL) <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="例如: https://www.youtube.com/watch?v=... 或 B站、Twitter、各类网页视频链接"
              className="w-full bg-zinc-950/80 border border-zinc-800 focus:border-cyan-500/50 rounded-xl px-4 py-3 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none transition-all font-mono"
            />
          </div>

          {/* 嵌套网页播放器 (Embedded Player) */}
          {embedInfo && (
            <div className="bg-zinc-950/90 border border-cyan-500/30 rounded-2xl p-4 space-y-3 animate-in fade-in duration-300">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-semibold text-cyan-400">
                  <Play className="w-3.5 h-3.5 fill-cyan-400" />
                  <span>🎬 视频即时试播与原画预览 ({embedInfo.title})</span>
                </div>
                <span className="text-[11px] text-zinc-500 font-mono">在网页端即时试看确认内容</span>
              </div>

              <div className="relative w-full aspect-video rounded-xl overflow-hidden bg-black border border-zinc-800 shadow-2xl">
                {embedInfo.type === "youtube" || embedInfo.type === "bilibili" ? (
                  <iframe
                    src={embedInfo.embedUrl}
                    title="Video Preview"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowFullScreen
                    className="w-full h-full border-0"
                  />
                ) : (
                  <video
                    src={embedInfo.embedUrl}
                    controls
                    className="w-full h-full object-contain"
                  />
                )}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                Google Drive 目标文件夹名称
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  placeholder="MonsterAI_Downloads"
                  className="w-full bg-zinc-950/80 border border-zinc-800 focus:border-cyan-500/50 rounded-xl px-4 py-3 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none transition-all font-mono pl-9"
                />
                <FolderCheck className="w-4 h-4 text-zinc-500 absolute left-3 top-3.5" />
              </div>
              <p className="text-[11px] text-zinc-500 mt-1">若文件夹不存在将自动在 Google Drive 根目录创建</p>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                画质与封装策略
              </label>
              <div className="bg-zinc-950/80 border border-zinc-800 rounded-xl px-4 py-3 text-xs text-zinc-400 flex items-center justify-between">
                <span>最高画质 + 最佳音质 (4K/1080P MP4)</span>
                <span className="text-[10px] bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 px-2 py-0.5 rounded-md font-mono">
                  AUTO BEST
                </span>
              </div>
            </div>
          </div>

          <div className="pt-2">
            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2.5 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 disabled:opacity-50 text-white font-semibold px-6 py-3.5 rounded-xl text-xs shadow-lg shadow-cyan-500/20 transition-all cursor-pointer"
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>正在执行云端流水线任务（实时流式回传中）...</span>
                </>
              ) : (
                <>
                  <CloudDownload className="w-4 h-4" />
                  <span>立即开始云端离线下载并转存</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>

      {/* 实时进度透视与双进度条 */}
      {progress && (
        <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-6 backdrop-blur-sm space-y-6 animate-in fade-in duration-300">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
              <Zap className="w-4 h-4 text-cyan-400" /> 实时转存进度仪表盘
            </h3>
            
            {/* 状态徽章 */}
            <div>
              {progress.phase === "init" && (
                <span className="px-3 py-1 bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 rounded-full text-xs flex items-center gap-1.5 font-medium">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" /> 准备就绪 / 连接中
                </span>
              )}
              {progress.phase === "downloading" && (
                <span className="px-3 py-1 bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-full text-xs flex items-center gap-1.5 font-medium">
                  <CloudDownload className="w-3.5 h-3.5 animate-bounce" /> 阶段 1: 正在千兆高速下载
                </span>
              )}
              {progress.phase === "uploading" && (
                <span className="px-3 py-1 bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded-full text-xs flex items-center gap-1.5 font-medium">
                  <HardDrive className="w-3.5 h-3.5 animate-pulse" /> 阶段 2: 正在直传 Google Drive
                </span>
              )}
              {progress.phase === "cleaning" && (
                <span className="px-3 py-1 bg-purple-500/10 text-purple-400 border border-purple-500/20 rounded-full text-xs flex items-center gap-1.5 font-medium">
                  <Trash2 className="w-3.5 h-3.5" /> 阶段 3: 释放临时缓存空间
                </span>
              )}
              {progress.phase === "done" && (
                <span className="px-3 py-1 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-full text-xs flex items-center gap-1.5 font-medium">
                  <CheckCircle2 className="w-3.5 h-3.5" /> 🎉 转存任务圆满完成！
                </span>
              )}
              {(progress.phase === "error" || progress.is_error) && (
                <span className="px-3 py-1 bg-red-500/10 text-red-400 border border-red-500/20 rounded-full text-xs flex items-center gap-1.5 font-medium">
                  <AlertCircle className="w-3.5 h-3.5" /> 任务异常中断
                </span>
              )}
            </div>
          </div>

          {/* 双进度条卡片 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* 1. 云端极速下载进度 */}
            <div className="p-4 bg-zinc-950/70 border border-zinc-800/80 rounded-xl space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-zinc-200 flex items-center gap-1.5">
                  <CloudDownload className="w-4 h-4 text-cyan-400" />
                  1. 云端 1000Mbps 下载
                </span>
                <span className="font-mono text-cyan-400 font-bold">
                  {progress.download_pct.toFixed(1)}%
                </span>
              </div>
              <div className="w-full bg-zinc-800 rounded-full h-2.5 overflow-hidden">
                <div 
                  className="bg-gradient-to-r from-cyan-500 to-blue-500 h-2.5 rounded-full transition-all duration-300"
                  style={{ width: `${progress.download_pct}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-[11px] text-zinc-400 font-mono">
                <span>速率: <strong className="text-zinc-200">{progress.download_speed}</strong></span>
                <span>总大小: <strong className="text-zinc-200">{progress.total_size}</strong></span>
                <span>剩余: <strong className="text-zinc-200">{progress.download_eta}</strong></span>
              </div>
            </div>

            {/* 2. Google Drive 推流上传进度 */}
            <div className="p-4 bg-zinc-950/70 border border-zinc-800/80 rounded-xl space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-zinc-200 flex items-center gap-1.5">
                  <HardDrive className="w-4 h-4 text-amber-400" />
                  2. Google Drive 直传推流
                </span>
                <span className="font-mono text-amber-400 font-bold">
                  {progress.upload_pct.toFixed(1)}%
                </span>
              </div>
              <div className="w-full bg-zinc-800 rounded-full h-2.5 overflow-hidden">
                <div 
                  className="bg-gradient-to-r from-amber-500 to-emerald-500 h-2.5 rounded-full transition-all duration-300"
                  style={{ width: `${progress.upload_pct}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-[11px] text-zinc-400 font-mono">
                <span>上传速率: <strong className="text-zinc-200">{progress.upload_speed}</strong></span>
                <span>目标: <strong className="text-zinc-200">{folder}</strong></span>
                <span>剩余: <strong className="text-zinc-200">{progress.upload_eta}</strong></span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 实时控制台滚动终端与一键复制按钮 */}
      {logs.length > 0 && (
        <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-6 backdrop-blur-sm space-y-4 animate-in fade-in duration-300">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
              <Terminal className="w-4 h-4 text-cyan-400" /> 实时终端流式输出与日志
            </h3>
            
            {/* 一键复制报错/日志按钮 */}
            <button
              type="button"
              onClick={handleCopyLog}
              className="flex items-center gap-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 px-3 py-1.5 rounded-lg text-xs font-medium border border-zinc-700 transition-all cursor-pointer active:scale-95"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-emerald-400 font-medium">已复制到剪贴板！</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 text-zinc-400" />
                  <span>{progress?.is_error ? "复制报错信息" : "复制完整日志"}</span>
                </>
              )}
            </button>
          </div>

          <div 
            ref={logContainerRef}
            className="bg-zinc-950 border border-zinc-800/80 rounded-xl p-4 font-mono text-[11px] text-zinc-300 overflow-y-auto max-h-80 whitespace-pre-wrap leading-relaxed select-text"
          >
            {logs.map((logLine, idx) => {
              const isErr = logLine.includes("ERROR") || logLine.includes("❌") || logLine.includes("Failed");
              const isSuccess = logLine.includes("🎉") || logLine.includes("成功");
              return (
                <div 
                  key={idx} 
                  className={isErr ? "text-red-400 font-semibold" : isSuccess ? "text-emerald-400 font-semibold" : ""}
                >
                  {logLine}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
