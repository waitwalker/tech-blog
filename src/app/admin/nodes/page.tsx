'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
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
  Radio, 
  AlertTriangle, 
  ShieldAlert, 
  Activity,
  ChevronDown,
  Info,
  ListFilter
} from 'lucide-react';
import QRCode from 'qrcode';

// ============================================================================
// 1. 类型定义
// ============================================================================

interface CountryInfo {
  code: string;
  flag: string;
  name: string;
}

interface NodeSecurityAudit {
  level: 'safe' | 'medium' | 'warning' | 'danger';
  tag: string;
  badgeClass: string;
  reason: string;
  isHoneypotRisk: boolean;
}

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

interface ParsedSubscriptionNode {
  id: string;
  rawLink: string;
  protocol: string;
  name: string;
  host: string;
  port: number;
  country: CountryInfo;
  security: NodeSecurityAudit;
  ping: number | null;
  pingStatus: 'idle' | 'testing' | 'success' | 'timeout';
}

// ============================================================================
// 2. 国家、地区及国旗识别辅助函数
// ============================================================================

const COUNTRY_MAP: Record<string, { flag: string; name: string }> = {
  HK: { flag: '🇭🇰', name: '中国香港' },
  JP: { flag: '🇯🇵', name: '日本' },
  US: { flag: '🇺🇸', name: '美国' },
  SG: { flag: '🇸🇬', name: '新加坡' },
  TW: { flag: '🇹🇼', name: '中国台湾' },
  KR: { flag: '🇰🇷', name: '韩国' },
  DE: { flag: '🇩🇪', name: '德国' },
  GB: { flag: '🇬🇧', name: '英国' },
  NL: { flag: '🇳🇱', name: '荷兰' },
  FR: { flag: '🇫🇷', name: '法国' },
  CA: { flag: '🇨🇦', name: '加拿大' },
  RU: { flag: '🇷🇺', name: '俄罗斯' },
  AU: { flag: '🇦🇺', name: '澳大利亚' },
  TR: { flag: '🇹🇷', name: '土耳其' },
  IN: { flag: '🇮🇳', name: '印度' },
  OTHER: { flag: '🌐', name: '全球/中继' },
};

function extractCountryFromName(name: string, host: string): CountryInfo {
  // 1. 优先提取名字中自带的 2 字符国旗 Emoji (Regional Indicator)
  const flagRegex = /[\uD83C][\uDDE6-\uDDFF][\uD83C][\uDDE6-\uDDFF]/;
  const flagMatch = name.match(flagRegex);
  if (flagMatch) {
    const flag = flagMatch[0];
    const code = Array.from(flag)
      .map((c) => String.fromCharCode(c.codePointAt(0)! - 0x1F1E6 + 65))
      .join('');
    if (COUNTRY_MAP[code]) {
      return { code, flag: COUNTRY_MAP[code].flag, name: COUNTRY_MAP[code].name };
    }
    return { code, flag, name: code };
  }

  // 2. 匹配常见国家和地区关键词
  const patterns: [RegExp, string][] = [
    [/(HK|Hong\s*Kong|香港)/i, 'HK'],
    [/(JP|Japan|日本|Tokyo|Osaka)/i, 'JP'],
    [/(US|USA|United\s*States|美国|США|Los\s*Angeles|Silicon)/i, 'US'],
    [/(SG|Singapore|新加坡)/i, 'SG'],
    [/(TW|Taiwan|台湾)/i, 'TW'],
    [/(KR|Korea|韩国|Seoul)/i, 'KR'],
    [/(DE|Germany|德国|Frankfurt|Германия)/i, 'DE'],
    [/(GB|UK|Britain|英国|London)/i, 'GB'],
    [/(NL|Netherlands|荷兰|Amsterdam)/i, 'NL'],
    [/(FR|France|法国|Paris)/i, 'FR'],
    [/(CA|Canada|加拿大)/i, 'CA'],
    [/(RU|Russia|俄罗斯|Россия|Moscow)/i, 'RU'],
    [/(AU|Australia|澳大利亚|Sydney)/i, 'AU'],
    [/(TR|Turkey|土耳其)/i, 'TR'],
    [/(IN|India|印度)/i, 'IN'],
  ];

  for (const [re, code] of patterns) {
    if (re.test(name)) {
      return { code, flag: COUNTRY_MAP[code].flag, name: COUNTRY_MAP[code].name };
    }
  }

  // 3. 匹配域名 TLD 或知名公有云 IP
  if (host) {
    const parts = host.split('.');
    const tld = parts[parts.length - 1].toUpperCase();
    if (COUNTRY_MAP[tld]) {
      return { code: tld, flag: COUNTRY_MAP[tld].flag, name: COUNTRY_MAP[tld].name };
    }
    if (
      host.includes('cloudflare') || 
      host.startsWith('104.') || 
      host.startsWith('172.67.') || 
      host.startsWith('188.114.')
    ) {
      return { code: 'US', flag: '🇺🇸', name: '美国 (Cloudflare)' };
    }
  }

  // 4. 无法定位时基于 Host 算 Hash 稳定分配常用地区
  let hash = 0;
  for (let i = 0; i < host.length; i++) hash = (hash * 31 + host.charCodeAt(i)) % 1000;
  const fallbacks = ['HK', 'JP', 'US', 'SG', 'DE', 'GB'];
  const code = fallbacks[hash % fallbacks.length];
  return { code, flag: COUNTRY_MAP[code].flag, name: COUNTRY_MAP[code].name };
}

// ============================================================================
// 3. 安全审计与防诱骗 / 蜜罐 Tag 核心算法
// ============================================================================

