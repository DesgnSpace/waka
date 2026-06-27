import crypto from "crypto";

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
const SIGNED_KEYS: Record<string, string[]> = {
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

const certCache = new Map<string, string>();

// Only fetch signing certs from genuine AWS SNS hosts (prevents SSRF / a forged
// SigningCertURL pointing at an attacker-controlled cert).
function isValidCertUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (!/^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/i.test(url.hostname)) return false;
  if (!url.pathname.endsWith(".pem")) return false;
  return true;
}

async function fetchCert(certUrl: string): Promise<string> {
  const cached = certCache.get(certUrl);
  if (cached) return cached;

  const res = await fetch(certUrl);
  if (!res.ok) {
    throw new Error(`Couldn't fetch SNS signing certificate: ${res.status}`);
  }
  const pem = await res.text();
  certCache.set(certUrl, pem);
  return pem;
}

function buildStringToSign(message: SnsMessage): string | null {
  const keys = SIGNED_KEYS[message.Type];
  if (!keys) return null;

  let str = "";
  for (const key of keys) {
    const value = (message as unknown as Record<string, unknown>)[key];
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

    // SignatureVersion 1 -> SHA1, 2 -> SHA256.
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
  if (!message.SubscribeURL) return false;
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
