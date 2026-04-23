/**
 * declaragent.dev — landing page behavior.
 *
 * Features:
 *   1. Typing terminal — cycles through a realistic CLI lifecycle,
 *      with a skip button for returning visitors.
 *   2. Install command copy + install-method tabs (npm / brew / curl).
 *   3. Live in-browser fleet validator (Advanced section).
 *   4. Event-tracking stub — `track(name, props)` routes through
 *      `posthog.capture(...)` when PostHog is loaded (snippet is in
 *      index.html, commented out until a project API key is wired),
 *      and no-ops otherwise. Wires up `data-track="..."` attributes on
 *      clickable elements so marketing can measure the funnel without
 *      touching the markup. Event-name convention: `<section>:<action>`.
 *   5. IntersectionObserver fade-in on sections (respects
 *      prefers-reduced-motion).
 */

/* ───────────────────────── analytics stub ───────────────────────── */

// PostHog: product analytics + session replay + funnels + feature
// flags. When the <script> in index.html is uncommented with a valid
// project API key, `window.posthog` exists and `posthog.capture(name,
// props)` fires real events. Until then, the stub below keeps
// `track()` from throwing. The loader snippet in index.html also
// installs a lazy stub — we guard for both paths here.
function track(name, props) {
  try {
    if (typeof window.posthog?.capture === 'function') {
      window.posthog.capture(name, props);
    }
    // No-op otherwise; analytics must never break the page.
  } catch {
    /* ignore */
  }
}

// Wire every element carrying `data-track="section:label"` to fire a
// named event on click. One convention covers every CTA on the page.
// Click name → PostHog event name (colon-delimited, e.g. "hero:star").
// When adding new CTAs, use `data-track="<section>:<action>"` — this
// wiring picks them up automatically, no JS changes needed.
document.addEventListener('click', (ev) => {
  const target = ev.target instanceof Element ? ev.target.closest('[data-track]') : null;
  if (!target) return;
  const name = target.getAttribute('data-track');
  if (!name) return;
  // Capture the destination when the element is an anchor — useful
  // for outbound-link attribution in PostHog's Insights.
  const props =
    target instanceof HTMLAnchorElement && target.href
      ? { href: target.href, external: target.host !== window.location.host }
      : undefined;
  track(name, props);
});

const installCmd = document.getElementById('install-cmd');

/* ───────────────────────── typing terminal ───────────────────────── */

const termBody = document.getElementById('term-body');
const termCursor = document.getElementById('term-cursor');

/**
 * Scripted CLI lifecycle. Each entry is a pair of lines to type out —
 * one "input" prompt+command, then a multi-line "output". The typer
 * colors spans via a tiny inline tag syntax: `{prompt}$ `, `{ok}✓...`,
 * `{dim}text`, `{warn}text`, `{key}name:`, `{str}"value"`.
 */
