"use client";

import { FormEvent, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  MailCheck,
  Search,
  XCircle,
} from "lucide-react";
import type { EmailDnsAssessment, EmailDnsCheck, EmailDnsStatus } from "@/lib/email-dns-readiness";

const statusStyles: Record<EmailDnsStatus, { label: string; icon: typeof CheckCircle2; className: string }> = {
  pass: {
    label: "Pass",
    icon: CheckCircle2,
    className: "border-green-200 bg-green-50 text-green-800",
  },
  warn: {
    label: "Review",
    icon: AlertTriangle,
    className: "border-amber-200 bg-amber-50 text-amber-900",
  },
  fail: {
    label: "Fix",
    icon: XCircle,
    className: "border-red-200 bg-red-50 text-red-800",
  },
  info: {
    label: "Info",
    icon: Info,
    className: "border-blue-200 bg-blue-50 text-blue-800",
  },
};

function StatusPill({ status }: { status: EmailDnsStatus }) {
  const style = statusStyles[status];
  const Icon = style.icon;

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${style.className}`}>
      <Icon className="h-3.5 w-3.5" />
      {style.label}
    </span>
  );
}

function CheckCard({ check }: { check: EmailDnsCheck }) {
  return (
    <article className="rounded-lg border border-[#e5e5e5] bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{check.title}</h3>
          <p className="mt-1 text-xs text-[#525252]">{check.summary}</p>
        </div>
        <StatusPill status={check.status} />
      </div>

      <ul className="mt-4 space-y-1.5 text-xs leading-6 text-[#525252]">
        {check.details.map((detail) => (
          <li key={detail} className="flex gap-2">
            <span className="mt-2 h-1 w-1 flex-none rounded-full bg-[#d4d4d4]" />
            <span>{detail}</span>
          </li>
        ))}
      </ul>

      {check.records.length > 0 ? (
        <div className="mt-4 rounded-md border border-[#e5e5e5] bg-[#fafafa]">
          {check.records.map((record) => (
            <code key={record} className="block break-words px-3 py-1.5 text-xs leading-5 text-[#525252]">
              {record}
            </code>
          ))}
        </div>
      ) : null}
    </article>
  );
}

export default function EmailDnsChecker() {
  const [domain, setDomain] = useState("");
  const [dkimSelector, setDkimSelector] = useState("");
  const [result, setResult] = useState<EmailDnsAssessment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const resultTitle = useMemo(() => {
    if (!result) return "Check your sending domain";
    if (result.overallStatus === "fail") return "Fix these records before launch";
    if (result.overallStatus === "warn") return "Review these DNS warnings";
    return "DNS looks ready";
  }, [result]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch("/api/tools/email-dns-checker", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, dkimSelector }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error ?? "Couldn't check DNS. Try again.");
      }

      setResult(payload as EmailDnsAssessment);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      <div className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
        <div className="rounded-lg border border-[#e5e5e5] bg-white p-6">
          <div className="mb-5 flex h-10 w-10 items-center justify-center rounded-lg bg-[#f5f5f5]">
            <MailCheck className="h-5 w-5" />
          </div>
          <h1 className="text-xl font-bold">
            Email DNS readiness checker
          </h1>
          <p className="mt-2 text-sm leading-6 text-[#525252]">
            Check SPF, DMARC, MX, and one DKIM selector before launching a Waka or Amazon SES domain.
          </p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div>
              <label htmlFor="domain" className="text-sm font-medium">
                Sending domain
              </label>
              <input
                id="domain"
                value={domain}
                onChange={(event) => setDomain(event.target.value)}
                placeholder="example.com"
                className="mt-1 w-full rounded-lg border border-[#e5e5e5] px-3 py-2 text-sm outline-none focus:border-[#171717] transition-colors"
                autoComplete="off"
              />
            </div>

            <div>
              <label htmlFor="dkimSelector" className="text-sm font-medium">
                DKIM selector
              </label>
              <input
                id="dkimSelector"
                value={dkimSelector}
                onChange={(event) => setDkimSelector(event.target.value)}
                placeholder="optional"
                className="mt-1 w-full rounded-lg border border-[#e5e5e5] px-3 py-2 text-sm outline-none focus:border-[#171717] transition-colors"
                autoComplete="off"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#171717] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#404040] transition-colors disabled:bg-[#a3a3a3] disabled:cursor-not-allowed"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              <span>{loading ? "Checking DNS..." : "Run DNS check"}</span>
            </button>
          </form>

          {error ? (
            <p className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>
          ) : null}

          <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
            Never paste AWS keys, SMTP passwords, database URLs, or private tokens into this checker.
          </div>
        </div>

        <div className="space-y-5">
          <div className="rounded-lg border border-[#e5e5e5] bg-white p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-[#737373]">
                  {result?.domain ?? "Waka"}
                </p>
                <h2 className="mt-1 text-lg font-bold">{resultTitle}</h2>
                <p className="mt-1 text-sm leading-6 text-[#525252]">
                  {result?.summary ?? "Run the checker to see which DNS records need attention before launch."}
                </p>
              </div>
              {result ? <StatusPill status={result.overallStatus} /> : null}
            </div>
          </div>

          {result ? (
            <>
              <div className="grid gap-4 md:grid-cols-2">
                {result.checks.map((check) => (
                  <CheckCard key={check.id} check={check} />
                ))}
              </div>

              {result.lookupErrors.length > 0 ? (
                <div className="rounded-lg border border-[#e5e5e5] bg-white p-4 text-sm text-[#525252]">
                  DNS lookup warnings: {result.lookupErrors.join("; ")}
                </div>
              ) : null}
            </>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {["SPF", "DMARC", "DKIM", "MX"].map((item) => (
                <div key={item} className="rounded-lg border border-dashed border-[#e5e5e5] bg-white p-5">
                  <div className="h-2 w-14 rounded bg-[#f5f5f5]" />
                  <div className="mt-4 text-sm font-semibold text-[#a3a3a3]">{item}</div>
                  <div className="mt-3 h-2 w-full rounded bg-[#f5f5f5]" />
                  <div className="mt-2 h-2 w-2/3 rounded bg-[#f5f5f5]" />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
