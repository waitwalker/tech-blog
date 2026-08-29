"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { 
  LayoutDashboard, 
  PenTool, 
  FileText, 
  StickyNote, 
  Activity, 
  CloudDownload, 
  HardDrive, 
  Bot, 
  LogOut, 
  ShieldCheck, 
  Globe 
} from "lucide-react";
import { getToken, removeToken, fetchWithAuth } from "@/lib/api";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      router.replace("/login");
      return;
    }

    // 严格向后端校验 Token 有效性与管理员身份
    fetchWithAuth("/auth/me")
      .then((res) => {
        if (res.ok) {
          return res.json();
        }
        throw new Error("Token 无效或已过期");
      })
      .then((json) => {
        if (json.code === 200 && json.data) {
          setUser(json.data);
          setIsAuthenticated(true);
        } else {
          throw new Error("用户身份异常");
        }
      })
      .catch(() => {
        removeToken();
        router.replace("/login");
      });
  }, [router]);

  const handleLogout = () => {
    removeToken();
    router.replace("/login");
  };

  // 未完成鉴权时，严禁渲染任何管理后台 UI 与子页面
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center text-zinc-400 gap-3">
        <div className="w-8 h-8 rounded-full border-2 border-emerald-500/20 border-t-emerald-400 animate-spin" />
        <span className="text-xs tracking-wider uppercase font-mono text-zinc-500">
          正在严格校验管理员安全凭证...
        </span>
      </div>
    );
  }

  const navItems = [
    { label: "总览仪表盘", href: "/admin", icon: LayoutDashboard },
    { label: "磁盘与存储管理", href: "/admin/storage", icon: HardDrive },
    { label: "云端离线直传", href: "/admin/downloader", icon: CloudDownload },
    { label: "全球节点中枢", href: "/admin/nodes", icon: Globe },
    { label: "Markdown创作台", href: "/admin/editor", icon: PenTool },
    { label: "文章管理", href: "/admin/posts", icon: FileText },
    { label: "私密随手记", href: "/admin/memos", icon: StickyNote },
    { label: "VPS 性能监控", href: "/admin/monitor", icon: Activity },
    { label: "私有 AI 助手", href: "/admin/ai", icon: Bot },
  ];

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col md:flex-row">
      {/* 侧边导航栏 */}
      <aside className="w-full md:w-64 bg-zinc-900/60 border-r border-zinc-800/80 backdrop-blur-xl p-4 flex flex-col justify-between shrink-0">
        <div>
          {/* Logo & 身份 */}
          <div className="px-3 py-4 mb-4 border-b border-zinc-800/80">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-sm font-bold text-zinc-100 tracking-tight">MonsterAI Admin</h2>
                <span className="text-[10px] text-emerald-400 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  已认证管理员
                </span>
              </div>
            </div>
          </div>

          {/* 导航链接 */}
          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href;
              return (
                <a
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-medium transition-all ${
                    active
                      ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 shadow-sm"
                      : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
                  }`}
                >
                  <Icon className={`w-4 h-4 ${active ? "text-emerald-400" : "text-zinc-400"}`} />
                  <span>{item.label}</span>
                </a>
              );
            })}
          </nav>
        </div>

        {/* 底部功能区 */}
        <div className="pt-4 mt-6 border-t border-zinc-800/80 space-y-1">
          <a
            href="/"
            target="_blank"
            className="flex items-center gap-3 px-3.5 py-2 rounded-xl text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 transition-colors"
          >
            <Globe className="w-4 h-4" />
            <span>返回博客主页</span>
          </a>
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-3.5 py-2 rounded-xl text-xs text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            <span>安全退出登录</span>
          </button>
        </div>
      </aside>

      {/* 主工作区 */}
      <main className="flex-1 min-w-0 p-6 md:p-8 overflow-y-auto max-h-screen">
        {children}
      </main>
    </div>
  );
}