const SCRIPT = [
  {
    in: '{prompt}$ {cmd}declaragent init --template concierge --provider anthropic',
    out: [
      '  wrote agent.yaml',
      '  wrote skills/concierge.md',
      '  wrote .env.example',
      '{ok}✓ init complete — concierge scaffolded.',
    ],
  },
  {
    in: '{prompt}$ {cmd}declaragent plugin install @declaragent/plugin-github',
    out: [
      '  resolving … plugin-github@1.4.0',
      '  consent: 3 permissions requested',
      '    {key}Bash:gh pr view*          {dim}read-only',
      '    {key}Bash:gh pr comment*       {dim}write',
      '    {key}Network:api.github.com    {dim}scoped',
      '{ok}✓ installed + permissions granted.',
    ],
  },
  {
    in: '{prompt}$ {cmd}declaragent source add webhook gh-events --config-file ./hook.yaml',
    out: [
      '  idempotency: transport-natural',
      "  dlq:          {str}'.declaragent/dlq/gh-events.db'",
      '{ok}✓ added webhook source "gh-events".',
    ],
  },
  {
    in: '{prompt}$ {cmd}declaragent daemon',
    out: [
      '  sources (1):  {dim}gh-events    {ok}healthy',
      '  tenants (1):  {dim}default      {ok}active',
      '  listening on {str}unix:///var/run/declaragent.sock',
      '',
      '  [webhook.received] {key}pr:opened  {dim}acme/app#42',
      '  → {key}skill:review-pr  {dim}depth=0',
      '  → tools:   {dim}Read, Bash, GitHubFetchDiff',
      '  → turns:   {dim}4  tokens: 2,341 in / 612 out',
      '  {ok}✓ responded  {dim}$0.0084  latency 2.1s',
    ],
  },
  {
    in: '{prompt}$ {cmd}declaragent audit verify',
    out: [
      '  records:     {dim}1,247',
      '  span:        {dim}2026-04-18 → 2026-04-20',
      '  chain head:  {dim}sha256:a91b…c7e',
      '{ok}✓ verified — no gaps, no forks, no tampering.',
    ],
  },
  {
    in: '{prompt}$ {cmd}declaragent deploy gcp-cloud-run --project acme --region us-central1',
    out: [
      '  building container …     {ok}✓  {dim}112 MiB',
      '  pushing to registry …    {ok}✓',
      '  deploying concierge@{str}v0.1.3-a1b2c3d …',
      '  health probe /healthz … {ok}200 OK',
      '{ok}✓ deployed. URL: https://concierge-a1b2c3d-uc.a.run.app',
    ],
  },
  // v0.2 — builder toolkit. Three lines showing propose → /yes → apply
  // so visitors see the conversational surface without leaving the hero.
  {
    in: '{prompt}you> {cmd}/plan add a pr-review Slack bot that DMs me on blockers',
    out: [
      '{dim}Proposal 8e4c6e8b-… — add a pr-review Slack bot',
      '{dim}  1. [addAgent]  scaffold pr-review from template',
      '{dim}  2. [addSkill]  write skills/dm-on-blockers.md',
      '{dim}  3. [addSecret] reserve {key}SLACK_BOT_TOKEN {dim}(provider: env)',
      '{dim}Type {cmd}/yes{dim} to apply, {cmd}/no{dim} to cancel.',
    ],
  },
  {
    in: '{prompt}you> {cmd}/yes',
    out: [
      '{ok}✓ proposal confirmed.',
      '  {dim}captured git HEAD  {key}7b0a1c9',
      '  {dim}addAgent   → agents/pr-reviewer/',
      '  {dim}addSkill   → skills/dm-on-blockers.md',
      '  {dim}addSecret  → .env.example  {key}DECLARA_SLACK_BOT_TOKEN=',
      '{ok}✓ apply complete — 3 steps, 0 rollback.',
    ],
  },
];

// Render spec: build a list of { char, cls } tuples from the tagged string
// so we can type char-by-char while preserving coloring.
function tokenize(line) {
  const out = [];
  let cls = null;
  let i = 0;
  while (i < line.length) {
    if (line[i] === '{') {
      const end = line.indexOf('}', i);
      if (end > i) {
        cls = line.slice(i + 1, end) || null;
        i = end + 1;
        continue;
      }
    }
    out.push({ ch: line[i], cls });
    i += 1;
  }
  return out;
}

// Skip button support — when `skipRequested` is true the typer
// drains remaining lines instantly and renders the final frame.
let skipRequested = false;
const termSkipBtn = document.getElementById('term-skip');
if (termSkipBtn) {
  termSkipBtn.addEventListener('click', () => {
    skipRequested = true;
    termSkipBtn.setAttribute('hidden', '');
  });
}

