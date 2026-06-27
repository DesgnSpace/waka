import type { Metadata } from "next";
import Link from "next/link";
import SesProductionRequestHelper from "@/components/SesProductionRequestHelper";

export const metadata: Metadata = {
  title: "SES production request helper",
  description:
    "Draft a safe Amazon SES production access request for a FreeResend launch without sharing secrets or customer data.",
};

export default function SesProductionRequestHelperPage() {
  return (
    <main className="min-h-screen bg-white">
      <div className="border-b border-gray-200">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <Link href="/" className="text-sm font-semibold text-gray-700 hover:text-gray-950">
            FreeResend
          </Link>
          <div className="flex items-center gap-4 text-sm font-medium">
            <Link href="/tools/email-dns-checker" className="text-gray-600 hover:text-gray-950">
              DNS checker
            </Link>
            <Link href="/guides/ses-production-readiness" className="text-gray-600 hover:text-gray-950">
              Guide
            </Link>
          </div>
        </nav>
      </div>
      <SesProductionRequestHelper />
    </main>
  );
}
