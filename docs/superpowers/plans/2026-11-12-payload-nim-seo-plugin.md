# Payload NIM SEO Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable Payload v3 plugin that creates reviewable, locale-specific SEO proposals through NVIDIA NIM and applies only editor-approved values.

**Architecture:** A TypeScript plugin injects localized SEO fields, private proposal/run collections, API endpoints, jobs and custom admin components into selected Payload collections. A server-only NIM adapter produces schema-validated proposals; the Payload admin compares and selectively applies them. The host project supplies content and URL adapters so rich text and localized routes remain project-specific.

**Tech Stack:** TypeScript, Payload CMS v3, React and `@payloadcms/ui`, Zod, Vitest, Playwright, `pnpm`.

**Spec:** `docs/superpowers/specs/2026-11-12-payload-nim-seo-plugin-design.md`

## Global Constraints

- Support Payload CMS v3 only; package as a portable TypeScript/NPM plugin.
- Require Payload localization and treat `fr` and `en` as independent locales; never translate or copy SEO between them.
- Require every configured source-content field used by the plugin to be localized independently for `fr` and `en`; generation uses the active localized source only.
- Call NIM only on the server; NIM URL, API key and model must never reach browser bundles or logs.
- Generate proposals only; batch processing and single-document generation must never mutate approved SEO fields.
- Require explicit editor action to apply a proposal, including a partial selection of fields.
- Store approved SEO data as localized fields on configured documents; store generated drafts/audits/runs centrally.
- Cap `seo.citability.summary` at exactly 2,000 characters in both UI and server validation.
- Use only selected Payload media metadata in a NIM request; never upload or enumerate the full media library.
- Require per-collection `extractContent` and `resolveURL` functions; omit canonical and URL-required schema when URL resolution returns nothing.
- Require host-configured Payload jobs for bulk runs, but keep one-document generation server-direct.

## Review Focus

- Malformed or non-JSON model output must create a failed proposal and must not expose raw output or write SEO fields — Task 4.
- A stale proposal whose source document has changed must be blocked from application — Task 6.
- A request to apply only meta fields must not alter image, schema or citability data — Task 6.
- Missing/incorrect Payload locales or an unconfigured background queue must fail with actionable startup configuration errors — Task 2 and Task 7.
- Media not deliberately selected by the editor must never appear in the NIM request payload — Task 5.

---

## File Structure

```
package.json                              package exports, peer dependencies and scripts
tsconfig.json / vitest.config.ts          compiler and test configuration
src/index.ts                              public plugin, helpers and type exports
src/plugin.ts                             config transformer and startup validation
src/types.ts                              stable public option and proposal types
src/fields/seoFields.ts                   localized SEO field definitions
src/collections/proposals.ts              private seo-proposals collection config
src/collections/runs.ts                   private seo-runs collection config
src/services/content.ts                   normalized input creation from host adapters
src/services/validation.ts                Zod contracts and deterministic output validation
src/services/nim.ts                       server-only compatible-NIM client
src/services/audit.ts                     completeness scoring and recommendations
src/services/proposals.ts                 creation, stale detection and selective application
src/jobs/generateProposal.ts              single-document job/task implementation
src/jobs/runAudit.ts                      batch audit/proposal task implementation
src/endpoints/generate.ts                 protected generate proposal endpoint
src/endpoints/apply.ts                    protected selective apply endpoint
src/endpoints/audit.ts                    protected audit/queue endpoint
src/ui/SeoPanel.tsx                       localized document-edit screen
src/ui/AuditDashboard.tsx                 localized central audit screen
src/translations/index.ts                 French/English admin copy
src/exports/client.ts                     client component exports for Payload import map
src/exports/rsc.ts                        server component exports for Payload import map
src/helpers/metadata.ts                   frontend metadata and JSON-LD helpers
dev/payload.config.ts                     local fixture Payload project
dev/collections/Posts.ts                 localized integration fixture
tests/unit/*.test.ts                      pure service tests
tests/int/plugin.int.spec.ts              Payload plugin integration tests
tests/e2e/seo-admin.spec.ts               browser-admin tests
README.md                                 installation and host integration guide
```

### Task 1: Scaffold the distributable plugin and local Payload fixture

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `src/types.ts`, `dev/payload.config.ts`, `dev/collections/Posts.ts`, `tests/unit/public-api.test.ts`, `README.md`

