{{- define "ach-channelmux.labels" -}}
app.kubernetes.io/name: ach-channelmux
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
{{- end }}

{{- define "ach-channelmux.selectorLabels" -}}
app.kubernetes.io/name: ach-channelmux
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
