# Payload NIM SEO plugin

TypeScript package scaffold for `@scope/payload-plugin-nim-seo`, targeting Payload CMS v3.
The plugin will produce locale-specific SEO proposals for explicit editorial review.

This initial scaffold exports the plugin factory and public contracts. The factory currently
returns the host configuration unchanged. SEO fields, NIM calls, validation, workflows,
admin components and rendering helpers are implemented in subsequent tasks.

## Requirements

- Node.js `^22.23.4 || >=24.22.1` and pnpm 11.9.0 for development.
- Payload and `@payloadcms/ui` 3.93 or newer compatible v3 releases, using matching versions.
- React and React DOM 19, using matching versions; the local fixture uses 19.3.1.
- A host project with Payload localization enabled for every configured plugin locale.

## Plugin contract

```ts
import { nimSeoPlugin } from '@scope/payload-plugin-nim-seo'
import type { NimSeoPluginOptions } from '@scope/payload-plugin-nim-seo'

const options: NimSeoPluginOptions = {
  collections: {
    posts: {
      titleField: 'title',
      extractContent: ({ doc }) => String(doc.content ?? '').slice(0, 10_000),
      resolveURL: ({ doc, locale }) =>
        typeof doc.slug === 'string'
          ? `https://example.com/${locale}/posts/${encodeURIComponent(doc.slug)}`
          : undefined,
      mediaCollection: 'media',
    },
  },
  locales: ['fr', 'en'],
  nim: {
    baseURL: process.env.NIM_BASE_URL!,
    apiKey: process.env.NIM_API_KEY!,
    model: process.env.NIM_MODEL!,
  },
  site: {
    defaultLocale: 'fr',
    organization: { name: 'Example', url: 'https://example.com' },
  },
  permissions: {
    generate: ({ req }) => Boolean(req.user),
    apply: ({ req }) => Boolean(req.user),
    manage: ({ req }) => Boolean(req.user),
  },
}

// Add to the host's buildConfig({ plugins: [...] }).
nimSeoPlugin(options)
```

Content and URL adapters receive the requested locale and may be asynchronous. Return
`undefined` or `null` from `resolveURL` when the document has no public URL. NIM
configuration belongs only in server configuration. Use environment variables for real
credentials; never import server configuration from client components.

The root exports `nimSeoPlugin` and the `NimSeoPluginOptions`, `CollectionSeoOptions`,
`NimConfig` and `SeoProposalPayload` types. Explicit `./client`, `./rsc` and `./helpers`
entry points are reserved and buildable; they export no components or helpers yet.

## Local fixture and checks

```sh
pnpm install
pnpm vitest run tests/unit/public-api.test.ts
pnpm test -- --run tests/unit/public-api.test.ts
pnpm typecheck
pnpm dev:check
pnpm build
```

`dev/payload.config.ts` uses the SQLite adapter, independent `fr`/`en` localization
with fallback disabled, localized posts, an upload-enabled media collection and local
authentication. NIM defaults are inert placeholders; startup and tests make no NIM calls.
`pnpm dev:check` initializes Payload through its Local API against a disposable database,
writes and reads different French and English content, then closes and removes that database.
This is a Local API fixture; a Next.js admin application is added with the admin workflow.

The fixture accepts `DATABASE_URL`, `PAYLOAD_SECRET`, `NIM_BASE_URL`, `NIM_API_KEY`
and `NIM_MODEL`. Its default database is `dev/fixture.db`; its default secret and
permissions are for local development only. Do not use the fixture as production configuration.

`pnpm build` emits JavaScript and declarations into `dist/`; only `dist/` and this
README are included in the package. `pnpm pack` builds before packaging. Local database
files, uploads, credentials, tests and the fixture are excluded from the distributable.
