/**
 * declaragent.dev — landing page behavior.
 *
 * Two features:
 *   1. Interactive fleet diagram — an envelope animates along the edge
 *      from concierge → pr-reviewer and back. Click a node to replay.
 *   2. Live in-browser fleet validator — parses the user's fleet.yaml,
 *      runs the same findings logic as `declaragent fleet validate`,
 *      and renders the results. No server round-trip.
 *
 * The validator is a faithful port of the slice-1 validations from
 * packages/cli/src/fleet-cli.ts (peer.dangling, peer.client-only,
 * capability.duplicate, deploy.target.missing) plus the schema-level
 * invariants that the core loader enforces at load time (agent id
 * uniqueness, manifest shape, env references).
 */

/* ───────────────────────── fleet SVG animation ───────────────────────── */

const stage = document.getElementById("fleet-stage");
const envelope = document.getElementById("envelope");
const statusEl = document.getElementById("fleet-status");
const clickHint = document.getElementById("click-hint");
const concierge = document.getElementById("node-concierge");
const reviewer = document.getElementById("node-reviewer");
const installCmd = document.getElementById("install-cmd");

/**
 * Interpolate a point along the edge path. The path is a cubic bezier;
 * we use getPointAtLength which the browser exposes natively on SVG paths.
 */
const edgePath = document.getElementById("edge-out");
const edgeLen = edgePath ? edgePath.getTotalLength() : 0;

function setEnvelopeAt(t) {
  if (!edgePath || !envelope) return;
  const pt = edgePath.getPointAtLength(Math.max(0, Math.min(1, t)) * edgeLen);
  envelope.setAttribute("transform", `translate(${pt.x} ${pt.y})`);
}

let animating = false;
function playRoundTrip({ from } = { from: "concierge" }) {
  if (animating) return;
  animating = true;
  if (clickHint) clickHint.style.opacity = "0.3";
  const reverse = from === "reviewer";

  const start = reverse ? reviewer : concierge;
  const end = reverse ? concierge : reviewer;
  start.classList.add("active");

  const dur = 1600;
  const t0 = performance.now();
  envelope.setAttribute("opacity", "1");
  setStatus(reverse ? "response ← pr-reviewer" : "request → pr-reviewer");

  function frame(now) {
    const p = Math.min(1, (now - t0) / dur);
    // easeInOutCubic
    const eased = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    setEnvelopeAt(reverse ? 1 - eased : eased);
    if (p < 1) {
      requestAnimationFrame(frame);
    } else {
      start.classList.remove("active");
      end.classList.add("active");
      // response leg (unless this IS the response)
      if (!reverse) {
        setTimeout(() => {
          end.classList.remove("active");
          playReturn();
        }, 380);
      } else {
        envelope.setAttribute("opacity", "0");
        setTimeout(() => {
          end.classList.remove("active");
          setStatus("idle");
          animating = false;
        }, 220);
      }
    }
  }
  requestAnimationFrame(frame);

  function playReturn() {
    setStatus("response ← pr-reviewer");
    const t1 = performance.now();
    function rFrame(now) {
      const p = Math.min(1, (now - t1) / dur);
      const eased = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      setEnvelopeAt(1 - eased);
      if (p < 1) {
        requestAnimationFrame(rFrame);
      } else {
        envelope.setAttribute("opacity", "0");
        setTimeout(() => {
          end.classList.remove("active");
          concierge.classList.remove("active");
          setStatus("idle");
          animating = false;
        }, 220);
      }
    }
    requestAnimationFrame(rFrame);
  }
}

function setStatus(s) {
  if (statusEl) statusEl.textContent = s;
}

// Wire up node clicks + keyboard
[concierge, reviewer].forEach((n) => {
  if (!n) return;
  n.addEventListener("click", () => {
    playRoundTrip({ from: n === reviewer ? "reviewer" : "concierge" });
  });
  n.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      playRoundTrip({ from: n === reviewer ? "reviewer" : "concierge" });
    }
  });
});

// Space key from anywhere on the page replays
document.addEventListener("keydown", (e) => {
  if (
    e.key === " " &&
    document.activeElement?.tagName !== "TEXTAREA" &&
    document.activeElement?.tagName !== "INPUT"
  ) {
    e.preventDefault();
    playRoundTrip();
  }
});

// Auto-play once on load (after everything renders)
window.addEventListener("load", () => {
  setTimeout(() => playRoundTrip(), 600);
});

/* ───────────────────────── install command copy ───────────────────────── */

