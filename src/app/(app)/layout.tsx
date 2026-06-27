"use client";

import { useAuth } from "@/contexts/AuthContext";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

const nav = [
  { href: "/domains", label: "Domains" },
  { href: "/apikeys", label: "API Keys" },
  { href: "/logs", label: "Email Logs" },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.push("/");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-sm text-[#737373]">Loading dashboard...</p>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="min-h-screen flex">
      <aside className="w-56 flex flex-col py-6 px-5">
        <div className="mb-8">
          <h1 className="font-semibold text-sm">FreeResend</h1>
          <span className="text-xs text-[#a3a3a3]">self-hosted</span>
        </div>

        <nav className="flex-1 space-y-1">
          {nav.map((item) => {
            const active = pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <button
                key={item.href}
                onClick={() => router.push(item.href)}
                className={`block w-full text-left px-3 py-2 text-sm rounded-lg transition-colors ${
                  active
                    ? "bg-[#f5f5f5] text-[#171717] font-medium"
                    : "text-[#737373] hover:text-[#525252] hover:bg-[#fafafa]"
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="pt-4 text-sm text-[#525252] space-y-2">
          <div className="truncate">{user.email}</div>
          <button
            onClick={logout}
            className="block text-[#a3a3a3] hover:text-[#171717] transition-colors"
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0 py-8 pr-8">
        {children}
      </main>
    </div>
  );
}
