/**
 * Render a {@link LoadedFleet} to a Helm chart.
 *
 * Chart layout emitted (chart name = sanitized fleet name):
 *
 * ```
 * <chart>/
 * ├── Chart.yaml
 * ├── values.yaml               # replicas / image / namespace / serviceMonitor toggle
 * ├── .helmignore
 * └── templates/
 *     ├── _helpers.tpl          # std labels + name helpers
 *     ├── namespace.yaml
 *     ├── secret.yaml           # key-only, {{ .Values.secrets }}-driven
 *     └── agents/<id>.yaml      # ConfigMap + Deployment + Service + (opt) ServiceMonitor
 * ```
 *
 * Templates use `{{ .Values.* }}` so operators can tune without
 * re-rendering. Keys exposed on `values.yaml`:
 *
 *   - `image.repository`, `image.tag`, `image.pullPolicy`
 *   - `namespace`
 *   - `replicas.default` + `replicas.<agentId>` overrides
 *   - `serviceMonitor.enabled`
 *   - `metricsPort`, `healthProbePath`
 *   - `secrets` — array of env var names (keys only, values at deploy time)
 *
 * `helm lint` + `helm template` both pass against the emitted chart —
 * §3 #9 Acceptance criterion 2.
 *
 * @since 0.6.x (Enterprise plan item #9)
 */

import { readFile } from 'node:fs/promises';
import type { LoadedFleet } from '@declaragent/core';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { AgentSource } from './k8s-renderer.js';
import {
  type RenderOptions,
  type RenderedFile,
  extractSecretRefs,
  resolveRenderOptions,
  sanitizeDns1123Label,
  secretRefToEnvName,
} from './types.js';

const YAML_OPTS = { lineWidth: 0, aliasDuplicateObjects: false } as const;

export async function renderHelm(
  fleet: LoadedFleet,
  opts: RenderOptions = {},
): Promise<RenderedFile[]> {
  const sources = await Promise.all(
    fleet.agents.map(async (a) => ({
      agent: a,
      agentYaml: await readFile(a.agentYamlPath, 'utf-8'),
    })),
  );
  return renderHelmFromSources(fleet, sources, opts);
}

