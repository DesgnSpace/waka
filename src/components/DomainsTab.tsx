"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useToast } from "@/contexts/ToastContext";

interface Domain {
  id: string;
  domain: string;
  status: "pending" | "verified" | "failed";
  dns_records: Array<{
    type: string;
    name: string;
    value: string;
    ttl?: number;
    description?: string;
  }>;
  smtp_credentials?: {
    username: string;
    password: string;
    server: string;
    port: number;
  };
  created_at: string;
}

export default function DomainsTab() {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);
  const [addingDomain, setAddingDomain] = useState(false);
  const [newDomain, setNewDomain] = useState("");
  const [showSmtpModal, setShowSmtpModal] = useState<Domain | null>(null);
  const [generatingSmtp, setGeneratingSmtp] = useState(false);
  const [deletingSmtp, setDeletingSmtp] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    loadDomains();
  }, []);

  const loadDomains = async () => {
    try {
      const response = await api.getDomains();
      setDomains(response.data.domains);
    } catch {
      toast("Couldn't load domains. Try refreshing the page.", "error");
    } finally {
      setLoading(false);
    }
  };

  const handleAddDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDomain.trim()) return;

    setAddingDomain(true);
    try {
        const response = await api.addDomain(newDomain.trim());
      setDomains([response.data.domain, ...domains]);
      setNewDomain("");
    } catch (error: unknown) {
      const errorObj = error as { message?: string };
      toast(errorObj.message || "Couldn't add domain. Check the domain and try again.", "error");
    } finally {
      setAddingDomain(false);
    }
  };

  const handleVerifyDomain = async (domainId: string) => {
    try {
      const response = await api.verifyDomain(domainId);
      await loadDomains();
      toast(response.message);
    } catch (error: unknown) {
      const errorObj = error as { message?: string };
      toast(errorObj.message || "Couldn't verify domain. Wait for DNS to propagate, then try again.", "error");
    }
  };

  const handleDeleteDomain = async (domainId: string) => {
    if (!confirm("Delete this domain? This also removes its API keys and SMTP credentials.")) return;

    try {
      await api.deleteDomain(domainId);
      setDomains(domains.filter((d) => d.id !== domainId));
    } catch (error: unknown) {
      const errorObj = error as { message?: string };
      toast(errorObj.message || "Couldn't delete domain. Try again.", "error");
    }
  };

  const handleGenerateSmtp = async (domainId: string) => {
    setGeneratingSmtp(true);
    try {
      const token = localStorage.getItem("auth_token");
      const response = await fetch(`/api/domains/${domainId}/smtp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Couldn't generate SMTP credentials. Try again.");
      }

      await loadDomains();
      const updatedDomain = domains.find((d) => d.id === domainId);
      if (updatedDomain) {
        setShowSmtpModal({ ...updatedDomain, smtp_credentials: data.credentials });
      }
      toast("SMTP credentials generated. Copy the password before closing.");
    } catch (error: unknown) {
      const errorObj = error as { message?: string };
      toast(errorObj.message || "Couldn't generate SMTP credentials. Try again.", "error");
    } finally {
      setGeneratingSmtp(false);
    }
  };

  const handleDeleteSmtp = async (domainId: string) => {
    if (!confirm("Delete these SMTP credentials? This removes the IAM user from AWS.")) return;

    setDeletingSmtp(true);
    try {
      const token = localStorage.getItem("auth_token");
      const response = await fetch(`/api/domains/${domainId}/smtp`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Couldn't delete SMTP credentials. Try again.");
      }

      await loadDomains();
      setShowSmtpModal(null);
      toast("SMTP credentials deleted.");
    } catch (error: unknown) {
      const errorObj = error as { message?: string };
      toast(errorObj.message || "Couldn't delete SMTP credentials. Try again.", "error");
    } finally {
      setDeletingSmtp(false);
    }
  };

  const statusColor = (status: Domain["status"]) => {
    switch (status) {
      case "verified": return "text-green-700";
      case "failed": return "text-red-700";
      default: return "text-amber-700";
    }
  };

  if (loading) {
    return <p className="text-sm text-[#737373]">Loading domains...</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Domains</h2>
        <p className="text-sm text-[#737373] mt-1">
          Add a domain, publish the DNS records, then verify it to start sending.
        </p>
      </div>

      {/* Add Domain Form */}
      <div className="border border-[#e5e5e5] rounded-lg p-5">
        <div className="text-sm font-medium mb-1">Add domain</div>
        <p className="text-xs text-[#737373] mb-3">Use a domain you own, such as example.com.</p>
        <form onSubmit={handleAddDomain} className="flex gap-3">
          <input
            type="text"
            placeholder="example.com"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            className="flex-1 max-w-xs rounded-lg border border-[#e5e5e5] px-3 py-2 text-sm text-[#171717] outline-none focus:border-[#171717] transition-colors"
            disabled={addingDomain}
          />
          <button
            type="submit"
            disabled={addingDomain || !newDomain.trim()}
            className="rounded-lg bg-[#171717] px-4 py-2 text-sm font-medium text-white hover:bg-[#404040] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {addingDomain ? "Adding..." : "Add domain"}
          </button>
        </form>
      </div>

      {/* Domains List */}
      <div className="border border-[#e5e5e5] rounded-lg overflow-hidden">
        {domains.length === 0 ? (
          <p className="text-sm text-[#a3a3a3] p-5 text-center">
            No domains yet. Add a domain to start sending email.
          </p>
        ) : (
          <ul className="divide-y divide-[#e5e5e5]">
            {domains.map((domain) => (
              <li key={domain.id} className="px-5 py-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className={`text-xs font-medium uppercase ${statusColor(domain.status)}`}>
                    {domain.status}
                  </span>
                  <div>
                    <div className="text-sm font-medium">{domain.domain}</div>
                    <div className="text-xs text-[#a3a3a3]">
                      Added {new Date(domain.created_at).toLocaleDateString()}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  {domain.status === "pending" && (
                    <>
                      <Link
                        href={`/domains/${domain.id}/dns`}
                        className="text-[#525252] hover:text-[#171717] transition-colors"
                      >
                        View DNS records
                      </Link>
                      <button
                        onClick={() => handleVerifyDomain(domain.id)}
                        className="text-[#525252] hover:text-[#171717] transition-colors"
                      >
                        Check verification
                      </button>
                    </>
                  )}
                  {domain.status === "verified" && (
                    <>
                      {domain.smtp_credentials ? (
                        <button
                          onClick={() => setShowSmtpModal(domain)}
                          className="text-[#525252] hover:text-[#171717] transition-colors"
                        >
                          View SMTP
                        </button>
                      ) : (
                        <button
                          onClick={() => handleGenerateSmtp(domain.id)}
                          disabled={generatingSmtp}
                          className="text-[#525252] hover:text-[#171717] transition-colors disabled:opacity-50"
                        >
                          {generatingSmtp ? "Generating..." : "Generate SMTP"}
                        </button>
                      )}
                    </>
                  )}
                  <button
                    onClick={() => handleDeleteDomain(domain.id)}
                    className="text-red-600 hover:text-red-800 transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* SMTP Credentials Modal */}
      {showSmtpModal && showSmtpModal.smtp_credentials && (
        <div className="fixed inset-0 bg-black/20 z-50 flex items-start justify-center pt-16">
          <div className="bg-white border border-[#e5e5e5] rounded-lg w-full max-w-2xl mx-4">
            <div className="p-5">
              <h3 className="text-base font-semibold mb-1">
                SMTP credentials for {showSmtpModal.domain}
              </h3>
              <p className="text-sm text-[#737373] mb-4">
                Use these credentials in any SMTP client.
              </p>

              <div className="space-y-4">
                <div className="bg-[#fafafa] border border-[#e5e5e5] rounded-lg p-4">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-xs text-[#737373]">Server</span>
                      <div className="mt-0.5 font-mono text-xs bg-white border border-[#e5e5e5] rounded p-2">
                        {showSmtpModal.smtp_credentials.server}
                      </div>
                    </div>
                    <div>
                      <span className="text-xs text-[#737373]">Port</span>
                      <div className="mt-0.5 font-mono text-xs bg-white border border-[#e5e5e5] rounded p-2">
                        {showSmtpModal.smtp_credentials.port}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-[#fafafa] border border-[#e5e5e5] rounded-lg p-4">
                  <div className="space-y-4">
                    <div>
                      <span className="text-xs text-[#737373]">Username</span>
                      <div className="mt-0.5 font-mono text-xs bg-white border border-[#e5e5e5] rounded p-2 break-all">
                        {showSmtpModal.smtp_credentials.username}
                      </div>
                    </div>
                    <div>
                      <span className="text-xs text-[#737373]">Password</span>
                      <div className="mt-0.5 font-mono text-xs bg-white border border-[#e5e5e5] rounded p-2 break-all">
                        {showSmtpModal.smtp_credentials.password}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                  <p className="text-xs text-amber-800">
                    <strong>Important:</strong> Copy the password now. It can&apos;t be shown again after you close this dialog.
                  </p>
                </div>
              </div>

              <div className="mt-6 flex justify-end gap-3">
                <button
                  onClick={() => handleDeleteSmtp(showSmtpModal.id)}
                  disabled={deletingSmtp}
                  className="rounded-lg border border-red-300 px-4 py-2 text-sm text-red-700 hover:bg-red-50 transition-colors disabled:opacity-50"
                >
                  {deletingSmtp ? "Deleting..." : "Delete credentials"}
                </button>
                <button
                  onClick={() => setShowSmtpModal(null)}
                  className="rounded-lg bg-[#171717] px-4 py-2 text-sm text-white hover:bg-[#404040] transition-colors"
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
