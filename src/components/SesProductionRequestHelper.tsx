"use client";

import { FormEvent, useMemo, useState } from "react";
import { Check, Clipboard, FileText } from "lucide-react";
import { buildSesProductionRequest, type SesProductionRequestInput } from "@/lib/ses-production-request";

const initialInput: SesProductionRequestInput = {
  sendingDomain: "",
  websiteUrl: "",
  region: "us-east-1",
  useCase: "",
  expectedVolume: "",
  optInSource: "",
  bounceHandling: "",
  complaintHandling: "",
};

export default function SesProductionRequestHelper() {
  const [input, setInput] = useState<SesProductionRequestInput>(initialInput);
  const [submittedInput, setSubmittedInput] = useState<SesProductionRequestInput | null>(null);
  const [copied, setCopied] = useState<"subject" | "body" | null>(null);

  const request = useMemo(
    () => buildSesProductionRequest(submittedInput ?? input),
    [input, submittedInput]
  );

  function updateInput(field: keyof SesProductionRequestInput, value: string) {
    setInput((current) => ({ ...current, [field]: value }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmittedInput(input);
  }

  async function copyText(kind: "subject" | "body", value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1800);
  }

  return (
    <section className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      <div className="grid gap-8 lg:grid-cols-[0.92fr_1.08fr] lg:items-start">
        <form onSubmit={handleSubmit} className="rounded-lg border border-[#e5e5e5] bg-white p-6">
          <div className="mb-5 flex h-10 w-10 items-center justify-center rounded-lg bg-[#f5f5f5]">
            <FileText className="h-5 w-5" />
          </div>
          <h1 className="text-xl font-bold">SES production request helper</h1>
          <p className="mt-2 text-sm leading-6 text-[#525252]">
            Draft an Amazon SES production access request from public rollout details before a FreeResend launch.
          </p>

          <div className="mt-6 grid gap-4">
            <Field
              id="sendingDomain"
              label="Sending domain"
              placeholder="example.com"
              value={input.sendingDomain}
              onChange={(value) => updateInput("sendingDomain", value)}
              required
            />
            <Field
              id="websiteUrl"
              label="Website or app URL"
              placeholder="https://example.com"
              value={input.websiteUrl}
              onChange={(value) => updateInput("websiteUrl", value)}
            />
            <Field
              id="region"
              label="AWS region"
              placeholder="us-east-1"
              value={input.region}
              onChange={(value) => updateInput("region", value)}
              required
            />
            <TextArea
              id="useCase"
              label="Use case"
              placeholder="Password resets, login codes, invoices, and account notifications"
              value={input.useCase}
              onChange={(value) => updateInput("useCase", value)}
            />
            <Field
              id="expectedVolume"
              label="Expected volume"
              placeholder="2,000 messages per month with gradual ramp-up"
              value={input.expectedVolume}
              onChange={(value) => updateInput("expectedVolume", value)}
            />
            <TextArea
              id="optInSource"
              label="Recipient opt-in/source"
              placeholder="Only registered users who request account email"
              value={input.optInSource}
              onChange={(value) => updateInput("optInSource", value)}
            />
            <TextArea
              id="bounceHandling"
              label="Bounce handling"
              placeholder="SNS webhook into FreeResend bounce handler"
              value={input.bounceHandling}
              onChange={(value) => updateInput("bounceHandling", value)}
            />
            <TextArea
              id="complaintHandling"
              label="Complaint handling"
              placeholder="SNS complaint webhook with suppression"
              value={input.complaintHandling}
              onChange={(value) => updateInput("complaintHandling", value)}
            />
          </div>

          <button
            type="submit"
            className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#171717] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#404040] transition-colors"
          >
            <FileText className="h-4 w-4" />
            <span>Generate request</span>
          </button>

          <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
            Don&apos;t paste AWS keys, SMTP passwords, customer lists, private logs, or customer data into this tool.
          </div>
        </form>

        <div className="space-y-5">
          <article className="rounded-lg border border-[#e5e5e5] bg-white p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-[#737373]">Draft output</p>
                <h2 className="mt-1 text-lg font-bold">{request.subject}</h2>
              </div>
              <button
                type="button"
                onClick={() => copyText("subject", request.subject)}
                className="inline-flex items-center gap-2 rounded-lg border border-[#e5e5e5] px-3 py-1.5 text-xs font-medium text-[#525252] hover:text-[#171717] hover:border-[#d4d4d4] transition-colors"
              >
                {copied === "subject" ? <Check className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}
                <span>Copy subject</span>
              </button>
            </div>
            <pre className="mt-5 max-h-[560px] overflow-auto whitespace-pre-wrap rounded-lg border border-[#e5e5e5] bg-[#171717] p-4 text-xs leading-6 text-[#a3e635] font-mono">
              {request.body}
            </pre>
            <button
              type="button"
              onClick={() => copyText("body", request.body)}
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-[#171717] px-4 py-2 text-xs font-medium text-white hover:bg-[#404040] transition-colors"
            >
              {copied === "body" ? <Check className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}
              <span>Copy request body</span>
            </button>
          </article>
        </div>
      </div>
    </section>
  );
}

function Field({
  id,
  label,
  placeholder,
  value,
  onChange,
  required = false,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required={required}
        className="mt-1 w-full rounded-lg border border-[#e5e5e5] px-3 py-2 text-sm outline-none focus:border-[#171717] transition-colors"
      />
    </div>
  );
}

function TextArea({
  id,
  label,
  placeholder,
  value,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={3}
        className="mt-1 w-full resize-y rounded-lg border border-[#e5e5e5] px-3 py-2 text-sm outline-none focus:border-[#171717] transition-colors"
      />
    </div>
  );
}