if (installCmd) {
  async function copyInstall() {
    const text = "npm i -g @declaragent/cli";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* ignore */
      }
      document.body.removeChild(ta);
    }
    installCmd.classList.add("copied");
    setTimeout(() => installCmd.classList.remove("copied"), 1500);
  }
  installCmd.addEventListener("click", copyInstall);
  installCmd.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
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
  const lines = src.split("\n").map((raw) => {
    // Remove comments that aren't inside a string.
    let inQuote = null;
    let out = "";
    for (let i = 0; i < raw.length; i += 1) {
      const c = raw[i];
      if (inQuote) {
        out += c;
        if (c === inQuote && raw[i - 1] !== "\\") inQuote = null;
        continue;
      }
      if (c === '"' || c === "'") {
        inQuote = c;
        out += c;
        continue;
      }
      if (c === "#") break; // rest of line is a comment
      out += c;
    }
    return out.replace(/\s+$/, "");
  });

  let idx = 0;

  function indentOf(line) {
    let i = 0;
    while (i < line.length && line[i] === " ") i += 1;
    return i;
  }

  function parseScalar(raw) {
    const s = raw.trim();
    if (s === "") return null;
    if (s === "null" || s === "~") return null;
    if (s === "true") return true;
    if (s === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n");
    }
    // Flow-style object / array — cheap JSON-like parse.
    if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
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
      .replace(
        /:\s*([A-Za-z_][\w.\/-]*)(?=\s*[,}\]])/g,
        (_m, val) =>
          ["true", "false", "null"].includes(val) || /^-?\d+(\.\d+)?$/.test(val)
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
    while (idx < lines.length && lines[idx].trim() === "") idx += 1;
    return idx < lines.length ? lines[idx] : null;
  }

  function parseBlock(parentIndent) {
    const line = peek();
    if (!line) return null;

    // Sequence
    const trimmed = line.trim();
    const lineIndent = indentOf(line);
    if (lineIndent <= parentIndent) return null;
    if (trimmed.startsWith("- ") || trimmed === "-") {
      const arr = [];
      while (idx < lines.length) {
        const cur = lines[idx];
        if (cur.trim() === "") {
          idx += 1;
          continue;
        }
        const curI = indentOf(cur);
        if (curI !== lineIndent) break;
        const curT = cur.trim();
        if (!curT.startsWith("-")) break;
        const afterDash = curT.slice(1).trim();
        idx += 1;
        if (afterDash === "") {
          const v = parseBlock(curI);
          arr.push(v ?? null);
        } else if (afterDash.includes(":") && !afterDash.startsWith("{") && !afterDash.startsWith("[")) {
          // Inline map after `- ` — synthesize a child map starting at curI + 2
          const fakeLine = " ".repeat(curI + 2) + afterDash;
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
    if (trimmed.includes(":")) {
      const map = {};
      while (idx < lines.length) {
        const cur = lines[idx];
        if (cur.trim() === "") {
          idx += 1;
          continue;
        }
        const curI = indentOf(cur);
        if (curI !== lineIndent) break;
        const curT = cur.trim();
        if (curT.startsWith("- ") || curT === "-") break;
        const colonAt = findColon(curT);
        if (colonAt === -1) break;
        const key = curT.slice(0, colonAt).trim();
        const rest = curT.slice(colonAt + 1).trim();
        idx += 1;
        if (rest === "" || rest === ">-" || rest === "|") {
          // Block scalar for `|` and `>-`; for simplicity join until dedent.
          if (rest === "|" || rest === ">-") {
            const blk = [];
            while (idx < lines.length) {
              const l = lines[idx];
              if (l.trim() === "") {
                blk.push("");
                idx += 1;
                continue;
              }
              const li = indentOf(l);
              if (li <= lineIndent) break;
              blk.push(l.slice(lineIndent + 2));
              idx += 1;
            }
            map[key] = rest === "|" ? blk.join("\n") : blk.join(" ").trim();
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
      else if (c === ":") return i;
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
  const add = (severity, code, message) =>
    findings.push({ severity, code, message });

  // Schema-level
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    add("error", "manifest.shape", "fleet.yaml must be a mapping at the top level.");
    return findings;
  }
  if (manifest.version !== 1) {
    add("error", "manifest.version", "`version` must equal 1.");
  }
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    add("error", "manifest.name", "`name` must be a non-empty string.");
  }

  const agents = Array.isArray(manifest.agents) ? manifest.agents : [];
  if (!Array.isArray(manifest.agents)) {
    add("error", "manifest.agents", "`agents` must be an array.");
  }

  // Agent entries
  const agentsById = new Map();
  const seenIds = new Set();
  for (const agent of agents) {
    if (!agent || typeof agent !== "object") {
      add("error", "agent.shape", "every agents[] entry must be a mapping.");
      continue;
    }
    if (typeof agent.id !== "string" || !AGENT_ID_RE.test(agent.id)) {
      add(
        "error",
        "agent.id",
        `agent id ${JSON.stringify(agent.id)} must be URL-safe (a-z0-9_- and start alphanumeric).`,
      );
      continue;
    }
    if (seenIds.has(agent.id)) {
      add("error", "agent.duplicate", `duplicate agent id "${agent.id}".`);
      continue;
    }
    seenIds.add(agent.id);
    if (typeof agent.path !== "string" || agent.path.length === 0) {
      add("error", "agent.path", `agent "${agent.id}" has no path.`);
    }
    agentsById.set(agent.id, agent);
  }

  // Environment refs
  const envs = manifest.environments && typeof manifest.environments === "object"
    ? manifest.environments
    : { default: {} };
  for (const agent of agents) {
    if (!agent?.id) continue;
    const env = agent.env ?? "default";
    if (!Object.hasOwn(envs, env)) {
      add(
        "error",
        "agent.env.missing",
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
        "error",
        "deploy.target.missing",
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
      const name = typeof cap === "string" ? cap : cap?.name;
      if (!name) continue;
      const existing = byName.get(name) ?? [];
      existing.push(agent.id);
      byName.set(name, existing);
    }
  }
  for (const [name, owners] of byName) {
    if (owners.length > 1) {
      add(
        "warning",
        "capability.duplicate",
        `capability "${name}" is declared by multiple agents: ${owners.map((o) => `agent://${o}`).join(", ")}.`,
      );
    }
  }

  // Peers
  const peers = Array.isArray(manifest.peers) ? manifest.peers : [];
  for (const peer of peers) {
    if (!peer?.agent) continue;
    const id = peer.agent.replace(/^agent:\/\//, "");
    if (!agentsById.has(id)) {
      if (id.includes(".")) {
        add(
          "info",
          "peer.external",
          `peer ${peer.agent} points outside the fleet (fqdn-style id).`,
        );
      } else {
        add(
          "error",
          "peer.dangling",
          `rpc-peers references ${peer.agent} but no in-fleet agent declares that id.`,
        );
      }
      continue;
    }
    const targetAgent = agentsById.get(id);
    if (!targetAgent.capabilities || targetAgent.capabilities.length === 0) {
      add(
        "warning",
        "peer.client-only",
        `peer agent://${id} has no capabilities — callers will fault at request time.`,
      );
    }
  }

  if (findings.length === 0) {
    add("ok", "fleet.ok", "fleet validates clean — no errors, no warnings.");
  }

  return findings;
}

/* ── Render findings ─────────────────────────────────────────────── */

const yamlInput = document.getElementById("yaml-input");
const findingsList = document.getElementById("findings-list");
const validateBtn = document.getElementById("validate-btn");

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
        severity: "error",
        code: "yaml.parse",
        message: err instanceof Error ? err.message : String(err),
      },
    ]);
    return;
  }
  const findings = validateFleet(manifest);
  renderFindings(findings);
}

function renderFindings(findings) {
  findingsList.innerHTML = "";
  if (findings.length === 0) {
    const li = document.createElement("li");
    li.className = "findings__placeholder";
    li.textContent = "No findings.";
    findingsList.appendChild(li);
    return;
  }
  for (const f of findings) {
    const li = document.createElement("li");
    li.className = `finding finding--${f.severity}`;
    const tag = document.createElement("span");
    tag.className = "finding__tag";
    tag.textContent = f.severity === "ok" ? "pass" : f.severity;
    const body = document.createElement("div");
    body.className = "finding__body";
    const code = document.createElement("div");
    code.className = "finding__code";
    code.textContent = f.code;
    const msg = document.createElement("div");
    msg.className = "finding__msg";
    msg.textContent = f.message;
    body.appendChild(code);
    body.appendChild(msg);
    li.appendChild(tag);
    li.appendChild(body);
    findingsList.appendChild(li);
  }
}

if (validateBtn) {
  validateBtn.addEventListener("click", runValidation);
}

// Auto-validate on first paint so users see output without clicking
if (yamlInput) {
  window.addEventListener("load", () => setTimeout(runValidation, 350));
}

/* ───────────────────────── install method tabs ──────────────────────── */

const installTabs = document.querySelectorAll(".install__tab");
const installPanels = document.querySelectorAll("[data-install-panel]");

if (installTabs.length > 0 && installPanels.length > 0) {
  for (const tab of installTabs) {
    tab.addEventListener("click", () => {
      const want = tab.dataset.install;
      for (const t of installTabs) {
        const active = t === tab;
        t.classList.toggle("is-active", active);
        t.setAttribute("aria-selected", active ? "true" : "false");
      }
      for (const p of installPanels) {
        if (p.dataset.installPanel === want) p.removeAttribute("hidden");
        else p.setAttribute("hidden", "");
      }
    });
  }
}
