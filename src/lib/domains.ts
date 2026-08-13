import { query, type DbRow } from "./database";
import {
  verifyDomain,
  getDomainVerificationStatus,
  createConfigurationSet,
  generateDNSRecords,
  enableDomainDkim,
  getDomainDkimTokens,
  setMailFromDomain,
  mailFromRecords,
  type DNSRecord,
} from "./ses";
import type { Domain } from "./database";
import { errorMessage } from "./errors";
import { isRecord, parseJsonArrayOf } from "./serialization";

export type { DNSRecord } from "./ses";

export interface DomainSetupResult {
  domain: PublicDomain;
  dnsRecords: DNSRecord[];
  sesConfigurationSet?: string | null;
  setupInstructions: string;
}

type DomainFields = {
  id: string;
  user_id: string;
  domain: string;
  status: Domain["status"];
  ses_identity_arn: string | null;
  ses_configuration_set: string | null;
  do_domain_id: string | null;
  mail_from_domain: string | null;
  dns_records: unknown;
  verification_token?: string | null;
  created_at: string;
  updated_at: string;
}

type DomainRow = DbRow<DomainFields>;
type DomainWithDnsRecords = Omit<Domain, "dns_records"> & {
  dns_records: DNSRecord[];
};
export type PublicDomain = Omit<
  DomainWithDnsRecords,
  "verification_token" | "smtp_credentials"
>;

function isDnsRecord(value: unknown): value is DNSRecord {
  if (!isRecord(value)) return false;
  const record = value;
  return (
    typeof record.type === "string" &&
    typeof record.name === "string" &&
    typeof record.value === "string" &&
    (record.ttl === undefined || typeof record.ttl === "number") &&
    (record.description === undefined || typeof record.description === "string")
  );
}

function parseDnsRecords(value: unknown): DNSRecord[] {
  return value == null ? [] : parseJsonArrayOf(value, "dns_records", isDnsRecord);
}

function domainFromRow(row: DomainRow): DomainWithDnsRecords {
  return { ...row, dns_records: parseDnsRecords(row.dns_records) };
}

function publicDomain(domain: DomainWithDnsRecords): PublicDomain {
  const { verification_token: _verificationToken, smtp_credentials: _smtpCredentials, ...safe } = domain;
  return safe;
}

export async function addDomain(
  userId: string,
  domainName: string
): Promise<DomainSetupResult> {
  domainName = domainName.trim().toLowerCase();
  // Validate domain format
  if (!isValidDomain(domainName)) {
    throw new Error("Enter a valid domain such as example.com.");
  }

  // Check if domain already exists in our database
  const existingDomain = await getDomainByName(domainName);
  if (existingDomain) {
    if (existingDomain.user_id !== userId) {
      throw new Error("That domain is already registered.");
    }
    // If domain exists, check and complete its setup
    return await verifyAndCompleteExistingDomain(userId, existingDomain);
  }

  try {
    // 1. Verify domain with Amazon SES
    const sesVerification = await verifyDomain(domainName);

    // 2. Enable DKIM for the domain (optional - graceful fallback)
    let dkimTokens: string[] = [];
    try {
      dkimTokens = await enableDomainDkim(domainName);
      console.log(
        `DKIM enabled for ${domainName} with ${dkimTokens.length} tokens`
      );
    } catch (error: unknown) {
      console.warn(`DKIM setup failed for ${domainName}:`, errorMessage(error));
      console.warn(
        "Continuing without DKIM. You can set it up manually in the AWS SES console."
      );
    }

    // 3. Create SES configuration set
    const configurationSet = await createConfigurationSet(domainName);

    // 4. Generate DNS records (including DKIM if available)
    const dnsRecords = generateDNSRecords(
      domainName,
      sesVerification.verificationToken,
      dkimTokens
    );

    // 5. Manual DNS: the records below must be added at the DNS provider.
    const setupInstructions =
      "Add these DNS records at your DNS provider, then click Verify.";

    // 6. Store domain information in database
    const result = await query<DomainRow>(
      `INSERT INTO domains (user_id, domain, status, ses_configuration_set, dns_records, verification_token) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       RETURNING id, user_id, domain, status, ses_identity_arn, ses_configuration_set,
                 do_domain_id, mail_from_domain, dns_records, created_at, updated_at`,
      [
        userId,
        domainName,
        "pending",
        configurationSet,
         JSON.stringify(dnsRecords),
        sesVerification.verificationToken,
      ]
    );

    if (result.rows.length === 0) {
      throw new Error("Couldn't save domain. Try again.");
    }

    const domain = domainFromRow(result.rows[0]);

    return {
      domain: publicDomain(domain),
      dnsRecords,
      sesConfigurationSet: configurationSet,
      setupInstructions,
    };
  } catch (error: unknown) {
    throw new Error(`Couldn't add domain: ${errorMessage(error)}`);
  }
}

