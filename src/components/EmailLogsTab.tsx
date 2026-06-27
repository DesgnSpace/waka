"use client";

import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/contexts/ToastContext";

interface EmailLog {
  id: string;
  from_email: string;
  to_emails: string[];
  subject: string;
  status:
    | "pending"
    | "sent"
    | "failed"
    | "delivered"
    | "bounced"
    | "complained";
  created_at: string;
  domains?: { domain: string };
  api_keys?: { key_name: string };
  html_content?: string;
  text_content?: string;
  error_message?: string;
}

interface Domain {
  id: string;
  domain: string;
}

const statusColor: Record<string, string> = {
  pending: "text-amber-700",
  sent: "text-blue-700",
  delivered: "text-green-700",
  failed: "text-red-700",
  bounced: "text-red-700",
  complained: "text-red-700",
};

export default function EmailLogsTab() {
  const [emails, setEmails] = useState<EmailLog[]>([]);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedEmail, setSelectedEmail] = useState<EmailLog | null>(null);
  const [filters, setFilters] = useState({
    domain_id: "",
    status: "",
    page: 1,
    limit: 50,
  });
  const { toast } = useToast();
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 50,
    total: 0,
    totalPages: 0,
  });

  const loadDomains = async () => {
    try {
      const response = await api.getDomains();
      setDomains(response.data.domains);
    } catch {
      toast("Couldn't load domains.", "error");
    }
  };

  const loadEmails = useCallback(async () => {
    setLoading(true);
    try {
      const params = Object.fromEntries(
        Object.entries(filters).filter(([, value]) => value !== "")
      );
      const response = await api.getEmailLogs(params);
      setEmails(response.data.emails);
      setPagination(response.data.pagination);
    } catch {
      toast("Couldn't load email logs. Try again.", "error");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    loadDomains();
  }, []);

  useEffect(() => {
    loadEmails();
  }, [loadEmails]);

  const handleEmailClick = async (emailId: string) => {
    try {
      const response = await api.getEmail(emailId);
      setSelectedEmail(response.data.email);
    } catch (error: unknown) {
      const errorObj = error as { message?: string };
      toast(errorObj.message || "Couldn't load email details. Try again.", "error");
    }
  };

  const handlePageChange = (newPage: number) => {
    setFilters({ ...filters, page: newPage });
  };

  if (loading && emails.length === 0) {
    return <p className="text-sm text-[#737373]">Loading email logs...</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Email Logs</h2>
        <p className="text-sm text-[#737373] mt-1">
          Track sends, deliveries, bounces, and complaints.
        </p>
      </div>

      {/* Filters */}
      <div className="border border-[#e5e5e5] rounded-lg p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="domain-filter" className="text-xs font-medium text-[#525252]">
              Domain
            </label>
            <select
              id="domain-filter"
              value={filters.domain_id}
              onChange={(e) =>
                setFilters({ ...filters, domain_id: e.target.value, page: 1 })
              }
              className="mt-1 block w-full rounded-lg border border-[#e5e5e5] px-3 py-2 text-sm text-[#171717] outline-none focus:border-[#171717] transition-colors"
            >
              <option value="">All domains</option>
              {domains.map((domain) => (
                <option key={domain.id} value={domain.id}>
                  {domain.domain}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="status-filter" className="text-xs font-medium text-[#525252]">
              Status
            </label>
            <select
              id="status-filter"
              value={filters.status}
              onChange={(e) =>
                setFilters({ ...filters, status: e.target.value, page: 1 })
              }
              className="mt-1 block w-full rounded-lg border border-[#e5e5e5] px-3 py-2 text-sm text-[#171717] outline-none focus:border-[#171717] transition-colors"
            >
              <option value="">All statuses</option>
              <option value="sent">Sent</option>
              <option value="delivered">Delivered</option>
              <option value="failed">Failed</option>
              <option value="bounced">Bounced</option>
              <option value="complained">Complained</option>
            </select>
          </div>

          <div>
            <label htmlFor="limit-filter" className="text-xs font-medium text-[#525252]">
              Per page
            </label>
            <select
              id="limit-filter"
              value={filters.limit}
              onChange={(e) =>
                setFilters({
                  ...filters,
                  limit: parseInt(e.target.value),
                  page: 1,
                })
              }
              className="mt-1 block w-full rounded-lg border border-[#e5e5e5] px-3 py-2 text-sm text-[#171717] outline-none focus:border-[#171717] transition-colors"
            >
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </select>
          </div>
        </div>
      </div>

      {/* Email List */}
      <div className="border border-[#e5e5e5] rounded-lg overflow-hidden">
        {emails.length === 0 ? (
          <p className="text-sm text-[#a3a3a3] p-5 text-center">
            No emails yet. Send your first email to see it here.
          </p>
        ) : (
          <>
            <ul className="divide-y divide-[#e5e5e5]">
              {emails.map((email) => (
                <li key={email.id}>
                  <button
                    onClick={() => handleEmailClick(email.id)}
                    className="w-full text-left px-5 py-4 hover:bg-[#fafafa] transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-medium truncate">
                            {email.subject || "(no subject)"}
                          </p>
                          <span className={`text-xs font-medium uppercase ml-3 ${statusColor[email.status] || ""}`}>
                            {email.status}
                          </span>
                        </div>
                        <div className="mt-1">
                          <p className="text-xs text-[#525252]">
                            From: {email.from_email}
                          </p>
                          <p className="text-xs text-[#525252]">
                            To: {email.to_emails.join(", ")}
                          </p>
                        </div>
                        <div className="mt-1 flex items-center gap-4 text-xs text-[#a3a3a3]">
                          <span>{email.domains?.domain}</span>
                          <span>{email.api_keys?.key_name}</span>
                          <span>{new Date(email.created_at).toLocaleString()}</span>
                        </div>
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>

            {pagination.totalPages > 1 && (
              <div className="border-t border-[#e5e5e5] px-5 py-3 flex items-center justify-between">
                <p className="text-xs text-[#737373]">
                  Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => handlePageChange(pagination.page - 1)}
                    disabled={pagination.page <= 1}
                    className="rounded-lg border border-[#e5e5e5] px-3 py-1.5 text-xs text-[#525252] hover:text-[#171717] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Previous
                  </button>
                  <button
                    onClick={() => handlePageChange(pagination.page + 1)}
                    disabled={pagination.page >= pagination.totalPages}
                    className="rounded-lg border border-[#e5e5e5] px-3 py-1.5 text-xs text-[#525252] hover:text-[#171717] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Email Detail Modal */}
      {selectedEmail && (
        <div className="fixed inset-0 bg-black/20 z-50 flex items-start justify-center pt-16">
          <div className="bg-white border border-[#e5e5e5] rounded-lg w-full max-w-4xl mx-4">
            <div className="p-5">
              <h3 className="text-base font-semibold mb-4">Email details</h3>

              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-xs text-[#737373]">From</span>
                    <div className="mt-0.5">{selectedEmail.from_email}</div>
                  </div>
                  <div>
                    <span className="text-xs text-[#737373]">Status</span>
                    <div className="mt-0.5">
                      <span className={`text-xs font-medium uppercase ${statusColor[selectedEmail.status] || ""}`}>
                        {selectedEmail.status}
                      </span>
                    </div>
                  </div>
                  <div>
                    <span className="text-xs text-[#737373]">To</span>
                    <div className="mt-0.5">
                      {selectedEmail.to_emails.join(", ")}
                    </div>
                  </div>
                  <div>
                    <span className="text-xs text-[#737373]">Created</span>
                    <div className="mt-0.5">
                      {new Date(selectedEmail.created_at).toLocaleString()}
                    </div>
                  </div>
                </div>

                <div>
                  <span className="text-xs text-[#737373]">Subject</span>
                    <div className="mt-0.5 text-sm">
                      {selectedEmail.subject || "(no subject)"}
                    </div>
                </div>

                {selectedEmail.html_content && (
                  <div>
                    <span className="text-xs text-[#737373]">HTML Content</span>
                    <div className="mt-1 bg-[#fafafa] border border-[#e5e5e5] rounded-lg p-4 max-h-64 overflow-y-auto">
                      <iframe
                        srcDoc={selectedEmail.html_content}
                        className="w-full h-48 border border-[#e5e5e5] rounded"
                        title="Email HTML Content"
                      />
                    </div>
                  </div>
                )}

                {selectedEmail.text_content && (
                  <div>
                    <span className="text-xs text-[#737373]">Text Content</span>
                    <div className="mt-1 bg-[#fafafa] border border-[#e5e5e5] rounded-lg p-4 max-h-64 overflow-y-auto whitespace-pre-wrap font-mono text-xs">
                      {selectedEmail.text_content}
                    </div>
                  </div>
                )}

                {selectedEmail.error_message && (
                  <div>
                    <span className="text-xs text-red-600">Error</span>
                    <div className="mt-0.5 text-sm text-red-600">
                      {selectedEmail.error_message}
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-6 flex justify-end">
                <button
                  onClick={() => setSelectedEmail(null)}
                  className="rounded-lg border border-[#e5e5e5] px-4 py-2 text-sm text-[#525252] hover:text-[#171717] transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
