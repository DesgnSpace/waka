import type { Metadata } from "next";
import Link from "next/link";
import EmailDnsChecker from "@/components/EmailDnsChecker";

export const metadata: Metadata = {
  title: "Email DNS readiness checker",
  description:
    "Check SPF, DMARC, DKIM, and MX records before launching a FreeResend or Amazon SES sending domain.",
};

export default function EmailDnsCheckerPage() {
  return (
    <main className="min-h-screen bg-white">
      <div className="border-b border-gray-200">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <Link href="/" className="text-sm font-semibold text-gray-700 hover:text-gray-950">
            FreeResend
          </Link>
          <div className="flex items-center gap-4 text-sm font-medium">
            <Link href="/guides/ses-production-readiness" className="text-gray-600 hover:text-gray-950">
              Guide
            </Link>
            <Link href="/tools/ses-production-request-helper" className="text-gray-600 hover:text-gray-950">
              SES request
            </Link>
          </div>
        </nav>
      </div>
      <EmailDnsChecker />
    </main>
  );
}
