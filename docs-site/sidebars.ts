import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

/**
 * Sidebar manifest for the four top-level sections.
 *
 * Order is: Quickstart → Reference → Cookbook → Troubleshooting.
 */
const sidebars: SidebarsConfig = {
  quickstart: [
    {
      type: 'category',
      label: 'Quickstart',
      link: { type: 'doc', id: 'quickstart/index' },
      items: ['quickstart/installing', 'quickstart/first-agent', 'quickstart/conversational-tour'],
    },
  ],

  reference: [
    {
      type: 'category',
      label: 'Reference',
      link: { type: 'doc', id: 'reference/index' },
      items: [
        'reference/agent-yaml',
        'reference/cli',
        'reference/env-vars',
        'reference/providers',
        'reference/extensions',
        'reference/rpc',
        'reference/fleet',
        'reference/builder',
        'reference/observability',
      ],
    },
  ],

  cookbook: [
    {
      type: 'category',
      label: 'Cookbook',
      link: { type: 'doc', id: 'cookbook/index' },
      items: [
        {
          type: 'category',
          label: 'Templates',
          items: [
            'cookbook/concierge',
            'cookbook/oncall-escalator',
            'cookbook/pr-review',
            'cookbook/kafka-pipeline',
            'cookbook/multi-tenant-starter',
            'cookbook/agent-rpc',
            'cookbook/fleet-starter',
          ],
        },
        {
          type: 'category',
          label: 'Recipes',
          items: [
            'cookbook/build-an-agent',
            'cookbook/deploy-cloud-run',
            'cookbook/rotate-vault-secret',
            'cookbook/two-tenants-one-daemon',
            'cookbook/grafana-tracing',
          ],
        },
        {
          type: 'category',
          label: 'Enterprise',
          items: [
            'cookbook/enterprise-zero-to-deploy',
            'cookbook/gitops-argocd-flux',
            'cookbook/siem-audit-export',
            'cookbook/zero-trust-rpc-migration',
            'cookbook/cross-host-fleet-kafka',
            'cookbook/grafana-dashboard-import',
          ],
        },
      ],
    },
  ],

  troubleshooting: [
    {
      type: 'category',
      label: 'Troubleshooting',
      link: { type: 'doc', id: 'troubleshooting/index' },
      items: [
        'troubleshooting/error-codes',
        'troubleshooting/deploy-403',
        {
          type: 'category',
          label: 'Runbooks',
          link: { type: 'doc', id: 'troubleshooting/runbook-index' },
          items: [
            'troubleshooting/runbooks/channels-outbound-failure-rate',
            'troubleshooting/runbooks/channels-rate-limit-sustained',
            'troubleshooting/runbooks/channels-inbound-failure',
            'troubleshooting/runbooks/channels-latency-degraded',
            'troubleshooting/runbooks/event-sources-sustained-lag',
            'troubleshooting/runbooks/event-sources-dlq-growing',
            'troubleshooting/runbooks/event-sources-connection-errors',
            'troubleshooting/runbooks/event-sources-inflight-stuck',
            'troubleshooting/runbooks/event-sources-latency',
            'troubleshooting/runbooks/daemon-bus-inflight-stuck',
            'troubleshooting/runbooks/daemon-heartbeat-timeout',
            'troubleshooting/runbooks/daemon-session-spawn-stall',
            'troubleshooting/runbooks/daemon-bus-pressure-sustained',
            'troubleshooting/runbooks/secret-access-denied-spike',
            'troubleshooting/runbooks/tenant-boundary-violation',
            'troubleshooting/runbooks/secret-rotation-overdue',
            'troubleshooting/runbooks/webhook-auth-failure-spike',
            'troubleshooting/runbooks/chaos-event-loss',
            'troubleshooting/runbooks/chaos-p99-latency-breach',
            'troubleshooting/runbooks/chaos-dlq-rate-breach',
            'troubleshooting/runbooks/whatsapp-template-reject-spike',
            'troubleshooting/runbooks/whatsapp-window-expiry-surge',
            'troubleshooting/runbooks/whatsapp-tier-health-drop',
          ],
        },
      ],
    },
  ],
};

export default sidebars;