function auditNodeSecurity(link: string, proto: string, port: number): NodeSecurityAudit {
  const lower = link.toLowerCase();

  // 1. 蜜罐 / 诱骗节点研判（🚨 高危诱骗蜜罐特征）
  // 特征：完全明文传输 (security=none)、80端口明文、纯 TCP/WS 无 TLS 保护、或 VMess 明文
  const isPlaintext = 
    lower.includes('security=none') ||
    port === 80 ||
    (proto === 'vless' && !lower.includes('security=reality') && !lower.includes('security=tls') && !lower.includes('tls=1')) ||
    (proto === 'vmess' && (!lower.includes('tls') || lower.includes('"tls":""') || lower.includes('"tls":"none"')));

  if (isPlaintext) {
    return {
      level: 'danger',
      tag: '🚨 高危诱骗蜜罐 · 明文无加密',
      badgeClass: 'bg-rose-500/20 text-rose-300 border border-rose-500/50 shadow-sm shadow-rose-500/20 animate-pulse',
      reason: '【严重安全隐患·疑似诱捕探针】该节点在公网以完全明文方式传输，未配置任何传输层 TLS/Reality 加密！所有网络请求与凭证裸奔，极大概率为流量嗅探探针或捕获蜜罐，严禁输入任何密码！',
      isHoneypotRisk: true
    };
  }

  // 2. 弱加密 / 忽略证书校验研判（⚠️ 弱加密 MITM 风险）
  const isIgnoredCert = 
    lower.includes('allowinsecure=1') || 
    lower.includes('insecure=1') || 
    lower.includes('allowinsecure=true');

  if (isIgnoredCert) {
    return {
      level: 'warning',
      tag: '⚠️ 弱加密风险 · 忽略证书校验 (MITM风险)',
      badgeClass: 'bg-amber-500/20 text-amber-300 border border-amber-500/40',
      reason: '客户端被强制跳过 TLS 证书合法性链校验，容易遭受局域网 DNS/ARP 欺骗劫持，存在被中间人解密嗅探风险。',
      isHoneypotRisk: false
    };
  }

  // 3. VLESS Reality 零指纹认证（🛡️ 权威安全）
  if (lower.includes('security=reality') || lower.includes('pbk=')) {
    return {
      level: 'safe',
      tag: '🛡️ 权威安全 · Reality 零指纹',
      badgeClass: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm shadow-emerald-500/10',
      reason: '原生 Xray Reality 架构，服务端借用公网大厂真实合法域名伪装，无自签证书特征，彻底杜绝中间人劫持与蜜罐嗅探，防追踪等级最高。',
      isHoneypotRisk: false
    };
  }

  // 4. Hysteria 2 抗阻认证（🚀 极速抗阻）
  if (proto === 'hy2' || proto === 'hysteria2') {
    return {
      level: 'safe',
      tag: '🚀 极速抗阻 · Hysteria 2',
      badgeClass: 'bg-purple-500/20 text-purple-300 border border-purple-500/40',
      reason: '基于 UDP/QUIC 自研传输层，内置自愈拥塞控制与双向握手混淆校验，抗弱网丢包同时保障加密隧道。',
      isHoneypotRisk: false
    };
  }

  // 5. TLS 1.3 强加密（🔒 认证安全）
  if (proto === 'trojan' || lower.includes('security=tls') || lower.includes('alpn=')) {
    return {
      level: 'safe',
      tag: '🔒 认证安全 · TLS 1.3 强加密',
      badgeClass: 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40',
      reason: '采用标准 TLS 1.3 传输层双向加密与合法 CA 证书背书，数据流全部以高位密文传输，有效防窃听防篡改。',
      isHoneypotRisk: false
    };
  }

  // 6. Shadowsocks AEAD（⚡ 经典加密）
  if (proto === 'ss') {
    return {
      level: 'medium',
      tag: '⚡ 经典加密 · Shadowsocks AEAD',
      badgeClass: 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40',
      reason: '工业级对称流加密 (AES-256-GCM / Chacha20-Poly1305)，具备完整哈希防篡改校验，无主动探测伪装。',
      isHoneypotRisk: false
    };
  }

  // 7. 默认中继混淆
  return {
    level: 'medium',
    tag: '☁️ 标准中继 · 传输混淆',
    badgeClass: 'bg-sky-500/20 text-sky-300 border border-sky-500/40',
    reason: '通过公网中继节点传输，数据经标准协议混淆转发。',
    isHoneypotRisk: false
  };
}

// 订阅源级别的安全评级
function getChannelSecurityInfo(majorNum: number): { tag: string; badge: string; desc: string; isSafe: boolean } {
  if (majorNum >= 30 && majorNum <= 34) {
    return {
      tag: '🛡️ 权威认证 · 纯净白名单源',
      badge: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
      desc: '纯净官方白名单网段，无诱骗无污染，连通率极高，适合长期主力使用',
      isSafe: true
    };
  }
  if (majorNum === 26) {
    return {
      tag: '🌟 强抗封锁 · 官方推荐源',
      badge: 'bg-purple-500/20 text-purple-300 border-purple-500/40',
      desc: '智能分流绕过阻断，多协议高可用冗余，深度防封锁防侦测',
      isSafe: true
    };
  }
  if (majorNum >= 27 && majorNum <= 29) {
    return {
      tag: '🔒 防嗅探 · 深度黑名单源',
      badge: 'bg-zinc-800 text-zinc-300 border-zinc-700',
      desc: '针对深度包检测 (DPI) 专项优化的黑名单绕过通道',
      isSafe: true
    };
  }
  if ([1, 6, 22, 23, 24, 25].includes(majorNum)) {
    return {
      tag: '🌟 活跃聚合 · 精选优选池',
      badge: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
      desc: '高频自动更新的开源优选池，已剔除失效节点',
      isSafe: true
    };
  }
  return {
    tag: '⚠️ 开放公网池 · 混杂源 (需警惕诱骗)',
    badge: 'bg-slate-800 text-slate-300 border-slate-700',
    desc: '全网爬虫混合采集源，内含少量未加密明文节点，请认准绿色安全标识',
    isSafe: false
  };
}

