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
        localizedSourceFields: ['title', 'slug', 'content'],
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

Each collection must declare a nonempty `localizedSourceFields` array containing
`titleField` and every translatable source field read by `extractContent` or
`resolveURL`. Startup rejects missing fields or fields without their own
`localized: true`, naming the collection and field in the diagnostic. Enabling
FR/EN locales or localizing only the plugin's SEO group does not satisfy this
requirement. The declaration checks the host schema, not whether translations
have been written or whether an adapter reads undeclared fields.

Use dot paths for nested groups, arrays and named tabs, such as
`article.body` or `sections.text`; rows, collapsibles and unnamed tabs do not add
a path segment. For block fields, include the block slug, for example
`layout.hero.text`. Inline blocks and `config.blocks` references are supported.
Each declared path must itself have `localized: true`; an explicitly localized
parent group/array/block field may instead be declared when that whole value is
the source read by your adapter. Declaring a child separately still requires
localization on that child. These are configuration paths; they do not replace
the project's content reader or add dot-path access to `titleField`.

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
Every standalone graph and `@graph` container receives the root
`@context: 'https://schema.org'` when absent; nested nodes inherit it. Foreign or
overridden contexts are rejected by proposal validation. The frontend helper
also fills missing root contexts on older approved graph values.

## Editorial field configuration

Editorial fields are an explicit per-collection opt-in. Omitting `editorialFields`
keeps the existing SEO-only behavior. Configure exact Payload schema paths:

```ts
editorialFields: {
  include: ['title', 'excerpt', 'faq', 'cta.label', 'tags', 'featuredImage'],
  exclude: ['content'],
  relations: {
    tags: { relationTo: 'tags', allowCreate: true },
    featuredImage: { relationTo: 'media', allowCreate: false },
  },
},
```

Startup resolves and caches the registry from the host schema. Every included
path must exist and itself declare `localized: true`; a localized parent alone
does not qualify an individually included child. Groups, arrays, named tabs and
block variants use dot paths (`faq.question`, `layout.hero.heading`). Block slugs
are required; array indexes and wildcards are not configuration paths. Rows,
collapsibles and unnamed tabs do not add path segments. Shared block references
resolve against `config.blocks`.

Adapters cover text, textarea, richText, number, date, checkbox, select,
relationship, upload, group, array, blocks and named tabs (as groups). Including
a whole localized container covers its validated child schema in that locale.
Include a container or its child paths, never both. Unsupported types, hidden,
read-only and virtual fields are rejected. A container containing a forbidden
field is rejected; configure safe child paths instead.

`content` is always forbidden at every nesting level, even if explicitly
included. Technical names, including IDs, publication status, slug/routing,
system authorship, timestamps, access, credentials, versions, file metadata and
payment fields are also forbidden. Hosts must keep business-sensitive fields out
of the allowlist. `exclude` removes exact paths and their descendants; a child
exclusion within an included whole container is rejected to prevent a parent
object patch from bypassing it. Unknown exclusions are rejected, except the
mandatory `content` exclusion, which is allowed even without a host field.

Every included relationship/upload, including children of a whole container,
requires an exact-path `relations` policy with explicit `allowCreate: true` or
`false`. `relationTo` must match the Payload target or full polymorphic target
list, and every target must exist. Creation additionally requires each target
collection in plugin `collections` with its own nonempty `editorialFields`
allowlist and the same validation rules. Collections without Payload drafts may
be configured, but creation still requires editor review and selection. Registry
configuration itself does not generate, create, link, update or publish records.

For application, include a whole localized array/block container (`faq`,
`layout`) rather than a descendant leaf such as `faq.question`. Patches have no
row index or stable row identity; descendant patches below arrays/blocks are
rejected during application. Nested group/tab leaves such as `cta.label` remain
supported. Whole-container values replace that selected container.

## Reviewing editorial proposals and graphs

When a proposal contains an `editorial` envelope, the admin shows a hierarchical
diff beside the four SEO groups. Check individual fields and every required
related draft explicitly. `content` stays with the editor and is never generated,
selected or applied. The French and English panels operate independently, using
only the active saved locale; changing document, locale or proposal clears the
selection. The preview never copies a proposal from another language.

The semantic graph has its own **Apply semantic graph** checkbox. It is mutually
exclusive with the legacy JSON-LD group. The preview shows selected properties,
nodes and relations only; `draft:<localId>` identities remain provisional until
the server creates the selected records and resolves their public URLs. The
approved value is one JSON-LD object with `@context: 'https://schema.org'` and an
`@graph` array, stored as the sole entry of `seo.schema`. Without that checkbox,
editorial application leaves the approved schema unchanged.

The structured editorial response is:

```ts
editorial: {
  locale: 'fr',
  patches: [{ path: 'excerpt', operation: 'set', value: 'Résumé proposé' }],
  relatedDrafts: [],
  semanticGraph: {
    '@context': 'https://schema.org',
    '@graph': [{ '@id': 'https://example.com/fr/article', '@type': 'Article', description: 'Résumé proposé' }],
  },
  graphBindings: [{ path: 'excerpt', nodeId: 'https://example.com/fr/article', properties: ['description'] }],
}
```

`semanticGraph` and `graphBindings` are an optional pair. Bindings assign every
non-draft graph property to one validated patch, allowing safe partial selection.
For collections with editorial fields, the default NIM client requests proposals
for every supported configured field, with one locale-specific graph and its
bindings. It sends only field types, constraints, option values and reachable
creation policies, never raw Payload field configuration. Unsupported values
remain omitted rather than fabricated. Existing upload choices come only from
the editor's selected media collection; other existing relationship IDs require
a future host-provided candidate catalog. Configured related drafts remain
available for review when no existing candidate is supplied. The editorial
completion budget is 8,192 tokens; truncated completions fail validation and are
stored as failed proposals. SEO-only collections keep the original prompt.
Related drafts have `{ collection, localId, locale, fields, graphNodeId }`; `fields`
maps exact configured target paths to proposed values and `graphNodeId` is
`draft:<localId>`. A relation value references it as `{ localId }` (or inside
Payload's `{ relationTo, value }` form for polymorphic relations). All local
dependencies must be explicitly selected and reachable from selected patches.
The server validates types, locale, source identity and graph safety again when
applying. Represented relations need a host `resolveURL` on their target
collection; model-supplied URLs never establish a document's public identity.

Editorial application requires a fresh proposal with an editable-field
fingerprint; older proposals remain usable for SEO groups only and should be
regenerated for field application. Creation, field updates, graph and application
audit share one transaction. SQLite and PostgreSQL currently support the verified
atomic proposal claim; other adapters reject editorial application until their
conditional-update guarantee is supported. SEO-only application retains its
existing adapter compatibility. Related collections with drafts receive drafts;
collections without drafts receive ordinary records after explicit validation.

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
   approved values beside the proposal. If editorial fields are present, also
   review each field, required related record and optional semantic graph.
   Apply only the explicit selection.
4. Application replaces each selected group, including clearing omitted optional
   values. Unselected fields/groups and `content` remain unchanged. This is not
   a fill-empty operation. Applying consumes the proposal once.
5. Publish through the host's normal editorial workflow. With Payload drafts
   enabled, application updates the latest draft and never publishes it. Enable
   drafts on target collections when review before public visibility is required.

Proposals are bound to source collection, ID, locale and a source fingerprint.
Proposal reads, counts, updates/rejections and deletes additionally require current
read access to the referenced source in its own locale. Source identities cannot
be rebound by editing a proposal. Losing source access also removes access to its
existing proposal snapshots, regardless of SEO role or proposal authorship.
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

The audit dashboard lists accessible documents in the active content locale.
Filter by collection, computed completeness status and score range; audit reads
do not call NIM, write records or schedule jobs, and work with bulk disabled.
Managers explicitly check individual rows before scheduling a batch. Changing
filters or pages clears the selection; matching documents are never selected
automatically. Each selected document/locale is processed independently.
`POST /nim-seo/audit` with `mode: 'list'` accepts `collection`, `locale`, `status`
(`all`, `incomplete`, `complete`), `minScore`, `maxScore`, `page` and `limit` (max 100).
The same endpoint with `mode: 'batch'` requires `collections`, `locales` and a
nonempty `documents` array of `{ collection, sourceID, locale }` (max 500).
The server freezes that selection with the scheduling actor and job binding.

`seo-runs` stores progress, per-document proposals, safe errors and provider usage.
Recognized nonnegative integer `prompt_tokens`, `completion_tokens` and
`total_tokens` from NIM are stored separately from SEO output as `promptTokens`,
`completionTokens` and `totalTokens` in proposal/run `usage`. Unknown metadata and
invalid counters are discarded; no price is inferred. Valid returned usage is
also retained for failed completions. Run totals derive from persisted outcomes,
including recovered proposals, without charging the same result twice on resume.
A completed run
can contain failures; inspect its failed count and error list. Batch generation
creates proposals only, with no automatic approval, application or publication.
Workers reload the scheduling user and re-check permissions; revoked/deleted
identities cannot borrow the worker's authority. Tasks disable automatic retries;
review failures before scheduling a new run to control provider cost.

Audit score filtering scans accessible drafts in pages because scores are computed
from approved fields. Proposal ACL queries enumerate accessible source IDs per
configured locale. Large repositories should account for that read cost; no stale
permission cache or source-access bypass is used.

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