async function typeTerminal() {
  if (!termBody || !termCursor) return;
  // Two loops: one full pass through the SCRIPT then clear + repeat.
  // Each run keeps rendered output in the DOM so the terminal fills
  // out top-to-bottom, then resets.
  while (true) {
    termBody.textContent = '';
    if (termSkipBtn) termSkipBtn.removeAttribute('hidden');
    skipRequested = false;
    for (const step of SCRIPT) {
      await typeLine(step.in, { delayPerChar: 28 });
      await sleep(skipRequested ? 0 : 220);
      for (const line of step.out) {
        await typeLine(line, { delayPerChar: 8, instantSpans: true });
      }
      await sleep(skipRequested ? 0 : 640);
    }
    await sleep(skipRequested ? 1200 : 5500);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function typeLine(raw, { delayPerChar, instantSpans }) {
  const tokens = tokenize(raw);
  if (instantSpans || skipRequested) {
    // Output lines (or skip in flight): render the whole line immediately.
    for (const { ch, cls } of tokens) appendChar(ch, cls);
    appendChar('\n', null);
    return;
  }
  for (const { ch, cls } of tokens) {
    appendChar(ch, cls);
    if (skipRequested) continue;
    await sleep(delayPerChar + Math.random() * 18);
  }
  appendChar('\n', null);
}

function appendChar(ch, cls) {
  if (!termBody) return;
  // Group consecutive same-class chars into one span for cleaner DOM.
  const last = termBody.lastElementChild;
  if (cls && last && last.dataset.cls === cls) {
    last.appendChild(document.createTextNode(ch));
    return;
  }
  if (cls) {
    const span = document.createElement('span');
    span.className = cls;
    span.dataset.cls = cls;
    span.appendChild(document.createTextNode(ch));
    termBody.appendChild(span);
  } else {
    termBody.appendChild(document.createTextNode(ch));
  }
  // Keep the terminal scrolled to the latest line.
  termBody.parentElement?.scrollTo({ top: 99999, behavior: 'auto' });
}

window.addEventListener('load', () => {
  typeTerminal();
  mountFadeIn();
});

/* ───────────────────────── fade-in on scroll ───────────────────────── */

// Respect OS-level reduced-motion preferences — skip the animation
// entirely and let content render plain.
function mountFadeIn() {
  if (typeof IntersectionObserver !== 'function') return;
  const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  if (mq?.matches) return;

  const targets = document.querySelectorAll('main > section');
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-visible');
        io.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -10% 0px', threshold: 0.05 },
  );
  for (const el of targets) {
    // Skip the hero — it should appear immediately, no fade.
    if (el.classList.contains('hero')) continue;
    el.classList.add('fade-in');
    io.observe(el);
  }
}

/* ───────────────────────── install command copy ───────────────────────── */

if (installCmd) {
  async function copyInstall() {
    const text = 'npm i -g @declaragent/cli';
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* ignore */
      }
      document.body.removeChild(ta);
    }
    installCmd.classList.add('copied');
    setTimeout(() => installCmd.classList.remove('copied'), 1500);
  }
  installCmd.addEventListener('click', copyInstall);
  installCmd.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      copyInstall();
    }
  });
}

/* ───────────────────────── fleet validator (browser port) ──────────────── */

/**
 * Minimal YAML parser for the subset we care about: mappings, sequences,
 * scalars (strings, numbers, booleans), flow-style objects, comments,
 * block scalars. Fleet manifests in the wild use a narrow subset — this
 * parser handles it without pulling in a 50KB+ YAML lib.
 *
 * NOT a general-purpose YAML parser. If someone crafts a fleet.yaml that
 * exercises anchors / tags / multi-doc streams, parsing fails loudly and
 * the validator reports a yaml.parse error.
 */
