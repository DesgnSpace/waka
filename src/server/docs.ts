// Operator documentation rendered by the dashboard. Content only: ui.ts wraps
// each topic in the dashboard layout and gates it behind the session.

export interface DocTopic {
  slug: string;
  title: string;
  summary: string;
  body: string;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

function text(value: string): string {
  return value.replace(/[&<>]/g, (c) => ESC[c]);
}

function code(sample: string): string {
  return `<pre><code>${text(sample.trim())}</code></pre>`;
}

function list(items: string[]): string {
  return `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;
}

function table(headings: string[], rows: string[][]): string {
  const head = headings.map((h) => `<th>${h}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function section(title: string, ...blocks: string[]): string {
  return `<h2>${title}</h2>${blocks.join("")}`;
}

function p(copy: string): string {
  return `<p>${copy}</p>`;
}

const HOST = "https://your-host.example";

const quickstart = [
  p(
    "Five steps take you from an empty account to a delivered message. You need a domain whose DNS records you can edit.",
  ),
  section(
    "1. Add your domain",
    p(
      'Open <a href="/dashboard">domains</a>, type the domain you want to send from — <code>example.com</code>, not <code>you@example.com</code> — and add it.',
    ),
  ),
  section(
    "2. Publish the DNS records",
    p(
      "The domain page lists every record to create at your DNS provider: an ownership record, a mail route, a sender policy, a signing record for each signing key, and a policy record for inbox providers. Copy each value exactly, or download them as a zone file if your provider can import one.",
    ),
    p(
      "If your provider adds the domain name to record names automatically, enter only the part before the domain.",
    ),
  ),
  section(
    "3. Check DNS",
    p(
      'DNS changes take a few minutes to a few hours to appear. Press <strong>check DNS</strong> on the domain page until the status reads <span class="status-badge status-verified"><span class="status-mark" aria-hidden="true"></span>verified</span>. Until then the domain cannot send.',
    ),
  ),
  section(
    "4. Create an API key",
    p(
      "On the domain's <strong>api keys</strong> tab, name a key and create it. The full key is shown once — copy it into your application's secret store before you leave the page. You can only see its first characters afterwards.",
    ),
    p(
      "You can cap a key to a number of messages per minute and per day when you create it, and change or clear those caps later.",
    ),
  ),
  section(
    "5. Send your first email",
    code(`curl -X POST ${HOST}/api/emails \\
  -H "Authorization: Bearer wka_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "from": "hello@example.com",
    "to": ["you@example.com"],
    "subject": "Hello",
    "html": "<p>Hello from my own domain.</p>"
  }'`),
    p("A message accepted for delivery answers with its id:"),
    code(`{
  "id": "0c8e5d52-1f1e-4e9f-9a31-9f1b0f2e1c77",
  "from": "hello@example.com",
  "to": ["you@example.com"],
  "created_at": "2026-09-12T10:04:11.512Z"
}`),
    p(
      "The domain's <strong>email activity</strong> tab shows the message and every delivery update that follows it.",
    ),
  ),
  section(
    "Sending from your existing code",
    p(
      `Clients written for Resend work unchanged when their base URL points at <code>${HOST}/api</code> and their key is the <code>wka_</code> key you just created.`,
    ),
  ),
].join("");

const authentication = [
  p("Two credentials open different doors. Both travel in the same header."),
  section(
    "API keys",
    p(
      "A key looks like <code>wka_A1b2C3d4_…</code> and belongs to one verified domain. Use it for everything your application does: sending, reading its own messages, reading its own usage.",
    ),
    code(`curl ${HOST}/api/emails/logs \\
  -H "Authorization: Bearer wka_your_api_key"`),
    list([
      "A key can only send from the domain it was created for.",
      "The full key is shown once, at creation. Store it in your secret manager.",
      "Sending requires the <code>send</code> permission, which every key created today carries.",
      "A key can be given an expiry date. Past that date it stops working and nothing else changes.",
      "Revoking a key in the dashboard takes effect on the next request.",
    ]),
  ),
  section(
    "Sign-in token",
    p(
      "Managing the account — domains, keys, webhook endpoints, blocked addresses — needs the token you get by signing in. It is valid for one hour, then you sign in again. The dashboard uses the same token, held in a session cookie.",
    ),
    code(`curl -X POST ${HOST}/api/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{"email":"you@example.com","password":"your-password"}'`),
    code(`{
  "success": true,
  "data": {
    "user": { "id": "…", "email": "you@example.com" },
    "token": "eyJhbGciOiJIUzI1NiIs…"
  }
}`),
    p("Confirm who a token belongs to:"),
    code(`curl ${HOST}/api/auth/me \\
  -H "Authorization: Bearer <token>"`),
  ),
  section(
    "Which credential each endpoint takes",
    table(
      ["Endpoint", "Credential"],
      [
        ["<code>POST /api/emails</code>, <code>POST /api/emails/batch</code>", "API key"],
        ["<code>GET /api/emails/logs</code>, <code>GET /api/emails/:id</code>, <code>GET /api/usage</code>", "API key or sign-in token"],
        ["<code>/api/domains…</code>, <code>/api/api-keys…</code>, <code>/api/webhooks…</code>", "Sign-in token"],
        ["<code>GET /api/health</code>, <code>POST /api/tools/email-dns-checker</code>", "None"],
      ],
    ),
  ),
  section(
    "Creating an account",
    p(
      "Sign-up takes an email address and a password of at least 12 characters (200 characters and 72 bytes maximum). The answer is the same whether or not the address was free, so no one can use it to discover who has an account.",
    ),
    code(`curl -X POST ${HOST}/api/auth/signup \\
  -H "Content-Type: application/json" \\
  -d '{"email":"you@example.com","password":"a-password-of-12-plus"}'`),
  ),
  section(
    "When a credential is refused",
    table(
      ["Answer", "Meaning"],
      [
        ["<code>401 Include an API key in the Authorization header.</code>", "The header was missing or did not start with <code>Bearer </code>."],
        ["<code>401 API key is invalid or revoked.</code>", "The key does not match any key on this instance."],
        ["<code>401 This API key has expired. Create a new API key for this domain to continue.</code>", "The key passed its expiry date."],
        ["<code>401 Your session expired. Sign in again.</code>", "The sign-in token is older than an hour, or was signed with a different secret."],
        ["<code>403 This API key can't send email. Create a key with send permission.</code>", "The key exists but carries no send permission."],
      ],
    ),
  ),
].join("");

const sendEmail = [
  p(
    "<code>POST /api/emails</code> accepts one message and answers as soon as it is handed to the email provider — or stored, if you scheduled it.",
  ),
  code(`curl -X POST ${HOST}/api/emails \\
  -H "Authorization: Bearer wka_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "from": "Support <hello@example.com>",
    "to": ["first@example.com", "second@example.com"],
    "cc": "manager@example.com",
    "reply_to": "replies@example.com",
    "subject": "Your receipt",
    "html": "<p>Thanks for your order.</p>",
    "text": "Thanks for your order."
  }'`),
  section(
    "Fields",
    table(
      ["Field", "Required", "Rules"],
      [
        [
          "<code>from</code>",
          "yes",
          "One address, up to 320 characters. <code>you@example.com</code> or <code>Name &lt;you@example.com&gt;</code>. The part after <code>@</code> must be the key's own verified domain.",
        ],
        [
          "<code>to</code>",
          "yes",
          "One address or a list of up to 100.",
        ],
        ["<code>cc</code>", "no", "One address or a list of up to 100."],
        ["<code>bcc</code>", "no", "One address or a list of up to 100."],
        [
          "<code>subject</code>",
          "yes",
          "1 to 500 characters, on a single line.",
        ],
        [
          "<code>html</code>",
          "one of the two",
          "Up to 10 MB. A message sent as HTML alone also gets a readable plain-text part built from it.",
        ],
        ["<code>text</code>", "one of the two", "Up to 10 MB."],
        [
          "<code>reply_to</code>",
          "no",
          "One address or a list of up to 20.",
        ],
        [
          "<code>attachments</code>",
          "no",
          "Up to 20 files, 10 MB in total once decoded.",
        ],
        [
          "<code>tags</code>",
          "no",
          "Up to 50 <code>{ name, value }</code> pairs. Names are 1 to 256 characters, values up to 256. An object such as <code>{\"campaign\":\"welcome\"}</code> is accepted too.",
        ],
        [
          "<code>scheduled_at</code>",
          "no",
          "A time to send instead of now. Up to 64 characters.",
        ],
      ],
    ),
    p(
      "The whole request body is limited to 15 MB. A larger body is answered with <code>413 Request body is too large.</code>",
    ),
  ),
  section(
    "Attachments",
    code(`curl -X POST ${HOST}/api/emails \\
  -H "Authorization: Bearer wka_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "from": "hello@example.com",
    "to": ["you@example.com"],
    "subject": "Your invoice",
    "text": "The invoice is attached.",
    "attachments": [
      {
        "filename": "invoice.pdf",
        "content": "JVBERi0xLjQKJcfs…",
        "contentType": "application/pdf"
      }
    ]
  }'`),
    list([
      "<code>content</code> is the file encoded as base64.",
      "<code>filename</code> cannot contain a line break or a double quote.",
      "<code>contentType</code> (or <code>content_type</code>) is optional; without it the file is sent as <code>application/octet-stream</code>.",
      "At most 20 files, and 10 MB once all of them are decoded — the provider's own ceiling for a whole message.",
    ]),
  ),
  section(
    "Tags",
    p(
      "Tags travel with the message to the email provider, where they group the delivery events it reports back.",
    ),
    code(`"tags": [
  { "name": "campaign", "value": "welcome" },
  { "name": "tier", "value": "pro" }
]`),
  ),
  section(
    "Sending later",
    p(
      "Add <code>scheduled_at</code> and the message is stored and delivered at that time instead of now. Two forms are accepted:",
    ),
    list([
      "A timestamp: <code>2026-09-01T09:00:00Z</code>. Include <code>Z</code> or an offset — a timestamp without one is read in the server's own time zone.",
      "A delay: <code>in 30 minutes</code>. Also <code>in 45 seconds</code>, <code>in 2 hours</code>, <code>in 1 day</code>.",
    ]),
    code(`curl -X POST ${HOST}/api/emails \\
  -H "Authorization: Bearer wka_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "from": "hello@example.com",
    "to": ["you@example.com"],
    "subject": "Tomorrow",
    "text": "This arrives at the time you picked.",
    "scheduled_at": "in 30 minutes"
  }'`),
    list([
      "The furthest you can schedule is 72 hours ahead. Further than that is refused with <code>422 scheduled_at can be at most 72 hours in the future.</code>",
      "A time already past simply sends straight away.",
      "You get the message id immediately. Until its time arrives it reads as <strong>scheduled</strong> in email activity.",
      "A worker picks the message up within a minute of its time. If sending fails it tries again 5 minutes later, up to 5 attempts in all, and then stops as <strong>failed</strong>.",
      "Daily allowance is counted when you submit the message, not when it leaves.",
    ]),
  ),
  section(
    "What comes back",
    code(`{
  "id": "0c8e5d52-1f1e-4e9f-9a31-9f1b0f2e1c77",
  "from": "hello@example.com",
  "to": ["you@example.com"],
  "created_at": "2026-09-12T10:04:11.512Z"
}`),
    p(
      'Use <code>id</code> to look the message up later — see <a href="/ui/docs/email-detail">Message details</a>.',
    ),
  ),
  section(
    "When a send is refused",
    table(
      ["Answer", "Meaning"],
      [
        ["<code>400 From email must use the domain example.com.</code>", "The <code>from</code> address is not on the key's domain."],
        ["<code>400 Domain isn't verified. Verify DNS and try again.</code>", "The domain's DNS records are not confirmed yet."],
        ["<code>400 Recipient … previously bounced or was marked as spam…</code>", 'One or more recipients are on the blocked list. See <a href="/ui/docs/suppressions">Blocked addresses</a>.'],
        ["<code>422</code> with a list of fields", "A field failed its rules; every failing field is named."],
        ["<code>429</code>", 'A limit is full. See <a href="/ui/docs/limits">Limits and allowances</a>.'],
        ["<code>502</code>", "The email provider rejected the message. The reason is passed through and the attempt is recorded as failed."],
      ],
    ),
  ),
].join("");

const batch = [
  p(
    "<code>POST /api/emails/batch</code> takes a JSON array of up to 100 messages, each shaped exactly like a single send, and works through them in order.",
  ),
  code(`curl -X POST ${HOST}/api/emails/batch \\
  -H "Authorization: Bearer wka_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '[
    {"from":"hello@example.com","to":["a@example.com"],"subject":"Hi A","text":"Hello A"},
    {"from":"hello@example.com","to":["b@example.com"],"subject":"Hi B","text":"Hello B"}
  ]'`),
  section(
    "Rules",
    list([
      "One API key, one domain: every <code>from</code> must be on that domain and the domain must be verified.",
      "Between 1 and 100 messages. An empty array, a body that is not an array, and more than 100 messages are each refused with <code>400</code>.",
      "Every message is checked, counted, and sent exactly as if you had sent it on its own — blocked recipients, limits, daily allowance and all.",
      "Messages go out one after another, so a batch of 50 counts as 50 against every limit.",
      "The 15 MB body ceiling applies to the whole array.",
    ]),
  ),
  section(
    "Reading the answer",
    p(
      "<code>data</code> holds one entry per message, in the order you sent them, so you can line the results up with your input.",
    ),
    code(`{
  "data": [
    {
      "id": "0c8e5d52-…",
      "from": "hello@example.com",
      "to": ["a@example.com"],
      "created_at": "2026-09-12T10:04:11.512Z"
    },
    {
      "statusCode": 429,
      "error": "Daily sending limit reached.",
      "message": "Daily sending limit reached."
    }
  ]
}`),
    table(
      ["Status", "Meaning"],
      [
        ["<code>200</code>", "Every message was accepted."],
        ["<code>207</code>", "At least one message failed. Read each entry to see which."],
        ["<code>400</code>", "The batch itself was unusable: not an array, empty, or over 100 messages."],
      ],
    ),
    p(
      "A batch where every message failed also answers <code>207</code>, so a client never mistakes a total failure for a success.",
    ),
  ),
  section(
    "Retries",
    p(
      'An <code>Idempotency-Key</code> works on a batch exactly as on a single send, and replays the whole stored answer. See <a href="/ui/docs/idempotency">Safe retries</a>.',
    ),
  ),
].join("");

const idempotency = [
  p(
    "A request that times out leaves you guessing whether the message went out. Send an <code>Idempotency-Key</code> header and the answer is no longer a guess: repeat the request with the same key and you get the original outcome back instead of a second message.",
  ),
  code(`curl -X POST ${HOST}/api/emails \\
  -H "Authorization: Bearer wka_your_api_key" \\
  -H "Idempotency-Key: order-4417-receipt" \\
  -H "Content-Type: application/json" \\
  -d '{
    "from": "hello@example.com",
    "to": ["you@example.com"],
    "subject": "Your receipt",
    "text": "Thanks for your order."
  }'`),
  section(
    "How it behaves",
    table(
      ["Situation", "What you get"],
      [
        ["The first request finished", "The stored status and body, plus the header <code>idempotency-replayed: true</code>. Nothing is sent again."],
        ["The first request is still running", "<code>409</code> with <code>An email with this Idempotency-Key is still being processed. Wait a moment and retry.</code> and <code>retry-after: 1</code>."],
        ["The first request was refused before the message left", "The key is freed, so your retry sends normally."],
        ["The message went out but could not be recorded", "The success is stored anyway, so a retry replays it rather than sending twice."],
      ],
    ),
  ),
  section(
    "Rules",
    list([
      "Pick a value that identifies the message you are sending — an order id, a job id. Use it for that message only.",
      "1 to 255 characters. An empty or longer value is refused with <code>400 The Idempotency-Key header must be between 1 and 255 characters.</code>",
      "Keys belong to the API key that used them. The same value on a different key is a different message.",
      "A key is remembered for 24 hours, then forgotten and reusable.",
      "A request that is cut off mid-flight releases its key after 5 minutes, so a crash cannot block that key forever.",
      "Requests sent without the header behave exactly as before.",
    ]),
  ),
].join("");

const limits = [
  p(
    "Limits protect the account and the sending reputation of every domain on it. A refused request is answered with <code>429</code> and a message naming the limit that stopped it.",
  ),
  section(
    "What applies to every send",
    table(
      ["Limit", "Value", "Counted per"],
      [
        ["Account, per minute", "60 messages", "the account that owns the key"],
        ["Account, per day", "1,000 messages by default", "the account that owns the key"],
        ["Address, per minute", "20 messages", "the calling IP address"],
        ["Key, per minute", "off unless you set it", "one API key"],
        ["Key, per day", "off unless you set it", "one API key"],
      ],
    ),
    p(
      "Every limit that applies is checked, and the strictest one wins. A per-minute window opens with your first message and closes 60 seconds later; daily allowances reset at midnight on the server.",
    ),
    p(
      "The daily account limit is set by the operator through <code>ACCOUNT_DAILY_SEND_LIMIT</code>; without it the limit is 1,000 messages a day.",
    ),
  ),
  section(
    "Capping one key",
    p(
      "Per-key caps keep a leaked or noisy key from consuming the account. Both are optional whole numbers from 1 to 1,000,000, and both can be changed or cleared later.",
    ),
    code(`curl -X POST ${HOST}/api/api-keys \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{"domainId":"<domain-id>","keyName":"mobile","rateLimitPerMinute":30,"dailySendLimit":500}'`),
    p("The same two fields appear on the key creation form in the dashboard."),
  ),
  section(
    "The messages you will see",
    table(
      ["Message", "Which limit"],
      [
        ["<code>This API key has reached its per-minute limit. Wait a moment and try again, or raise the limit for this key.</code>", "that key's per-minute cap"],
        ["<code>This API key has reached its daily sending limit.</code>", "that key's daily cap"],
        ["<code>Sending too quickly. Try again later.</code>", "the account's 60 a minute, or the address's 20 a minute"],
        ["<code>Daily sending limit reached.</code>", "the account's daily allowance"],
      ],
    ),
    p(
      "In a batch, a limit that fills part-way through fails only the remaining messages; the ones already accepted stand.",
    ),
  ),
  section(
    "Limits elsewhere",
    table(
      ["Action", "Limit"],
      [
        ["Signing in", "10 attempts a minute per address, and 10 a minute per email"],
        ["Signing up", "3 an hour per address, 3 an hour per email, 100 an hour overall"],
        ["The DNS checker tool", "10 checks a minute per address"],
        ["The dashboard's test email", "the same account and address limits as any send, and it counts against the daily allowance"],
      ],
    ),
    p(
      "Per-address limits count the connection the server sees. Behind a reverse proxy the operator sets <code>TRUST_PROXY</code> so the real client address is used instead of the proxy's.",
    ),
  ),
].join("");

const suppressions = [
  p(
    "When a message bounces permanently or someone marks it as spam, that address is blocked for that domain. Sending to it again would damage the domain's reputation, so the attempt is refused before anything else happens.",
  ),
  section(
    "How an address gets blocked",
    list([
      "A permanent bounce — the address does not exist, or the receiving server refuses it for good.",
      "A spam complaint — the recipient pressed the report button.",
    ]),
    p(
      "Temporary problems, such as a full mailbox, never block an address.",
    ),
    p(
      "Blocks are per domain. The same address can be blocked for one of your domains and perfectly fine for another.",
    ),
  ),
  section(
    "What a blocked recipient does to a send",
    p(
      "Every address in <code>to</code>, <code>cc</code> and <code>bcc</code> is checked. If any one of them is blocked, the whole message is refused with <code>400</code> and the blocked addresses are named — no part of it goes out, and nothing is counted against your limits.",
    ),
    code(`{
  "error": "Recipient bad@example.com previously bounced or was marked as spam for this domain and won't receive mail. Remove it from the suppression list to send again.",
  "message": "Recipient bad@example.com previously bounced or was marked as spam for this domain and won't receive mail. Remove it from the suppression list to send again.",
  "suppressed": ["bad@example.com"]
}`),
  ),
  section(
    "Seeing and clearing blocks",
    p("Both take your sign-in token."),
    code(`curl ${HOST}/api/domains/<domain-id>/suppressions \\
  -H "Authorization: Bearer <token>"`),
    code(`{
  "success": true,
  "data": {
    "suppressions": [
      {
        "id": "…",
        "domain_id": "…",
        "email": "bad@example.com",
        "reason": "bounce",
        "created_at": "2026-09-10T08:12:04.000Z"
      }
    ]
  }
}`),
    p("<code>reason</code> is <code>bounce</code> or <code>complaint</code>."),
    p("Unblock one address — encode the <code>@</code> in the path:"),
    code(`curl -X DELETE ${HOST}/api/domains/<domain-id>/suppressions/bad%40example.com \\
  -H "Authorization: Bearer <token>"`),
    p(
      "An address that was not blocked answers <code>404 Suppression not found</code>. Clearing a block only removes the record — if the address still bounces, it comes straight back.",
    ),
  ),
].join("");

const logs = [
  p(
    "<code>GET /api/emails/logs</code> lists messages newest first, with every filter combined. An API key sees only its own domain; a sign-in token sees every domain on the account.",
  ),
  code(`curl "${HOST}/api/emails/logs?status=bounced&limit=25" \\
  -H "Authorization: Bearer wka_your_api_key"`),
  section(
    "Filters",
    table(
      ["Parameter", "Accepts"],
      [
        ["<code>page</code>", "1 to 10,000. Defaults to 1."],
        ["<code>limit</code>", "1 to 100 per page. Defaults to 50."],
        ["<code>domain_id</code>", "A domain id."],
        [
          "<code>status</code>",
          "<code>pending</code>, <code>sent</code>, <code>failed</code>, <code>delivered</code>, <code>bounced</code>, <code>complained</code>, <code>scheduled</code>, <code>sending</code>.",
        ],
        [
          "<code>recipient</code>",
          "Any part of an address in <code>to</code>, <code>cc</code> or <code>bcc</code>. Case is ignored.",
        ],
        ["<code>subject</code>", "Any part of the subject. Case is ignored."],
        [
          "<code>from</code> and <code>to</code>",
          "A date range. <code>YYYY-MM-DD</code> or a full timestamp; a plain date as <code>to</code> covers the whole day. Also accepted as <code>from_date</code>/<code>to_date</code>, <code>start_date</code>/<code>end_date</code>, <code>startDate</code>/<code>endDate</code>.",
        ],
        [
          "<code>message_id</code>",
          "An exact id — the message id Waka gave you, or the provider's. Also accepted as <code>messageId</code>.",
        ],
      ],
    ),
  ),
  section(
    "What comes back",
    code(`{
  "success": true,
  "data": {
    "emails": [
      {
        "id": "0c8e5d52-…",
        "from_email": "hello@example.com",
        "to_emails": ["you@example.com"],
        "subject": "Your receipt",
        "status": "delivered",
        "created_at": "2026-09-12T10:04:11.512Z",
        "domains": { "domain": "example.com" },
        "api_keys": { "key_name": "production" }
      }
    ],
    "pagination": { "page": 1, "limit": 50, "total": 1, "totalPages": 1 }
  }
}`),
    p(
      "Each entry also carries the copy of the message that was sent, the provider's message id, and the reason for a failure when there is one. Message bodies are cleared once they pass the retention window.",
    ),
  ),
  section(
    "In the dashboard",
    p(
      "A domain's <strong>email activity</strong> tab searches the same way — recipient, subject, date range, message id, delivery status — and shows how many times each message was opened and clicked.",
    ),
  ),
].join("");

const emailDetail = [
  p(
    "<code>GET /api/emails/:id</code> returns one message with everything recorded about it, including each delivery update received from the email provider. It takes either an API key with send permission, scoped to its own domain, or a sign-in token for any domain on the account.",
  ),
  code(`curl ${HOST}/api/emails/<message-id> \\
  -H "Authorization: Bearer wka_your_api_key"`),
  code(`{
  "success": true,
  "data": {
    "email": {
      "id": "0c8e5d52-…",
      "from_email": "hello@example.com",
      "to_emails": ["you@example.com"],
      "cc_emails": [],
      "bcc_emails": [],
      "subject": "Your receipt",
      "html_content": "<p>Thanks for your order.</p>",
      "text_content": "Thanks for your order.",
      "attachments": [
        { "filename": "invoice.pdf", "contentType": "application/pdf", "size": 20418 }
      ],
      "status": "delivered",
      "ses_message_id": "0100019…",
      "error_message": null,
      "created_at": "2026-09-12T10:04:11.512Z",
      "domains": { "domain": "example.com" },
      "api_keys": { "key_name": "production" },
      "webhook_events": [
        {
          "id": "…",
          "event_type": "delivery",
          "event_data": { },
          "created_at": "2026-09-12T10:04:14.104Z"
        }
      ]
    }
  }
}`),
  section(
    "Notes",
    list([
      "<code>attachments</code> lists what was attached — name, type and size. The file contents are never returned.",
      "A message stored for later sending keeps its request privately until it goes out; that copy is never returned either.",
      "<code>webhook_events</code> is every update the email provider sent about this message, newest first.",
      "<code>html_content</code> and <code>text_content</code> are emptied once the message passes the retention window; the rest of the record stays.",
      "An id that is not yours answers <code>404 Email not found</code>.",
    ]),
  ),
].join("");

const usage = [
  p(
    "<code>GET /api/usage</code> counts messages and engagement day by day. An API key reports its own domain; a sign-in token reports every domain on the account.",
  ),
  code(`curl "${HOST}/api/usage?from=2026-09-01&to=2026-09-07" \\
  -H "Authorization: Bearer <token>"`),
  code(`{
  "success": true,
  "data": {
    "from": "2026-09-01",
    "to": "2026-09-07",
    "usage": [
      {
        "date": "2026-09-01",
        "sent": 120,
        "delivered": 118,
        "bounced": 2,
        "complained": 0,
        "opened": 64,
        "clicked": 11
      }
    ]
  }
}`),
  section(
    "Range",
    list([
      "<code>from</code> and <code>to</code> are plain dates, <code>YYYY-MM-DD</code>, and both ends are included.",
      "Leave both out and you get the last 30 days.",
      "Give only one and the other is filled in 30 days away from it, never past today.",
      "The longest range is 90 days. Longer answers <code>400 Date range too large. Maximum 90 days.</code>",
      "Every day in the range is returned, including days with nothing on them.",
      "A <code>from</code> later than <code>to</code> answers <code>400 `from` must be on or before `to`.</code>",
    ]),
  ),
  section(
    "Reading the numbers",
    list([
      "<code>sent</code>, <code>delivered</code>, <code>bounced</code> and <code>complained</code> count messages by the state they are in now, on the day they were submitted. A message that was delivered today counts once, under <code>delivered</code>.",
      "<code>opened</code> and <code>clicked</code> count every open and every click on the day it happened, so one message can count many times.",
    ]),
  ),
].join("");

const apiKeys = [
  p(
    "Keys are created per domain, and a key can only send from that domain. Manage them in the dashboard, on a domain's <strong>api keys</strong> tab, or over the API with your sign-in token.",
  ),
  section(
    "Create a key",
    code(`curl -X POST ${HOST}/api/api-keys \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "domainId": "<domain-id>",
    "keyName": "production",
    "expiresAt": "2027-01-01T00:00:00Z",
    "rateLimitPerMinute": 30,
    "dailySendLimit": 500
  }'`),
    table(
      ["Field", "Required", "Rules"],
      [
        ["<code>domainId</code>", "yes", "A domain you own, already verified. An unverified domain answers <code>400 Verify the domain before creating API keys.</code>"],
        ["<code>keyName</code>", "yes", "1 to 255 characters. For your own records."],
        ["<code>permissions</code>", "no", "<code>[\"send\"]</code>, which is also the default and the only value."],
        ["<code>expiresAt</code>", "no", "A timestamp. Omit it or pass <code>null</code> and the key never expires."],
        ["<code>rateLimitPerMinute</code>", "no", "1 to 1,000,000, or <code>null</code> for no cap."],
        ["<code>dailySendLimit</code>", "no", "1 to 1,000,000, or <code>null</code> for no cap."],
      ],
    ),
    p(
      "The answer carries the key once, under <code>data.apiKey.key</code>. It is never shown again — copy it now.",
    ),
  ),
  section(
    "List keys",
    code(`curl ${HOST}/api/api-keys \\
  -H "Authorization: Bearer <token>"`),
    p(
      "Each entry shows the name, the first characters of the key, its domain, its caps, its expiry, when it was created and when it was last used. The key itself is not in the list.",
    ),
  ),
  section(
    "Change a key",
    p(
      "Send at least one field. Pass <code>null</code> to clear a cap or an expiry.",
    ),
    code(`curl -X PUT ${HOST}/api/api-keys/<key-id> \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{"rateLimitPerMinute":10,"dailySendLimit":null}'`),
  ),
  section(
    "Revoke a key",
    code(`curl -X DELETE ${HOST}/api/api-keys/<key-id> \\
  -H "Authorization: Bearer <token>"`),
    p(
      "Applications using it stop sending at once. Deleting a domain revokes its keys too.",
    ),
  ),
  section(
    "Expiry",
    p(
      "An expired key is refused with <code>401 This API key has expired. Create a new API key for this domain to continue.</code> The dashboard marks it <strong>expired</strong> in the key list, and you can set or change an expiry date there without creating a new key.",
    ),
  ),
].join("");

const domains = [
  p(
    "A domain has to prove it is yours, and has to tell inbox providers that this service may send on its behalf. Both happen through DNS records you publish.",
  ),
  section(
    "Add a domain",
    code(`curl -X POST ${HOST}/api/domains \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{"domain":"example.com"}'`),
    p(
      "The answer carries the domain and the DNS records to publish. A domain already registered to another account is refused.",
    ),
  ),
  section(
    "The DNS records",
    table(
      ["Type", "Name", "Value", "What it does"],
      [
        ["TXT", "<code>_amazonses.example.com</code>", "the verification token", "Proves you own the domain"],
        ["MX", "<code>example.com</code>", "<code>10 inbound-smtp.us-east-1.amazonaws.com.</code>", "Routes mail for the domain"],
        ["TXT", "<code>example.com</code>", "<code>v=spf1 include:amazonses.com ~all</code>", "Lists who may send for you"],
        ["TXT", "<code>_dmarc.example.com</code>", "<code>v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com</code>", "Tells inboxes what to do with unauthenticated mail"],
        ["CNAME, one per signing key", "<code>&lt;key&gt;._domainkey.example.com</code>", "<code>&lt;key&gt;.dkim.amazonses.com.</code>", "Signs your outgoing mail"],
      ],
    ),
    list([
      "Every record uses a TTL of 300 seconds.",
      "Trailing dots in the values are part of the value. Keep them.",
      "If your provider appends the domain to record names automatically, enter only the part before the domain.",
      "The domain page offers the whole set as a downloadable zone file for providers that import one.",
    ]),
  ),
  section(
    "Check the records",
    code(`curl -X POST ${HOST}/api/domains/<domain-id>/verify \\
  -H "Authorization: Bearer <token>"`),
    p(
      "Or press <strong>check DNS</strong> on the domain page. A domain reads <strong>waiting for DNS</strong> until every record is found, <strong>verified</strong> when it is ready to send, and <strong>needs attention</strong> when a record is present but does not match.",
    ),
  ),
  section(
    "Return address",
    p(
      "By default bounces come back to a shared address at the email provider. Point them at your own subdomain — <code>bounce.example.com</code> — and replies to the technical envelope carry your name instead. Set it in the <strong>Optional return address</strong> box on the domain page.",
    ),
    p("Two more records appear once you save it:"),
    table(
      ["Type", "Name", "Value"],
      [
        ["MX", "<code>bounce.example.com</code>", "<code>10 feedback-smtp.&lt;region&gt;.amazonses.com.</code>"],
        ["TXT", "<code>bounce.example.com</code>", "<code>v=spf1 include:amazonses.com ~all</code>"],
      ],
    ),
    p(
      "Use a subdomain, not the domain itself. If the MX record is missing, mail still goes out using the default return address.",
    ),
  ),
  section(
    "List and remove",
    code(`curl ${HOST}/api/domains -H "Authorization: Bearer <token>"`),
    code(`curl ${HOST}/api/domains/<domain-id> -H "Authorization: Bearer <token>"`),
    code(`curl -X DELETE ${HOST}/api/domains/<domain-id> \\
  -H "Authorization: Bearer <token>"`),
    p(
      "Deleting a domain also deletes its API keys and its email activity. It cannot be undone.",
    ),
  ),
].join("");

const webhooks = [
  p(
    "Register an HTTPS address and every delivery update Waka records for your domains is posted to it as signed JSON. One endpoint receives events for all of your domains.",
  ),
  section(
    "Register an endpoint",
    code(`curl -X POST ${HOST}/api/webhooks \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com/waka-events"}'`),
    code(`{
  "success": true,
  "data": {
    "webhook": { "id": "…", "url": "https://example.com/waka-events", "enabled": true },
    "secret": "9f2c…"
  },
  "message": "Webhook endpoint created. Store the secret securely — you can retrieve it again via GET /api/webhooks/:id/secret."
}`),
    p(
      "The address must be a public <code>https://</code> URL with no username or password in it. Registering the same URL twice answers <code>409 An endpoint with this URL already exists.</code>",
    ),
  ),
  section(
    "Manage endpoints",
    code(`curl ${HOST}/api/webhooks -H "Authorization: Bearer <token>"`),
    p("Read the signing secret again:"),
    code(`curl ${HOST}/api/webhooks/<id>/secret \\
  -H "Authorization: Bearer <token>"`),
    p("Replace the signing secret — deliveries in flight use the new one:"),
    code(`curl -X POST ${HOST}/api/webhooks/<id>/rotate \\
  -H "Authorization: Bearer <token>"`),
    p("Stop receiving events:"),
    code(`curl -X DELETE ${HOST}/api/webhooks/<id> \\
  -H "Authorization: Bearer <token>"`),
  ),
  section(
    "What arrives",
    code(`{
  "type": "delivery",
  "created_at": "2026-09-12T10:04:14.104Z",
  "data": {
    "email_id": "0c8e5d52-…",
    "ses_message_id": "0100019…",
    "source": "hello@example.com",
    "destination": ["you@example.com"],
    "timestamp": "2026-09-12T10:04:11.512Z",
    "bounce": null,
    "complaint": null,
    "deliveryDelay": null,
    "open": null,
    "click": null
  }
}`),
    p(
      "<code>email_id</code> is the id the send returned, so you can match the event to your own record. Only the object matching <code>type</code> is filled in; the rest are <code>null</code>. Those objects are passed through from the email provider exactly as received, with every detail it reports — bounce type, complaint type, clicked link, and the rest.",
    ),
  ),
  section(
    "Event types",
    table(
      ["<code>type</code>", "Means"],
      [
        ["<code>send</code>", "The provider accepted the message."],
        ["<code>delivery</code>", "The receiving server accepted it."],
        ["<code>bounce</code>", "It came back. Permanent bounces block the address."],
        ["<code>complaint</code>", "The recipient marked it as spam. The address is blocked."],
        ["<code>reject</code>", "The provider refused to send it."],
        ["<code>open</code>", "The recipient opened it. Sent once per open."],
        ["<code>click</code>", "The recipient followed a link. Sent once per click."],
        ["<code>deliverydelay</code>", "Delivery is taking longer than usual; the message is not lost yet."],
      ],
    ),
    p(
      "Any other event the provider publishes is forwarded under its own name, in lower case. Treat an unknown <code>type</code> as something to ignore rather than an error.",
    ),
  ),
  section(
    "Checking a delivery is genuine",
    p("Every request carries two headers:"),
    table(
      ["Header", "Value"],
      [
        ["<code>X-Waka-Timestamp</code>", "The time of the attempt, in whole seconds since 1970, e.g. <code>1789200000</code>."],
        ["<code>X-Waka-Signature</code>", "<code>v1=</code> followed by the signature as hex."],
      ],
    ),
    p(
      "The signature is HMAC-SHA256 of <code>&lt;timestamp&gt;.&lt;body&gt;</code> — the timestamp header, a dot, then the raw body exactly as received — keyed with your endpoint's secret. Verify before you parse the body, and compare the bytes in constant time.",
    ),
    code(`import crypto from "node:crypto";

function verify(secret, timestamp, rawBody, signatureHeader) {
  const expected =
    "v1=" +
    crypto.createHmac("sha256", secret).update(\`\${timestamp}.\${rawBody}\`).digest("hex");
  if (expected.length !== signatureHeader.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}

// in your handler, with the body read as text and not yet parsed:
const timestamp = req.headers.get("x-waka-timestamp");
const signature = req.headers.get("x-waka-signature");
if (!verify(process.env.WAKA_WEBHOOK_SECRET, timestamp, rawBody, signature)) {
  return new Response("invalid signature", { status: 400 });
}
if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
  return new Response("stale timestamp", { status: 400 });
}
const event = JSON.parse(rawBody);`),
    p(
      "Rejecting timestamps more than 300 seconds old stops anyone replaying a captured delivery later.",
    ),
  ),
  section(
    "Answering a delivery",
    list([
      "Any <code>2xx</code> means received. Answer quickly and do your work afterwards.",
      "A <code>5xx</code>, a <code>429</code>, a <code>408</code>, a timeout or a dropped connection is treated as temporary and tried again.",
      "Any other <code>4xx</code> is treated as final — the delivery is dropped without another attempt.",
      "Redirects are not followed. A <code>3xx</code> is final too, so register the address you actually serve.",
      "Waka waits 10 seconds for an answer.",
    ]),
  ),
  section(
    "Retries",
    p(
      "The first attempt is immediate. Each temporary failure waits longer than the last: 1 minute, 2, 4, 8, 16, 32, then 64 minutes. After the eighth attempt the delivery is dropped.",
    ),
    p(
      "Deliveries go out a minute at a time, up to 25 per round and 5 at once, so a slow endpoint does not hold up the rest.",
    ),
  ),
  section(
    "Endpoints that stop answering",
    p(
      "Five dropped deliveries in a row disable the endpoint. It stops receiving events and stays that way until you delete it and register the address again. A successful delivery resets the count.",
    ),
  ),
  section(
    "Addresses that are refused",
    p(
      "An endpoint has to be reachable from the public internet. These are refused when you register, and checked again at delivery time in case a name starts pointing somewhere private:",
    ),
    list([
      "Anything that is not <code>https://</code>.",
      "<code>localhost</code> and any name ending in <code>.localhost</code>.",
      "Loopback and private ranges: <code>10.0.0.0/8</code>, <code>172.16.0.0/12</code>, <code>192.168.0.0/16</code>, <code>127.0.0.0/8</code>, <code>100.64.0.0/10</code>, <code>0.0.0.0/8</code>.",
      "Link-local: <code>169.254.0.0/16</code> and <code>fe80::/10</code>.",
      "IPv6 loopback <code>::1</code> and unique local <code>fc00::/7</code>.",
    ]),
    p(
      "A delivery whose address resolves into one of those ranges is dropped straight away, without retries.",
    ),
  ),
].join("");

const statuses = [
  p(
    "Every message carries one status. It moves forward as the email provider reports what happened, and never moves back.",
  ),
  section(
    "The statuses",
    table(
      ["Status", "In the dashboard", "Means"],
      [
        ["<code>scheduled</code>", "scheduled", "Stored, waiting for its send time."],
        ["<code>sending</code>", "processing", "A worker has picked it up and is sending it."],
        ["<code>pending</code>", "processing", "Recorded, with no outcome yet."],
        ["<code>sent</code>", "accepted", "The email provider took it. Not proof it arrived."],
        ["<code>failed</code>", "failed", "It was refused before leaving, or gave up after its retries."],
        ["<code>delivered</code>", "delivered", "The receiving server accepted it."],
        ["<code>bounced</code>", "not delivered", "It came back."],
        ["<code>complained</code>", "spam complaint", "The recipient marked it as spam."],
      ],
    ),
  ),
  section(
    "How updates change it",
    table(
      ["Event from the provider", "New status"],
      [
        ["<code>send</code>", "<code>sent</code>"],
        ["<code>reject</code>", "<code>failed</code>"],
        ["<code>delivery</code>", "<code>delivered</code>"],
        ["<code>bounce</code>", "<code>bounced</code>"],
        ["<code>complaint</code>", "<code>complained</code>"],
      ],
    ),
    p(
      "Opens and clicks are counted separately and never change the status. Any other event is recorded and forwarded, and leaves the status alone.",
    ),
  ),
  section(
    "Why a status never goes backwards",
    p(
      "Updates arrive out of order and sometimes twice. So each status has a rank, and an update only applies when it ranks higher than what the message already has:",
    ),
    code(`pending  0
sent     1
failed   2
delivered 3
bounced  4
complained 5`),
    list([
      "A delivery notice arriving after a bounce cannot make a returned message look delivered.",
      "A spam complaint outranks everything, so nothing later can bury it.",
      "A late duplicate of an update already applied changes nothing.",
      "A message still <code>scheduled</code> or <code>sending</code> ranks below all of these, so the first real outcome always applies.",
    ]),
    p(
      "Each update from the provider is processed exactly once, even when it is delivered to the server more than once.",
    ),
  ),
].join("");

const retention = [
  p(
    "Waka keeps the record of every message for as long as the account exists. What it does not keep forever is the content.",
  ),
  section(
    "What gets cleared",
    p(
      "Each night the messages older than the retention window lose their HTML body, their plain-text body, and the raw provider update stored alongside them. The row itself stays: who it went to, the subject, the status, the dates, the failure reason.",
    ),
    p(
      "The window is set by the operator through <code>LOG_RETENTION_DAYS</code>, and is 90 days unless they changed it. Setting it to <code>0</code> turns the clearing off and keeps everything.",
    ),
  ),
  section(
    "What this means for you",
    list([
      "<code>html_content</code> and <code>text_content</code> read as empty on older messages. Everything else still reads normally.",
      "Older entries in <code>webhook_events</code> keep their type and time but lose their detail.",
      "Attachments are never stored after sending; only the name, type and size are kept.",
      "A scheduled message holds its request privately until it is sent, then that copy is cleared immediately.",
      "Retry keys are forgotten 24 hours after their request.",
    ]),
    p(
      "If you need message content for longer than the window, store it on your side when you send.",
    ),
  ),
].join("");

const errors = [
  p(
    "Errors come back as JSON with an <code>error</code> field, and a matching <code>message</code> field where clients expect one. A validation failure names every field that failed.",
  ),
  code(`{
  "error": "subject: Subject is required.; to: Add at least one recipient.",
  "message": "subject: Subject is required.; to: Add at least one recipient.",
  "details": [ ]
}`),
  section(
    "By status",
    table(
      ["Status", "When"],
      [
        [
          "<code>400</code>",
          "The request was understood but cannot be carried out: the sender is not on the key's domain, the domain is not verified, a recipient is blocked, the body is not valid JSON, the retry key is the wrong length, or a batch is empty, oversized, or not an array.",
        ],
        [
          "<code>401</code>",
          "No credential, or one that is invalid, expired or revoked.",
        ],
        [
          "<code>403</code>",
          "The credential is valid but not allowed to do this — a key without send permission. Dashboard forms also answer <code>403</code> when their security token is missing.",
        ],
        [
          "<code>404</code>",
          "No such domain, message, blocked address, webhook endpoint, or route.",
        ],
        [
          "<code>409</code>",
          "A request with the same retry key is still running, or a webhook endpoint with that URL already exists.",
        ],
        ["<code>413</code>", "The request body is over 15 MB."],
        [
          "<code>422</code>",
          "A field failed its rules. Every failing field is listed as <code>field: reason</code>, separated by <code>;</code>, with the raw detail under <code>details</code>. A send time further than 72 hours ahead lands here too.",
        ],
        [
          "<code>429</code>",
          "A limit is full — sending, signing in, signing up, or DNS checks.",
        ],
        [
          "<code>500</code>",
          "Something went wrong on the server. <code>Email sent but could not be recorded.</code> means the message did go out; retry with the same retry key rather than sending again.",
        ],
        [
          "<code>502</code>",
          "The email provider rejected the message. Its reason is passed through and the attempt is recorded as failed.",
        ],
        [
          "<code>503</code>",
          "The service is not ready — the database is unreachable, or sign-in is temporarily unavailable.",
        ],
      ],
    ),
  ),
  section(
    "Checking the service",
    code(`curl ${HOST}/api/health`),
    p(
      "Answers <code>200</code> while the service and its database are healthy, and <code>503</code> when they are not. No credential needed.",
    ),
  ),
].join("");

export const DOC_TOPICS: DocTopic[] = [
  {
    slug: "quickstart",
    title: "Quickstart",
    summary: "From a new domain to your first delivered message.",
    body: quickstart,
  },
  {
    slug: "authentication",
    title: "Authentication",
    summary: "API keys, sign-in tokens, and which one each endpoint takes.",
    body: authentication,
  },
  {
    slug: "send-email",
    title: "Send email",
    summary: "Every field, attachments, tags, and sending later.",
    body: sendEmail,
  },
  {
    slug: "batch",
    title: "Send in batches",
    summary: "Up to 100 messages in one request, and how to read the answer.",
    body: batch,
  },
  {
    slug: "idempotency",
    title: "Safe retries",
    summary: "Repeat a request without sending the message twice.",
    body: idempotency,
  },
  {
    slug: "limits",
    title: "Limits and allowances",
    summary: "How much you can send, per minute and per day.",
    body: limits,
  },
  {
    slug: "suppressions",
    title: "Blocked addresses",
    summary: "Why an address stops receiving mail, and how to clear it.",
    body: suppressions,
  },
  {
    slug: "logs",
    title: "Find a message",
    summary: "Search your email activity and page through it.",
    body: logs,
  },
  {
    slug: "email-detail",
    title: "Message details",
    summary: "Everything recorded about one message.",
    body: emailDetail,
  },
  {
    slug: "usage",
    title: "Usage",
    summary: "Daily counts of what you sent and how it landed.",
    body: usage,
  },
  {
    slug: "api-keys",
    title: "API keys",
    summary: "Create, cap, expire and revoke the keys your apps use.",
    body: apiKeys,
  },
  {
    slug: "domains",
    title: "Domains and DNS",
    summary: "The records to publish and how verification works.",
    body: domains,
  },
  {
    slug: "webhooks",
    title: "Webhooks",
    summary: "Receive delivery updates, and prove they came from here.",
    body: webhooks,
  },
  {
    slug: "statuses",
    title: "Delivery statuses",
    summary: "What each status means and why it never goes backwards.",
    body: statuses,
  },
  {
    slug: "retention",
    title: "How long content is kept",
    summary: "What is cleared from older messages, and when.",
    body: retention,
  },
  {
    slug: "errors",
    title: "Errors",
    summary: "Every status the API answers with and what it means.",
    body: errors,
  },
];

export function findDocTopic(slug: string): DocTopic | undefined {
  return DOC_TOPICS.find((topic) => topic.slug === slug);
}
