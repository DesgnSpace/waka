"use client";

import { useState, useEffect } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/contexts/ToastContext";

interface Domain {
  id: string;
  domain: string;
  status: string;
}

interface ApiKey {
  id: string;
  domain_id: string;
  key_name: string;
  key_prefix: string;
  permissions: string[];
  last_used_at?: string;
  created_at: string;
  domains?: { domain: string };
}

export default function ApiKeysTab() {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newKey, setNewKey] = useState({
    domainId: "",
    keyName: "",
    permissions: ["send"],
  });
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [apiKeysResponse, domainsResponse] = await Promise.all([
        api.getApiKeys(),
        api.getDomains(),
      ]);
      setApiKeys(apiKeysResponse.data.apiKeys);
      setDomains(
        domainsResponse.data.domains.filter(
          (d: Domain) => d.status === "verified"
        )
      );
    } catch {
      toast("Couldn't load API keys. Try refreshing the page.", "error");
    } finally {
      setLoading(false);
    }
  };

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKey.domainId || !newKey.keyName.trim()) return;

    setCreating(true);
    try {
      const response = await api.createApiKey(
        newKey.domainId,
        newKey.keyName.trim(),
        newKey.permissions
      );
      setApiKeys([response.data.apiKey, ...apiKeys]);
      setCreatedKey(response.data.apiKey.key);
      setNewKey({ domainId: "", keyName: "", permissions: ["send"] });
      setShowCreateForm(false);
    } catch (error: unknown) {
      const errorObj = error as { message?: string };
      toast(errorObj.message || "Couldn't create API key. Try again.", "error");
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteKey = async (keyId: string) => {
    if (
      !confirm(
        "Delete this API key? Apps using it will stop sending email immediately."
      )
    )
      return;

    try {
      await api.deleteApiKey(keyId);
      setApiKeys(apiKeys.filter((k) => k.id !== keyId));
    } catch (error: unknown) {
      const errorObj = error as { message?: string };
      toast(errorObj.message || "Couldn't delete API key. Try again.", "error");
    }
  };

  const maskApiKey = (keyPrefix: string) => {
    return `${keyPrefix}_${"*".repeat(32)}`;
  };

  if (loading) {
    return <p className="text-sm text-[#737373]">Loading API keys...</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold">API keys</h2>
          <p className="text-sm text-[#737373] mt-1">
            Create keys for each verified domain. Use them with the Resend SDK.
          </p>
        </div>
        <button
          onClick={() => setShowCreateForm(true)}
          disabled={domains.length === 0}
          className="rounded-lg bg-[#171717] px-4 py-2 text-sm font-medium text-white hover:bg-[#404040] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Create API key
        </button>
      </div>

      {domains.length === 0 && (
        <div className="border border-amber-200 bg-amber-50 rounded-lg p-4">
          <p className="text-sm text-amber-800">
            Add and verify a domain before you can create API keys.
          </p>
        </div>
      )}

      {/* Create API Key Form */}
      {showCreateForm && domains.length > 0 && (
        <div className="border border-[#e5e5e5] rounded-lg p-5">
          <h3 className="text-sm font-semibold mb-4">Create API key</h3>
          <form onSubmit={handleCreateKey} className="space-y-4">
            <div>
              <label htmlFor="domain" className="text-sm font-medium text-[#171717]">
                Domain
              </label>
              <select
                id="domain"
                value={newKey.domainId}
                onChange={(e) =>
                  setNewKey({ ...newKey, domainId: e.target.value })
                }
                className="mt-1 block w-full max-w-xs rounded-lg border border-[#e5e5e5] px-3 py-2 text-sm text-[#171717] outline-none focus:border-[#171717] transition-colors"
                required
              >
                <option value="">Select domain</option>
                {domains.map((domain) => (
                  <option key={domain.id} value={domain.id}>
                    {domain.domain}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="keyName" className="text-sm font-medium text-[#171717]">
                Key Name
              </label>
              <input
                type="text"
                id="keyName"
                value={newKey.keyName}
                onChange={(e) =>
                  setNewKey({ ...newKey, keyName: e.target.value })
                }
                placeholder="e.g., Production"
                className="mt-1 block w-full max-w-xs rounded-lg border border-[#e5e5e5] px-3 py-2 text-sm text-[#171717] outline-none focus:border-[#171717] transition-colors"
                required
              />
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setShowCreateForm(false)}
                className="rounded-lg border border-[#e5e5e5] px-4 py-2 text-sm text-[#525252] hover:text-[#171717] transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={creating}
                className="rounded-lg bg-[#171717] px-4 py-2 text-sm text-white hover:bg-[#404040] transition-colors disabled:opacity-50"
              >
                {creating ? "Creating..." : "Create key"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Created API Key Display */}
      {createdKey && (
        <div className="border border-green-200 bg-green-50 rounded-lg p-4">
          <p className="text-sm font-medium text-green-800 mb-1">
            API key created
          </p>
          <p className="text-xs text-green-700 mb-2">
            Copy this key now. It won&apos;t be shown again.
          </p>
          <div className="bg-white border border-green-200 rounded p-3 font-mono text-sm break-all">
            {createdKey}
          </div>
          <button
            onClick={() => {
              navigator.clipboard.writeText(createdKey);
              toast("API key copied to clipboard!");
            }}
            className="mt-2 text-xs text-green-700 hover:text-green-900"
          >
            Copy
          </button>
          <button
            onClick={() => setCreatedKey(null)}
            className="block mt-2 text-xs text-green-700 hover:text-green-900"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* API Keys List */}
      <div className="border border-[#e5e5e5] rounded-lg overflow-hidden">
        {apiKeys.length === 0 ? (
          <p className="text-sm text-[#a3a3a3] p-5 text-center">
            No API keys yet. Create one to start sending email.
          </p>
        ) : (
          <ul className="divide-y divide-[#e5e5e5]">
            {apiKeys.map((key) => (
              <li key={key.id} className="px-5 py-4 flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">{key.key_name}</div>
                  <div className="text-xs text-[#a3a3a3]">
                    Domain: {key.domains?.domain || "Unknown"}
                  </div>
                  <div className="text-xs text-[#a3a3a3] font-mono">
                    {maskApiKey(key.key_prefix)}
                  </div>
                  <div className="text-xs text-[#a3a3a3]">
                    Created {new Date(key.created_at).toLocaleDateString()}
                    {key.last_used_at && (
                      <span>
                        {" "}• Last used {new Date(key.last_used_at).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs bg-[#f5f5f5] border border-[#e5e5e5] rounded px-2 py-0.5">
                    {key.permissions.join(", ")}
                  </span>
                  <button
                    onClick={() => handleDeleteKey(key.id)}
                    className="text-xs text-red-600 hover:text-red-800 transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