**Interfaces:**
- Produces: `nimSeoPlugin(options: NimSeoPluginOptions): Plugin` exported by `src/index.ts`.
- Produces: `NimSeoPluginOptions`, `CollectionSeoOptions`, `NimConfig`, `SeoProposalPayload` exported from `src/types.ts`.

- [ ] **Step 1: Write the failing public API test**

```ts
import { nimSeoPlugin } from '../../src/index.js'

test('exports a Payload plugin factory', () => {
  expect(nimSeoPlugin(validOptions)).toBeTypeOf('function')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/unit/public-api.test.ts`

Expected: FAIL because the package entry point does not exist.

- [ ] **Step 3: Create the package contract and fixture**

Configure `payload`, `@payloadcms/ui`, `react` and `react-dom` as compatible peer dependencies; use `zod` as a runtime dependency and TypeScript/Vitest/Playwright as development dependencies. Configure an explicit `exports` map for `.`, `./client`, `./rsc` and `./helpers`. Make the dev fixture enable `fr` and `en`, a `media` collection, `posts`, and a local test database adapter.

- [ ] **Step 4: Run unit typecheck and fixture startup checks**

Run: `pnpm test -- --run tests/unit/public-api.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts src dev tests README.md
git commit -m "chore: scaffold Payload NIM SEO plugin"
```

### Task 2: Define options and validate host compatibility

**Files:**
- Modify: `src/types.ts`, `src/plugin.ts`, `src/index.ts`
- Create: `tests/unit/plugin-options.test.ts`

**Interfaces:**
- Consumes: `NimSeoPluginOptions` from Task 1.
- Produces: `validatePluginOptions(options: NimSeoPluginOptions, config: Config): ValidatedPluginOptions`.
- Produces: `nimSeoPlugin(options): Plugin` that validates configured collections, host locales, NIM config and bulk-job availability.

- [ ] **Step 1: Write failing option-validation tests**

```ts
expect(() => validatePluginOptions(options, configWithoutEn)).toThrow(/en.*localization/i)
expect(() => validatePluginOptions(options, configWithoutJobs)).toThrow(/jobs/i)
expect(() => validatePluginOptions(options, validConfig)).toMatchObject({ locales: ['fr', 'en'] })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/unit/plugin-options.test.ts`

Expected: FAIL because validation is absent.

- [ ] **Step 3: Implement `validatePluginOptions` and `nimSeoPlugin` in `src/plugin.ts`**