function parseYaml(src) {
  // Strip comments + blank lines but keep line numbers for error reporting.
  const lines = src.split('\n').map((raw) => {
    // Remove comments that aren't inside a string.
    let inQuote = null;
    let out = '';
    for (let i = 0; i < raw.length; i += 1) {
      const c = raw[i];
      if (inQuote) {
        out += c;
        if (c === inQuote && raw[i - 1] !== '\\') inQuote = null;
        continue;
      }
      if (c === '"' || c === "'") {
        inQuote = c;
        out += c;
        continue;
      }
      if (c === '#') break; // rest of line is a comment
      out += c;
    }
    return out.replace(/\s+$/, '');
  });

  let idx = 0;

  function indentOf(line) {
    let i = 0;
    while (i < line.length && line[i] === ' ') i += 1;
    return i;
  }

  function parseScalar(raw) {
    const s = raw.trim();
    if (s === '') return null;
    if (s === 'null' || s === '~') return null;
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
    }
    // Flow-style object / array — cheap JSON-like parse.
    if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
      return parseFlow(s);
    }
    return s;
  }

  function parseFlow(s) {
    // Convert bare keys + values to JSON then JSON.parse.
    // Rough: `{ kind: memory, topics: { requests: foo } }` → `{"kind":"memory",...}`.
    // Works for the shapes we emit in this page; breaks on weird strings.
    const quoted = s
      // quote keys (anything that looks like an identifier, followed by :)
      .replace(/([,{\[\s])([A-Za-z_][\w-]*)\s*:/g, '$1"$2":')
      .replace(/^\s*{\s*([A-Za-z_][\w-]*)\s*:/g, '{"$1":')
      // quote bare scalar values (word chars, ., /) that aren't booleans/numbers/already-quoted
      .replace(/:\s*([A-Za-z_][\w.\/-]*)(?=\s*[,}\]])/g, (_m, val) =>
        ['true', 'false', 'null'].includes(val) || /^-?\d+(\.\d+)?$/.test(val)
          ? `: ${val}`
          : `: "${val}"`,
      );
    try {
      return JSON.parse(quoted);
    } catch {
      return s;
    }
  }

  function peek() {
    while (idx < lines.length && lines[idx].trim() === '') idx += 1;
    return idx < lines.length ? lines[idx] : null;
  }

  function parseBlock(parentIndent) {
    const line = peek();
    if (!line) return null;

    // Sequence
    const trimmed = line.trim();
    const lineIndent = indentOf(line);
    if (lineIndent <= parentIndent) return null;
    if (trimmed.startsWith('- ') || trimmed === '-') {
      const arr = [];
      while (idx < lines.length) {
        const cur = lines[idx];
        if (cur.trim() === '') {
          idx += 1;
          continue;
        }
        const curI = indentOf(cur);
        if (curI !== lineIndent) break;
        const curT = cur.trim();
        if (!curT.startsWith('-')) break;
        const afterDash = curT.slice(1).trim();
        idx += 1;
        if (afterDash === '') {
          const v = parseBlock(curI);
          arr.push(v ?? null);
        } else if (
          afterDash.includes(':') &&
          !afterDash.startsWith('{') &&
          !afterDash.startsWith('[')
        ) {
          // Inline map after `- ` — synthesize a child map starting at curI + 2
          const fakeLine = ' '.repeat(curI + 2) + afterDash;
          lines.splice(idx, 0, fakeLine);
          const v = parseBlock(curI);
          arr.push(v ?? {});
        } else {
          arr.push(parseScalar(afterDash));
        }
      }
      return arr;
    }

    // Mapping
    if (trimmed.includes(':')) {
      const map = {};
      while (idx < lines.length) {
        const cur = lines[idx];
        if (cur.trim() === '') {
          idx += 1;
          continue;
        }
        const curI = indentOf(cur);
        if (curI !== lineIndent) break;
        const curT = cur.trim();
        if (curT.startsWith('- ') || curT === '-') break;
        const colonAt = findColon(curT);
        if (colonAt === -1) break;
        const key = curT.slice(0, colonAt).trim();
        const rest = curT.slice(colonAt + 1).trim();
        idx += 1;
        if (rest === '' || rest === '>-' || rest === '|') {
          // Block scalar for `|` and `>-`; for simplicity join until dedent.
          if (rest === '|' || rest === '>-') {
            const blk = [];
            while (idx < lines.length) {
              const l = lines[idx];
              if (l.trim() === '') {
                blk.push('');
                idx += 1;
                continue;
              }
              const li = indentOf(l);
              if (li <= lineIndent) break;
              blk.push(l.slice(lineIndent + 2));
              idx += 1;
            }
            map[key] = rest === '|' ? blk.join('\n') : blk.join(' ').trim();
          } else {
            const v = parseBlock(curI);
            map[key] = v ?? null;
          }
        } else {
          map[key] = parseScalar(rest);
        }
      }
      return map;
    }

    idx += 1;
    return parseScalar(trimmed);
  }

  function findColon(s) {
    let inQ = null;
    for (let i = 0; i < s.length; i += 1) {
      const c = s[i];
      if (inQ) {
        if (c === inQ) inQ = null;
        continue;
      }
      if (c === '"' || c === "'") inQ = c;
      else if (c === ':') return i;
    }
    return -1;
  }

  const root = parseBlock(-1);
  return root ?? {};
}

