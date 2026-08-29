'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { 
  Globe, 
  RefreshCw, 
  Copy, 
  Check, 
  Zap, 
  ShieldCheck, 
  Server, 
  Wifi, 
  Filter, 
  QrCode,
  X,
  ShieldAlert,
  Shield,
  AlertTriangle,
  Info
} from 'lucide-react';
import QRCode from 'qrcode';
import { fetchWithAuth } from '@/lib/api';

interface ProxyNode {
  id: string;
  name: string;
  protocol: string;
  host: string;
  port: number;
  latency_ms: number | null;
  link: string;
  country: string;
  is_alive: boolean;
  security_level: 'safe' | 'medium' | 'warning' | 'danger';
  security_tag: string;
  security_reason: string;
}

interface FetchResponse {
  total_fetched: number;
  total_alive: number;
  avg_latency_ms: number;
  nodes: ProxyNode[];
  updated_at: string;
}

export default function AdminNodesPage() {
  const [data, setData] = useState<FetchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedSub, setCopiedSub] = useState(false);
  const [selectedCountry, setSelectedCountry] = useState('ALL');
  const [selectedProtocol, setSelectedProtocol] = useState('ALL');
  const [selectedSecurity, setSelectedSecurity] = useState('ALL');
  const [onlyLowLatency, setOnlyLowLatency] = useState(false);
  const [qrModalNode, setQrModalNode] = useState<ProxyNode | null>(null);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string>('');

  const fetchNodes = async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth('/nodes/fetch');
      if (res.ok) {
        const json = await res.json();
        if (json.data) {
          setData(json.data);
        }
      }
    } catch (e) {
      console.error('Failed to fetch nodes', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchNodes();
  }, []);

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleCopySub = () => {
    const subUrl = 'https://blog.monsterai.us.kg/api/v1/nodes/sub';
    navigator.clipboard.writeText(subUrl);
    setCopiedSub(true);
    setTimeout(() => setCopiedSub(false), 2000);
  };

  const handleOpenQr = async (node: ProxyNode) => {
    setQrModalNode(node);
    try {
      const url = await QRCode.toDataURL(node.link, {
        width: 300,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#ffffff'
        }
      });
      setQrCodeDataUrl(url);
    } catch (err) {
      console.error(err);
    }
  };

  const filteredNodes = (data?.nodes || []).filter((node) => {
    if (selectedCountry !== 'ALL' && !node.country.includes(selectedCountry)) {
      return false;
    }
    if (selectedProtocol !== 'ALL' && node.protocol.toLowerCase() !== selectedProtocol.toLowerCase()) {
      return false;
    }
    if (selectedSecurity !== 'ALL' && node.security_level !== selectedSecurity) {
      return false;
    }
    if (onlyLowLatency && (!node.is_alive || (node.latency_ms && node.latency_ms > 300))) {
      return false;
    }
    return true;
  });

  const countries = ['ALL', '香港', '日本', '新加坡', '美国', '加拿大', '荷兰', '德国', '英国', '台湾', '韩国', '法国', '土耳其', '瑞典', '芬兰', '俄罗斯'];
  const protocols = ['ALL', 'vless', 'trojan', 'hysteria2', 'ss', 'vmess'];

  return (
    <div className="space-y-8 pb-16">
      {/* 顶部导航与操作栏 */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800/80 pb-6">
        <div>
          <div className="flex items-center gap-2 text-sm text-cyan-400 mb-1">
            <Link href="/admin" className="hover:underline">控制台</Link>
            <span>/</span>
            <span>节点中枢</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white flex items-center gap-3">
            <Globe className="w-8 h-8 text-cyan-400 animate-pulse" />
            全球公开节点智能抓取与安全审计
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            全自动从 21 个 GitHub 顶级开源源聚合，内置传输层加密审计与防钓鱼蜜罐智能识别。
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={handleCopySub}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/30 rounded-xl text-indigo-300 text-sm font-medium transition-all shadow-lg"
          >
            {copiedSub ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
            {copiedSub ? '已复制专属订阅' : '📋 复制聚合订阅 URL'}
          </button>

          <button
            onClick={fetchNodes}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-cyan-500 to-indigo-600 hover:from-cyan-400 hover:to-indigo-500 disabled:opacity-50 text-white text-sm font-semibold rounded-xl transition-all shadow-lg shadow-cyan-500/20"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            {loading ? '正在全网抓取并测速...' : '⚡ 重新抓取与测速'}
          </button>
        </div>
      </div>

      {/* 核心指标统计 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-5 rounded-2xl bg-slate-900/50 border border-slate-800/80 backdrop-blur-xl">
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium mb-2">
            <span>抓取总节点数</span>
            <Server className="w-4 h-4 text-cyan-400" />
          </div>
          <div className="text-2xl font-bold text-white">
            {data?.total_fetched ?? 0} <span className="text-xs text-slate-400 font-normal">个</span>
          </div>
        </div>

        <div className="p-5 rounded-2xl bg-slate-900/50 border border-slate-800/80 backdrop-blur-xl">
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium mb-2">
            <span>在线存活节点</span>
            <Wifi className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-bold text-emerald-400">
            {data?.total_alive ?? 0} <span className="text-xs text-slate-400 font-normal">个</span>
          </div>
        </div>

        <div className="p-5 rounded-2xl bg-slate-900/50 border border-slate-800/80 backdrop-blur-xl">
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium mb-2">
            <span>平均握手延迟</span>
            <Zap className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-2xl font-bold text-amber-400">
            {data?.avg_latency_ms ?? 0} <span className="text-xs text-slate-400 font-normal">ms</span>
          </div>
        </div>

        <div className="p-5 rounded-2xl bg-slate-900/50 border border-slate-800/80 backdrop-blur-xl">
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium mb-2">
            <span>安全审计引擎</span>
            <ShieldCheck className="w-4 h-4 text-purple-400" />
          </div>
          <div className="text-sm font-semibold text-emerald-400 mt-1 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            已启用全自动风控
          </div>
        </div>
      </div>

      {/* 筛选控制器 */}
      <div className="p-5 rounded-2xl bg-slate-900/40 border border-slate-800/80 space-y-4">
        {/* 安全等级快速标签 */}
        <div className="flex items-center gap-2 flex-wrap text-sm border-b border-slate-800/60 pb-3">
          <span className="text-slate-400 flex items-center gap-1 font-medium mr-1 text-xs">
            <Shield className="w-3.5 h-3.5 text-cyan-400" /> 安全评级:
          </span>
          <button
            onClick={() => setSelectedSecurity('ALL')}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
              selectedSecurity === 'ALL' ? 'bg-cyan-500 text-white' : 'bg-slate-800/60 text-slate-300 hover:bg-slate-700/60'
            }`}
          >
            全部评级
          </button>
          <button
            onClick={() => setSelectedSecurity('safe')}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
              selectedSecurity === 'safe' ? 'bg-emerald-500 text-white' : 'bg-emerald-950/40 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-900/40'
            }`}
          >
            🟢 推荐安全 (Reality/TLS/Hysteria2)
          </button>
          <button
            onClick={() => setSelectedSecurity('medium')}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
              selectedSecurity === 'medium' ? 'bg-sky-500 text-white' : 'bg-sky-950/40 text-sky-400 border border-sky-500/30 hover:bg-sky-900/40'
            }`}
          >
            ☁️ Cloudflare 中继
          </button>
          <button
            onClick={() => setSelectedSecurity('warning')}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
              selectedSecurity === 'warning' ? 'bg-amber-500 text-white' : 'bg-amber-950/40 text-amber-400 border border-amber-500/30 hover:bg-amber-900/40'
            }`}
          >
            ⚠️ 忽略校验/自签证书
          </button>
          <button
            onClick={() => setSelectedSecurity('danger')}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
              selectedSecurity === 'danger' ? 'bg-rose-500 text-white' : 'bg-rose-950/40 text-rose-400 border border-rose-500/30 hover:bg-rose-900/40'
            }`}
          >
            🔴 明文传输 (警惕抓包/蜜罐)
          </button>
        </div>

        {/* 地区与协议筛选 */}
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="flex items-center gap-2 flex-wrap text-sm">
            <span className="text-slate-400 flex items-center gap-1 font-medium mr-1 text-xs">
              <Filter className="w-3.5 h-3.5" /> 地区:
            </span>
            {countries.map((c) => (
              <button
                key={c}
                onClick={() => setSelectedCountry(c)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                  selectedCountry === c 
                    ? 'bg-cyan-500 text-white shadow-md shadow-cyan-500/20' 
                    : 'bg-slate-800/60 text-slate-300 hover:bg-slate-700/60'
                }`}
              >
                {c === 'ALL' ? '全部' : c}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-4 flex-wrap text-sm">
            <div className="flex items-center gap-1.5">
              <span className="text-slate-400 text-xs font-medium">协议:</span>
              <select
                value={selectedProtocol}
                onChange={(e) => setSelectedProtocol(e.target.value)}
                className="bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1 text-xs text-slate-200 outline-none focus:border-cyan-500"
              >
                {protocols.map((p) => (
                  <option key={p} value={p}>
                    {p === 'ALL' ? '全部协议' : p.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>

            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={onlyLowLatency}
                onChange={(e) => setOnlyLowLatency(e.target.checked)}
                className="rounded border-slate-700 bg-slate-800 text-cyan-500 focus:ring-cyan-500"
              />
              仅看极速节点 (&lt;300ms)
            </label>
          </div>
        </div>
      </div>

      {/* 节点网格卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredNodes.map((node) => (
          <div
            key={node.id}
            className={`p-5 rounded-2xl bg-slate-900/60 border transition-all flex flex-col justify-between group shadow-lg ${
              node.security_level === 'danger' ? 'border-rose-500/40 bg-rose-950/10' :
              node.security_level === 'warning' ? 'border-amber-500/40 bg-amber-950/10' :
              'border-slate-800/80 hover:border-slate-700'
            }`}
          >
            <div>
              {/* 顶部标签栏 */}
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700/60">
                  {node.country}
                </span>

                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2 py-0.5 rounded font-mono uppercase font-bold ${
                    node.protocol === 'vless' ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30' :
                    node.protocol === 'trojan' ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30' :
                    node.protocol.includes('hy') ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30' :
                    'bg-slate-800 text-slate-300'
                  }`}>
                    {node.protocol}
                  </span>

                  {node.is_alive ? (
                    <span className={`text-xs px-2 py-0.5 rounded-full font-mono flex items-center gap-1 ${
                      (node.latency_ms ?? 999) < 200 ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' :
                      (node.latency_ms ?? 999) < 450 ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' :
                      'bg-orange-500/10 text-orange-400 border border-orange-500/20'
                    }`}>
                      <span className="w-1.5 h-1.5 rounded-full bg-current animate-ping" />
                      {node.latency_ms}ms
                    </span>
                  ) : (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20">
                      不可用
                    </span>
                  )}
                </div>
              </div>

              {/* 安全等级徽章 */}
              <div className="mb-3">
                <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-lg border ${
                  node.security_level === 'safe' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                  node.security_level === 'medium' ? 'bg-sky-500/10 text-sky-400 border-sky-500/20' :
                  node.security_level === 'warning' ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' :
                  'bg-rose-500/10 text-rose-400 border-rose-500/20 animate-pulse'
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

              {/* 安全审计原因说明 */}
              <p className="text-[11px] text-slate-400/90 bg-slate-950/60 p-2 rounded-lg border border-slate-800/60 leading-relaxed mb-4">
                {node.security_reason}
              </p>
            </div>

            <div className="flex items-center gap-2 pt-3 border-t border-slate-800/60">
              <button
                onClick={() => handleCopy(node.id, node.link)}
                className="flex-1 flex items-center justify-center gap-1.5 py-1.5 px-3 bg-slate-800/80 hover:bg-slate-700/80 rounded-lg text-xs text-slate-200 font-medium transition-all"
              >
                {copiedId === node.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedId === node.id ? '已复制链接' : '复制节点'}
              </button>

              <button
                onClick={() => handleOpenQr(node)}
                className="p-1.5 bg-slate-800/80 hover:bg-slate-700/80 rounded-lg text-slate-300 hover:text-cyan-400 transition-all"
                title="查看导入二维码"
              >
                <QrCode className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {filteredNodes.length === 0 && !loading && (
        <div className="text-center py-16 bg-slate-900/30 rounded-2xl border border-slate-800/60">
          <Server className="w-12 h-12 text-slate-600 mx-auto mb-3" />
          <p className="text-slate-400 text-sm">未找到符合当前筛选条件的可用节点</p>
          <button
            onClick={() => { setSelectedCountry('ALL'); setSelectedProtocol('ALL'); setSelectedSecurity('ALL'); setOnlyLowLatency(false); }}
            className="mt-3 text-xs text-cyan-400 hover:underline"
          >
            重置所有筛选
          </button>
        </div>
      )}

      {/* 二维码弹窗 */}
      {qrModalNode && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 max-w-sm w-full relative shadow-2xl">
            <button
              onClick={() => setQrModalNode(null)}
              className="absolute top-4 right-4 text-slate-400 hover:text-white p-1 rounded-full bg-slate-800/60"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="text-center">
              <h3 className="text-base font-bold text-white mb-1">
                {qrModalNode.name}
              </h3>
              <p className="text-xs text-slate-400 mb-2">
                手机 Shadowrocket / V2Ray 客户端扫码导入
              </p>

              <div className="mb-3">
                <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-0.5 rounded-lg border ${
                  qrModalNode.security_level === 'safe' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                  qrModalNode.security_level === 'medium' ? 'bg-sky-500/10 text-sky-400 border-sky-500/20' :
                  qrModalNode.security_level === 'warning' ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' :
                  'bg-rose-500/10 text-rose-400 border-rose-500/20'
                }`}>
                  {qrModalNode.security_tag}
                </span>
              </div>

              {qrCodeDataUrl && (
                <div className="p-4 bg-white rounded-2xl inline-block shadow-inner mb-4">
                  <img src={qrCodeDataUrl} alt="QR Code" className="w-48 h-48" />
                </div>
              )}

              <button
                onClick={() => handleCopy(qrModalNode.id, qrModalNode.link)}
                className="w-full py-2.5 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold rounded-xl text-xs flex items-center justify-center gap-2 transition-all"
              >
                {copiedId === qrModalNode.id ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copiedId === qrModalNode.id ? '已复制链接到剪贴板' : '复制原始链接'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
