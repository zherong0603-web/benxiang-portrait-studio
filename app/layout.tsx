import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "本相 · 肖像工作室",
  description: "上传本人照片，选择肖像风格，查看生成进度、对照原照检查并下载作品。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