export function renderHelmFromSources(
  fleet: LoadedFleet,
  agents: readonly AgentSource[],
  opts: RenderOptions = {},
): RenderedFile[] {
  const resolved = resolveRenderOptions(fleet.manifest.name, opts);
  const chartName = sanitizeDns1123Label(fleet.manifest.name);
  const files: RenderedFile[] = [];

  // 1. Chart.yaml — pinned apiVersion v2, no timestamps.
  files.push({
    path: 'Chart.yaml',
    contents: stringifyYaml(
      {
        apiVersion: 'v2',
        name: chartName,
        description:
          fleet.manifest.description?.trim() ??
          `Helm chart for the ${chartName} declaragent fleet.`,
        type: 'application',
        version: '0.1.0',
        appVersion: '0.1.0',
        keywords: ['declaragent', 'agents', 'ai'],
      },
      YAML_OPTS,
    ),
  });

  // 2. values.yaml — common knobs. Replica overrides per-agent are
  //    always listed (even when equal to default) so operators can
  //    discover the override surface by reading `values.yaml`.
  const secretRefs = unionSecretRefs(agents);
  files.push({
    path: 'values.yaml',
    contents: renderValuesYaml(fleet, agents, resolved, secretRefs),
  });

  files.push({
    path: '.helmignore',
    contents: HELMIGNORE,
  });

  // 3. _helpers.tpl — standard Helm label helpers.
  files.push({
    path: 'templates/_helpers.tpl',
    contents: renderHelpersTpl(chartName),
  });

  // 4. templates/namespace.yaml — createNamespace toggle-able.
  files.push({
    path: 'templates/namespace.yaml',
    contents: NAMESPACE_TPL,
  });

  // 5. templates/secret.yaml — key-only. Gated on `values.secrets` length.
  files.push({
    path: 'templates/secret.yaml',
    contents: SECRET_TPL,
  });

  // 6. templates/agents/<id>.yaml — per-agent docs.
  for (const src of agents) {
    const id = sanitizeDns1123Label(src.agent.id);
    files.push({
      path: `templates/agents/${id}.yaml`,
      contents: renderAgentTemplate(
        src.agent.id,
        src.agentYaml,
        resolved.serviceMonitor,
        resolved.configSplit ? detectAgentSections(src.agentYaml) : [],
      ),
    });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

// ── values.yaml ────────────────────────────────────────────────────────

function renderValuesYaml(
  fleet: LoadedFleet,
  agents: readonly AgentSource[],
  resolved: ReturnType<typeof resolveRenderOptions>,
  secretRefs: readonly string[],
): string {
  const [repository, tag] = splitImageRef(resolved.image);
  const replicaOverrides: Record<string, number> = {};
  for (const src of agents) {
    const perAgent = src.agent.entry.deploy?.minInstances;
    if (typeof perAgent === 'number' && perAgent > 0) {
      replicaOverrides[sanitizeDns1123Label(src.agent.id)] = perAgent;
    }
  }

  const values: Record<string, unknown> = {
    namespace: resolved.namespace,
    createNamespace: true,
    image: {
      repository,
      tag,
      pullPolicy: 'IfNotPresent',
    },
    replicas: {
      default: resolved.replicas,
      ...replicaOverrides,
    },
    metricsPort: resolved.metricsPort,
    healthProbePath: resolved.healthProbePath,
    serviceMonitor: {
      enabled: resolved.serviceMonitor,
      interval: '30s',
      additionalLabels: {
        prometheus: 'kube-prometheus',
      },
    },
    // Post-enterprise backlog #32: split channel / source / plugin
    // config into dedicated ConfigMaps that envFrom into the
    // Deployment, so operators can rotate per-section config without
    // rebuilding the image. Default-off at 0.7.5; toggle enabled here
    // to flip the behaviour without re-rendering the chart.
    configSplit: {
      enabled: resolved.configSplit,
    },
    // Key-only. Values MUST be supplied at `helm install` time via
    // `--set-string secrets.SLACK_BOT_TOKEN=…` or a sealed-secrets flow.
    secrets: Object.fromEntries(secretRefs.map((ref) => [secretRefToEnvName(ref), ''])),
    resources: {
      requests: { cpu: '100m', memory: '128Mi' },
      limits: { cpu: '500m', memory: '512Mi' },
    },
    fleet: {
      name: sanitizeDns1123Label(fleet.manifest.name),
    },
  };

  return stringifyYaml(values, YAML_OPTS);
}

function splitImageRef(image: string): [string, string] {
  const colon = image.lastIndexOf(':');
  // Do not split on a `:` that is part of the registry host (i.e.
  // `registry.local:5000/foo`); a tag follows the final `/`.
  if (colon <= 0 || colon < image.lastIndexOf('/')) return [image, 'latest'];
  return [image.slice(0, colon), image.slice(colon + 1)];
}

// ── _helpers.tpl ───────────────────────────────────────────────────────

function renderHelpersTpl(chartName: string): string {
  return `{{/*
Standard helpers — name, fullname, labels, selectorLabels.
*/}}
{{- define "declaragent.name" -}}
${chartName}
{{- end -}}

{{- define "declaragent.fullname" -}}
{{- printf "%s" (include "declaragent.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "declaragent.labels" -}}
app.kubernetes.io/name: {{ include "declaragent.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: {{ include "declaragent.name" . }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end -}}

{{- define "declaragent.agentLabels" -}}
{{ include "declaragent.labels" . }}
declaragent.io/agent-id: {{ .agentId }}
app.kubernetes.io/component: {{ .agentId }}
{{- end -}}

{{- define "declaragent.agentSelectorLabels" -}}
app.kubernetes.io/name: {{ include "declaragent.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: {{ .agentId }}
{{- end -}}
`;
}

// ── Namespace template ─────────────────────────────────────────────────

const NAMESPACE_TPL = `{{- if .Values.createNamespace -}}
apiVersion: v1
kind: Namespace
metadata:
  name: {{ .Values.namespace }}
  labels:
    {{- include "declaragent.labels" . | nindent 4 }}
{{- end }}
`;

// ── Secret template ────────────────────────────────────────────────────

const SECRET_TPL = `{{- if gt (len .Values.secrets) 0 -}}
apiVersion: v1
kind: Secret
metadata:
  name: {{ include "declaragent.fullname" . }}-secrets
  namespace: {{ .Values.namespace }}
  labels:
    {{- include "declaragent.labels" . | nindent 4 }}
  annotations:
    declaragent.io/note: >-
      Keys only when rendered from fleet.yaml — supply values via
      --set-string secrets.NAME=... at \`helm install\` time, or use
      External Secrets / Sealed Secrets.
type: Opaque
stringData:
{{- range $k, $v := .Values.secrets }}
  {{ $k }}: {{ $v | quote }}
{{- end }}
{{- end }}
`;

// ── Per-agent template ─────────────────────────────────────────────────

/**
 * Sections we fan into dedicated ConfigMaps under `--config-split` (#32).
 * Must stay aligned with `SPLIT_SECTIONS` in `k8s-renderer.ts`.
 */
interface HelmSplitSection {
  readonly suffix: 'channels-config' | 'sources-config' | 'plugins-config';
  readonly envKey: 'CHANNELS_YAML' | 'SOURCES_YAML' | 'PLUGINS_YAML';
  readonly sectionTag: 'channels' | 'sources' | 'plugins';
  /** Raw YAML text of the section, already indented for embedding. */
  readonly yaml: string;
}

function detectAgentSections(agentYaml: string): HelmSplitSection[] {
  let parsed: Record<string, unknown> | undefined;
  try {
    const raw = parseYaml(agentYaml);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      parsed = raw as Record<string, unknown>;
    }
  } catch {
    return [];
  }
  if (!parsed) return [];
  const specs: Array<{
    suffix: HelmSplitSection['suffix'];
    envKey: HelmSplitSection['envKey'];
    sectionTag: HelmSplitSection['sectionTag'];
    yamlKeys: readonly string[];
  }> = [
    {
      suffix: 'channels-config',
      envKey: 'CHANNELS_YAML',
      sectionTag: 'channels',
      yamlKeys: ['channels'],
    },
    {
      suffix: 'sources-config',
      envKey: 'SOURCES_YAML',
      sectionTag: 'sources',
      yamlKeys: ['event-sources', 'sources'],
    },
    {
      suffix: 'plugins-config',
      envKey: 'PLUGINS_YAML',
      sectionTag: 'plugins',
      yamlKeys: ['plugins'],
    },
  ];
  const out: HelmSplitSection[] = [];
  for (const spec of specs) {
    const matchedKey = spec.yamlKeys.find((k) => parsed?.[k] !== undefined);
    if (!matchedKey) continue;
    const text = stringifyYaml(parsed[matchedKey], YAML_OPTS).replace(/\n$/, '');
    out.push({
      suffix: spec.suffix,
      envKey: spec.envKey,
      sectionTag: spec.sectionTag,
      yaml: text,
    });
  }
  return out;
}

function renderAgentTemplate(
  agentId: string,
  agentYaml: string,
  serviceMonitor: boolean,
  splitSections: readonly HelmSplitSection[] = [],
): string {
  const safeId = sanitizeDns1123Label(agentId);
  // Embed the agent.yaml content. Helm passes template strings through
  // Go templating, so any literal `{{ }}` in the agent.yaml would be
  // misinterpreted as actions. Escape them using Helm's documented
  // `{{ "{{" }}` trick — at render time Go emits a literal `{{` into
  // the output, preserving the agent.yaml content byte-for-byte.
  const safeAgentYaml = agentYaml.replace(/\{\{/g, '{{ "{{" }}').replace(/\}\}/g, '{{ "}}" }}');

  // Build the split-ConfigMap blocks (one per matching section). Gated
  // on `.Values.configSplit.enabled` so operators can toggle without
  // re-rendering. Section values are embedded at chart-render time —
  // the template escapes any `{{`/`}}` tokens the same way we do for
  // `agent.yaml` above, so verbatim YAML round-trips safely.
  const splitConfigBlocks: string[] = [];
  const splitEnvFromEntries: string[] = [];
  for (const s of splitSections) {
    const cmName = `${safeId}-${s.suffix}`;
    const safeYaml = s.yaml.replace(/\{\{/g, '{{ "{{" }}').replace(/\}\}/g, '{{ "}}" }}');
    splitConfigBlocks.push(`{{- if .Values.configSplit.enabled }}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: ${cmName}
  namespace: {{ .Values.namespace }}
  labels:
    {{- include "declaragent.agentLabels" (merge (dict "agentId" $agentId) .) | nindent 4 }}
    declaragent.io/config-section: ${s.sectionTag}
data:
  ${s.envKey}: |
${indent(safeYaml, 4)}
{{- end }}`);
    splitEnvFromEntries.push(`            - configMapRef:
                name: ${cmName}`);
  }
  const splitConfigDocs = splitConfigBlocks.join('\n');
  const splitEnvFromBlock =
    splitEnvFromEntries.length > 0
      ? `          {{- if .Values.configSplit.enabled }}
          envFrom:
${splitEnvFromEntries.join('\n')}
          {{- if gt (len .Values.secrets) 0 }}
            - secretRef:
                name: {{ include "declaragent.fullname" . }}-secrets
          {{- end }}
          {{- else if gt (len .Values.secrets) 0 }}
          envFrom:
            - secretRef:
                name: {{ include "declaragent.fullname" . }}-secrets
          {{- end }}`
      : `          {{- if gt (len .Values.secrets) 0 }}
          envFrom:
            - secretRef:
                name: {{ include "declaragent.fullname" . }}-secrets
          {{- end }}`;

  const serviceMonitorBlock = serviceMonitor
    ? `{{- if .Values.serviceMonitor.enabled }}
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: ${safeId}
  namespace: {{ .Values.namespace }}
  labels:
    {{- include "declaragent.agentLabels" (merge (dict "agentId" "${safeId}") .) | nindent 4 }}
    {{- with .Values.serviceMonitor.additionalLabels }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
spec:
  selector:
    matchLabels:
      {{- include "declaragent.agentSelectorLabels" (merge (dict "agentId" "${safeId}") .) | nindent 6 }}
  endpoints:
    - port: metrics
      path: /metrics
      interval: {{ .Values.serviceMonitor.interval }}
{{- end }}
`
    : '';

  const splitConfigBlock = splitConfigDocs.length > 0 ? `\n${splitConfigDocs}\n` : '';

  return `{{- $agentId := "${safeId}" -}}
{{- $replicas := default .Values.replicas.default (index .Values.replicas $agentId) -}}
apiVersion: v1
kind: ConfigMap
metadata:
  name: ${safeId}-config
  namespace: {{ .Values.namespace }}
  labels:
    {{- include "declaragent.agentLabels" (merge (dict "agentId" $agentId) .) | nindent 4 }}
data:
  agent.yaml: |
${indent(safeAgentYaml, 4)}${splitConfigBlock}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${safeId}
  namespace: {{ .Values.namespace }}
  labels:
    {{- include "declaragent.agentLabels" (merge (dict "agentId" $agentId) .) | nindent 4 }}
spec:
  replicas: {{ $replicas }}
  selector:
    matchLabels:
      {{- include "declaragent.agentSelectorLabels" (merge (dict "agentId" $agentId) .) | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "declaragent.agentLabels" (merge (dict "agentId" $agentId) .) | nindent 8 }}
    spec:
      containers:
        - name: declaragent
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          args:
            - up
            - -d
            - -f
            - /etc/declaragent/agent.yaml
          ports:
            - name: metrics
              containerPort: {{ .Values.metricsPort }}
              protocol: TCP
          env:
            - name: DECLARAGENT_AGENT_ID
              value: ${safeId}
            - name: DECLARAGENT_FLEET_NAME
              value: {{ include "declaragent.name" . | quote }}
${splitEnvFromBlock}
          readinessProbe:
            httpGet:
              path: {{ .Values.healthProbePath }}
              port: metrics
            initialDelaySeconds: 3
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: {{ .Values.healthProbePath }}
              port: metrics
            initialDelaySeconds: 15
            periodSeconds: 30
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
          volumeMounts:
            - name: agent-config
              mountPath: /etc/declaragent
              readOnly: true
      volumes:
        - name: agent-config
          configMap:
            name: ${safeId}-config
---
apiVersion: v1
kind: Service
metadata:
  name: ${safeId}
  namespace: {{ .Values.namespace }}
  labels:
    {{- include "declaragent.agentLabels" (merge (dict "agentId" $agentId) .) | nindent 4 }}
spec:
  type: ClusterIP
  selector:
    {{- include "declaragent.agentSelectorLabels" (merge (dict "agentId" $agentId) .) | nindent 4 }}
  ports:
    - name: metrics
      port: {{ .Values.metricsPort }}
      targetPort: metrics
      protocol: TCP
${serviceMonitorBlock}`;
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? line : pad + line))
    .join('\n');
}

const HELMIGNORE = `# Patterns to ignore when building the chart package.
.DS_Store
.git/
.gitignore
.vscode/
*.bak
*.swp
*.tmp
`;

// ── Shared helpers ─────────────────────────────────────────────────────

function unionSecretRefs(agents: readonly AgentSource[]): string[] {
  const seen = new Set<string>();
  for (const src of agents) {
    let parsed: unknown;
    try {
      parsed = parseYaml(src.agentYaml);
    } catch {
      continue;
    }
    for (const ref of extractSecretRefs(parsed)) seen.add(ref);
  }
  return [...seen].sort();
}
