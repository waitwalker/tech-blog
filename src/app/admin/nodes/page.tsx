'use client';

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { 
  Globe, 
  RefreshCw, 
  Copy, 
  Check, 
  Zap, 
  ShieldCheck, 
  Server, 
  Filter, 
  QrCode,
  X,
  Shield,
  Search,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  Layers,
  Star,
  Lock,
  Unlock,
  Smartphone,
  Laptop,
  Radio
} from 'lucide-react';
import QRCode from 'qrcode';

interface SubChannelVariant {
  id: string;
  filename: string;
  major_num: number;
  title: string;
  name: string;
  description: string;
  node_count: number;
  is_short: boolean;
  is_full: boolean;
  category: string;
  is_recommended: boolean;
  is_obhod: boolean;
  is_blacklist: boolean;
  is_whitelist: boolean;
  raw_url: string;
  raw_path: string;
}

interface MajorChannel {
  major_num: number;
  name: string;
  title: string;
  description: string;
  category: string;
  is_recommended: boolean;
  is_obhod: boolean;
  is_blacklist: boolean;
  is_whitelist: boolean;
  variants: SubChannelVariant[];
}

interface CuratedNode {
  id: string;
  name: string;
  protocol: string;
  host: string;
  port: number;
  latency_ms: number;
  link: string;
  country: string;
  country_flag: string;
  country_name: string;
  is_alive: boolean;
  security_level: 'safe' | 'medium' | 'warning' | 'danger';
  security_tag: string;
  security_reason: string;
}

interface MetaStats {
  total_unique_nodes: number;
  total_channels: number;
  total_config_files: number;
  curated_pool_size: number;
  protocol_breakdown: Record<string, number>;
  country_breakdown: Record<string, string>;
  security_breakdown: Record<string, number>;
  updated_at: string;
}

