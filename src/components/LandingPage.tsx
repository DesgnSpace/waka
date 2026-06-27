"use client";

import Link from "next/link";
import { Github } from "lucide-react";

export default function LandingPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-[#e5e5e5]">
        <div className="mx-auto max-w-5xl px-6 h-14 flex items-center justify-between">
          <span className="font-semibold text-sm">FreeResend</span>
          <div className="flex items-center gap-5 text-sm">
            <a
              href="https://github.com/eibrahim/freeresend"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#525252] hover:text-[#171717]"
            >
              <Github className="h-4 w-4" />
            </a>
            <Link href="/login" className="text-[#525252] hover:text-[#171717]">
              Sign in
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1 mx-auto max-w-3xl px-6 py-20">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Self-hosted transactional email API
        </h1>
        <p className="mt-4 text-[#525252] leading-7 max-w-2xl">
          Drop-in Resend replacement using Amazon SES. Change{" "}
          <code className="text-sm bg-[#f5f5f5] px-1.5 py-0.5 rounded font-mono">
            RESEND_BASE_URL
          </code>{" "}
          and keep using your existing Resend SDK code.
        </p>

        <div className="mt-8 flex flex-col sm:flex-row gap-3">
          <a
            href="https://github.com/eibrahim/freeresend"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#171717] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#404040] transition-colors"
          >
            <Github className="h-4 w-4" />
            View on GitHub
          </a>
          <Link
            href="/login"
            className="inline-flex items-center justify-center rounded-lg border border-[#e5e5e5] px-5 py-2.5 text-sm font-medium text-[#525252] hover:text-[#171717] hover:border-[#d4d4d4] transition-colors"
          >
            Open dashboard
          </Link>
        </div>

        <hr className="my-16 border-[#e5e5e5]" />

        <div className="grid sm:grid-cols-2 gap-x-12 gap-y-8 text-sm">
          <div>
            <h2 className="font-semibold text-[#171717] mb-2">API compatible</h2>
            <p className="text-[#525252] leading-6">
              Use the Resend Node.js SDK or raw HTTPS. Set one env var, no code changes.
            </p>
          </div>
          <div>
            <h2 className="font-semibold text-[#171717] mb-2">DKIM signing</h2>
            <p className="text-[#525252] leading-6">
              Automatic DKIM key generation and DNS record creation per domain.
            </p>
          </div>
          <div>
            <h2 className="font-semibold text-[#171717] mb-2">Self-contained</h2>
            <p className="text-[#525252] leading-6">
              One Docker compose, one env file, one migration. PostgreSQL + SES.
            </p>
          </div>
          <div>
            <h2 className="font-semibold text-[#171717] mb-2">Email logs</h2>
            <p className="text-[#525252] leading-6">
              Track delivery status, bounces, and complaints per message.
            </p>
          </div>
          <div>
            <h2 className="font-semibold text-[#171717] mb-2">MIT licensed</h2>
            <p className="text-[#525252] leading-6">
              Free to self-host, fork, modify. No paid tiers, no feature gates.
            </p>
          </div>
          <div>
            <h2 className="font-semibold text-[#171717] mb-2">SMTP support</h2>
            <p className="text-[#525252] leading-6">
              Per-domain SMTP credentials for legacy senders.
            </p>
          </div>
        </div>

        {/* Code example */}
        <div className="mt-16">
          <h2 className="text-sm font-semibold text-[#171717] mb-3">Quick start</h2>
          <pre className="bg-[#171717] text-[#a3e635] p-4 rounded-lg text-sm overflow-x-auto leading-6 font-mono">
            <span className="text-[#737373]"># Set your FreeResend instance URL</span>{"\n"}
            export RESEND_BASE_URL=&quot;https://email.example.com/api&quot;
            {"\n\n"}
            <span className="text-[#737373]"># Use Resend SDK as usual</span>{"\n"}
            import &#123; Resend &#125; from &quot;resend&quot;{"\n"}
            const resend = new Resend(&quot;frs_your-api-key&quot;){"\n\n"}
            await resend.emails.send(&#123;{"\n"}
            &nbsp;&nbsp;from: &quot;hello@example.com&quot;,{"\n"}
            &nbsp;&nbsp;to: [&quot;user@email.com&quot;],{"\n"}
            &nbsp;&nbsp;subject: &quot;Hello&quot;,{"\n"}
            &nbsp;&nbsp;html: &quot;&lt;strong&gt;it works!&lt;/strong&gt;&quot;,{"\n"}
            &#125;)
          </pre>
        </div>
      </main>

      <footer className="border-t border-[#e5e5e5] py-6 text-center text-xs text-[#a3a3a3]">
        MIT Licensed &middot; FreeResend
      </footer>
    </div>
  );
}
