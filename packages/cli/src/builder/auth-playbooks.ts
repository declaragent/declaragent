/**
 * Auth setup playbooks — one concise guide per supported provider.
 *
 * The plan (BUILDER_PLAN §7 phase 2) names a `.md`-per-provider layout
 * under `auth-playbooks/`. We inline the content as string literals
 * here instead: `tsc` does not copy `.md` files from `src/` to `dist/`,
 * and adding a prebuild copy step for five small files is not worth
 * the extra moving part. The markdown is authored, reviewed, and
 * versioned here the same way a `.md` file would be.
 *
 * To add a provider:
 *   1. Append an entry to {@link AUTH_PLAYBOOK_PROVIDERS}.
 *   2. Append the markdown in {@link AUTH_PLAYBOOKS}.
 *   3. Add a test to `auth-playbook.test.ts`.
 *
 * @since 0.2.0
 */

export const AUTH_PLAYBOOK_PROVIDERS = ['anthropic', 'openai', 'github', 'slack', 'vault'] as const;

export type AuthPlaybookProvider = (typeof AUTH_PLAYBOOK_PROVIDERS)[number];

export function isAuthPlaybookProvider(value: string): value is AuthPlaybookProvider {
  return (AUTH_PLAYBOOK_PROVIDERS as readonly string[]).includes(value);
}

const ANTHROPIC = `# Anthropic API key

1. Sign in at https://console.anthropic.com.
2. Go to **Settings → API Keys** and click **Create Key**.
3. Copy the key (it starts with \`sk-ant-\`). It is shown **once**.
4. Store it as \`ANTHROPIC_API_KEY\` in your \`.env\`.

## Required scopes
None — Anthropic keys are account-scoped, not per-resource.

## Rotation
Rotate by creating a new key, swapping it in \`.env\`, then revoking the old
key in the console. No traffic overlap is required; clients pick up the
new value on restart.

## Never do
- Commit the key. Declaragent's \`.gitignore\` covers \`.env\` by default;
  do not add the file with \`git add -f\`.
- Paste the key into a REPL message. The builder redacts \`sk-ant-…\`
  prefixes but you should not rely on detection.`;

const OPENAI = `# OpenAI API key

1. Sign in at https://platform.openai.com.
2. Go to **API keys** → **Create new secret key**.
3. Choose **Restricted** and grant the minimum scope your agent needs
   (typically \`model.request\`). Give the key a name tied to this
   agent so you can audit usage later.
4. Copy the key (starts with \`sk-proj-\` for project keys or
   \`sk-live-\` for user keys).
5. Store as \`OPENAI_API_KEY\` in \`.env\`.

## Required scopes
\`model.request\` is the baseline. Add \`fine_tuning.read\` only if your
skills poll fine-tune status.

## Rotation
OpenAI keys support overlap — create a new key before deleting the old
one so in-flight requests don't 401. Swap \`.env\`, restart the agent,
then revoke.

## Never do
- Use an **unrestricted** account key. If the agent's key leaks, the
  blast radius is everything in the account.`;

const GITHUB = `# GitHub PAT (fine-grained)

1. Sign in at https://github.com.
2. Go to **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens**.
3. Click **Generate new token**:
   - **Resource owner**: the org or user that owns the target repo.
   - **Repository access**: select the minimum set of repos.
   - **Permissions**: grant only what this agent needs, e.g.
     - *Pull requests: Read* for a PR-review agent
     - *Contents: Read* for a repo-search agent
     - *Issues: Write* only if the agent files issues
4. Set an expiry ≤ 90 days. Put the expiry date in your calendar.
5. Copy the token (\`ghp_…\`) and store as \`GITHUB_TOKEN\` in \`.env\`.

## Required scopes
Least-privilege — the defaults under "Permissions" are too broad.

## Rotation
GitHub fine-grained tokens cannot be rotated in place; generate a new
one, swap \`.env\`, restart, then revoke the old token in the token
list.

## Never do
- Use a **classic** PAT. They grant account-wide access and can't be
  scoped to a single repo.
- Grant *admin:org*, *delete_repo*, or *workflow* unless the agent
  explicitly needs them. When in doubt, don't.`;

