import type { Metadata } from 'next';
import './globals.css';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';

export const metadata: Metadata = {
  title: 'MonsterAI Lab | 架构与全栈技术博客',
  description: '专注于 Flutter 跨平台开发、Rust 高性能后端架构及 Next.js 现代全栈技术实践。',
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico' },
    ],
    shortcut: '/icon.svg',
    apple: '/icon.svg',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" className="dark">
      <body className="min-h-screen flex flex-col bg-[#090d16] text-slate-200">
        {/* 背景光斑效果 */}
        <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
          <div className="absolute -top-40 left-1/4 w-[500px] h-[500px] bg-indigo-600/10 rounded-full blur-3xl" />
          <div className="absolute top-1/3 right-10 w-[400px] h-[400px] bg-cyan-600/10 rounded-full blur-3xl" />
          <div className="absolute -bottom-20 left-1/3 w-[600px] h-[600px] bg-purple-600/10 rounded-full blur-3xl" />
        </div>

        <Header />
        <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 pt-10 z-10">
          {children}
        </main>
        <Footer />
      </body>
    </html>
  );
}
