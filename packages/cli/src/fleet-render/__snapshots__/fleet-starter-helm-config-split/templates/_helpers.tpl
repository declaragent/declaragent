{{/*
Standard helpers — name, fullname, labels, selectorLabels.
*/}}
{{- define "declaragent.name" -}}
fleet-starter
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