Require every target collection to supply `titleField`, `extractContent`, `resolveURL` and `mediaCollection`; require plugin locales to be a subset of the host’s Payload locales; validate NIM `baseURL`, `apiKey`, `model`; reject bulk activation without Payload jobs. Use descriptive configuration errors naming the missing value.

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm vitest run tests/unit/plugin-options.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src tests/unit/plugin-options.test.ts
git commit -m "feat: validate SEO plugin host configuration"
```

### Task 3: Add localized SEO and private workflow data models

**Files:**
- Create: `src/fields/seoFields.ts`, `src/collections/proposals.ts`, `src/collections/runs.ts`, `tests/int/plugin.int.spec.ts`
- Modify: `src/plugin.ts`, `dev/payload.config.ts`

**Interfaces:**
- Produces: `buildSeoFields(options: ValidatedPluginOptions): Field[]`.
- Produces: `buildProposalsCollection(options): CollectionConfig` and `buildRunsCollection(options): CollectionConfig`.
- Consumes: `ValidatedPluginOptions` from Task 2.

- [ ] **Step 1: Write the failing Payload integration tests**

```ts
expect(payload.collections.posts.config.fields).toContainEqual(expect.objectContaining({ name: 'seo', localized: true }))
expect(payload.collections['seo-proposals']).toBeDefined()
expect(payload.collections['seo-runs']).toBeDefined()
expect(await payload.find({ collection: 'seo-proposals', user: unauthorised })).toReject()
```

- [ ] **Step 2: Run the integration test to verify it fails**

Run: `pnpm vitest run tests/int/plugin.int.spec.ts`

Expected: FAIL because plugin fields and workflow collections do not exist.

- [ ] **Step 3: Implement fields and collections**

Add localized `seo.meta`, `seo.social`, `seo.schema`, `seo.citability`, and `seo.status` groups. Enforce the 2,000-character maximum on `citability.summary`. Store proposal source identity, locale, source fingerprint, structured output, diff, state, actor and errors. Restrict proposal/run records to configured SEO roles and never expose NIM secrets.

- [ ] **Step 4: Run integration tests**

Run: `pnpm vitest run tests/int/plugin.int.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src dev tests/int/plugin.int.spec.ts
git commit -m "feat: add localized SEO fields and workflow collections"
```

### Task 4: Normalize content and validate generated SEO output

**Files:**
- Create: `src/services/content.ts`, `src/services/validation.ts`, `tests/unit/content.test.ts`, `tests/unit/validation.test.ts`

**Interfaces:**
- Produces: `buildGenerationInput(args: BuildGenerationInputArgs): Promise<GenerationInput>`.
- Produces: `parseProposalOutput(value: unknown, input: GenerationInput): SeoProposalPayload`.
- Consumes: `extractContent`, `resolveURL` and selected media from Task 2 options.

- [ ] **Step 1: Write failing normalization and validation tests**

```ts
expect(await buildGenerationInput({ doc, locale: 'fr', selectedMedia })).toMatchObject({ locale: 'fr', url: 'https://site.test/fr/x' })
expect(() => parseProposalOutput({ citability: { summary: 'x'.repeat(2001) } }, input)).toThrow(/2000/)
expect(() => parseProposalOutput('not JSON', input)).toThrow(/proposal/i)
expect(parseProposalOutput(validOutputWithoutURL, inputWithoutURL).meta.canonical).toBeUndefined()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/unit/content.test.ts tests/unit/validation.test.ts`

Expected: FAIL because normalization and schemas are absent.

- [ ] **Step 3: Implement generation input and proposal parser**

Call the host content/URL adapters for the requested locale, attach only editor-selected media metadata, and fingerprint the normalized input. Use Zod to parse every generated group, limit citability to 2,000 characters, validate allowed Schema.org types and URLs, remove canonical/URL-required schema when `resolveURL` is empty, and expose field-level validation diagnostics.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run tests/unit/content.test.ts tests/unit/validation.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services tests/unit/content.test.ts tests/unit/validation.test.ts
git commit -m "feat: normalize SEO context and validate AI output"
```

### Task 5: Implement server-only NIM proposal generation

**Files:**
- Create: `src/services/nim.ts`, `src/services/proposals.ts`, `tests/unit/nim.test.ts`, `tests/unit/proposals.test.ts`

**Interfaces:**
- Produces: `createNimClient(config: NimConfig): NimClient` with `generate(input: GenerationInput): Promise<SeoProposalPayload>`.
- Produces: `createProposal(args: CreateProposalArgs): Promise<SeoProposal>`.
- Consumes: `buildGenerationInput` and `parseProposalOutput` from Task 4.

- [ ] **Step 1: Write failing NIM and proposal-persistence tests**

```ts
expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/v1\/chat\/completions$/), expect.objectContaining({ method: 'POST' }))
expect(JSON.stringify(fetchMock.mock.calls[0][1])).not.toContain('unselected-media-id')
expect(proposal).toMatchObject({ locale: 'en', state: 'draft', sourceFingerprint: expect.any(String) })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/unit/nim.test.ts tests/unit/proposals.test.ts`

Expected: FAIL because the client and proposal service are absent.

- [ ] **Step 3: Implement `NimClient.generate` and `createProposal`**

