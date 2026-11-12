# Payload NIM SEO plugin

`@scope/payload-plugin-nim-seo` adds localized SEO fields, editorial proposals,
FR/EN admin tools and optional batch generation to Payload CMS v3. NVIDIA NIM
produces a proposal; an editor reviews and explicitly applies selected groups.
Generation and audits never apply SEO or publish documents automatically.

The package name is currently a development placeholder. Build and install a local
tarball until a release is published under your chosen package scope.

## Requirements and installation

- Node.js `^22.23.4 || >=24.22.1`; pnpm 11.9.0 for this repository.
- Matching Payload and `@payloadcms/ui` v3 versions, `>=3.93.0` within v3.
- Matching React and React DOM versions satisfying the package peer ranges
  (`^19.0.1 || ^19.1.2 || ^19.2.1 || ^19.3.0`). The fixture uses 19.3.1.
- Payload localization, localized source fields, an upload collection and a
  database adapter with effective transactions enabled.
- A server-accessible NIM OpenAI-compatible chat completions endpoint and model
  that supports JSON object responses.

```sh
# In this repository
pnpm install --frozen-lockfile
pnpm pack --out /tmp/payload-plugin-nim-seo.tgz

# In a Payload v3 application
pnpm add /tmp/payload-plugin-nim-seo.tgz
```

The root entry point exports `nimSeoPlugin`, `validatePluginOptions` and public
configuration types. Use `/client` for admin components, `/rsc` for the server
component boundary, and `/helpers` for frontend metadata helpers. Frontend helpers
have no Payload, React, Next.js or NIM runtime dependency.

## Server configuration

Set these environment variables on the Payload server, without a `NEXT_PUBLIC_` prefix:

```dotenv
NIM_BASE_URL=https://integrate.api.nvidia.com/v1
NIM_API_KEY=your-server-only-key
NIM_MODEL=your-supported-model-id
```

`NIM_BASE_URL` is the API prefix: the plugin appends `/chat/completions`. Use a
trusted endpoint without embedded credentials, query parameters or fragments.
HTTPS is recommended for a remote provider; HTTP supports local NIM deployments.
Requests have a 60-second timeout and do not follow redirects. Provider errors
are reduced to safe diagnostics; raw responses and credentials are not persisted.
The selected locale's extracted content and selected media metadata are sent to
that endpoint. Only extract material you intend to share with your provider.

```ts
import { buildConfig, type PayloadRequest } from 'payload'
import { nimSeoPlugin } from '@scope/payload-plugin-nim-seo'

// The host must protect role writes in its auth collection.
const editor = ({ req }: { req: PayloadRequest }) =>
  req.user?.role === 'editor' || req.user?.role === 'admin'
const manager = ({ req }: { req: PayloadRequest }) => req.user?.role === 'admin'

export default buildConfig({
  // Keep your existing secret, database, admin and other host configuration.
  localization: { locales: ['fr', 'en'], defaultLocale: 'fr', fallback: false },
  collections: [
    {
      slug: 'posts',
      versions: { drafts: true },
      fields: [
        { name: 'title', type: 'text', localized: true, required: true },
        { name: 'slug', type: 'text', localized: true, required: true },
        { name: 'content', type: 'textarea', localized: true },
      ],
    },
    {
      slug: 'media',
      upload: true,
      fields: [{ name: 'alt', type: 'text', localized: true }],
    },
    // Include your auth collection with protected roles and host access rules.
  ],
  // Required only when bulk: true; also configure a queue runner (see below).
  jobs: { tasks: [] },
  plugins: [nimSeoPlugin({
    collections: {
      posts: {
        titleField: 'title',
        extractContent: ({ doc }) => String(doc.content ?? '').slice(0, 10_000),
        resolveURL: ({ doc, locale }) => typeof doc.slug === 'string'
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
    permissions: { generate: editor, apply: editor, manage: manager },
    bulk: true, // Optional; defaults to false.
  })],
})
```