export default function AdminNodesPage() {
  // Tab State: 'channels' | 'nodes' | 'clients'
  const [activeTab, setActiveTab] = useState<'channels' | 'nodes' | 'clients'>('channels');

  // Channel filters: 'all' | 'recommended' | 'obhod' | 'blacklist' | 'whitelist' | 'full'
  const [channelFilter, setChannelFilter] = useState<'all' | 'recommended' | 'obhod' | 'blacklist' | 'whitelist' | 'full'>('all');
  const [channelSearch, setChannelSearch] = useState('');

  // Node Explorer filters
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCountry, setSelectedCountry] = useState('ALL');
  const [selectedProtocol, setSelectedProtocol] = useState('ALL');
  const [selectedSecurity, setSelectedSecurity] = useState('ALL');
  const [onlyLowLatency, setOnlyLowLatency] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 24;

  // Data states
  const [channels, setChannels] = useState<MajorChannel[]>([]);
  const [nodes, setNodes] = useState<CuratedNode[]>([]);
  const [meta, setMeta] = useState<MetaStats | null>(null);
  const [loading, setLoading] = useState(true);

  // Copy & QR States
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedSub, setCopiedSub] = useState(false);
  const [qrModalInfo, setQrModalInfo] = useState<{ title: string; subtitle: string; link: string; tag?: string } | null>(null);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string>('');

  // Load Data
  const loadData = async () => {
    setLoading(true);
    try {
      // 1. Fetch channels
      const chRes = await fetch('/data/nodes/channels.json');
      if (chRes.ok) {
        const chData = await chRes.json();
        setChannels(chData.channels || []);
      }

      // 2. Fetch meta
      const metaRes = await fetch('/data/nodes/meta.json');
      if (metaRes.ok) {
        const metaData = await metaRes.json();
        setMeta(metaData);
      }

      // 3. Fetch curated nodes
      const nodesRes = await fetch('/data/nodes/nodes-curated.json');
      if (nodesRes.ok) {
        const nodesData = await nodesRes.json();
        setNodes(nodesData.nodes || []);
      }
    } catch (e) {
      console.error('Failed to load nodes data:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // Copy Action
  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Copy Master Aggregated Subscription
  const handleCopyMasterSub = () => {
    const subUrl = 'https://blog.monsterai.us.kg/configs/sub.txt';
    navigator.clipboard.writeText(subUrl);
    setCopiedSub(true);
    setTimeout(() => setCopiedSub(false), 2000);
  };

  // Open QR Code Modal
  const handleOpenQr = async (title: string, subtitle: string, link: string, tag?: string) => {
    setQrModalInfo({ title, subtitle, link, tag });
    try {
      const url = await QRCode.toDataURL(link, {
        width: 320,
        margin: 2,
        color: { dark: '#020617', light: '#ffffff' }
      });
      setQrCodeDataUrl(url);
    } catch (err) {
      console.error('QR code generation failed:', err);
    }
  };

  // Filtered Channels
  const filteredChannels = useMemo(() => {
    return channels.filter((ch) => {
      // Filter tab
      if (channelFilter === 'recommended' && !ch.is_recommended) return false;
      if (channelFilter === 'obhod' && !ch.is_obhod) return false;
      if (channelFilter === 'blacklist' && !ch.is_blacklist) return false;
      if (channelFilter === 'whitelist' && !ch.is_whitelist) return false;
      if (channelFilter === 'full') {
        const hasFull = ch.variants.some((v) => v.is_full);
        if (!hasFull) return false;
      }

      // Keyword search
      if (channelSearch.trim()) {
        const q = channelSearch.toLowerCase();
        const matchName = ch.name.toLowerCase().includes(q);
        const matchTitle = ch.title.toLowerCase().includes(q);
        const matchDesc = ch.description.toLowerCase().includes(q);
        const matchNum = String(ch.major_num).includes(q);
        if (!matchName && !matchTitle && !matchDesc && !matchNum) return false;
      }
      return true;
    });
  }, [channels, channelFilter, channelSearch]);

  // Filtered Curated Nodes
  const filteredNodes = useMemo(() => {
    return nodes.filter((node) => {
      if (selectedCountry !== 'ALL' && node.country !== selectedCountry) return false;
      if (selectedProtocol !== 'ALL' && node.protocol.toLowerCase() !== selectedProtocol.toLowerCase()) return false;
      if (selectedSecurity !== 'ALL' && node.security_level !== selectedSecurity) return false;
      if (onlyLowLatency && node.latency_ms > 100) return false;

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchName = node.name.toLowerCase().includes(q);
        const matchHost = node.host.toLowerCase().includes(q);
        const matchCountry = node.country_name.toLowerCase().includes(q);
        if (!matchName && !matchHost && !matchCountry) return false;
      }
      return true;
    });
  }, [nodes, selectedCountry, selectedProtocol, selectedSecurity, onlyLowLatency, searchQuery]);

  // Pagination for nodes
  const totalPages = Math.ceil(filteredNodes.length / pageSize) || 1;
  const paginatedNodes = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredNodes.slice(start, start + pageSize);
  }, [filteredNodes, currentPage, pageSize]);

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [selectedCountry, selectedProtocol, selectedSecurity, onlyLowLatency, searchQuery]);

  const countryTabs = [
    { code: 'ALL', label: '全部国家/地区' },
    { code: 'HK', label: '🇭🇰 香港' },
    { code: 'JP', label: '🇯🇵 日本' },
    { code: 'US', label: '🇺🇸 美国' },
    { code: 'SG', label: '🇸🇬 新加坡' },
    { code: 'TW', label: '🇹🇼 台湾' },
    { code: 'KR', label: '🇰🇷 韩国' },
    { code: 'DE', label: '🇩🇪 德国' },
    { code: 'GB', label: '🇬🇧 英国' },
    { code: 'NL', label: '🇳🇱 荷兰' },
    { code: 'CA', label: '🇨🇦 加拿大' }
  ];

  return (
    <div className="space-y-8 pb-20">
      {/* 顶部导航与品牌标头 */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-5 border-b border-slate-800/80 pb-6">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-cyan-400 mb-1.5">
            <Link href="/admin" className="hover:text-cyan-300 transition-colors">控制台</Link>
            <span className="text-slate-600">/</span>
            <span className="text-slate-300">全球节点与订阅中枢</span>
            <span className="bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 text-[10px] px-2 py-0.5 rounded-full font-mono">
              v2.0 增强版
            </span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white flex items-center gap-3">
            <Globe className="w-8 h-8 text-cyan-400 animate-pulse shrink-0" />
            全球海量订阅通道与公开节点中枢
          </h1>
          <p className="text-slate-400 text-sm mt-1.5 max-w-3xl leading-relaxed">
            完整复刻 GitHub <span className="text-cyan-400 font-mono font-medium">Hidashimora/free-vpn-anti-rkn</span> 开源拓扑体系。覆盖 34 大分类通道、超 12.6 万+ 去重唯一节点，内建 TLS/Reality 强加密审计与全客户端即插即用配置。
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap shrink-0">
          <button
            onClick={handleCopyMasterSub}
            className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-cyan-500/20 to-indigo-500/20 hover:from-cyan-500/30 hover:to-indigo-500/30 border border-cyan-500/30 rounded-xl text-cyan-300 text-sm font-semibold transition-all shadow-lg hover:shadow-cyan-500/10 active:scale-95"
          >
            {copiedSub ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4 text-cyan-400" />}
            {copiedSub ? '已复制聚合订阅' : '📋 复制聚合订阅 (sub.txt)'}
          </button>

          <button
            onClick={loadData}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl text-slate-200 text-sm font-medium transition-all active:scale-95 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-cyan-400' : ''}`} />
            {loading ? '正在同步数据...' : '刷新本地元数据'}
          </button>
        </div>
      </div>

      {/* 核心指标统计横幅 */}
      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-5 rounded-2xl bg-gradient-to-br from-slate-900/90 to-slate-900/40 border border-slate-800/80 backdrop-blur-xl shadow-lg relative overflow-hidden group hover:border-cyan-500/30 transition-all">
          <div className="absolute top-0 right-0 w-24 h-24 bg-cyan-500/5 rounded-full blur-2xl group-hover:bg-cyan-500/10 transition-all" />
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium mb-2">
            <span className="flex items-center gap-1.5"><Server className="w-3.5 h-3.5 text-cyan-400" /> 全网唯一节点总数</span>
          </div>
          <div className="text-3xl font-extrabold text-white tracking-tight">
            {meta?.total_unique_nodes ? Number(meta.total_unique_nodes).toLocaleString() : '126,701'}
            <span className="text-xs text-slate-400 font-normal ml-1.5">个</span>
          </div>
          <div className="text-[11px] text-cyan-400/80 mt-1 font-mono">112 个高可用通道全量去重</div>
        </div>

        <div className="p-5 rounded-2xl bg-gradient-to-br from-slate-900/90 to-slate-900/40 border border-slate-800/80 backdrop-blur-xl shadow-lg relative overflow-hidden group hover:border-emerald-500/30 transition-all">
          <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-500/5 rounded-full blur-2xl group-hover:bg-emerald-500/10 transition-all" />
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium mb-2">
            <span className="flex items-center gap-1.5"><Layers className="w-3.5 h-3.5 text-emerald-400" /> 订阅通道大厅</span>
          </div>
          <div className="text-3xl font-extrabold text-emerald-400 tracking-tight">
            {meta?.total_channels ?? 34}
            <span className="text-xs text-slate-400 font-normal ml-1.5">大主类 / 110+ 细分</span>
          </div>
          <div className="text-[11px] text-emerald-400/80 mt-1 font-mono">直通 Caddy 高速 CDN 静态服务</div>
        </div>

        <div className="p-5 rounded-2xl bg-gradient-to-br from-slate-900/90 to-slate-900/40 border border-slate-800/80 backdrop-blur-xl shadow-lg relative overflow-hidden group hover:border-amber-500/30 transition-all">
          <div className="absolute top-0 right-0 w-24 h-24 bg-amber-500/5 rounded-full blur-2xl group-hover:bg-amber-500/10 transition-all" />
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium mb-2">
            <span className="flex items-center gap-1.5"><Zap className="w-3.5 h-3.5 text-amber-400" /> 精选在线池</span>
          </div>
          <div className="text-3xl font-extrabold text-amber-400 tracking-tight">
            {nodes.length ? nodes.length.toLocaleString() : '2,455'}
            <span className="text-xs text-slate-400 font-normal ml-1.5">个即用</span>
          </div>
          <div className="text-[11px] text-amber-400/80 mt-1 font-mono">港日美新等低延迟优选</div>
        </div>

        <div className="p-5 rounded-2xl bg-gradient-to-br from-slate-900/90 to-slate-900/40 border border-slate-800/80 backdrop-blur-xl shadow-lg relative overflow-hidden group hover:border-purple-500/30 transition-all">
          <div className="absolute top-0 right-0 w-24 h-24 bg-purple-500/5 rounded-full blur-2xl group-hover:bg-purple-500/10 transition-all" />
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium mb-2">
            <span className="flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5 text-purple-400" /> 安全审计引擎</span>
          </div>
          <div className="text-sm font-bold text-purple-300 mt-1 flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
            Reality / TLS 强加密
          </div>
          <div className="text-[11px] text-slate-400 mt-1 font-mono">88%+ 节点支持防指纹/防阻断</div>
        </div>
      </div>

      {/* 顶级三栏 Tab 控制台 */}
      <div className="border-b border-slate-800 flex items-center gap-2 overflow-x-auto pb-1">
        <button
          onClick={() => setActiveTab('channels')}
          className={`flex items-center gap-2 px-5 py-3 rounded-xl font-semibold text-sm transition-all whitespace-nowrap ${
            activeTab === 'channels'
              ? 'bg-cyan-500 text-slate-950 shadow-lg shadow-cyan-500/20'
              : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
          }`}
        >
          <Layers className="w-4 h-4" />
          34 大专属订阅通道大厅
          <span className={`text-[11px] px-2 py-0.5 rounded-full font-mono font-bold ${
            activeTab === 'channels' ? 'bg-slate-950 text-cyan-400' : 'bg-slate-800 text-slate-400'
          }`}>
            {channels.length}
          </span>
        </button>

        <button
          onClick={() => setActiveTab('nodes')}
          className={`flex items-center gap-2 px-5 py-3 rounded-xl font-semibold text-sm transition-all whitespace-nowrap ${
            activeTab === 'nodes'
              ? 'bg-cyan-500 text-slate-950 shadow-lg shadow-cyan-500/20'
              : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
          }`}
        >
          <Search className="w-4 h-4" />
          海量节点在线检索与审计
          <span className={`text-[11px] px-2 py-0.5 rounded-full font-mono font-bold ${
            activeTab === 'nodes' ? 'bg-slate-950 text-cyan-400' : 'bg-slate-800 text-slate-400'
          }`}>
            {filteredNodes.length}
          </span>
        </button>

        <button
          onClick={() => setActiveTab('clients')}
          className={`flex items-center gap-2 px-5 py-3 rounded-xl font-semibold text-sm transition-all whitespace-nowrap ${
            activeTab === 'clients'
              ? 'bg-cyan-500 text-slate-950 shadow-lg shadow-cyan-500/20'
              : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
          }`}
        >
          <Laptop className="w-4 h-4" />
          客户端接入与订阅指引
        </button>
      </div>

      {/* ========================================================================= */}
      {/* TAB 1: 34 大专属订阅通道大厅 */}
      {/* ========================================================================= */}
      {activeTab === 'channels' && (
        <div className="space-y-6">
          {/* 通道筛选与搜索栏 */}
          <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800/80 backdrop-blur-xl flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-slate-400 font-medium flex items-center gap-1 mr-1">
                <Filter className="w-3.5 h-3.5 text-cyan-400" /> 分类过滤:
              </span>
              <button
                onClick={() => setChannelFilter('all')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  channelFilter === 'all'
                    ? 'bg-cyan-500 text-slate-950 shadow-sm'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
              >
                全部通道
              </button>
              <button
                onClick={() => setChannelFilter('recommended')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
                  channelFilter === 'recommended'
                    ? 'bg-amber-500 text-slate-950 shadow-sm'
                    : 'bg-amber-500/10 text-amber-300 border border-amber-500/30 hover:bg-amber-500/20'
                }`}
              >
                <Star className="w-3 h-3 fill-current" />
                🌟 推荐核心 (1,6,22~34)
              </button>
              <button
                onClick={() => setChannelFilter('obhod')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
                  channelFilter === 'obhod'
                    ? 'bg-purple-500 text-slate-950 shadow-sm'
                    : 'bg-purple-500/10 text-purple-300 border border-purple-500/30 hover:bg-purple-500/20'
                }`}
              >
                <Unlock className="w-3 h-3" />
                🔓 突破封锁 (26~34)
              </button>
              <button
                onClick={() => setChannelFilter('blacklist')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
                  channelFilter === 'blacklist'
                    ? 'bg-zinc-300 text-slate-950 shadow-sm'
                    : 'bg-slate-800 text-slate-300 border border-slate-700 hover:bg-slate-700'
                }`}
              >
                <Lock className="w-3 h-3" />
                ⛔ 增强黑名单 (27~29)
              </button>
              <button
                onClick={() => setChannelFilter('whitelist')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
                  channelFilter === 'whitelist'
                    ? 'bg-sky-500 text-slate-950 shadow-sm'
                    : 'bg-sky-500/10 text-sky-300 border border-sky-500/30 hover:bg-sky-500/20'
                }`}
              >
                <Shield className="w-3 h-3" />
                🛡️ 权威白名单 (26,30~34)
              </button>
              <button
                onClick={() => setChannelFilter('full')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
                  channelFilter === 'full'
                    ? 'bg-rose-500 text-slate-950 shadow-sm'
                    : 'bg-rose-500/10 text-rose-300 border border-rose-500/30 hover:bg-rose-500/20'
                }`}
              >
                📦 全量大通道
              </button>
            </div>

            <div className="relative w-full md:w-64">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="搜索通道名称或编号..."
                value={channelSearch}
                onChange={(e) => setChannelSearch(e.target.value)}
                className="w-full bg-slate-800/80 border border-slate-700 rounded-xl pl-9 pr-3 py-1.5 text-xs text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500 transition-colors"
              />
            </div>
          </div>

          {/* 通道卡片列表 */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
            {filteredChannels.map((ch) => (
              <div
                key={ch.major_num}
                className="rounded-2xl bg-gradient-to-br from-slate-900/90 to-slate-950/70 border border-slate-800/80 hover:border-cyan-500/30 p-6 flex flex-col justify-between transition-all group shadow-xl hover:shadow-cyan-500/5"
              >
                <div>
                  {/* 卡片顶部：编号与标签 */}
                  <div className="flex items-start justify-between gap-3 mb-4">
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-cyan-500/20 to-indigo-500/20 border border-cyan-500/30 flex items-center justify-center text-cyan-300 font-extrabold text-xl font-mono shadow-inner">
                        {ch.major_num}
                      </div>
                      <div>
                        <h3 className="text-base font-bold text-white group-hover:text-cyan-300 transition-colors">
                          {ch.title}
                        </h3>
                        <span className="text-xs text-slate-400 font-mono">
                          {ch.name}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-1 shrink-0">
                      {ch.is_recommended && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30">
                          🌟 推荐
                        </span>
                      )}
                      {ch.is_obhod && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-400 border border-purple-500/30">
                          🔓 突破封锁
                        </span>
                      )}
                      {ch.is_whitelist && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-400 border border-sky-500/30">
                          🛡️ 白名单
                        </span>
                      )}
                      {ch.is_blacklist && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-300 border border-zinc-700">
                          ⛔ 黑名单
                        </span>
                      )}
                    </div>
                  </div>

                  <p className="text-xs text-slate-400 leading-relaxed mb-4">
                    {ch.description}
                  </p>

                  {/* 变体版本 (短/精选 vs 全量) */}
                  <div className="space-y-2 mb-4 bg-slate-950/60 p-3 rounded-xl border border-slate-800/80">
                    <div className="text-[11px] font-medium text-slate-400 mb-1.5 flex items-center justify-between">
                      <span>包含细分通道:</span>
                      <span className="text-slate-500 text-[10px] font-mono">点击直接复制</span>
                    </div>

                    {ch.variants.map((v) => (
                      <div
                        key={v.id}
                        className="flex items-center justify-between gap-2 p-2 rounded-lg bg-slate-900/80 hover:bg-slate-800/80 border border-slate-800/60 transition-colors"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`text-[11px] font-mono px-1.5 py-0.5 rounded font-bold ${
                            v.is_short ? 'bg-cyan-500/20 text-cyan-300' : 'bg-rose-500/20 text-rose-300'
                          }`}>
                            {v.id}
                          </span>
                          <span className="text-xs text-slate-200 truncate">
                            {v.is_short ? '精选短通道 (低负荷推荐)' : '全量大通道 (节点众多)'}
                          </span>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className="text-[11px] font-mono text-slate-400 font-semibold mr-1">
                            {v.node_count.toLocaleString()} 节点
                          </span>

                          <button
                            onClick={() => handleCopy(v.id, v.raw_url)}
                            title="复制订阅 URL"
                            className="p-1 text-slate-400 hover:text-cyan-400 hover:bg-slate-700/60 rounded-md transition-colors"
                          >
                            {copiedId === v.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>

                          <button
                            onClick={() => handleOpenQr(`通道 ${v.id}`, `${ch.title} (${v.node_count} 节点)`, v.raw_url, v.is_short ? '精选通道' : '全量通道')}
                            title="查看手机订阅二维码"
                            className="p-1 text-slate-400 hover:text-cyan-400 hover:bg-slate-700/60 rounded-md transition-colors"
                          >
                            <QrCode className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 底部主按钮 */}
                <div className="flex items-center gap-2 pt-2 border-t border-slate-800/60">
                  {ch.variants[0] && (
                    <button
                      onClick={() => handleCopy(`main-${ch.major_num}`, ch.variants[0].raw_url)}
                      className="flex-1 py-2 px-3 rounded-xl bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 text-cyan-300 text-xs font-semibold flex items-center justify-center gap-1.5 transition-all"
                    >
                      {copiedId === `main-${ch.major_num}` ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      {copiedId === `main-${ch.major_num}` ? '已复制订阅链接' : `复制默认订阅 (${ch.variants[0].id})`}
                    </button>
                  )}

                  <a
                    href={ch.variants[0]?.raw_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
                    title="新窗口查看原始订阅文件"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </a>
                </div>
              </div>
            ))}
          </div>

          {filteredChannels.length === 0 && (
            <div className="text-center py-16 bg-slate-900/40 rounded-2xl border border-dashed border-slate-800">
              <Layers className="w-12 h-12 text-slate-600 mx-auto mb-3" />
              <p className="text-slate-400 text-sm">未找到匹配的订阅通道</p>
              <button
                onClick={() => { setChannelFilter('all'); setChannelSearch(''); }}
                className="mt-3 text-xs text-cyan-400 hover:underline"
              >
                重置筛选条件
              </button>
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 2: 海量单节点在线检索与安全审计 */}
      {/* ========================================================================= */}
      {activeTab === 'nodes' && (
        <div className="space-y-6">
          {/* 筛选与搜索控制器 */}
          <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800/80 backdrop-blur-xl space-y-5 shadow-lg">
            {/* 搜索框与状态 */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="relative flex-1">
                <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  placeholder="搜索服务器地址、域名、国家或备注..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-slate-950/80 border border-slate-700/80 rounded-xl pl-10 pr-4 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-colors"
                />
              </div>

              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none bg-slate-800/60 px-3 py-2 rounded-xl border border-slate-700/60 hover:bg-slate-800 transition-colors">
                  <input
                    type="checkbox"
                    checked={onlyLowLatency}
                    onChange={(e) => setOnlyLowLatency(e.target.checked)}
                    className="rounded border-slate-700 bg-slate-900 text-cyan-500 focus:ring-cyan-500 w-3.5 h-3.5"
                  />
                  <span>⚡ 仅看超低延迟 (&lt;100ms)</span>
                </label>
              </div>
            </div>

            {/* 安全等级筛选 */}
            <div className="flex items-center gap-2 flex-wrap text-sm border-t border-slate-800/60 pt-4">
              <span className="text-slate-400 flex items-center gap-1 font-medium mr-1 text-xs">
                <Shield className="w-3.5 h-3.5 text-cyan-400" /> 安全审计:
              </span>
              <button
                onClick={() => setSelectedSecurity('ALL')}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
                  selectedSecurity === 'ALL' ? 'bg-cyan-500 text-slate-950' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
              >
                全部评级
              </button>
              <button
                onClick={() => setSelectedSecurity('safe')}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
                  selectedSecurity === 'safe'
                    ? 'bg-emerald-500 text-slate-950'
                    : 'bg-emerald-950/40 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-900/40'
                }`}
              >
                🟢 推荐安全 (Reality/TLS/Hy2)
              </button>
              <button
                onClick={() => setSelectedSecurity('medium')}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
                  selectedSecurity === 'medium'
                    ? 'bg-sky-500 text-slate-950'
                    : 'bg-sky-950/40 text-sky-400 border border-sky-500/30 hover:bg-sky-900/40'
                }`}
              >
                ☁️ Shadowsocks / 传输层中继
              </button>
              <button
                onClick={() => setSelectedSecurity('warning')}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
                  selectedSecurity === 'warning'
                    ? 'bg-amber-500 text-slate-950'
                    : 'bg-amber-950/40 text-amber-400 border border-amber-500/30 hover:bg-amber-900/40'
                }`}
              >
                ⚠️ 明文/无TLS传输 (提示免流)
              </button>
            </div>

            {/* 国家地区筛选 */}
            <div className="flex items-center gap-2 flex-wrap text-sm border-t border-slate-800/60 pt-4">
              <span className="text-slate-400 flex items-center gap-1 font-medium mr-1 text-xs">
                <Globe className="w-3.5 h-3.5 text-cyan-400" /> 目标地区:
              </span>
              {countryTabs.map((c) => (
                <button
                  key={c.code}
                  onClick={() => setSelectedCountry(c.code)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                    selectedCountry === c.code
                      ? 'bg-cyan-500 text-slate-950 font-bold shadow-md shadow-cyan-500/20'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>

            {/* 协议筛选 */}
            <div className="flex items-center gap-3 flex-wrap text-sm border-t border-slate-800/60 pt-4">
              <span className="text-slate-400 text-xs font-medium">协议类型:</span>
              {['ALL', 'vless', 'trojan', 'hy2', 'ss', 'vmess'].map((p) => (
                <button
                  key={p}
                  onClick={() => setSelectedProtocol(p)}
                  className={`px-3 py-1 rounded-lg text-xs font-mono font-bold uppercase transition-all ${
                    selectedProtocol === p
                      ? 'bg-indigo-500 text-white shadow-md shadow-indigo-500/20'
                      : 'bg-slate-800/80 text-slate-400 hover:bg-slate-700 hover:text-slate-200'
                  }`}
                >
                  {p === 'ALL' ? '全部协议' : p}
                </button>
              ))}

              <div className="ml-auto text-xs text-slate-400 font-mono">
                检索到 <span className="text-cyan-400 font-bold">{filteredNodes.length.toLocaleString()}</span> 条可用节点
              </div>
            </div>
          </div>

          {/* 节点网格卡片 */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {paginatedNodes.map((node) => (
              <div
                key={node.id}
                className={`p-5 rounded-2xl bg-gradient-to-br from-slate-900/80 to-slate-950/60 border transition-all flex flex-col justify-between group shadow-lg ${
                  node.security_level === 'danger' ? 'border-rose-500/40 bg-rose-950/10' :
                  node.security_level === 'warning' ? 'border-amber-500/30 hover:border-amber-500/50' :
                  'border-slate-800/80 hover:border-cyan-500/30'
                }`}
              >
                <div>
                  {/* 头部：国旗、协议与延迟 */}
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-slate-800 text-slate-200 border border-slate-700/60 flex items-center gap-1.5">
                      <span>{node.country_flag}</span>
                      <span>{node.country_name}</span>
                    </span>

                    <div className="flex items-center gap-2">
                      <span className={`text-[11px] px-2 py-0.5 rounded font-mono uppercase font-bold ${
                        node.protocol === 'vless' ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30' :
                        node.protocol === 'trojan' ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30' :
                        node.protocol === 'hy2' ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30' :
                        node.protocol === 'ss' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' :
                        'bg-slate-800 text-slate-300'
                      }`}>
                        {node.protocol}
                      </span>

                      <span className="text-[11px] px-2 py-0.5 rounded-full font-mono flex items-center gap-1 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                        {node.latency_ms}ms
                      </span>
                    </div>
                  </div>

                  {/* 安全标签徽章 */}
                  <div className="mb-2.5">
                    <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-lg border ${
                      node.security_level === 'safe' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                      node.security_level === 'medium' ? 'bg-sky-500/10 text-sky-400 border-sky-500/20' :
                      'bg-amber-500/10 text-amber-400 border-amber-500/20'
                    }`}>
                      {node.security_tag}
                    </span>
                  </div>

                  <h3 className="text-sm font-semibold text-slate-100 line-clamp-1 mb-1" title={node.name}>
                    {node.name}
                  </h3>
                  <p className="text-xs text-slate-400 font-mono truncate mb-2">
                    {node.host}:{node.port}
                  </p>

                  {/* 审计说明 */}
                  <p className="text-[11px] text-slate-400 bg-slate-950/70 p-2.5 rounded-lg border border-slate-800/80 leading-relaxed mb-4">
                    {node.security_reason}
                  </p>
                </div>

                {/* 底部操作按键 */}
                <div className="flex items-center gap-2 pt-3 border-t border-slate-800/60">
                  <button
                    onClick={() => handleCopy(node.id, node.link)}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 bg-slate-800/90 hover:bg-slate-700/90 rounded-xl text-xs text-slate-200 font-medium transition-all"
                  >
                    {copiedId === node.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedId === node.id ? '已复制节点链接' : '复制单节点'}
                  </button>

                  <button
                    onClick={() => handleOpenQr(node.name, `${node.country_name} · ${node.protocol.toUpperCase()} · ${node.latency_ms}ms`, node.link, node.security_tag)}
                    className="p-2 bg-slate-800/90 hover:bg-slate-700/90 rounded-xl text-slate-300 hover:text-cyan-400 transition-all"
                    title="查看扫码导入二维码"
                  >
                    <QrCode className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* 分页控制器 */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between gap-4 p-4 rounded-2xl bg-slate-900/60 border border-slate-800/80 mt-6">
              <div className="text-xs text-slate-400 font-mono">
                第 <span className="text-cyan-400 font-bold">{currentPage}</span> / {totalPages} 页 (共 {filteredNodes.length.toLocaleString()} 条)
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="px-3 py-1.5 rounded-xl bg-slate-800 text-slate-200 text-xs font-semibold hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-slate-800 transition-colors flex items-center gap-1"
                >
                  <ChevronLeft className="w-3.5 h-3.5" /> 上一页
                </button>

                <div className="hidden sm:flex items-center gap-1">
                  {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                    let pageNum = i + 1;
                    if (currentPage > 3 && totalPages > 5) {
                      pageNum = Math.min(totalPages - 4 + i, Math.max(1, currentPage - 2 + i));
                    }
                    return (
                      <button
                        key={pageNum}
                        onClick={() => setCurrentPage(pageNum)}
                        className={`w-8 h-8 rounded-lg text-xs font-mono font-bold transition-all ${
                          currentPage === pageNum
                            ? 'bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/20'
                            : 'text-slate-400 hover:text-white hover:bg-slate-800'
                        }`}
                      >
                        {pageNum}
                      </button>
                    );
                  })}
                </div>

                <button
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="px-3 py-1.5 rounded-xl bg-slate-800 text-slate-200 text-xs font-semibold hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-slate-800 transition-colors flex items-center gap-1"
                >
                  下一页 <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          {filteredNodes.length === 0 && (
            <div className="text-center py-16 bg-slate-900/40 rounded-2xl border border-dashed border-slate-800">
              <Server className="w-12 h-12 text-slate-600 mx-auto mb-3" />
              <p className="text-slate-400 text-sm">未检索到符合条件的节点</p>
              <button
                onClick={() => {
                  setSelectedCountry('ALL');
                  setSelectedProtocol('ALL');
                  setSelectedSecurity('ALL');
                  setOnlyLowLatency(false);
                  setSearchQuery('');
                }}
                className="mt-3 text-xs text-cyan-400 hover:underline"
              >
                重置所有筛选参数
              </button>
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 3: 客户端接入与订阅指引 */}
      {/* ========================================================================= */}
      {activeTab === 'clients' && (
        <div className="space-y-6">
          {/* 聚合核心卡片 */}
          <div className="p-6 sm:p-8 rounded-3xl bg-gradient-to-br from-indigo-950/40 via-slate-900/80 to-slate-950/90 border border-indigo-500/30 backdrop-blur-xl shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 right-0 w-80 h-80 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />

            <div className="max-w-2xl">
              <span className="text-xs font-bold uppercase tracking-wider text-indigo-400 bg-indigo-500/10 px-3 py-1 rounded-full border border-indigo-500/20 inline-block mb-3">
                一键全局聚合订阅源
              </span>
              <h2 className="text-xl sm:text-2xl font-bold text-white mb-2">
                推荐客户端聚合订阅链接
              </h2>
              <p className="text-slate-300 text-sm leading-relaxed mb-5">
                此订阅汇总了全网经过传输层 TLS/Reality 强加密审计的低延迟优质节点，支持主流跨平台客户端直接订阅解析：
              </p>

              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 bg-slate-950/80 p-2.5 rounded-2xl border border-slate-800 mb-5">
                <input
                  type="text"
                  readOnly
                  value="https://blog.monsterai.us.kg/configs/sub.txt"
                  className="flex-1 bg-transparent px-3 py-1 text-xs font-mono text-cyan-300 outline-none select-all"
                />
                <button
                  onClick={handleCopyMasterSub}
                  className="px-4 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold transition-colors flex items-center justify-center gap-1.5 shadow-lg shadow-cyan-500/20"
                >
                  {copiedSub ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedSub ? '已复制' : '复制订阅'}
                </button>
                <button
                  onClick={() => handleOpenQr('全网聚合订阅', 'sub.txt (精选 250+ 高速节点)', 'https://blog.monsterai.us.kg/configs/sub.txt', '全局聚合')}
                  className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition-colors flex items-center justify-center gap-1.5"
                >
                  <QrCode className="w-3.5 h-3.5 text-cyan-400" />
                  <span>扫码</span>
                </button>
              </div>

              <div className="flex flex-wrap gap-2 text-xs text-slate-400">
                <span className="flex items-center gap-1"><Check className="w-3.5 h-3.5 text-emerald-400" /> 零广告免注册</span>
                <span className="flex items-center gap-1"><Check className="w-3.5 h-3.5 text-emerald-400" /> Caddy HTTP/2 极速分发</span>
                <span className="flex items-center gap-1"><Check className="w-3.5 h-3.5 text-emerald-400" /> 防 DNS 污染泄漏</span>
              </div>
            </div>
          </div>

          {/* 常用客户端使用步骤指南 */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800/80 hover:border-slate-700 transition-all flex flex-col justify-between">
              <div>
                <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 flex items-center justify-center font-bold mb-3">
                  <Laptop className="w-5 h-5" />
                </div>
                <h3 className="text-base font-bold text-white mb-1">Clash Verge Rev</h3>
                <span className="text-xs text-cyan-400/80 font-mono block mb-3">Windows / macOS / Linux</span>
                <ol className="text-xs text-slate-400 space-y-2 list-decimal list-inside leading-relaxed">
                  <li>打开软件进入「订阅配置」页面。</li>
                  <li>点击「新建」并粘贴上方的订阅链接。</li>
                  <li>保存并右键点击「更新」。</li>
                  <li>切换至「代理」面板选择节点并开启系统代理。</li>
                </ol>
              </div>
            </div>

            <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800/80 hover:border-slate-700 transition-all flex flex-col justify-between">
              <div>
                <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/20 text-purple-400 flex items-center justify-center font-bold mb-3">
                  <Smartphone className="w-5 h-5" />
                </div>
                <h3 className="text-base font-bold text-white mb-1">Shadowrocket (小火箭)</h3>
                <span className="text-xs text-purple-400/80 font-mono block mb-3">iOS / iPadOS</span>
                <ol className="text-xs text-slate-400 space-y-2 list-decimal list-inside leading-relaxed">
                  <li>点击右上角「+」号添加节点。</li>
                  <li>类型选择「Subscribe」并粘贴订阅 URL。</li>
                  <li>或者直接点击上方「扫码」图标，相机一键扫码。</li>
                  <li>在主界面按延迟测速并连接。</li>
                </ol>
              </div>
            </div>

            <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800/80 hover:border-slate-700 transition-all flex flex-col justify-between">
              <div>
                <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center font-bold mb-3">
                  <Radio className="w-5 h-5" />
                </div>
                <h3 className="text-base font-bold text-white mb-1">Sing-box / Hiddify</h3>
                <span className="text-xs text-amber-400/80 font-mono block mb-3">全平台通用新一代核心</span>
                <ol className="text-xs text-slate-400 space-y-2 list-decimal list-inside leading-relaxed">
                  <li>进入 Profiles / 新建配置文件。</li>
                  <li>选择 Remote Config 并填入订阅 URL。</li>
                  <li>支持 VLESS Reality 与 Hysteria2 原生低丢包传输。</li>
                  <li>启动 VPN 模式即可无缝分流。</li>
                </ol>
              </div>
            </div>

            <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800/80 hover:border-slate-700 transition-all flex flex-col justify-between">
              <div>
                <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold mb-3">
                  <Server className="w-5 h-5" />
                </div>
                <h3 className="text-base font-bold text-white mb-1">v2rayN / v2rayNG</h3>
                <span className="text-xs text-emerald-400/80 font-mono block mb-3">Windows / Android</span>
                <ol className="text-xs text-slate-400 space-y-2 list-decimal list-inside leading-relaxed">
                  <li>点击顶部「订阅分组」-&gt;「订阅分组设置」。</li>
                  <li>点击「添加」并填入可选通道订阅地址。</li>
                  <li>点击「订阅」-&gt;「更新全部订阅 (不通过代理)」。</li>
                  <li>按 Ctrl+R 批量测试真连接延迟。</li>
                </ol>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 二维码弹窗 */}
      {qrModalInfo && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 max-w-sm w-full relative shadow-2xl animate-in fade-in zoom-in-95 duration-200">
            <button
              onClick={() => setQrModalInfo(null)}
              className="absolute top-4 right-4 text-slate-400 hover:text-white p-1 rounded-full bg-slate-800/80 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="text-center">
              <h3 className="text-base font-bold text-white mb-1 line-clamp-1">
                {qrModalInfo.title}
              </h3>
              <p className="text-xs text-slate-400 mb-3 truncate">
                {qrModalInfo.subtitle}
              </p>

              {qrModalInfo.tag && (
                <div className="mb-4">
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                    {qrModalInfo.tag}
                  </span>
                </div>
              )}

              {qrCodeDataUrl && (
                <div className="p-3 bg-white rounded-2xl inline-block shadow-inner mb-4">
                  <img src={qrCodeDataUrl} alt="QR Code" className="w-52 h-52" />
                </div>
              )}

              <p className="text-[11px] text-slate-400 mb-4">
                手机 Shadowrocket / v2rayNG 打开相机扫码自动识别
              </p>

              <button
                onClick={() => handleCopy('modal-qr', qrModalInfo.link)}
                className="w-full py-2.5 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold rounded-xl text-xs flex items-center justify-center gap-2 transition-all active:scale-98"
              >
                {copiedId === 'modal-qr' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copiedId === 'modal-qr' ? '已复制原始链接' : '复制原始链接到剪贴板'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