POST to the configured OpenAI-compatible NIM endpoint with the configured model and a server-side bearer secret. Request JSON-only output matching Task 4. Convert transport/model/parser failures into safe typed errors, record them in a failed proposal, and do not log request headers, API key or unvalidated raw content.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/unit/nim.test.ts tests/unit/proposals.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services tests/unit/nim.test.ts tests/unit/proposals.test.ts
git commit -m "feat: generate reviewable SEO proposals through NIM"
```

### Task 6: Audit, detect stale drafts and apply selected values

**Files:**
- Create: `src/services/audit.ts`, `tests/unit/audit.test.ts`
- Modify: `src/services/proposals.ts`, `tests/unit/proposals.test.ts`

**Interfaces:**
- Produces: `auditSeo(doc: Document, locale: string): SeoAudit`.
- Produces: `applyProposal(args: ApplyProposalArgs): Promise<Document>` where `args.groups` is a non-empty subset of `meta | social | schema | citability`.
- Consumes: proposal state and source fingerprint from Task 5.

- [ ] **Step 1: Write failing audit/application tests**

```ts
expect(auditSeo(incompletePost, 'fr')).toMatchObject({ score: expect.any(Number), missing: expect.arrayContaining(['meta.description']) })
await expect(applyProposal({ proposal: staleProposal, groups: ['meta'] })).rejects.toThrow(/stale/i)
await applyProposal({ proposal: freshProposal, groups: ['meta'] })
expect(updated.seo.meta.title).toBe('Proposed title')
expect(updated.seo.social).toEqual(original.seo.social)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/unit/audit.test.ts tests/unit/proposals.test.ts`

Expected: FAIL because auditing, stale checks and selective apply are absent.

- [ ] **Step 3: Implement audit and selective apply**

Score only approved fields for the requested locale, return concrete missing/invalid recommendations, re-fingerprint the source immediately before mutation, reject stale/non-draft proposals, update only selected groups in the active locale and mark the proposal `applied` with actor/timestamp.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/unit/audit.test.ts tests/unit/proposals.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services tests/unit/audit.test.ts tests/unit/proposals.test.ts
git commit -m "feat: audit and selectively apply SEO proposals"
```

### Task 7: Add protected endpoints and Payload jobs

**Files:**
- Create: `src/endpoints/generate.ts`, `src/endpoints/apply.ts`, `src/endpoints/audit.ts`, `src/jobs/generateProposal.ts`, `src/jobs/runAudit.ts`, `tests/int/endpoints.int.spec.ts`, `tests/int/jobs.int.spec.ts`
- Modify: `src/plugin.ts`

**Interfaces:**
- Produces: `generateProposalEndpoint`, `applyProposalEndpoint`, `auditEndpoint` Payload endpoint handlers.
- Produces: `generateProposalTask` and `runAuditTask` registered in `config.jobs.tasks`.
- Consumes: Tasks 5–6 services and `permissions.generate`, `permissions.apply`, `permissions.manage`.

- [ ] **Step 1: Write failing endpoint/job integration tests**

```ts
expect((await generateAsViewer()).status).toBe(403)
expect((await generateAsEditor()).status).toBe(201)
expect((await applyAsEditor({ groups: ['citability'] })).status).toBe(200)
await runAuditTask({ input: { collection: 'posts', locales: ['fr', 'en'] }, req })
expect(await proposalsForRun()).toHaveLength(2)
expect(await sourceDocument()).toEqual(beforeRun)
```

- [ ] **Step 2: Run integration tests to verify they fail**

Run: `pnpm vitest run tests/int/endpoints.int.spec.ts tests/int/jobs.int.spec.ts`

Expected: FAIL because handlers and tasks are absent.

- [ ] **Step 3: Implement endpoints and jobs**

Authorize before reading content; endpoint generation creates one draft only; application delegates to selective apply; audit endpoint reports without mutation and queues a bulk run only for managers. Register tasks without deleting host tasks. Persist per-document run progress/errors and always create, rather than apply, proposals in a bulk run.

- [ ] **Step 4: Run integration tests**

Run: `pnpm vitest run tests/int/endpoints.int.spec.ts tests/int/jobs.int.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src tests/int/endpoints.int.spec.ts tests/int/jobs.int.spec.ts
git commit -m "feat: add protected SEO endpoints and batch jobs"
```

### Task 8: Build the bilingual Payload admin workflow

**Files:**
- Create: `src/ui/SeoPanel.tsx`, `src/ui/AuditDashboard.tsx`, `src/translations/index.ts`, `src/exports/client.ts`, `src/exports/rsc.ts`, `tests/e2e/seo-admin.spec.ts`
- Modify: `src/plugin.ts`, `dev/payload.config.ts`

**Interfaces:**
- Produces: `SeoPanel` and `AuditDashboard` client components available under the package `./client` export.
- Consumes: Task 7 API responses; `translations(locale: 'fr' | 'en')`.

- [ ] **Step 1: Write failing Playwright admin workflow tests**

```ts
await expect(page.getByRole('heading', { name: /SEO IA.*Français/i })).toBeVisible()
await page.getByRole('button', { name: /générer une proposition/i }).click()
await expect(page.getByText(/modifications.*meta.*OG.*JSON-LD/i)).toBeVisible()
await page.getByLabel(/meta/i).check()
await page.getByRole('button', { name: /appliquer/i }).click()
await expect(page.getByText(/appliquée/i)).toBeVisible()
```

