function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderJson(value) {
  return escapeHtml(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2));
}

export function renderHtmlReport(result) {
  const diagnostics = result.compilerDiagnostics ?? [];
  const steps = result.steps ?? [];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PreflightSim ${escapeHtml(result.jobId)}</title>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#090d16;color:#e8edf7}body{max-width:1200px;margin:0 auto;padding:32px}h1,h2{letter-spacing:-.03em}.card{background:#111827;border:1px solid #273244;border-radius:14px;padding:18px;margin:14px 0}.ok{color:#67e8a5}.failed{color:#fb7185}pre{white-space:pre-wrap;word-break:break-word;background:#070b12;padding:14px;border-radius:10px;overflow:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #273244}code{font-family:ui-monospace,SFMono-Regular,monospace}</style>
</head>
<body>
<h1>PreflightSim Lite</h1>
<div class="card"><strong>Job:</strong> <code>${escapeHtml(result.jobId)}</code><br><strong>Status:</strong> <span class="${result.status === 'completed' ? 'ok' : 'failed'}">${escapeHtml(result.status)}</span><br><strong>Chain:</strong> ${escapeHtml(result.chain ?? '')}<br><strong>Fork block:</strong> ${escapeHtml(result.block ?? '')}<br><strong>Started:</strong> ${escapeHtml(result.startedAt)}<br><strong>Finished:</strong> ${escapeHtml(result.finishedAt)}</div>
<h2>Deployments</h2><pre>${renderJson(result.deployments ?? {})}</pre>
<h2>Compiler diagnostics</h2>${diagnostics.length ? diagnostics.map((item) => `<div class="card"><strong>${escapeHtml(item.severity ?? 'info')}</strong><pre>${escapeHtml(item.formattedMessage ?? item.message ?? '')}</pre></div>`).join('') : '<div class="card ok">No compiler diagnostics.</div>'}
<h2>Workflow</h2>${steps.map((step) => `<div class="card"><strong>Step ${step.index}: ${escapeHtml(step.action)}</strong> — <span class="${step.status === 'completed' ? 'ok' : 'failed'}">${escapeHtml(step.status)}</span><pre>${renderJson(step.output ?? step.error ?? {})}</pre></div>`).join('')}
<h2>Raw result</h2><pre>${renderJson(result)}</pre>
</body></html>`;
}
