// Entrypoint. Configuration comes from the environment.
//
//   SLACK_APP_TOKEN, SLACK_BOT_TOKEN   real Slack app credentials
//   PUBLIC_URL                         URL daemons use to reach the gateway (e.g. http://ach-channelmux.ach.svc)
//   AUTH_RESOLVER_URL                  endpoint that resolves a daemon's token (GET) to its owner
//   AUTH_RESOLVER_HEADER               request header carrying the token
//   AUTH_RESOLVER_EMAIL_FIELD          dotted path to the owner's email in the JSON reply (default "email")
//   PORT                               default 8080
//   SESSION_PREAMBLE                   optional; added to each thread's first message (default below, "" disables)
//   OFFLINE_MESSAGE                    optional; reply while the user's daemon is not connected
//   CHANNELS                           optional; name or id=owner email,… channels whose mentions go to that owner's daemon (default: DMs only)
//   CODE_CHANNELS                      optional; of those, the channels where a mention opens a Slack code channel

import { createGateway, parseChannels } from "./gateway.ts";
import { tokenResolver } from "./resolver.ts";

// The daemon wraps each Slack message in <slack ...> and streams the reply text plus a card per
// tool call. The gateway wraps this in a relay-context block with the user's name, email and local time.
const SLACK_PREAMBLE = `The user is talking to you through Slack. Each of their Slack messages arrives wrapped in
<slack from="..." at="...">...</slack>. Anything not wrapped that way did not come from Slack (for
example, when this session is later continued in a terminal): answer that normally.
In Slack they see your reply text and, while you work, one folded card per stretch of thinking and
tool calls (the tools' names, not their results).
- Finish the request in this turn: do not stop after saying what you will do.
- When the user asks to run something (e.g. \`ls -la\`), run it, then paste the relevant
  output in a code block. Trim long output and say so.
- Write GitHub-style Markdown: short paragraphs, lists, tables, and code blocks with a language
  (\`\`\`diff for changes). No HTML. Slack does not render LaTeX: never write \$…\$, \$\$…\$\$ or \\(…\\),
  not even for a single symbol; write math as plain text or Unicode (n, 1/ln(n), x², √2, ≤).
- To send the user a file (an image, a report, a log), use the send_file tool.
- When you need the user to decide something to go on, ask with the ask_user tool (they tap an
  answer); do not end your turn just to ask.`;

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};

const gw = createGateway({
  port: Number(env("PORT", "8080")),
  publicUrl: env("PUBLIC_URL").replace(/\/$/, ""),
  upstreamApiUrl: env("SLACK_API_URL", "https://slack.com/api/"),
  appToken: env("SLACK_APP_TOKEN"),
  botToken: env("SLACK_BOT_TOKEN"),
  resolveToken: tokenResolver({
    url: env("AUTH_RESOLVER_URL"),
    header: env("AUTH_RESOLVER_HEADER"),
    emailField: env("AUTH_RESOLVER_EMAIL_FIELD", "email"),
  }),
  sessionPreamble: env("SESSION_PREAMBLE", SLACK_PREAMBLE),
  offlineMessage: process.env.OFFLINE_MESSAGE || undefined,
  channels: parseChannels(process.env.CHANNELS ?? "", process.env.CODE_CHANNELS ?? ""),
});

await gw.start();
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => gw.stop().then(() => process.exit(0)));