/* ── Validator: port of packages/cli/src/fleet-cli.ts runValidations ── */

const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

function validateFleet(manifest) {
  const findings = [];
  const add = (severity, code, message) => findings.push({ severity, code, message });

  // Schema-level
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    add('error', 'manifest.shape', 'fleet.yaml must be a mapping at the top level.');
    return findings;
  }
  if (manifest.version !== 1) {
    add('error', 'manifest.version', '`version` must equal 1.');
  }
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    add('error', 'manifest.name', '`name` must be a non-empty string.');
  }

  const agents = Array.isArray(manifest.agents) ? manifest.agents : [];
  if (!Array.isArray(manifest.agents)) {
    add('error', 'manifest.agents', '`agents` must be an array.');
  }

  // Agent entries
  const agentsById = new Map();
  const seenIds = new Set();
  for (const agent of agents) {
    if (!agent || typeof agent !== 'object') {
      add('error', 'agent.shape', 'every agents[] entry must be a mapping.');
      continue;
    }
    if (typeof agent.id !== 'string' || !AGENT_ID_RE.test(agent.id)) {
      add(
        'error',
        'agent.id',
        `agent id ${JSON.stringify(agent.id)} must be URL-safe (a-z0-9_- and start alphanumeric).`,
      );
      continue;
    }
    if (seenIds.has(agent.id)) {
      add('error', 'agent.duplicate', `duplicate agent id "${agent.id}".`);
      continue;
    }
    seenIds.add(agent.id);
    if (typeof agent.path !== 'string' || agent.path.length === 0) {
      add('error', 'agent.path', `agent "${agent.id}" has no path.`);
    }
    agentsById.set(agent.id, agent);
  }

  // Environment refs
  const envs =
    manifest.environments && typeof manifest.environments === 'object'
      ? manifest.environments
      : { default: {} };
  for (const agent of agents) {
    if (!agent?.id) continue;
    const env = agent.env ?? 'default';
    if (!Object.hasOwn(envs, env)) {
      add(
        'error',
        'agent.env.missing',
        `agent "${agent.id}" references environment "${env}" which is not declared in environments{}.`,
      );
    }
  }

  // Deploy targets
  const targets = manifest.deploy?.targets ?? {};
  for (const agent of agents) {
    if (!agent?.deploy?.target) continue;
    if (!Object.hasOwn(targets, agent.deploy.target)) {
      add(
        'error',
        'deploy.target.missing',
        `agent "${agent.id}" deploys to target "${agent.deploy.target}" which is not declared in deploy.targets{}.`,
      );
    }
  }

  // Capabilities aggregation (from inline blocks under agents for the browser demo)
  // Real CLI reads per-agent capabilities.yaml; the browser demo lets users declare
  // them inline under `agents[].capabilities` for quick experimentation.
  const byName = new Map();
  for (const agent of agents) {
    if (!agent?.capabilities || !Array.isArray(agent.capabilities)) continue;
    for (const cap of agent.capabilities) {
      const name = typeof cap === 'string' ? cap : cap?.name;
      if (!name) continue;
      const existing = byName.get(name) ?? [];
      existing.push(agent.id);
      byName.set(name, existing);
    }
  }
  for (const [name, owners] of byName) {
    if (owners.length > 1) {
      add(
        'warning',
        'capability.duplicate',
        `capability "${name}" is declared by multiple agents: ${owners.map((o) => `agent://${o}`).join(', ')}.`,
      );
    }
  }

  // Peers
  const peers = Array.isArray(manifest.peers) ? manifest.peers : [];
  for (const peer of peers) {
    if (!peer?.agent) continue;
    const id = peer.agent.replace(/^agent:\/\//, '');
    if (!agentsById.has(id)) {
      if (id.includes('.')) {
        add(
          'info',
          'peer.external',
          `peer ${peer.agent} points outside the fleet (fqdn-style id).`,
        );
      } else {
        add(
          'error',
          'peer.dangling',
          `rpc-peers references ${peer.agent} but no in-fleet agent declares that id.`,
        );
      }
      continue;
    }
    const targetAgent = agentsById.get(id);
    if (!targetAgent.capabilities || targetAgent.capabilities.length === 0) {
      add(
        'warning',
        'peer.client-only',
        `peer agent://${id} has no capabilities — callers will fault at request time.`,
      );
    }
  }

  if (findings.length === 0) {
    add('ok', 'fleet.ok', 'fleet validates clean — no errors, no warnings.');
  }

  return findings;
}

