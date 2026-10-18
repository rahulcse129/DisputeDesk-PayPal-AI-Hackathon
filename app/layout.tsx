import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { Suspense } from "react";
import { NavLinks } from "./components/nav-links";
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
  title: "DisputeDesk: AI dispute assistant for PayPal merchants",
  description: "An AI agent that analyzes PayPal disputes, recommends a resolution and executes it only after merchant approval.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col bg-slate-50 text-slate-900">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
            <Link href="/" className="flex items-center gap-2.5">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-[#003087] text-sm font-bold text-white">DD</span>
              <span className="text-[15px] font-semibold tracking-tight">
                Dispute<span className="text-[#0070e0]">Desk</span>
              </span>
            </Link>
            {/* usePathname reads request data, so it streams in after the static shell. */}
            <Suspense fallback={<div className="h-8 w-44" />}>
              <NavLinks />
            </Suspense>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
        <footer className="border-t border-slate-200 py-4 text-center text-xs text-slate-500">
          DisputeDesk never moves money or messages a buyer without your approval.
        </footer>
      </body>
    </html>
  );
}