async function verifyAndCompleteExistingDomain(
  userId: string,
  existingDomain: Domain
): Promise<DomainSetupResult> {
  // Check ownership
  if (existingDomain.user_id !== userId) {
    throw new Error("This domain is already registered to another account.");
  }

  const domainName = existingDomain.domain;
  let needsUpdate = false;
  const updateFields: Record<string, string> = {};
  const setupInstructions =
    "Add/verify these DNS records at your DNS provider.";

  try {
    // 1. Check SES domain status
    let sesStatus = "NotStarted";
    let sesVerificationToken = existingDomain.verification_token;

    try {
      sesStatus = await getDomainVerificationStatus(domainName);
      console.log(`SES status for ${domainName}: ${sesStatus}`);
    } catch (error: unknown) {
      const message = errorMessage(error);
      if (
        message.includes("not exist") ||
        message.includes("not found")
      ) {
        // Domain doesn't exist in SES, need to verify it
        console.log(`Domain ${domainName} not found in SES, re-verifying...`);
        try {
          const sesVerification = await verifyDomain(domainName);
          sesVerificationToken = sesVerification.verificationToken;
          sesStatus = "Pending";
          needsUpdate = true;
          updateFields.verification_token = sesVerificationToken;
          console.log(`Re-verified domain ${domainName} in SES`);
        } catch (verifyError: unknown) {
          console.warn(
            `Failed to re-verify domain in SES: ${errorMessage(verifyError)}`
          );
        }
      }
    }

    // 2. Check/setup DKIM
    let dkimTokens: string[] = [];
    try {
      dkimTokens = await getDomainDkimTokens(domainName);
      console.log(`Found ${dkimTokens.length} DKIM tokens for ${domainName}`);
    } catch {
      console.log(`DKIM not found for ${domainName}, attempting to enable...`);
      try {
        dkimTokens = await enableDomainDkim(domainName);
        console.log(
          `Enabled DKIM for ${domainName} with ${dkimTokens.length} tokens`
        );
      } catch (dkimError: unknown) {
        console.warn(
          `Failed to enable DKIM for ${domainName}: ${errorMessage(dkimError)}`
        );
      }
    }

    // 3. Check/create SES configuration set
    let configurationSet = existingDomain.ses_configuration_set;
    if (!configurationSet) {
      try {
        configurationSet = await createConfigurationSet(domainName);
        needsUpdate = true;
        updateFields.ses_configuration_set = configurationSet;
        console.log(
          `Created configuration set for ${domainName}: ${configurationSet}`
        );
      } catch (error: unknown) {
        console.warn(`Failed to create configuration set: ${errorMessage(error)}`);
      }
    }

    // 4. Generate current DNS records
    const dnsRecords = generateDNSRecords(
      domainName,
      sesVerificationToken || "",
      dkimTokens
    );

    // 6. Update database if needed
    if (needsUpdate) {
      const result = await query<DomainRow>(
        `UPDATE domains
         SET verification_token = COALESCE($2, verification_token),
             ses_configuration_set = COALESCE($3, ses_configuration_set),
             dns_records = $4,
             updated_at = NOW()
         WHERE id = $1 AND user_id = $5
         RETURNING id, user_id, domain, status, ses_identity_arn,
                    ses_configuration_set, do_domain_id, mail_from_domain,
                    dns_records, verification_token, created_at, updated_at`,
        [
          existingDomain.id,
          updateFields.verification_token ?? null,
          updateFields.ses_configuration_set ?? null,
          JSON.stringify(dnsRecords),
          userId,
        ],
      );

      if (result.rows.length > 0) {
        const updatedDomain = domainFromRow(result.rows[0]);

        return {
          domain: publicDomain(updatedDomain),
          dnsRecords,
          sesConfigurationSet: configurationSet,
          setupInstructions,
        };
      }
    }

    // 7. Return existing domain with current setup info
    return {
      domain: publicDomain({
        ...existingDomain,
        dns_records: parseDnsRecords(existingDomain.dns_records),
      }),
      dnsRecords,
      sesConfigurationSet: configurationSet,
      setupInstructions: `Domain already exists. ${setupInstructions}`,
    };
  } catch (error: unknown) {
    throw new Error(`Couldn't verify existing domain setup: ${errorMessage(error)}`);
  }
}

export async function getUserDomains(userId: string): Promise<PublicDomain[]> {
  try {
    const result = await query<DomainRow>(
      `SELECT id, user_id, domain, status, ses_identity_arn, ses_configuration_set,
              do_domain_id, mail_from_domain, dns_records, created_at, updated_at
       FROM domains
       WHERE user_id = $1 
       ORDER BY created_at DESC`,
      [userId]
    );

    return result.rows.map((row) => publicDomain(domainFromRow(row)));
  } catch (error: unknown) {
    throw new Error(`Failed to fetch domains: ${errorMessage(error)}`);
  }
}

