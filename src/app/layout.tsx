import { APP_NAME } from '@/lib/hrms/constants'
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: `${APP_NAME} — People, Attendance & Payroll`,
  description:
    "Ultra-clean HR Management System: glassmorphism + Material 3 design, strict RBAC, two-tier leave approvals, configurable HR policy rules, short-hour tracking, automated payroll and PDF reporting.",
  keywords: ["HRMS", "KINTO", "HR", "Payroll", "Attendance", "Leave Management"],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        suppressHydrationWarning
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster richColors position="top-center" closeButton />
      </body>
    </html>
  );
}