The example is a fragment to merge into a working host configuration. For SQLite,
use `sqliteAdapter({ client: { url: process.env.DATABASE_URL! }, transactionOptions: {} })`
to enable transactions as in the local fixture. Configure equivalent effective
transactions for your chosen adapter. Application refuses to write SEO without a
transaction, so source SEO and proposal state commit or roll back together.

Generate the host import map after installation (`pnpm payload generate:importmap`)
and regenerate Payload types (`pnpm payload generate:types`). The plugin reserves
`seo`, `nimSeoPanel`, `seo-proposals`, `seo-runs`, its `/nim-seo/*` endpoints and its
job task slugs. Resolve collisions before enabling it; it does not adopt another
plugin's SEO fields or collections.

## Localization and collection adapters

Payload admin language and content locale are independent. Admin labels support
French and English. Configure both source content and SEO localization: mark the
host title, body, slug and other translatable source fields `localized: true`.
Plugin-added `seo` is a localized group. Register every plugin locale in Payload's
`localization.locales`, with fallback disabled for explicit editorial workflows.

Generation loads the saved draft in exactly one requested locale with
`fallbackLocale: false`; it does not translate missing source content. Save changes
before generating. `titleField` names the source title. `extractContent` receives
that locale's document and must return readable text, flattening rich text or
blocks when necessary. `resolveURL` receives the same document and locale; return
a real absolute HTTP(S) URL, or `undefined`/`null` when none exists. Both adapters
may be asynchronous. Avoid doing your own locale fallback inside adapters.

Without a public URL, proposals omit canonical URLs and page-dependent JSON-LD.
The server validates JSON output, allowed Schema.org types, selected media IDs,
URLs and plain text, and limits citability summaries to 2,000 characters. It does
not check the truth of claims or guarantee search rankings: editorial review is
required. JSON-LD is structured data, not arbitrary HTML or scripts.

## Permissions and editorial workflow

`generate`, `apply` and `manage` callbacks run on the server and may be asynchronous.
They require an authenticated user; `manage` also grants the generation and
application workflows. Host collection access remains enforced for source,
proposal and media reads/writes. Hiding an admin action does not grant authority.
Protect host role fields and configure least-privilege access for content/media.

1. Save the localized source document and select existing accessible media.
2. Generate a proposal. The current SEO stays unchanged; failed output stores safe
   diagnostics in `seo-proposals`.
3. Review the four groups: meta, social, schema and citability, with the current
   approved values beside the proposal. Apply only explicitly selected groups.
4. Application replaces each selected group, including clearing omitted optional
   values. Unselected SEO groups and source content remain unchanged. This is not
   a fill-empty operation. Applying consumes the proposal once.
5. Publish through the host's normal editorial workflow. With Payload drafts
   enabled, application updates the latest draft and never publishes it. Enable
   drafts on target collections when review before public visibility is required.

Proposals are bound to source collection, ID, locale and a source fingerprint.
Source or selected media changes make a proposal stale; regenerate before applying.
An English proposal cannot be applied to French SEO. The localized `seo.status`
fields are available for host workflows; do not treat them as publication controls.

Media selection uses the configured `mediaCollection`. NIM can propose alt text,
filename, caption, social titles and recommended dimensions for selected assets;
it does not generate images, upload assets, rename files, resize them or modify
shared media records. Batch runs have no per-document selected media and cannot
invent an image. Editors should select media during document generation when
image suggestions are needed.

## Batch jobs and operations

With `bulk: false`, single-document generation and audit work synchronously;
no Payload jobs configuration or worker is needed. With `bulk: true`, configure
Payload `jobs` and operate a Payload jobs runner on the default queue. Adding
`jobs: { tasks: [] }` registers storage/tasks but does not start a worker.
For a trusted server worker that already initializes Payload:

```ts
await payload.jobs.run({ queue: 'default', limit: 10 })
```

Run this through your host's queue service or scheduled worker. Keep the jobs API
and scheduling routes under the host's normal authentication/access policy. The
plugin registers `nim-seo-generate-proposal` and `nim-seo-run-audit`; do not enqueue
raw plugin tasks yourself because execution requires a server-authorized run
bound to its job ID and scheduling identity.

