/**
 * Structural validator for `declaragent-fleet-dashboard.json`.
 *
 * Shipped as a fleet-operator-facing artifact (see POST_ENTERPRISE_BACKLOG.md
 * row #51). The file is hand-edited when panels change, so the test guards
 * the three invariants that matter for "this imports cleanly into Grafana
 * and shows the metrics we claim to ship":
 *
 *   1. Valid JSON with a `__inputs` + `panels` shape.
 *   2. Three row panels with the expected titles — "MCP health",
 *      "Audit + SIEM", "Rate limits + dispatch" — so operators get
 *      the same mental model the README describes.
 *   3. Every metric the README promises is referenced in at least one
 *      panel target expression. If a panel gets renamed or removed
 *      the test fails loudly rather than silently shipping a dashboard
 *      that has lost a panel.
 *
 * @since 0.7.6 (Sprint 6 post-enterprise backlog)
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DASHBOARD_PATH = join(import.meta.dir, 'declaragent-fleet-dashboard.json');

type PanelTarget = { expr?: string; legendFormat?: string; refId?: string };
type Panel = {
  type: string;
  title: string;
  id?: number;
  targets?: PanelTarget[];
  panels?: Panel[];
};
type Dashboard = {
  __inputs?: Array<{ name: string; type: string; pluginId: string }>;
  panels: Panel[];
  templating?: { list: Array<{ name: string; type: string; query?: string }> };
  time?: { from: string; to: string };
  refresh?: string;
  uid?: string;
  title?: string;
};

function loadDashboard(): Dashboard {
  const raw = readFileSync(DASHBOARD_PATH, 'utf8');
  return JSON.parse(raw) as Dashboard;
}

function allPanels(dashboard: Dashboard): Panel[] {
  const out: Panel[] = [];
  const stack = [...dashboard.panels];
  while (stack.length > 0) {
    const p = stack.pop() as Panel;
    out.push(p);
    if (p.panels) stack.push(...p.panels);
  }
  return out;
}

function allExpressions(dashboard: Dashboard): string[] {
  const panels = allPanels(dashboard);
  const exprs: string[] = [];
  for (const panel of panels) {
    for (const t of panel.targets ?? []) {
      if (t.expr) exprs.push(t.expr);
    }
  }
  return exprs;
}

describe('grafana/declaragent-fleet-dashboard.json', () => {
  test('parses as valid JSON', () => {
    expect(() => loadDashboard()).not.toThrow();
  });

  test('declares a Prometheus datasource input named DS_PROMETHEUS', () => {
    const dashboard = loadDashboard();
    expect(dashboard.__inputs).toBeDefined();
    const input = dashboard.__inputs?.find((i) => i.name === 'DS_PROMETHEUS');
    expect(input).toBeDefined();
    expect(input?.pluginId).toBe('prometheus');
  });

  test('has stable identity fields (title, uid, default time range, refresh)', () => {
    const dashboard = loadDashboard();
    expect(dashboard.title).toContain('Declaragent');
    expect(dashboard.uid).toBe('declaragent-fleet-0-7-6');
    expect(dashboard.time?.from).toBe('now-15m');
    expect(dashboard.refresh).toBe('30s');
  });

  test('ships the three README-documented rows', () => {
    const dashboard = loadDashboard();
    const rowTitles = dashboard.panels.filter((p) => p.type === 'row').map((p) => p.title);
    expect(rowTitles).toEqual(['MCP health', 'Audit + SIEM', 'Rate limits + dispatch']);
  });

  test('every panel id is unique', () => {
    const dashboard = loadDashboard();
    const ids = allPanels(dashboard)
      .map((p) => p.id)
      .filter((id): id is number => typeof id === 'number');
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('references every metric the README promises', () => {
    const dashboard = loadDashboard();
    const joined = allExpressions(dashboard).join('\n');
    const requiredMetrics = [
      // MCP health
      'mcp_server_restarts_total',
      'mcp_server_circuit_state',
      'mcp_server_circuit_open_total',
      'mcp_server_drain_duration_ms_bucket',
      'mcp_server_rate_limited_total',
      // Audit + SIEM
      'declaragent_audit_backpressure_backlog_ms',
      'declaragent_audit_backpressure_active',
      'declaragent_audit_batch_interval_ms',
      'declaragent_audit_batch_rows_bucket',
      'declaragent_audit_export_acked_total',
      'declaragent_audit_export_failures_total',
      'declaragent_audit_export_last_seq',
      // Rate limits + dispatch
      'declaragent_provider_rate_limit_waits',
      'declaragent_provider_rate_limit_wait_ms_bucket',
      'declaragent_tool_rate_limit_waits_total',
      'source_messages_dlq',
      'source_messages_received',
      'source_messages_processed',
      'source_inflight',
    ];
    for (const metric of requiredMetrics) {
      expect(joined).toContain(metric);
    }
  });

  test('every non-row panel has at least one target with an expr', () => {
    const dashboard = loadDashboard();
    const panels = allPanels(dashboard).filter((p) => p.type !== 'row');
    for (const panel of panels) {
      expect(panel.targets ?? []).not.toHaveLength(0);
      const exprs = (panel.targets ?? []).map((t) => t.expr ?? '');
      expect(exprs.some((e) => e.length > 0)).toBe(true);
    }
  });

  test('template variables key on live metrics (mcp / tool / source)', () => {
    const dashboard = loadDashboard();
    const names = (dashboard.templating?.list ?? []).map((t) => t.name);
    expect(names).toContain('server_id');
    expect(names).toContain('agent');
    expect(names).toContain('source');
  });
});
