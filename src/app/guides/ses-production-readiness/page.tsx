import type { Metadata } from "next";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  MailCheck,
  Radar,
  ShieldCheck,
  Siren,
  Workflow,
} from "lucide-react";

export const metadata: Metadata = {
  title: "FreeResend SES production readiness guide",
  description:
    "A practical SES, DNS, webhook, monitoring, and rollback checklist for teams preparing a FreeResend deployment for production email.",
};

const readinessSteps = [
  {
    icon: ShieldCheck,
    title: "Authenticate the sending domain",
    copy: "Verify the domain in SES, publish DKIM records, keep SPF aligned with the real sender, and set a DMARC policy that reports failures before it rejects mail.",
    checks: ["DKIM records resolve", "SPF includes the sending path", "DMARC reporting address works"],
  },
  {
    icon: MailCheck,
    title: "Move SES out of sandbox deliberately",
    copy: "Confirm the production region, requested daily quota, expected peak send rate, suppression list behavior, and the account identity that will own the launch.",
    checks: ["Production access approved", "Quota matches first-week traffic", "Region matches app config"],
  },
  {
    icon: Workflow,
    title: "Wire bounce and complaint events",
    copy: "Use SNS or EventBridge to feed FreeResend webhook handling, then test the path before any customer-facing transactional mail depends on it.",
    checks: ["Bounce path tested", "Complaint path tested", "Suppression updates observable"],
  },
  {
    icon: Radar,
    title: "Run a production smoke test",
    copy: "Send a low-volume test from the production app path, inspect headers, confirm logs, and make sure rollback does not require editing secrets in a hurry.",
    checks: ["Headers show aligned domain", "App logs preserve message IDs", "Rollback owner is named"],
  },
];

const launchRisks = [
  "SES remains in sandbox while the app is already configured for production traffic.",
  "A DMARC record exists, but reports go nowhere or the policy hides DKIM alignment failures.",
  "Bounce and complaint webhooks are configured after launch instead of before the first real send.",
  "The team has no low-risk rollback path if DNS, secrets, or SES quotas are wrong.",
];

const handoffQuestions = [
  "Which domain and subdomain will send transactional mail?",
  "Which AWS account, SES region, and quota request own this launch?",
  "Where do bounces, complaints, and delivery events appear after a send?",
  "Who can roll back the sender configuration during the first production hour?",
];

export default function SesProductionReadinessPage() {
  return (
    <main className="min-h-screen bg-white">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:px-8">
        <nav className="mb-10 flex items-center justify-between">
          <Link href="/" className="text-sm font-medium text-[#525252] hover:text-[#171717]">
            FreeResend
          </Link>
          <div className="flex items-center gap-4 text-sm font-medium">
            <Link href="/tools/email-dns-checker" className="text-[#525252] hover:text-[#171717]">
              DNS checker
            </Link>
            <Link href="/tools/ses-production-request-helper" className="text-[#525252] hover:text-[#171717]">
              SES request
            </Link>
          </div>
        </nav>

        <section className="max-w-3xl">
          <p className="text-xs font-medium uppercase tracking-wide text-[#737373] mb-3">
            Production checklist
          </p>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            SES production readiness guide
          </h1>
          <p className="mt-4 text-[#525252] leading-7">
            Use this guide before pointing a real application at FreeResend. It focuses on the launch details that
            usually create the first production incident: SES sandbox access, DNS authentication, webhook coverage,
            smoke tests, monitoring, and rollback ownership.
          </p>
          <div className="mt-6 flex flex-col sm:flex-row gap-3">
            <Link
              href="/tools/email-dns-checker"
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#171717] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#404040] transition-colors"
            >
              <MailCheck className="h-4 w-4" />
              Run DNS checker
            </Link>
            <Link
              href="/tools/ses-production-request-helper"
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#e5e5e5] px-5 py-2.5 text-sm font-medium text-[#525252] hover:text-[#171717] hover:border-[#d4d4d4] transition-colors"
            >
              <ClipboardCheck className="h-4 w-4" />
              Draft SES request
            </Link>
          </div>
        </section>

        <section className="mt-16 grid gap-5 md:grid-cols-2">
          {readinessSteps.map((step) => {
            const Icon = step.icon;
            return (
              <article key={step.title} className="border border-[#e5e5e5] rounded-lg p-6">
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-[#f5f5f5]">
                  <Icon className="h-5 w-5" />
                </div>
                <h2 className="text-base font-semibold">{step.title}</h2>
                <p className="mt-2 text-sm leading-6 text-[#525252]">{step.copy}</p>
                <ul className="mt-4 space-y-2">
                  {step.checks.map((check) => (
                    <li key={check} className="flex gap-2 text-sm text-[#525252]">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none text-green-600" />
                      <span>{check}</span>
                    </li>
                  ))}
                </ul>
              </article>
            );
          })}
        </section>

        <section className="mt-16 grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="border border-amber-200 bg-amber-50 rounded-lg p-6">
            <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-white">
              <AlertTriangle className="h-5 w-5 text-amber-700" />
            </div>
            <h2 className="text-base font-semibold text-amber-900">Common launch risks</h2>
            <ul className="mt-4 space-y-3">
              {launchRisks.map((risk) => (
                <li key={risk} className="flex gap-2 text-sm leading-6 text-amber-800">
                  <Siren className="mt-0.5 h-4 w-4 flex-none text-amber-600" />
                  <span>{risk}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="border border-[#e5e5e5] rounded-lg p-6">
            <p className="text-xs font-medium uppercase tracking-wide text-[#737373]">Handoff questions</p>
            <h2 className="mt-2 text-base font-semibold">What a reviewer needs before launch</h2>
            <p className="mt-2 text-sm leading-6 text-[#525252]">
              A useful deployment review needs the public sending domain, the intended SES region, and
              the specific risks you want checked before production traffic.
            </p>
            <ul className="mt-4 space-y-2">
              {handoffQuestions.map((question) => (
                <li key={question} className="flex gap-2 text-sm text-[#525252]">
                  <span className="mt-1.5 h-1.5 w-1.5 flex-none rounded-full bg-[#d4d4d4]" />
                  <span>{question}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </main>
  );
}