The audit dashboard lets managers choose collections and a Payload filter, then
queue a batch for the active content locale. Each document/locale is processed independently.
`seo-runs` stores progress, per-document proposals and safe errors. A completed run
can contain failures; inspect its failed count and error list. Batch generation
creates proposals only, with no automatic approval, application or publication.
Workers reload the scheduling user and re-check permissions; revoked/deleted
identities cannot borrow the worker's authority. Tasks disable automatic retries;
review failures before scheduling a new run to control provider cost.

## Next.js rendering

Read the approved `doc.seo` for one locale; never render `seo-proposals.output`.
The helpers are pure and do not fetch, infer approval, choose a locale, fall back
to another language or call NIM. Load published content on public routes, disable
fallback, and use `depth: 1` to populate the selected media relationship. Unresolved
media IDs are omitted from social images. Actual media dimensions are used;
recommended dimensions are editorial suggestions only.

```tsx
import type { Metadata } from 'next'
import { buildJsonLd, buildMetadata } from '@scope/payload-plugin-nim-seo/helpers'

// Implement getPublishedPost in your host with Payload's Local API:
// payload.findByID({ collection: 'posts', id, locale, fallbackLocale: false,
//   draft: false, depth: 1, overrideAccess: false, req })
// Supply a correctly authenticated/anonymous request and your host's public-read
// access policy. Validate locale against your allowed public routes.

export async function generateMetadata({ params }): Promise<Metadata> {
  const { id, locale } = await params
  const doc = await getPublishedPost(id, locale)
  return {
    metadataBase: new URL('https://example.com'),
    ...buildMetadata(doc.seo ?? {}),
  }
}

export default async function PostPage({ params }) {
  const { id, locale } = await params
  const doc = await getPublishedPost(id, locale)
  const graphs = buildJsonLd(doc.seo ?? {})
  return <>
    {graphs.map((graph, index) => <script
      key={index}
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(graph).replace(/</g, '\\u003c'),
      }}
    />)}
    {/* Render the host's published content here. */}
  </>
}
```

Set `metadataBase` when media URLs are relative. Escape `<` whenever embedding
JSON-LD in HTML, even for approved data; `buildJsonLd` returns cloned objects,
not HTML. Payload's generated JSON-field union is accepted directly; non-array
or malformed graph-array values produce no JSON-LD. The helper does not replace
proposal validation or editorial approval. Plain metadata strings belong in framework metadata APIs, not raw HTML.
Citability summaries, sources and claims are available in `doc.seo.citability`
for host rendering; the plugin does not automatically add them to page content.

## Migrations, local development and release checks

Back up your host database, generate and inspect a migration after enabling the
plugin (`pnpm payload migrate:create`), and apply it using your normal production
release process (`pnpm payload migrate`). Regenerate types/import maps, restart
Payload and verify both locales, permissions and transaction support before
editorial use. Existing SEO data needs an explicit host-specific migration; the
plugin does not import or overwrite another SEO plugin's fields automatically.

The local fixture in `dev/` has FR/EN localized posts, upload media, protected
viewer/editor/admin roles and SQLite transactions. `pnpm dev` starts its Next.js
admin. Defaults are for local development only. It accepts `DATABASE_URL`,
`PAYLOAD_SECRET` and the NIM environment variables above. The default provider
key/model are inert placeholders, so use a real configured provider only when
intentionally testing live generation.

```sh
pnpm dev:check
pnpm lint
pnpm typecheck
pnpm vitest run
pnpm playwright test
pnpm build
pnpm pack --dry-run
```

Vitest covers configuration, locale isolation, NIM safety, validation, transactional
application, endpoints, jobs, admin wiring and frontend helpers. Playwright uses
an ephemeral database and a local fake provider to exercise the admin workflow;
no live NIM key is required. Install Chromium with `pnpm exec playwright install chromium`
if your environment has no compatible browser.

`pnpm pack` runs the build. Only `dist/`, package metadata and this README belong
in the tarball; fixture databases, uploads, credentials, source tests and planning
files are excluded. Review the package inventory before publishing a release.
