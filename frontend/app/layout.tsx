import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tube Grabber",
  description: "Download a YouTube video, playlist or whole channel",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
