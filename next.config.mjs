/** @type {import('next').NextConfig} */
const nextConfig = {
  // 开启静态站点导出，将网页生成为纯 HTML/CSS/JS 到 out/ 目录
  // 在 512MB Lightsail 上使用 Caddy 托管，内存开销 < 20MB，彻底杜绝 Node.js OOM
  output: 'export',
  trailingSlash: true,
  images: {
    unoptimized: true
  }
};

export default nextConfig;