export async function getDomainById(
  domainId: string,
  userId: string,
): Promise<PublicDomain | null> {
  const result = await query<DomainRow>(
    `SELECT id, user_id, domain, status, ses_identity_arn, ses_configuration_set,
            do_domain_id, mail_from_domain, dns_records, created_at, updated_at
     FROM domains
     WHERE id = $1 AND user_id = $2
     LIMIT 1`,
    [domainId, userId],
  );

  if (result.rows.length === 0) {
    return null;
  }

  return publicDomain(domainFromRow(result.rows[0]));
}

export async function getDomainByName(
  domainName: string
): Promise<Domain | null> {
  const result = await query<DomainRow>(
    `SELECT id, user_id, domain, status, ses_identity_arn, ses_configuration_set,
            do_domain_id, mail_from_domain, dns_records, verification_token,
            created_at, updated_at
     FROM domains
     WHERE LOWER(domain) = LOWER($1)
     LIMIT 1`,
    [domainName.trim()]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return domainFromRow(result.rows[0]);
}

export async function updateDomainStatus(
  domainId: string,
  status: Domain["status"],
  userId: string,
): Promise<void> {
  try {
    const result = await query(
      "UPDATE domains SET status = $1 WHERE id = $2 AND user_id = $3",
      [status, domainId, userId],
    );

    if (result.rowCount === 0) {
      throw new Error("Domain not found.");
    }
  } catch (error: unknown) {
    throw new Error(`Couldn't update domain status: ${errorMessage(error)}`);
  }
}

export async function checkDomainVerification(
  domainId: string,
  userId: string,
): Promise<Domain["status"]> {
  const domain = await getDomainById(domainId, userId);
  if (!domain) {
    throw new Error("Domain not found.");
  }

  try {
    const sesStatus = await getDomainVerificationStatus(domain.domain);

    let newStatus: Domain["status"] = "pending";
    if (sesStatus === "Success") {
      newStatus = "verified";
    } else if (sesStatus === "Failed") {
      newStatus = "failed";
    }

    if (newStatus !== domain.status) {
      await updateDomainStatus(domainId, newStatus, userId);
    }

    return newStatus;
  } catch (error) {
    console.error("Failed to check domain verification:", error);
    return domain.status;
  }
}

export async function deleteDomain(
  domainId: string,
  userId: string
): Promise<void> {
  const domain = await getDomainById(domainId, userId);
  if (!domain || domain.user_id !== userId) {
    throw new Error("Domain not found or you don't have access.");
  }

  try {
    const result = await query(
      "DELETE FROM domains WHERE id = $1 AND user_id = $2",
      [domainId, userId]
    );

    if (result.rowCount === 0) {
      throw new Error("Domain not found or you don't have access.");
    }
  } catch (error: unknown) {
    throw new Error(`Couldn't delete domain: ${errorMessage(error)}`);
  }
}

// Set or clear the custom MAIL FROM (return-path) domain. Blank clears it (SES
// reverts to its default). The return domain must be a subdomain of the sending
// domain so SPF aligns for DMARC. DNS records are rewritten to match.
export async function updateMailFromDomain(
  domainId: string,
  userId: string,
  mailFromRaw: string
): Promise<{ mailFrom: string | null; dnsRecords: DNSRecord[] }> {
  const domain = await getDomainById(domainId, userId);
  if (!domain || domain.user_id !== userId) {
    throw new Error("Domain not found or you don't have access.");
  }

  const mailFrom = mailFromRaw.trim().toLowerCase() || null;
  if (mailFrom && (!isValidDomain(mailFrom) || !mailFrom.endsWith(`.${domain.domain}`))) {
    throw new Error(
      `Return-path must be a subdomain of ${domain.domain}, e.g. bounce.${domain.domain}.`
    );
  }

  // Set it in SES first. If that throws (e.g. missing ses:SetIdentityMailFromDomain),
  // let it propagate so the caller can surface the real error — never persist a
  // MAIL FROM that SES doesn't actually have.
  await setMailFromDomain(domain.domain, mailFrom);

  const base = domain.dns_records.filter(
    (r) => r.description !== "Custom MAIL FROM (return-path)" && r.description !== "MAIL FROM SPF"
  );
  const dnsRecords = mailFrom ? [...base, ...mailFromRecords(mailFrom)] : base;

  await query(
    "UPDATE domains SET mail_from_domain = $1, dns_records = $2, updated_at = NOW() WHERE id = $3 AND user_id = $4",
    [mailFrom, JSON.stringify(dnsRecords), domainId, userId]
  );

  return { mailFrom, dnsRecords };
}

export function isValidDomain(domain: string): boolean {
  const domainRegex =
    /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  return domainRegex.test(domain) && domain.length <= 253;
}
