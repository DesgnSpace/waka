import crypto from "crypto";

import { TtlCache } from "./ttl-cache";

// Amazon SNS HTTP(S) message signature validation.
//
// Verifies that an incoming SNS message genuinely originates from AWS before we
// act on it (confirm a subscription, mutate email_logs, etc). Without this, the
// public /api/webhooks/ses endpoint would trust any forged POST.
//
// Spec: https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html

export interface SnsMessage {
  Type: string;
  MessageId: string;
  Token?: string;
  TopicArn?: string;
  Subject?: string;
  Message: string;
  SubscribeURL?: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL?: string;
  // legacy spelling seen in some payloads
  SigningCertUrl?: string;
  UnsubscribeURL?: string;
}

// Keys that are signed, in the exact order AWS uses, per message type.
const SIGNED_KEYS: Record<string, Array<keyof SnsMessage>> = {
  Notification: ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"],
  SubscriptionConfirmation: [
    "Message",
    "MessageId",
    "SubscribeURL",
    "Timestamp",
    "Token",
    "TopicArn",
    "Type",
  ],
  UnsubscribeConfirmation: [
    "Message",
    "MessageId",
    "SubscribeURL",
    "Timestamp",
    "Token",
    "TopicArn",
    "Type",
  ],
};

// AWS rotates signing certificates rarely, so a one-hour TTL bounds how long a
// stale certificate can keep validating (or rejecting) signatures after
// rotation. 50 entries is far above the handful of distinct cert URLs SNS uses,
// keeping memory bounded without evicting live traffic.
const CERT_CACHE_TTL_MS = 60 * 60 * 1000;
const CERT_CACHE_MAX_ENTRIES = 50;
const certCache = new TtlCache<string>(CERT_CACHE_TTL_MS, CERT_CACHE_MAX_ENTRIES);
const CERT_FETCH_TIMEOUT_MS = 5000;
const CERT_MAX_BYTES = 64 * 1024;
const snsHostPattern = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/i;

function isValidSnsUrl(rawUrl: string): URL | null {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && snsHostPattern.test(url.hostname)
      ? url
      : null;
  } catch {
    return null;
  }
}

// Only fetch signing certs from genuine AWS SNS hosts (prevents SSRF / a forged
// SigningCertURL pointing at an attacker-controlled cert).
function isValidCertUrl(rawUrl: string): boolean {
  const url = isValidSnsUrl(rawUrl);
  return url !== null && url.pathname.endsWith(".pem");
}

async function fetchCert(certUrl: string): Promise<string> {
  const cached = certCache.get(certUrl, Date.now());
  if (cached) return cached;

  const failed = () => new Error(`Couldn't fetch SNS signing certificate: ${certUrl}`);

  let res: Response;
  try {
    res = await fetch(certUrl, { signal: AbortSignal.timeout(CERT_FETCH_TIMEOUT_MS) });
  } catch {
    throw failed();
  }
  if (!res.ok || !res.body) throw failed();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > CERT_MAX_BYTES) {
      await reader.cancel();
      throw failed();
    }
    chunks.push(value);
  }

  const pem = Buffer.concat(chunks).toString("utf8");
  certCache.set(certUrl, pem, Date.now());
  return pem;
}

function buildStringToSign(message: SnsMessage): string | null {
  const keys = SIGNED_KEYS[message.Type];
  if (!keys) return null;

  let str = "";
  for (const key of keys) {
    const value = message[key];
    // Subject is optional: skip when absent (AWS omits it from the signed string).
    if (value === undefined || value === null) continue;
    str += `${key}\n${String(value)}\n`;
  }
  return str;
}

/**
 * Returns true only if the message carries a valid AWS signature.
 */
export async function validateSnsMessage(message: SnsMessage): Promise<boolean> {
  try {
    if (!message || !message.Signature) return false;

    const certUrl = message.SigningCertURL || message.SigningCertUrl;
    if (!certUrl || !isValidCertUrl(certUrl)) return false;

    const stringToSign = buildStringToSign(message);
    if (stringToSign === null) return false;

    if (message.SignatureVersion !== "1" && message.SignatureVersion !== "2") {
      return false;
    }
    const algo = message.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1";

    const pem = await fetchCert(certUrl);
    const verifier = crypto.createVerify(algo);
    verifier.update(stringToSign, "utf8");
    return verifier.verify(pem, message.Signature, "base64");
  } catch (error) {
    console.error("SNS signature validation error:", error);
    return false;
  }
}

/**
 * Confirms an SNS subscription by calling its one-time SubscribeURL.
 * Caller MUST validate the message signature first.
 */
export async function confirmSubscription(message: SnsMessage): Promise<boolean> {
  if (!message.SubscribeURL || !isValidSnsUrl(message.SubscribeURL)) return false;
  try {
    const res = await fetch(message.SubscribeURL);
    if (!res.ok) {
      console.error(`SNS subscription confirmation failed: ${res.status}`);
      return false;
    }
    console.log(`SNS subscription confirmed for topic ${message.TopicArn}`);
    return true;
  } catch (error) {
    console.error("SNS subscription confirmation error:", error);
    return false;
  }
}
