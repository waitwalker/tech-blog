import React from 'react';
import { Cpu, ShieldCheck, Heart } from 'lucide-react';

export const Footer: React.FC = () => {
  return (
    <footer className="border-t border-slate-800/60 bg-[#060911] text-slate-400 py-12 mt-20 text-sm">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-6">
        <div className="flex items-center space-x-2">
          <Cpu className="w-4 h-4 text-indigo-400" />
          <span>© 2026 MonsterAI Lab. Built with Next.js & Rust Ecosystem.</span>
        </div>
        <div className="flex items-center space-x-6 text-xs font-mono text-slate-500">
          <span className="flex items-center gap-1">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
            Lightsail High Reliability Node
          </span>
          <span>SSL via Let's Encrypt</span>
        </div>
      </div>
    </footer>
  );
};
