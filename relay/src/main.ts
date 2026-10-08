// Entrypoint. Configuration comes from the environment.
//
//   SLACK_APP_TOKEN, SLACK_BOT_TOKEN   real Slack app credentials
//   PUBLIC_URL                         URL daemons use to reach the gateway (e.g. http://ach-channelmux.ach.svc)
//   AUTH_RESOLVER_URL                  endpoint that resolves a daemon's token (GET) to its owner
//   AUTH_RESOLVER_HEADER               request header carrying the token
//   AUTH_RESOLVER_EMAIL_FIELD          dotted path to the owner's email in the JSON reply (default "email")
//   PORT                               default 8080
//   SESSION_PREAMBLE                   optional; added to each thread's first message (default below, "" disables)

import { createGateway } from "./gateway.ts";
import { tokenResolver } from "./resolver.ts";

// The daemon streams the reply text plus a card per tool call (title and status).
// The gateway wraps it in a relay-context block with the user's name, email and local time.
const SLACK_PREAMBLE = `The user is talking to you through Slack. They see your reply text and, while you work,
each tool call's title and status, but not tool output, thinking or usage stats.
- Finish the request in this turn: do not stop after saying what you will do.
- When the user asks to run something (e.g. \`ls -la\`), run it, then paste the relevant
  output in your reply inside a code block. Trim long output and say so.
- Use Slack-friendly Markdown: short paragraphs, code blocks, no tables or HTML.`;

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
});

await gw.start();
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => gw.stop().then(() => process.exit(0)));
