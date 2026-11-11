import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AppChrome } from "@/components/app-chrome";
import { EnvironmentRibbon } from "@/components/environment-ribbon";
import { StatusBar } from "@/components/status-bar";
import { BRAND } from "@/lib/brand";
import { THEME_SCRIPT } from "@/lib/theme";
import { getTheme } from "@/lib/theme-server";
import "katex/dist/katex.min.css";
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
  title: BRAND,
  description: BRAND,
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // A demo build names itself on every page, undismissably (docs/auth.md, "Demo
  // mode"). The comparison folds at build time; an Entra build has no demo ribbon.
  let ribbon = <EnvironmentRibbon />;
  if (process.env.NOVEDU_AUTH_MODE === "demo") {
    const { DemoRibbon } = await import("@/components/demo-ribbon");
    ribbon = <DemoRibbon />;
  }

  // The device's colour theme (lib/theme.ts): rendered as `data-theme`; the
  // inline script turns it into the `dark` class before the first paint. The
  // script changes `<html>`'s class before hydration, hence the warning opt-out
  // (it covers this element's attributes only).
  const theme = await getTheme();

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable}`}
      data-theme={theme}
      suppressHydrationWarning
    >
      <head>
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: a static constant with no interpolated value (lib/theme.ts)
          dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }}
        />
      </head>
      <body>
        <AppChrome>
          <StatusBar />
        </AppChrome>
        {ribbon}
        {children}
      </body>
    </html>
  );
}
