import React from 'react';
import { User, Terminal, Server, Shield, Globe, Award } from 'lucide-react';

export default function AboutPage() {
  return (
    <div className="max-w-3xl mx-auto space-y-12">
      <div className="glass-card rounded-3xl p-8 sm:p-12 space-y-6 text-center">
        <div className="w-24 h-24 mx-auto rounded-full bg-gradient-to-tr from-indigo-500 via-cyan-500 to-emerald-400 flex items-center justify-center text-white shadow-xl shadow-indigo-500/20">
          <Terminal className="w-12 h-12" />
        </div>
        <div>
          <h1 className="text-3xl font-black text-white">Waitwalker</h1>
          <p className="text-slate-400 font-mono text-sm mt-1">Fullstack Engineer & Cross-Platform Architect</p>
        </div>
        <p className="text-slate-300 text-sm leading-relaxed max-w-xl mx-auto">
          热爱探索低延迟系统架构、跨平台渲染引擎及现代 Web 性能极致优化。坚持工匠精神，编写高可维护、高韧性代码。
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        <div className="glass-card rounded-2xl p-6 space-y-3">
          <div className="p-3 w-fit rounded-xl bg-indigo-500/10 text-indigo-400">
            <Server className="w-5 h-5" />
          </div>
          <h3 className="text-lg font-bold text-white">底层架构与网络</h3>
          <p className="text-slate-400 text-xs leading-relaxed">
            深入 Rust Tokio 异步并发体系，精通 Linux 网络栈优化、BBR 拥塞控制与高性能网络代理协议设计。
          </p>
        </div>

        <div className="glass-card rounded-2xl p-6 space-y-3">
          <div className="p-3 w-fit rounded-xl bg-cyan-500/10 text-cyan-400">
            <Globe className="w-5 h-5" />
          </div>
          <h3 className="text-lg font-bold text-white">跨端与现代前端</h3>
          <p className="text-slate-400 text-xs leading-relaxed">
            精通 Flutter 引擎级混合栈开发与原生通信，深度掌握 Next.js 极速渲染与超轻量化部署优化。
          </p>
        </div>
      </div>
    </div>
  );
}