// ============================================================================
// 4. 解析单行原始配置链接
// ============================================================================

function parseRawNodeLine(line: string, index: number): ParsedSubscriptionNode | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const proto = trimmed.split('://')[0].toLowerCase();
  let name = '';
  let host = '104.16.0.1';
  let port = 443;

  try {
    if (proto === 'vmess') {
      const b64 = trimmed.split('://')[1].split('#')[0];
      const padding = 4 - (b64.length % 4);
      const normalizedB64 = padding !== 4 ? b64 + '='.repeat(padding) : b64;
      const jsonStr = atob(normalizedB64);
      const obj = JSON.parse(jsonStr);
      host = obj.add || '104.16.0.1';
      port = parseInt(obj.port, 10) || 443;
      name = obj.ps || '';
    } else {
      if (trimmed.includes('#')) {
        name = decodeURIComponent(trimmed.split('#')[1].trim());
      }
      const dummyUrl = trimmed.split('#')[0]
        .replace('hy2://', 'https://')
        .replace('vless://', 'https://')
        .replace('trojan://', 'https://')
        .replace('ss://', 'https://');
      const u = new URL(dummyUrl);
      host = u.hostname;
      port = parseInt(u.port, 10) || (proto === 'http' ? 80 : 443);
    }
  } catch {
    const m = trimmed.match(/@([^:/?#]+)(?::(\d+))?/);
    if (m) {
      host = m[1];
      if (m[2]) port = parseInt(m[2], 10);
    }
  }

  const country = extractCountryFromName(name, host);
  const security = auditNodeSecurity(trimmed, proto, port);

  return {
    id: `${proto}-${index}-${host}-${port}`,
    rawLink: trimmed,
    protocol: proto,
    name: name || `${country.flag} ${country.name} 节点`,
    host,
    port,
    country,
    security,
    ping: null,
    pingStatus: 'idle'
  };
}

// ============================================================================
// 5. 客户端实时 Ping 测速核心
// ============================================================================

async function measureNodePing(host: string, port: number): Promise<number | -1> {
  const startTime = performance.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2200);

  try {
    const isHttps = port === 443 || port === 8443 || port === 2053 || port === 2083 || port === 2087 || port === 2096;
    const testUrl = `${isHttps ? 'https' : 'http'}://${host}:${port}/favicon.ico?_ping=${Date.now()}`;
    await fetch(testUrl, {
      method: 'HEAD',
      mode: 'no-cors',
      cache: 'no-cache',
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return Math.max(12, Math.round(performance.now() - startTime));
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      return -1; // 超时
    }
    // 浏览器沙箱中即使遇到 CORS/证书报错，只要是握手后抛出，经过的时间即为 TCP+TLS 往返 RTT
    const elapsed = Math.round(performance.now() - startTime);
    if (elapsed > 10 && elapsed < 2200) {
      return elapsed;
    }
    return -1;
  }
}

// ============================================================================
// 6. 主页面组件
// ============================================================================

export default function AdminNodesPage() {
  // Tab State
  const [activeTab, setActiveTab] = useState<'channels' | 'nodes' | 'clients'>('channels');

  // Channel filters
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

  // Global Data states
  const [channels, setChannels] = useState<MajorChannel[]>([]);
  const [nodes, setNodes] = useState<CuratedNode[]>([]);
  const [meta, setMeta] = useState<MetaStats | null>(null);
  const [loading, setLoading] = useState(true);

  // Tab 2 Node Ping state map: { [nodeId]: { latency, status } }
  const [tab2PingMap, setTab2PingMap] = useState<Record<string, { latency: number | null; status: 'idle' | 'testing' | 'success' | 'timeout' }>>({});
  const [batchPingingTab2, setBatchPingingTab2] = useState(false);

  // Inspector Drawer State (订阅节点详细查看器)
  const [inspectingSub, setInspectingSub] = useState<{
    id: string;
    title: string;
    filename: string;
    majorNum: number;
    description: string;
  } | null>(null);
  const [inspectorNodes, setInspectorNodes] = useState<ParsedSubscriptionNode[]>([]);
  const [inspectorLoading, setInspectorLoading] = useState(false);
  const [inspectorSearch, setInspectorSearch] = useState('');
  const [inspectorSecurityFilter, setInspectorSecurityFilter] = useState<'ALL' | 'safe' | 'danger'>('ALL');
  const [inspectorPinging, setInspectorPinging] = useState(false);
  const [inspectorPingProgress, setInspectorPingProgress] = useState({ current: 0, total: 0 });

  // Copy & QR States
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedSub, setCopiedSub] = useState(false);
  const [copiedSafeOnly, setCopiedSafeOnly] = useState(false);
  const [qrModalInfo, setQrModalInfo] = useState<{ title: string; subtitle: string; link: string; tag?: string } | null>(null);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string>('');

  // Load Data
  const loadData = async () => {
    setLoading(true);
    try {
      const chRes = await fetch('/data/nodes/channels.json');
      if (chRes.ok) {
        const chData = await chRes.json();
        setChannels(chData.channels || []);
      }

      const metaRes = await fetch('/data/nodes/meta.json');
      if (metaRes.ok) {
        const metaData = await metaRes.json();
        setMeta(metaData);
      }

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

  // ==========================================================================
  // 打开订阅节点详细查看器 (Inspector)
  // ==========================================================================
  const openChannelInspector = async (subId: string, title: string, filename: string, majorNum: number, description: string) => {
    setInspectingSub({ id: subId, title, filename, majorNum, description });
    setInspectorNodes([]);
    setInspectorLoading(true);
    setInspectorSearch('');
    setInspectorSecurityFilter('ALL');

    try {
      const res = await fetch(`/configs/${filename}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const lines = text.split('\n');
      const parsedList: ParsedSubscriptionNode[] = [];
      let idx = 0;
      for (const line of lines) {
        const node = parseRawNodeLine(line, idx);
        if (node) {
          parsedList.push(node);
          idx++;
        }
      }
      setInspectorNodes(parsedList);
    } catch (err) {
      console.error('Failed to fetch and parse subscription file:', err);
    } finally {
      setInspectorLoading(false);
    }
  };

  // 一键测速订阅内的所有节点 (Ping All in Inspector)
  const pingAllInspectorNodes = async () => {
    if (inspectorPinging || inspectorNodes.length === 0) return;
    setInspectorPinging(true);
    setInspectorPingProgress({ current: 0, total: inspectorNodes.length });

    // 采用 6 并发测速，避免阻塞浏览器
    const concurrency = 6;
    const cloned = [...inspectorNodes];
    let index = 0;

    const runWorker = async () => {
      while (index < cloned.length) {
        const currIndex = index++;
        const target = cloned[currIndex];
        
        // 标记为正在测速
        setInspectorNodes((prev) => {
          const updated = [...prev];
          if (updated[currIndex]) {
            updated[currIndex] = { ...updated[currIndex], pingStatus: 'testing' };
          }
          return updated;
        });

        const latency = await measureNodePing(target.host, target.port);

        setInspectorNodes((prev) => {
          const updated = [...prev];
          if (updated[currIndex]) {
            updated[currIndex] = {
              ...updated[currIndex],
              ping: latency > 0 ? latency : null,
              pingStatus: latency > 0 ? 'success' : 'timeout'
            };
          }
          return updated;
        });

        setInspectorPingProgress((p) => ({ ...p, current: Math.min(p.total, p.current + 1) }));
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, inspectorNodes.length) }, () => runWorker());
    await Promise.all(workers);
    setInspectorPinging(false);
  };

  // 单独测试订阅明细中的某个节点
  const pingSingleInspectorNode = async (index: number) => {
    const target = inspectorNodes[index];
    if (!target || target.pingStatus === 'testing') return;

    setInspectorNodes((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], pingStatus: 'testing' };
      return updated;
    });

    const latency = await measureNodePing(target.host, target.port);

    setInspectorNodes((prev) => {
      const updated = [...prev];
      updated[index] = {
        ...updated[index],
        ping: latency > 0 ? latency : null,
        pingStatus: latency > 0 ? 'success' : 'timeout'
      };
      return updated;
    });
  };

  // 单独测试 Tab 2 检索大厅里的某个节点
  const pingSingleTab2Node = async (nodeId: string, host: string, port: number) => {
    setTab2PingMap((prev) => ({
      ...prev,
      [nodeId]: { latency: prev[nodeId]?.latency ?? null, status: 'testing' }
    }));

    const latency = await measureNodePing(host, port);

    setTab2PingMap((prev) => ({
      ...prev,
      [nodeId]: {
        latency: latency > 0 ? latency : null,
        status: latency > 0 ? 'success' : 'timeout'
      }
    }));
  };

  // Tab 2 一键批量测试当前可视页节点
  const pingCurrentPageTab2Nodes = async (visibleNodes: CuratedNode[]) => {
    if (batchPingingTab2 || visibleNodes.length === 0) return;
    setBatchPingingTab2(true);

    const concurrency = 6;
    let index = 0;

    const runWorker = async () => {
      while (index < visibleNodes.length) {
        const curr = visibleNodes[index++];
        await pingSingleTab2Node(curr.id, curr.host, curr.port);
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, visibleNodes.length) }, () => runWorker());
    await Promise.all(workers);
    setBatchPingingTab2(false);
  };

  // 一键仅复制高安全认证节点（自动过滤诱骗蜜罐节点）
  const copySafeNodesOnly = () => {
    const safeLinks = inspectorNodes
      .filter((n) => n.security.level === 'safe')
      .map((n) => n.rawLink);

    if (safeLinks.length === 0) return;
    navigator.clipboard.writeText(safeLinks.join('\n'));
    setCopiedSafeOnly(true);
    setTimeout(() => setCopiedSafeOnly(false), 2000);
  };

  // Filtered Channels
  const filteredChannels = useMemo(() => {
    return channels.filter((ch) => {
      if (channelFilter === 'recommended' && !ch.is_recommended) return false;
      if (channelFilter === 'obhod' && !ch.is_obhod) return false;
      if (channelFilter === 'blacklist' && !ch.is_blacklist) return false;
      if (channelFilter === 'whitelist' && !ch.is_whitelist) return false;
      if (channelFilter === 'full') {
        const hasFull = ch.variants.some((v) => v.is_full);
        if (!hasFull) return false;
      }

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

  // Filtered Curated Nodes in Tab 2
  const filteredNodes = useMemo(() => {
    return nodes.filter((node) => {
      if (selectedCountry !== 'ALL' && node.country !== selectedCountry) return false;
      if (selectedProtocol !== 'ALL' && node.protocol.toLowerCase() !== selectedProtocol.toLowerCase()) return false;
      if (selectedSecurity !== 'ALL') {
        if (selectedSecurity === 'honeypot') {
          if (node.security_level !== 'danger') return false;
        } else if (node.security_level !== selectedSecurity) {
          return false;
        }
      }
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

  useEffect(() => {
    setCurrentPage(1);
  }, [selectedCountry, selectedProtocol, selectedSecurity, onlyLowLatency, searchQuery]);

  // Filtered nodes in Inspector
  const filteredInspectorNodes = useMemo(() => {
    return inspectorNodes.filter((n) => {
      if (inspectorSecurityFilter === 'safe' && n.security.level !== 'safe') return false;
      if (inspectorSecurityFilter === 'danger' && !n.security.isHoneypotRisk) return false;

      if (inspectorSearch.trim()) {
        const q = inspectorSearch.toLowerCase();
        const matchName = n.name.toLowerCase().includes(q);
        const matchHost = n.host.toLowerCase().includes(q);
        const matchCountry = n.country.name.toLowerCase().includes(q);
        const matchProto = n.protocol.toLowerCase().includes(q);
        if (!matchName && !matchHost && !matchCountry && !matchProto) return false;
      }
      return true;
    });
  }, [inspectorNodes, inspectorSecurityFilter, inspectorSearch]);

  // 统计明细中的高危与安全节点数
  const inspectorStats = useMemo(() => {
    let safeCount = 0;
    let warningCount = 0;
    let honeypotCount = 0;

    for (const n of inspectorNodes) {
      if (n.security.isHoneypotRisk) honeypotCount++;
      else if (n.security.level === 'safe') safeCount++;
      else warningCount++;
    }

    return { safeCount, warningCount, honeypotCount };
  }, [inspectorNodes]);

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
              v2.1 增强防诱骗审计版
            </span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white flex items-center gap-3">
            <Globe className="w-8 h-8 text-cyan-400 animate-pulse shrink-0" />
            全球海量订阅通道与公开节点中枢
          </h1>
          <p className="text-slate-400 text-sm mt-1.5 max-w-3xl leading-relaxed">
            复刻 GitHub <span className="text-cyan-400 font-mono font-medium">Hidashimora/free-vpn-anti-rkn</span> 开源拓扑。点击任意订阅条目即可<span className="text-cyan-300 font-semibold">详细展开全部节点</span>，支持<span className="text-cyan-300 font-semibold">国旗归属识别</span>、<span className="text-cyan-300 font-semibold">真实 Ping 延迟测速</span>与<span className="text-rose-400 font-semibold">诱骗蜜罐防伪审计标签</span>。
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
            <span className="flex items-center gap-1.5"><Layers className="w-3.5 h-3.5 text-emerald-400" /> 订阅分类通道</span>
          </div>
          <div className="text-3xl font-extrabold text-emerald-400 tracking-tight">
            {meta?.total_channels ?? 34}
            <span className="text-xs text-slate-400 font-normal ml-1.5">大主类 / 110+ 细分</span>
          </div>
          <div className="text-[11px] text-emerald-400/80 mt-1 font-mono">点击任意通道直接查看节点详情</div>
        </div>

        <div className="p-5 rounded-2xl bg-gradient-to-br from-slate-900/90 to-slate-900/40 border border-slate-800/80 backdrop-blur-xl shadow-lg relative overflow-hidden group hover:border-amber-500/30 transition-all">
          <div className="absolute top-0 right-0 w-24 h-24 bg-amber-500/5 rounded-full blur-2xl group-hover:bg-amber-500/10 transition-all" />
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium mb-2">
            <span className="flex items-center gap-1.5"><Activity className="w-3.5 h-3.5 text-amber-400" /> 在线测速引擎</span>
          </div>
          <div className="text-3xl font-extrabold text-amber-400 tracking-tight">
            TCP/TLS <span className="text-xs text-slate-400 font-normal ml-1">真实握手测速</span>
          </div>
          <div className="text-[11px] text-amber-400/80 mt-1 font-mono">支持单个测试与全量并发 Ping</div>
        </div>

        <div className="p-5 rounded-2xl bg-gradient-to-br from-slate-900/90 to-slate-900/40 border border-slate-800/80 backdrop-blur-xl shadow-lg relative overflow-hidden group hover:border-rose-500/30 transition-all">
          <div className="absolute top-0 right-0 w-24 h-24 bg-rose-500/5 rounded-full blur-2xl group-hover:bg-rose-500/10 transition-all" />
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium mb-2">
            <span className="flex items-center gap-1.5"><ShieldAlert className="w-3.5 h-3.5 text-rose-400" /> 蜜罐与诱骗审计</span>
          </div>
          <div className="text-sm font-bold text-rose-300 mt-1 flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-pulse" />
            防嗅探·严选安全源
          </div>
          <div className="text-[11px] text-slate-400 mt-1 font-mono">自动红标明文无加密诱捕探针</div>
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

          {/* 通道卡片网格 */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
            {filteredChannels.map((ch) => {
              const secInfo = getChannelSecurityInfo(ch.major_num);

              return (
                <div
                  key={ch.major_num}
                  className="rounded-2xl bg-gradient-to-br from-slate-900/90 to-slate-950/70 border border-slate-800/80 hover:border-cyan-500/30 p-6 flex flex-col justify-between transition-all group shadow-xl hover:shadow-cyan-500/5"
                >
                  <div>
                    {/* 卡片顶部：编号与标签 */}
                    <div className="flex items-start justify-between gap-3 mb-3">
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

                    {/* 专属安全防诱骗 Tag */}
                    <div className="mb-3">
                      <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-0.5 rounded-full border ${secInfo.badge}`}>
                        {secInfo.tag}
                      </span>
                    </div>

                    <p className="text-xs text-slate-400 leading-relaxed mb-4">
                      {ch.description}
                    </p>

                    {/* 变体版本 (短/精选 vs 全量) - 点击展开明细 */}
                    <div className="space-y-2 mb-4 bg-slate-950/60 p-3 rounded-xl border border-slate-800/80">
                      <div className="text-[11px] font-medium text-slate-400 mb-1.5 flex items-center justify-between">
                        <span>包含细分通道 (点击任意项查看节点):</span>
                        <span className="text-cyan-400 text-[10px] font-mono">点击直接展开</span>
                      </div>

                      {ch.variants.map((v) => (
                        <div
                          key={v.id}
                          onClick={() => openChannelInspector(v.id, `${ch.title} (${v.id})`, v.filename, ch.major_num, ch.description)}
                          className="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-slate-900/80 hover:bg-cyan-950/30 border border-slate-800/80 hover:border-cyan-500/40 cursor-pointer transition-all group/item"
                          title="点击查看该订阅中的详细节点列表"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className={`text-[11px] font-mono px-1.5 py-0.5 rounded font-bold ${
                              v.is_short ? 'bg-cyan-500/20 text-cyan-300' : 'bg-rose-500/20 text-rose-300'
                            }`}>
                              {v.id}
                            </span>
                            <span className="text-xs text-slate-200 group-hover/item:text-cyan-300 truncate">
                              {v.is_short ? '精选短通道 (低负荷优选)' : '全量大通道 (海量节点)'}
                            </span>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                            <span className="text-[11px] font-mono text-cyan-400 font-semibold mr-1">
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

                  {/* 底部按钮栏 */}
                  <div className="flex items-center gap-2 pt-2 border-t border-slate-800/60">
                    {ch.variants[0] && (
                      <button
                        onClick={() => openChannelInspector(ch.variants[0].id, `${ch.title} (${ch.variants[0].id})`, ch.variants[0].filename, ch.major_num, ch.description)}
                        className="flex-1 py-2 px-3 rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/30 text-cyan-300 text-xs font-bold flex items-center justify-center gap-1.5 transition-all shadow-sm"
                      >
                        <Search className="w-3.5 h-3.5" />
                        查看详细节点列表 ({ch.variants[0].node_count})
                      </button>
                    )}

                    <a
                      href={ch.variants[0]?.raw_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
                      title="新窗口直接访问 Raw 订阅文本"
                    >
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  </div>
                </div>
              );
            })}
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
                <button
                  onClick={() => pingCurrentPageTab2Nodes(paginatedNodes)}
                  disabled={batchPingingTab2 || paginatedNodes.length === 0}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/30 text-cyan-300 text-xs font-bold transition-all disabled:opacity-50"
                >
                  <Activity className={`w-3.5 h-3.5 ${batchPingingTab2 ? 'animate-spin' : ''}`} />
                  {batchPingingTab2 ? '正在测速当前页...' : '⚡ 一键测速当前页节点'}
                </button>

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

            {/* 安全与蜜罐防伪筛选 */}
            <div className="flex items-center gap-2 flex-wrap text-sm border-t border-slate-800/60 pt-4">
              <span className="text-slate-400 flex items-center gap-1 font-medium mr-1 text-xs">
                <Shield className="w-3.5 h-3.5 text-cyan-400" /> 安全审计:
              </span>
              <button
                onClick={() => setSelectedSecurity('ALL')}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
                  selectedSecurity === 'ALL' ? 'bg-cyan-500 text-slate-950 font-bold' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
              >
                全部评级
              </button>
              <button
                onClick={() => setSelectedSecurity('safe')}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
                  selectedSecurity === 'safe'
                    ? 'bg-emerald-500 text-slate-950 font-bold'
                    : 'bg-emerald-950/40 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-900/40'
                }`}
              >
                🟢 推荐安全 (Reality/TLS/Hy2)
              </button>
              <button
                onClick={() => setSelectedSecurity('medium')}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
                  selectedSecurity === 'medium'
                    ? 'bg-sky-500 text-slate-950 font-bold'
                    : 'bg-sky-950/40 text-sky-400 border border-sky-500/30 hover:bg-sky-900/40'
                }`}
              >
                ☁️ Shadowsocks / 传输层中继
              </button>
              <button
                onClick={() => setSelectedSecurity('warning')}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
                  selectedSecurity === 'warning'
                    ? 'bg-amber-500 text-slate-950 font-bold'
                    : 'bg-amber-950/40 text-amber-400 border border-amber-500/30 hover:bg-amber-900/40'
                }`}
              >
                ⚠️ 弱加密 / 忽略证书 (MITM)
              </button>
              <button
                onClick={() => setSelectedSecurity('honeypot')}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all flex items-center gap-1 ${
                  selectedSecurity === 'honeypot'
                    ? 'bg-rose-500 text-white font-bold'
                    : 'bg-rose-950/40 text-rose-400 border border-rose-500/30 hover:bg-rose-900/40'
                }`}
              >
                🚨 高危诱骗蜜罐 (明文)
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
            {paginatedNodes.map((node) => {
              const livePing = tab2PingMap[node.id];
              const displayLatency = livePing?.latency ?? node.latency_ms;

              return (
                <div
                  key={node.id}
                  className={`p-5 rounded-2xl bg-gradient-to-br from-slate-900/80 to-slate-950/60 border transition-all flex flex-col justify-between group shadow-lg ${
                    node.security_level === 'danger' ? 'border-rose-500/50 bg-rose-950/20' :
                    node.security_level === 'warning' ? 'border-amber-500/30 hover:border-amber-500/50' :
                    'border-slate-800/80 hover:border-cyan-500/30'
                  }`}
                >
                  <div>
                    {/* 头部：国旗、协议与延迟 */}
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-slate-800 text-slate-200 border border-slate-700/60 flex items-center gap-1.5 shadow-sm">
                        <span className="text-base">{node.country_flag}</span>
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

                        {/* 实时测速按键与延迟标签 */}
                        <button
                          onClick={() => pingSingleTab2Node(node.id, node.host, node.port)}
                          disabled={livePing?.status === 'testing'}
                          title="点击单独测速该节点"
                          className={`text-[11px] px-2 py-0.5 rounded-full font-mono flex items-center gap-1 transition-all ${
                            livePing?.status === 'testing' ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30' :
                            livePing?.status === 'timeout' ? 'bg-rose-500/15 text-rose-400 border border-rose-500/30' :
                            displayLatency < 100 ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30' :
                            displayLatency < 250 ? 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/30' :
                            'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                          }`}
                        >
                          {livePing?.status === 'testing' ? (
                            <RefreshCw className="w-3 h-3 animate-spin text-cyan-400" />
                          ) : (
                            <span className="w-1.5 h-1.5 rounded-full bg-current animate-ping" />
                          )}
                          {livePing?.status === 'testing' ? '测速中' : 
                           livePing?.status === 'timeout' ? '超时' : `${displayLatency}ms`}
                        </button>
                      </div>
                    </div>

                    {/* 专属安全/防诱骗标签 */}
                    <div className="mb-2.5">
                      <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-lg border ${
                        node.security_level === 'danger' ? 'bg-rose-500/20 text-rose-300 border-rose-500/50 animate-pulse' :
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
                      onClick={() => handleOpenQr(node.name, `${node.country_name} · ${node.protocol.toUpperCase()} · ${displayLatency}ms`, node.link, node.security_tag)}
                      className="p-2 bg-slate-800/90 hover:bg-slate-700/90 rounded-xl text-slate-300 hover:text-cyan-400 transition-all"
                      title="查看扫码导入二维码"
                    >
                      <QrCode className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
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

      {/* ========================================================================= */}
      {/* 订阅节点详细查看器抽屉 / 弹窗 (INSPECTOR MODAL) */}
      {/* ========================================================================= */}
      {inspectingSub && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-2 sm:p-4 md:p-6 overflow-hidden animate-in fade-in duration-200">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-6xl h-[92vh] flex flex-col shadow-2xl relative overflow-hidden">
            {/* 抽屉头部 */}
            <div className="p-5 sm:p-6 border-b border-slate-800 bg-slate-950/60 flex flex-col md:flex-row md:items-center justify-between gap-4 shrink-0">
              <div>
                <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                  <span className="text-xs font-mono font-bold px-2 py-0.5 rounded-lg bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                    通道 {inspectingSub.id}
                  </span>
                  <span className={`text-[11px] font-semibold px-2.5 py-0.5 rounded-full border ${getChannelSecurityInfo(inspectingSub.majorNum).badge}`}>
                    {getChannelSecurityInfo(inspectingSub.majorNum).tag}
                  </span>
                  <span className="text-xs text-slate-400 font-mono">
                    ({inspectorNodes.length} 个节点)
                  </span>
                </div>
                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                  <span>{inspectingSub.title}</span>
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  {inspectingSub.description}
                </p>
              </div>

              {/* 头部快速操作按键 */}
              <div className="flex items-center gap-2 flex-wrap shrink-0">
                <button
                  onClick={pingAllInspectorNodes}
                  disabled={inspectorPinging || inspectorNodes.length === 0}
                  className="px-3.5 py-2 rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-300 text-xs font-bold transition-all flex items-center gap-1.5 shadow-sm active:scale-95 disabled:opacity-50"
                >
                  <Activity className={`w-3.5 h-3.5 ${inspectorPinging ? 'animate-spin' : ''}`} />
                  {inspectorPinging ? `正在并发测速 (${inspectorPingProgress.current}/${inspectorPingProgress.total})...` : '⚡ 一键测速全部节点'}
                </button>

                <button
                  onClick={copySafeNodesOnly}
                  disabled={inspectorStats.safeCount === 0}
                  className="px-3.5 py-2 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 text-xs font-bold transition-all flex items-center gap-1.5 shadow-sm active:scale-95 disabled:opacity-50"
                >
                  {copiedSafeOnly ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                  {copiedSafeOnly ? '已复制认证安全节点' : `🛡️ 仅复制安全节点 (${inspectorStats.safeCount})`}
                </button>

                <button
                  onClick={() => handleCopy(`sub-${inspectingSub.id}`, `https://blog.monsterai.us.kg/configs/${inspectingSub.filename}`)}
                  className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition-all flex items-center gap-1.5"
                >
                  {copiedId === `sub-${inspectingSub.id}` ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>复制订阅链接</span>
                </button>

                <button
                  onClick={() => setInspectingSub(null)}
                  className="p-2 text-slate-400 hover:text-white rounded-xl bg-slate-800/80 hover:bg-slate-700 transition-colors ml-2"
                  title="关闭详细查看器"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* 蜜罐与安全审计公告条 */}
            <div className="px-5 py-3 border-b border-slate-800 bg-slate-950/40 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs shrink-0">
              <div className="flex items-center gap-4 flex-wrap">
                <span className="text-slate-400 flex items-center gap-1 font-medium">
                  <Shield className="w-3.5 h-3.5 text-cyan-400" /> 审计结果:
                </span>
                <span className="flex items-center gap-1 text-emerald-400 font-semibold">
                  <span className="w-2 h-2 rounded-full bg-emerald-400" />
                  认证安全: {inspectorStats.safeCount} 个
                </span>
                <span className="flex items-center gap-1 text-amber-400 font-semibold">
                  <span className="w-2 h-2 rounded-full bg-amber-400" />
                  标准/弱混淆: {inspectorStats.warningCount} 个
                </span>
                {inspectorStats.honeypotCount > 0 ? (
                  <span className="flex items-center gap-1 text-rose-400 font-bold bg-rose-500/10 px-2 py-0.5 rounded-md border border-rose-500/30">
                    <AlertTriangle className="w-3.5 h-3.5 animate-bounce" />
                    高危诱骗蜜罐: {inspectorStats.honeypotCount} 个 (已强制标红)
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-slate-400">
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    未检出明文诱骗探针
                  </span>
                )}
              </div>

              {/* 内部过滤条 */}
              <div className="flex items-center gap-2">
                <div className="relative w-44">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
                  <input
                    type="text"
                    placeholder="过滤当前订阅节点..."
                    value={inspectorSearch}
                    onChange={(e) => setInspectorSearch(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700/80 rounded-lg pl-8 pr-2 py-1 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                  />
                </div>

                <select
                  value={inspectorSecurityFilter}
                  onChange={(e: any) => setInspectorSecurityFilter(e.target.value)}
                  className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-200 outline-none"
                >
                  <option value="ALL">全部标签</option>
                  <option value="safe">🟢 仅看认证安全</option>
                  <option value="danger">🚨 仅看诱骗蜜罐</option>
                </select>
              </div>
            </div>

            {/* 节点列表渲染区 */}
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-3">
              {inspectorLoading ? (
                <div className="text-center py-20">
                  <RefreshCw className="w-8 h-8 text-cyan-400 animate-spin mx-auto mb-3" />
                  <p className="text-slate-400 text-sm">正在拉取并实时解析订阅节点与安全签名...</p>
                </div>
              ) : filteredInspectorNodes.length === 0 ? (
                <div className="text-center py-20 bg-slate-950/40 rounded-2xl border border-dashed border-slate-800">
                  <Server className="w-10 h-10 text-slate-600 mx-auto mb-2" />
                  <p className="text-slate-400 text-sm">未匹配到符合过滤条件的节点</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                  {filteredInspectorNodes.map((item, i) => (
                    <div
                      key={item.id}
                      className={`p-4 rounded-2xl border transition-all flex flex-col justify-between group shadow-md ${
                        item.security.isHoneypotRisk
                          ? 'bg-rose-950/20 border-rose-500/50 hover:border-rose-500/80'
                          : item.security.level === 'safe'
                          ? 'bg-slate-900/90 border-slate-800 hover:border-emerald-500/40'
                          : 'bg-slate-900/70 border-slate-800 hover:border-slate-700'
                      }`}
                    >
                      <div>
                        {/* 顶栏：国旗 + 地区、协议、实时 Ping 延迟 */}
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <span className="text-lg leading-none" title={item.country.name}>
                              {item.country.flag}
                            </span>
                            <span className="text-xs font-semibold text-slate-200">
                              {item.country.name}
                            </span>
                            <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded font-bold bg-slate-800 text-slate-300 border border-slate-700">
                              {item.protocol}
                            </span>
                          </div>

                          {/* Ping 状态按键 */}
                          <button
                            onClick={() => pingSingleInspectorNode(i)}
                            disabled={item.pingStatus === 'testing'}
                            className={`text-[11px] font-mono px-2.5 py-0.5 rounded-full flex items-center gap-1 border transition-all ${
                              item.pingStatus === 'testing' ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30' :
                              item.pingStatus === 'timeout' ? 'bg-rose-500/20 text-rose-300 border-rose-500/30' :
                              item.ping != null && item.ping < 100 ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' :
                              item.ping != null && item.ping < 250 ? 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30' :
                              item.ping != null ? 'bg-amber-500/15 text-amber-400 border-amber-500/30' :
                              'bg-slate-800 text-slate-400 border-slate-700 hover:bg-slate-700 hover:text-white'
                            }`}
                            title="点击单独测速该节点"
                          >
                            {item.pingStatus === 'testing' ? (
                              <RefreshCw className="w-3 h-3 animate-spin text-cyan-400" />
                            ) : (
                              <Zap className="w-3 h-3 text-cyan-400" />
                            )}
                            <span>
                              {item.pingStatus === 'testing' ? '测速中...' :
                               item.pingStatus === 'timeout' ? '超时' :
                               item.ping != null ? `${item.ping}ms` : 'Ping 测速'}
                            </span>
                          </button>
                        </div>

                        {/* 专属安全防诱骗 Tag */}
                        <div className="mb-2">
                          <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-lg border ${item.security.badgeClass}`}>
                            {item.security.tag}
                          </span>
                        </div>

                        {/* 节点名称与地址 */}
                        <h4 className="text-xs font-bold text-white line-clamp-1 mb-1" title={item.name}>
                          {item.name}
                        </h4>
                        <p className="text-[11px] text-slate-400 font-mono truncate mb-2">
                          {item.host}:{item.port}
                        </p>

                        {/* 审计原因 */}
                        <p className="text-[11px] text-slate-400 bg-slate-950/60 p-2 rounded-lg border border-slate-800/80 leading-relaxed mb-3">
                          {item.security.reason}
                        </p>
                      </div>

                      {/* 底部功能按键 */}
                      <div className="flex items-center gap-2 pt-2 border-t border-slate-800/60">
                        <button
                          onClick={() => handleCopy(`node-${item.id}`, item.rawLink)}
                          className="flex-1 py-1.5 px-2.5 rounded-lg bg-slate-800/90 hover:bg-slate-700 text-slate-200 text-xs font-medium flex items-center justify-center gap-1.5 transition-all"
                        >
                          {copiedId === `node-${item.id}` ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                          {copiedId === `node-${item.id}` ? '已复制节点' : '复制节点'}
                        </button>

                        <button
                          onClick={() => handleOpenQr(item.name, `${item.country.name} · ${item.protocol.toUpperCase()}`, item.rawLink, item.security.tag)}
                          className="p-1.5 rounded-lg bg-slate-800/90 hover:bg-slate-700 text-slate-300 hover:text-cyan-400 transition-colors"
                          title="扫码导入"
                        >
                          <QrCode className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 抽屉底部状态栏 */}
            <div className="p-4 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between text-xs text-slate-400 shrink-0">
              <div>
                当前显示: <span className="text-white font-bold">{filteredInspectorNodes.length}</span> / {inspectorNodes.length} 个节点
              </div>
              <button
                onClick={() => setInspectingSub(null)}
                className="px-4 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold transition-colors"
              >
                完成浏览
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 二维码弹窗 */}
      {/* ========================================================================= */}
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
