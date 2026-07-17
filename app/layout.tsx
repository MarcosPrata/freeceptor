import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { version } from "../package.json";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Freeceptor",
  description: "Proxy reverso e inspeção de APIs em tempo real.",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/logo.png", type: "image/png", sizes: "766x762" },
    ],
    apple: "/logo.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className={`${geistSans.className} font-sans antialiased`}>
        {children}
        <div
          aria-label={`Versão ${version}`}
          className="pointer-events-none fixed bottom-3 left-3 z-50 font-mono text-[10px] text-zinc-400 dark:text-zinc-600"
        >
          v{version}
        </div>
      </body>
    </html>
  );
}