- [ ] **Step 2: Run the E2E test to verify it fails**

Run: `pnpm playwright test tests/e2e/seo-admin.spec.ts`

Expected: FAIL because no custom SEO admin UI exists.

- [ ] **Step 3: Implement localized panels and Payload registration**

Render the active Payload locale, only its own proposals and an explicit no-translation notice. Provide audit score, generation, diff, field-group checkboxes, preview of JSON-LD/OG/image attributes, apply/reject actions and protected batch scheduling. Supply complete French and English copy; do not hard-code French labels in component bodies.

- [ ] **Step 4: Run admin E2E test and all unit tests**

Run: `pnpm playwright test tests/e2e/seo-admin.spec.ts && pnpm vitest run`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src dev tests/e2e/seo-admin.spec.ts
git commit -m "feat: add bilingual SEO proposal admin workflow"
```

### Task 9: Provide frontend helpers, documentation and release checks

**Files:**
- Create: `src/helpers/metadata.ts`, `tests/unit/metadata.test.ts`
- Modify: `src/index.ts`, `package.json`, `README.md`

**Interfaces:**
- Produces: `buildMetadata(seo: SeoFields): MetadataLike` and `buildJsonLd(seo: SeoFields): Record<string, unknown>[]` exported from `@scope/payload-plugin-nim-seo/helpers`.
- Consumes: approved localized SEO data from Task 3.

- [ ] **Step 1: Write failing helper tests**

```ts
expect(buildMetadata(frSeo)).toMatchObject({ title: 'Titre', description: 'Description', openGraph: { images: [{ url: '/media/a.jpg' }] } })
expect(buildJsonLd(frSeo)).toEqual([expect.objectContaining({ '@context': 'https://schema.org' })])
expect(buildJsonLd({ ...frSeo, schema: [] })).toEqual([])
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/unit/metadata.test.ts`

Expected: FAIL because frontend helpers are absent.

- [ ] **Step 3: Implement helpers and write the README**

Keep helpers pure and only consume already-approved fields. Document peer requirements, install/configuration, environment variables, localized Payload setup, collection adapters, jobs/worker requirement, permissions, media workflow, NIM security, manual review policy, Next.js rendering example, migration and testing commands.

- [ ] **Step 4: Run full release checks**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run && pnpm playwright test && pnpm pack --dry-run`

Expected: PASS and the package contains only intended distributable files.

- [ ] **Step 5: Commit**

```bash
git add src package.json README.md tests/unit/metadata.test.ts
git commit -m "docs: document Payload NIM SEO plugin integration"
```

## Self-Review

- **Spec coverage:** Tasks 2–3 cover Payload v3 configuration, localization and persisted models; Tasks 4–5 cover NIM generation, JSON-LD and strict output safety; Tasks 6–7 cover auditing, review, batch behavior and permissions; Task 8 covers FR/EN admin UX; Task 9 covers headless frontend consumption and operator documentation. Every explicit design objective has a task.
- **Step scan:** Each step has a specific test, command, interface or implementation boundary. No task delegates an undefined behavior to a later task.
- **Type consistency:** `NimSeoPluginOptions → ValidatedPluginOptions → GenerationInput → SeoProposalPayload → SeoProposal → ApplyProposalArgs` is created in Tasks 1–6 and consumed by later tasks using the same names.
- **Review focus:** The five highest-risk failure modes appear in Tasks 2, 4, 5 and 6 with direct tests.
- **Proportion:** The plan defines boundaries, signatures, test assertions and verification only; it does not prescribe component bodies or prompt text beyond the approved constraints.

### Task 10: Enforce bilingual source-content configuration

**Files:**
- Modify: `src/types.ts`, `src/plugin.ts`, `tests/unit/plugin-options.test.ts`, `README.md`

**Interfaces:**
- Extend `CollectionSeoOptions` with `localizedSourceFields: readonly string[]`.
- `validatePluginOptions(options, config)` rejects a targeted collection unless every named source field exists and has `localized: true` in Payload’s field configuration.

- [ ] Write failing validation tests for an unlocalized `title` or `content` field and a passing independent `fr`/`en` source configuration.
- [ ] Implement recursive field lookup and startup diagnostics that name the collection and field; keep `extractContent` as the project-specific content reader.
- [ ] Add README configuration guidance and run focused tests, full release checks and typecheck.
- [ ] Commit: `feat: require localized source content fields`