const SLACK = `# Slack bot + app-level tokens

1. Go to https://api.slack.com/apps and click **Create New App** →
   **From scratch**.
2. Give the app a name and pick the target workspace.
3. Under **OAuth & Permissions**, add the bot scopes your agent needs.
   Common choices:
   - \`chat:write\` — send messages as the bot
   - \`channels:history\` — read channel messages (only channels the
     bot is invited to)
   - \`im:history\`, \`im:write\` — direct messages
   - \`reactions:write\` — emoji reactions (e.g. "eyes" on receipt)
4. Under **Socket Mode**, enable it. This avoids opening inbound
   webhook ports.
5. Under **Basic Information → App-Level Tokens**, click **Generate**
   and grant the \`connections:write\` scope. Copy it — starts with
   \`xapp-\`. Store as \`SLACK_APP_TOKEN\` in \`.env\`.
6. Install the app to your workspace (OAuth & Permissions → Install to
   Workspace). Copy the **Bot User OAuth Token** — starts with
   \`xoxb-\`. Store as \`SLACK_BOT_TOKEN\` in \`.env\`.
7. Invite the bot to every channel it should read or post in with
   \`/invite @your-bot\`.

## Required scopes
Least-privilege. Never request \`chat:write.public\` (post anywhere) or
\`admin\` scopes.

## Rotation
Regenerate the bot token under **OAuth & Permissions**. Regenerate the
app-level token under **Basic Information**. Both invalidate the old
value immediately, so schedule a restart window.

## Never do
- Enable **events** with an HTTP callback URL unless you have a TLS
  ingress ready. Socket Mode is the safer default for most fleets.`;

const VAULT = `# HashiCorp Vault

Declaragent's Vault secret provider uses an **auth method** + a **path
pattern** to fetch secrets at runtime. You do not paste values into
\`.env\`; you configure Vault access instead.

1. Pick an auth method based on where the agent runs:
   - **Kubernetes**: use the \`kubernetes\` auth method with a
     ServiceAccount. The agent pod's ServiceAccount token is exchanged
     for a Vault token at runtime. No shared secret on disk.
   - **AppRole**: suitable for VMs / bare metal. Provision a
     \`role_id\` + \`secret_id\` and wrap the \`secret_id\` in a
     response-wrapping token so \`.env\` never holds a long-lived
     credential.
   - **Token** (development only): a plain Vault token in
     \`VAULT_TOKEN\`. Not for production.

2. Create a policy that grants \`read\` on exactly the paths this agent
   needs. Example:
   \`\`\`hcl
   path "kv/data/my-agent/*" { capabilities = ["read"] }
   \`\`\`

3. In your \`secrets.yaml\`, add a provider of type \`vault\` with the
   address and auth config:
   \`\`\`yaml
   version: 1
   providers:
     vault-prod:
       type: vault
       address: https://vault.example.com
       auth:
         method: approle
         roleId: \${env:VAULT_ROLE_ID}
         secretId: \${env:VAULT_SECRET_ID}
   \`\`\`

4. Reference individual secrets inline in skills / sources / channels:
   \`\${secret:vault-prod:kv/data/my-agent/gh-token}\`.

## Never do
- Grant \`*\` capabilities on a path prefix.
- Mount \`kv/\` without a per-agent sub-path — that lets one leaky agent
  read every other agent's secrets.
- Ship a production agent with the \`token\` auth method.`;

export const AUTH_PLAYBOOKS: Readonly<Record<AuthPlaybookProvider, string>> = Object.freeze({
  anthropic: ANTHROPIC,
  openai: OPENAI,
  github: GITHUB,
  slack: SLACK,
  vault: VAULT,
});

export function getAuthPlaybook(provider: AuthPlaybookProvider): string {
  return AUTH_PLAYBOOKS[provider];
}
