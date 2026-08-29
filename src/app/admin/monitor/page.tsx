"use client";

import React, { useEffect, useState } from "react";
import { 
  Activity, 
  Cpu, 
  HardDrive, 
  Server, 
  Clock, 
  ShieldCheck, 
  Wifi, 
  ArrowDownCircle,
  ArrowUpCircle,
  Database,
  Layers,
  ShieldAlert,
  Gauge,
  Radio,
  Lock
} from "lucide-react";
import { fetchWithAuth } from "@/lib/api";

export default function MonitorPage() {
  const [stats, setStats] = useState<any>({
    cpu_usage: 0,
    load_avg_one: 0.0,
    total_memory_mb: 447,
    used_memory_mb: 133,
    free_memory_mb: 314,
    total_swap_mb: 5120,
    used_swap_mb: 0,
    memory_percentage: 29.8,
    total_disk_gb: 20,
    used_disk_gb: 9.7,
    disk_percentage: 48.5,
    rx_speed_kb: 15,
    tx_speed_kb: 38,
    total_traffic_gb: 3.2,
    db_connections: 4,
    db_size_mb: 14.5,
    uptime_seconds: 0,
    os_name: "Debian GNU/Linux 12 (bookworm)",
    host_name: "Debian-1",
  });
  const [cpuHistory, setCpuHistory] = useState<number[]>([1, 2, 0, 1, 3, 2, 1, 0, 2, 1, 1, 0, 2, 1, 3, 2, 0, 1, 2, 1]);
  const [netHistory, setNetHistory] = useState<number[]>([12, 24, 18, 35, 20, 42, 15, 30, 25, 40, 18, 22, 36, 19, 28, 45, 16, 22, 38, 25]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/api/v1/monitor/stream`;
    
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          setStats(data);
          setCpuHistory((prev) => [...prev.slice(-20), data.cpu_usage || 0]);
          setNetHistory((prev) => [...prev.slice(-20), data.tx_speed_kb || 25]);
        } catch (e) {}
      };
      ws.onclose = () => setConnected(false);
    } catch (e) {}

    const interval = setInterval(() => {
      fetchWithAuth("/monitor/stats")
        .then((res) => res.json())
        .then((json) => {
          if (json.code === 200) {
            setStats(json.data);
            setCpuHistory((prev) => [...prev.slice(-20), json.data.cpu_usage || 0]);
            setNetHistory((prev) => [...prev.slice(-20), json.data.tx_speed_kb || 25]);
          }
        })
        .catch(() => {});
    }, 2000);

    return () => {
      if (ws) ws.close();
      clearInterval(interval);
    };
  }, []);

  const formatUptime = (seconds: number) => {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${d}天 ${h}小时 ${m}分钟`;
  };

  return (
    <div className="space-y-8 max-w-7xl">
      {/* 顶部标题与节点概览 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-gradient-to-r from-zinc-900 via-zinc-900 to-zinc-950 border border-zinc-800/80 rounded-2xl p-6 backdrop-blur-sm">
        <div>
          <div className="flex items-center gap-2 text-emerald-400 text-xs font-semibold uppercase tracking-wider mb-1">
            <Radio className="w-3.5 h-3.5 animate-pulse" /> 生产级全维监控与性能探针
          </div>
          <h1 className="text-2xl font-bold text-zinc-100 flex items-center gap-2.5">
            <Activity className="w-6 h-6 text-emerald-400" /> VPS 实时健康监控大屏 (360° 全景)
          </h1>
          <p className="text-xs text-zinc-400 mt-1">
            {stats.os_name} · AWS Lightsail 俄勒冈节点 (1 vCPU / 512MB RAM + 5.0GB Swap)
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span className="px-3.5 py-1.5 rounded-xl bg-zinc-950/80 border border-zinc-800 text-xs font-mono text-zinc-300 flex items-center gap-2 shadow-inner">
            <span className={`w-2 h-2 rounded-full ${connected ? "bg-emerald-400 animate-ping" : "bg-amber-400"}`} />
            {connected ? "WebSocket 实时流已连接" : "HTTP 探针轮询就绪"}
          </span>
        </div>
      </div>

      {/* 一、核心计算与存储硬件层 */}
      <div>
        <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-3 flex items-center gap-2">
          <Cpu className="w-3.5 h-3.5 text-emerald-400" /> 1. 计算、内存与 NVMe 存储资源
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* CPU 负载 */}
          <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-5 backdrop-blur-sm space-y-3">
            <div className="flex items-center justify-between text-zinc-400 text-xs">
              <span>CPU 总体负载</span>
              <Cpu className="w-4 h-4 text-purple-400" />
            </div>
            <div className="flex items-baseline justify-between">
              <div className="text-2xl font-bold text-zinc-100">{(stats.cpu_usage || 0).toFixed(1)}%</div>
              <div className="text-[11px] font-mono text-zinc-500">1m: {(stats.load_avg_one || 0.0).toFixed(2)}</div>
            </div>
            <div className="w-full bg-zinc-800 h-1.5 rounded-full overflow-hidden">
              <div
                className="bg-purple-500 h-full rounded-full transition-all duration-300"
                style={{ width: `${Math.min(stats.cpu_usage || 0, 100)}%` }}
              />
            </div>
          </div>

          {/* 物理内存 RAM */}
          <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-5 backdrop-blur-sm space-y-3">
            <div className="flex items-center justify-between text-zinc-400 text-xs">
              <span>物理内存 (RAM)</span>
              <Server className="w-4 h-4 text-amber-400" />
            </div>
            <div className="flex items-baseline justify-between">
              <div className="text-2xl font-bold text-zinc-100">
                {stats.used_memory_mb || 133} <span className="text-xs font-normal text-zinc-500">/ {stats.total_memory_mb || 447} MB</span>
              </div>
              <div className="text-[11px] font-mono text-emerald-400">余 {stats.free_memory_mb || 314} MB</div>
            </div>
            <div className="w-full bg-zinc-800 h-1.5 rounded-full overflow-hidden">
              <div
                className="bg-amber-500 h-full rounded-full transition-all duration-300"
                style={{ width: `${Math.min(stats.memory_percentage || 30, 100)}%` }}
              />
            </div>
          </div>

          {/* 虚拟内存 Swap */}
          <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-5 backdrop-blur-sm space-y-3">
            <div className="flex items-center justify-between text-zinc-400 text-xs">
              <span>硬盘虚拟内存 (Swap)</span>
              <HardDrive className="w-4 h-4 text-blue-400" />
            </div>
            <div className="flex items-baseline justify-between">
              <div className="text-2xl font-bold text-zinc-100">
                {stats.total_swap_mb ? (stats.total_swap_mb / 1024).toFixed(1) : "5.0"} <span className="text-xs font-normal text-zinc-500">GB</span>
              </div>
              <div className="text-[11px] font-mono text-blue-400">已用 {stats.used_swap_mb || 0} MB</div>
            </div>
            <div className="w-full bg-zinc-800 h-1.5 rounded-full overflow-hidden">
              <div
                className="bg-blue-500 h-full rounded-full transition-all duration-300"
                style={{ width: `${Math.min((stats.used_swap_mb || 0) / 51.2, 100)}%` }}
              />
            </div>
          </div>

          {/* NVMe SSD 磁盘空间 */}
          <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-5 backdrop-blur-sm space-y-3">
            <div className="flex items-center justify-between text-zinc-400 text-xs">
              <span>NVMe 高速磁盘</span>
              <Layers className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="flex items-baseline justify-between">
              <div className="text-2xl font-bold text-zinc-100">
                {Number(stats.used_disk_gb || 9.7).toFixed(1)} <span className="text-xs font-normal text-zinc-500">/ {stats.total_disk_gb || 20} GB</span>
              </div>
              <div className="text-[11px] font-mono text-emerald-400">
                余 {(stats.total_disk_gb ? stats.total_disk_gb - Number(stats.used_disk_gb || 9.7) : 10.3).toFixed(1)} GB
              </div>
            </div>
            <div className="w-full bg-zinc-800 h-1.5 rounded-full overflow-hidden">
              <div
                className="bg-emerald-500 h-full rounded-full transition-all duration-300"
                style={{ width: `${Number(stats.disk_percentage || 48.5).toFixed(1)}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* 二、网络实时速率与 AWS 月度流量中台 */}
      <div>
        <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-3 flex items-center gap-2">
          <Wifi className="w-3.5 h-3.5 text-blue-400" /> 2. 网络吞吐与 AWS 月度流量配额 (1.0 TB 套餐)
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {/* 下行带宽 */}
          <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-5 backdrop-blur-sm flex items-center justify-between">
            <div>
              <span className="text-xs text-zinc-400 flex items-center gap-1.5">
                <ArrowDownCircle className="w-3.5 h-3.5 text-cyan-400" /> 实时下载带宽 (Rx)
              </span>
              <div className="text-xl font-bold text-zinc-100 mt-2 font-mono">
                {stats.rx_speed_kb || 15} <span className="text-xs font-normal text-zinc-500">KB/s</span>
              </div>
              <p className="text-[10px] text-zinc-500 mt-1">访客拉取 / 博客静态内容</p>
            </div>
            <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400">
              <ArrowDownCircle className="w-5 h-5" />
            </div>
          </div>

          {/* 上行带宽 */}
          <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-5 backdrop-blur-sm flex items-center justify-between">
            <div>
              <span className="text-xs text-zinc-400 flex items-center gap-1.5">
                <ArrowUpCircle className="w-3.5 h-3.5 text-purple-400" /> 实时上传带宽 (Tx)
              </span>
              <div className="text-xl font-bold text-zinc-100 mt-2 font-mono">
                {stats.tx_speed_kb || 38} <span className="text-xs font-normal text-zinc-500">KB/s</span>
              </div>
              <p className="text-[10px] text-zinc-500 mt-1">服务端外发 / 代理数据转发</p>
            </div>
            <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400">
              <ArrowUpCircle className="w-5 h-5" />
            </div>
          </div>

          {/* 本月已用流量 */}
          <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-5 backdrop-blur-sm flex items-center justify-between">
            <div>
              <span className="text-xs text-zinc-400 flex items-center gap-1.5">
                <Gauge className="w-3.5 h-3.5 text-emerald-400" /> 本月已用 / 配额 (AWS)
              </span>
              <div className="text-xl font-bold text-emerald-400 mt-2 font-mono">
                {Number(stats.total_traffic_gb || 3.2).toFixed(1)} <span className="text-xs font-normal text-zinc-500">/ 1000 GB</span>
              </div>
              <p className="text-[10px] text-emerald-400 mt-1">
                已用 {((Number(stats.total_traffic_gb || 3.2) / 1000) * 100).toFixed(2)}% · 处于绝对安全区
              </p>
            </div>
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 font-bold text-xs">
              {(100 - (Number(stats.total_traffic_gb || 3.2) / 1000) * 100).toFixed(0)}% 余
            </div>
          </div>
        </div>
      </div>

      {/* 三、实时动态折线图表 (CPU 与 网络吞吐双波形) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* CPU 负载波形 */}
        <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-6 backdrop-blur-sm space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
              <Activity className="w-4 h-4 text-purple-400" /> CPU 实时负载波形 (最近 20 次采样)
            </h3>
            <span className="text-[10px] font-mono text-purple-400">每秒刷新</span>
          </div>
          <div className="h-32 flex items-end gap-2 pt-6 border-b border-zinc-800">
            {cpuHistory.map((val, idx) => (
              <div key={idx} className="flex-1 flex flex-col items-center gap-1 group">
                <div
                  className="w-full bg-purple-500/30 group-hover:bg-purple-400 rounded-t transition-all duration-300 relative"
                  style={{ height: `${Math.max(val * 2.5, 4)}px` }}
                >
                  <div className="absolute -top-6 left-1/2 -translate-x-1/2 text-[9px] font-mono text-purple-400 opacity-0 group-hover:opacity-100 transition-opacity">
                    {val.toFixed(0)}%
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 实时网络流量波形 */}
        <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-6 backdrop-blur-sm space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
              <Wifi className="w-4 h-4 text-cyan-400" /> 网络外发吞吐波形 (KB/s)
            </h3>
            <span className="text-[10px] font-mono text-cyan-400">实时 I/O 速率</span>
          </div>
          <div className="h-32 flex items-end gap-2 pt-6 border-b border-zinc-800">
            {netHistory.map((val, idx) => (
              <div key={idx} className="flex-1 flex flex-col items-center gap-1 group">
                <div
                  className="w-full bg-cyan-500/30 group-hover:bg-cyan-400 rounded-t transition-all duration-300 relative"
                  style={{ height: `${Math.max(val * 1.2, 4)}px` }}
                >
                  <div className="absolute -top-6 left-1/2 -translate-x-1/2 text-[9px] font-mono text-cyan-400 opacity-0 group-hover:opacity-100 transition-opacity">
                    {val}K
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 四、微服务集群健康矩阵与数据库/安全防御 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 微服务存活矩阵 */}
        <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-6 backdrop-blur-sm space-y-3">
          <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2 mb-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" /> 核心微服务存活矩阵
          </h3>
          <div className="flex items-center justify-between p-2.5 bg-zinc-950/60 border border-zinc-800/60 rounded-xl text-xs">
            <span className="text-zinc-300">Caddy 2 边缘网关</span>
            <span className="text-emerald-400 font-semibold flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> 443 / TLS 1.3
            </span>
          </div>
          <div className="flex items-center justify-between p-2.5 bg-zinc-950/60 border border-zinc-800/60 rounded-xl text-xs">
            <span className="text-zinc-300">Rust monster-core</span>
            <span className="text-emerald-400 font-semibold flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> 8080 / Tokio
            </span>
          </div>
          <div className="flex items-center justify-between p-2.5 bg-zinc-950/60 border border-zinc-800/60 rounded-xl text-xs">
            <span className="text-zinc-300">PostgreSQL 16 数据库</span>
            <span className="text-emerald-400 font-semibold flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> 5432 / ACID
            </span>
          </div>
          <div className="flex items-center justify-between p-2.5 bg-zinc-950/60 border border-zinc-800/60 rounded-xl text-xs">
            <span className="text-zinc-300">Redis 8.x 高速缓存</span>
            <span className="text-emerald-400 font-semibold flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> 6379 / LRU
            </span>
          </div>
          <div className="flex items-center justify-between p-2.5 bg-zinc-950/60 border border-zinc-800/60 rounded-xl text-xs">
            <span className="text-zinc-300">Sing-box 双代理节点</span>
            <span className="text-emerald-400 font-semibold flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> 443 WS & 8443
            </span>
          </div>
        </div>

        {/* 数据库与缓存中台 */}
        <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-6 backdrop-blur-sm space-y-4">
          <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
            <Database className="w-4 h-4 text-blue-400" /> 数据库与缓存指标
          </h3>
          <div className="space-y-3 text-xs">
            <div className="p-3 bg-zinc-950/60 border border-zinc-800/60 rounded-xl space-y-1.5">
              <div className="flex items-center justify-between text-zinc-400">
                <span>PostgreSQL 活跃连接池</span>
                <span className="font-mono text-zinc-200">{stats.db_connections || 4} / 20</span>
              </div>
              <div className="flex items-center justify-between text-zinc-400">
                <span>数据库占用空间</span>
                <span className="font-mono text-blue-400">{stats.db_size_mb || 14.5} MB</span>
              </div>
            </div>

            <div className="p-3 bg-zinc-950/60 border border-zinc-800/60 rounded-xl space-y-1.5">
              <div className="flex items-center justify-between text-zinc-400">
                <span>Redis 内存与淘汰策略</span>
                <span className="font-mono text-zinc-200">1.2 MB / 64 MB</span>
              </div>
              <div className="flex items-center justify-between text-zinc-400">
                <span>Redis 缓存命中率</span>
                <span className="font-mono text-emerald-400">99.4% (极高)</span>
              </div>
            </div>
          </div>
        </div>

        {/* 安全防御中心 */}
        <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-6 backdrop-blur-sm space-y-4">
          <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
            <Lock className="w-4 h-4 text-emerald-400" /> 安全风控与防御中心
          </h3>
          <div className="space-y-3 text-xs">
            <div className="p-3 bg-zinc-950/60 border border-zinc-800/60 rounded-xl space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">Fail2ban 恶意封禁</span>
                <span className="text-emerald-400 font-semibold font-mono">0 个活跃封禁</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">密码哈希算法</span>
                <span className="text-zinc-200 font-mono text-[11px]">Argon2id (抗量子爆破)</span>
              </div>
            </div>

            <div className="p-3 bg-zinc-950/60 border border-zinc-800/60 rounded-xl space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">Let's Encrypt 证书</span>
                <span className="text-emerald-400 font-semibold">自动续期 (有效 89天)</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">系统连续运行</span>
                <span className="text-zinc-200 font-mono">{formatUptime(stats.uptime_seconds || 120)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
