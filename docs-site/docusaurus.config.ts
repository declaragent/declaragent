import type * as Preset from '@docusaurus/preset-classic';
import type { Config } from '@docusaurus/types';
import { themes as prismThemes } from 'prism-react-renderer';

/**
 * Declaragent docs site configuration.
 *
 * Served from https://docs.declaragent.dev/ as a standalone Cloudflare
 * Pages project (`declaragent-docs`). The root declaragent.dev is a
 * separate Pages project (`declaragent`) that hosts the marketing page
 * in `website/`.
 */
const config: Config = {
  title: 'Declaragent',
  tagline: 'Declarative, git-versioned AI agents.',
  favicon: 'img/logo.svg',

  url: 'https://docs.declaragent.dev',
  baseUrl: '/',

  organizationName: 'declaragent',
  projectName: 'declaragent',

  // Keep the site building even if a link target temporarily breaks during
  // slice merges. Flipped to `throw` once the site stabilizes post-slice 9.
  onBrokenLinks: 'throw',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  themes: ['@docusaurus/theme-mermaid'],

  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/declaragent/declaragent/tree/main/docs-site/',
          // Versioning scaffold. Docusaurus creates `versions.json` when
          // `npm run docusaurus docs:version 1.0` runs at release time.
          // For now everything is on `current` / the unversioned sidebar.
          includeCurrentVersion: true,
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    [
      // Local, offline search. Algolia DocSearch lands post-slice.
      require.resolve('@easyops-cn/docusaurus-search-local'),
      {
        hashed: true,
        indexDocs: true,
        indexBlog: false,
        docsRouteBasePath: '/',
        highlightSearchTermsOnTargetPage: true,
      },
    ],
  ],

  themeConfig: {
    // Social card lands post-slice as a real PNG; omit for now so the build
    // doesn't reference a missing asset.
    navbar: {
      title: 'Declaragent',
      logo: {
        alt: 'Declaragent logo',
        src: 'img/logo.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'quickstart',
          position: 'left',
          label: 'Quickstart',
        },
        {
          type: 'docSidebar',
          sidebarId: 'reference',
          position: 'left',
          label: 'Reference',
        },
        {
          type: 'docSidebar',
          sidebarId: 'cookbook',
          position: 'left',
          label: 'Cookbook',
        },
        {
          type: 'docSidebar',
          sidebarId: 'troubleshooting',
          position: 'left',
          label: 'Troubleshooting',
        },
        {
          href: 'https://github.com/declaragent/declaragent',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Quickstart', to: '/quickstart' },
            { label: 'Reference', to: '/reference' },
            { label: 'Cookbook', to: '/cookbook' },
            { label: 'Troubleshooting', to: '/troubleshooting' },
          ],
        },
        {
          title: 'Community',
          items: [
            {
              label: 'GitHub Discussions',
              href: 'https://github.com/declaragent/declaragent/discussions',
            },
          ],
        },
        {
          title: 'More',
          items: [
            { label: 'GitHub', href: 'https://github.com/declaragent/declaragent' },
            { label: 'Changelog', href: 'https://github.com/declaragent/declaragent/releases' },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Declaragent contributors. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'yaml', 'json', 'toml', 'docker'],
    },
    colorMode: {
      defaultMode: 'dark',
      respectPrefersColorScheme: true,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