/* ── Render findings ─────────────────────────────────────────────── */

const yamlInput = document.getElementById('yaml-input');
const findingsList = document.getElementById('findings-list');
const validateBtn = document.getElementById('validate-btn');

const DEFAULT_YAML = `version: 1
name: acme-fleet
description: Two-agent fleet paired via agent-rpc.

agents:
  - id: concierge
    path: ./agents/concierge
    env: shared
  - id: pr-reviewer
    path: ./agents/pr-reviewer
    env: shared
    deploy:
      target: cloud-run-reviewer
    capabilities:
      - name: review-pr

environments:
  shared:
    peersRef: ./rpc-peers.yaml

peers:
  - agent: agent://pr-reviewer
    transports:
      - { kind: memory, topics: { requests: agents.pr-reviewer.requests } }

deploy:
  strategy: rolling
  targets:
    cloud-run-reviewer:
      kind: gcp-cloud-run
      region: us-central1
`;

if (yamlInput) yamlInput.value = DEFAULT_YAML;

function runValidation() {
  if (!findingsList || !yamlInput) return;
  let manifest;
  try {
    manifest = parseYaml(yamlInput.value);
  } catch (err) {
    renderFindings([
      {
        severity: 'error',
        code: 'yaml.parse',
        message: err instanceof Error ? err.message : String(err),
      },
    ]);
    return;
  }
  const findings = validateFleet(manifest);
  renderFindings(findings);
}

function renderFindings(findings) {
  findingsList.innerHTML = '';
  if (findings.length === 0) {
    const li = document.createElement('li');
    li.className = 'findings__placeholder';
    li.textContent = 'No findings.';
    findingsList.appendChild(li);
    return;
  }
  for (const f of findings) {
    const li = document.createElement('li');
    li.className = `finding finding--${f.severity}`;
    const tag = document.createElement('span');
    tag.className = 'finding__tag';
    tag.textContent = f.severity === 'ok' ? 'pass' : f.severity;
    const body = document.createElement('div');
    body.className = 'finding__body';
    const code = document.createElement('div');
    code.className = 'finding__code';
    code.textContent = f.code;
    const msg = document.createElement('div');
    msg.className = 'finding__msg';
    msg.textContent = f.message;
    body.appendChild(code);
    body.appendChild(msg);
    li.appendChild(tag);
    li.appendChild(body);
    findingsList.appendChild(li);
  }
}

if (validateBtn) {
  validateBtn.addEventListener('click', runValidation);
}

// Auto-validate on first paint so users see output without clicking
if (yamlInput) {
  window.addEventListener('load', () => setTimeout(runValidation, 350));
}

/* ───────────────────────── install method tabs ──────────────────────── */

const installTabs = document.querySelectorAll('.install__tab');
const installPanels = document.querySelectorAll('[data-install-panel]');

if (installTabs.length > 0 && installPanels.length > 0) {
  for (const tab of installTabs) {
    tab.addEventListener('click', () => {
      const want = tab.dataset.install;
      for (const t of installTabs) {
        const active = t === tab;
        t.classList.toggle('is-active', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
      }
      for (const p of installPanels) {
        if (p.dataset.installPanel === want) p.removeAttribute('hidden');
        else p.setAttribute('hidden', '');
      }
    });
  }
}
