# Editorial Field Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the plugin so editors can review and apply AI proposals for every configured editorial field except `content`, including selected related-document drafts and a final semantic `@graph`.

**Architecture:** Extend per-collection options with an explicit editorial field registry and relation policies. A new schema-aware proposal layer validates patches, related drafts and graph references before persistence. Application resolves selected drafts and patches transactionally; admin UI renders a locale-scoped tree diff and graph preview.

**Tech Stack:** TypeScript, Payload CMS v3, React, Zod, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-12-editorial-field-graph-design.md`

## Global Constraints

- `content` is never generated, persisted, patched or created in a related draft.
- Only explicitly configured localized editorial fields are eligible; all technical and access fields are excluded.
- FR and EN remain independent; every operation reads and writes only the active locale.
- Existing/new related documents are proposals; their creation/linking occurs only after editor selection.
- Related collection creation requires explicit configuration; collections without drafts may receive ordinary documents only after validation.
- Final `@graph` contains only selected patches, selected relations and selected related drafts.
- Source, related document and proposal mutations occur in a single effective Payload transaction.

## Review Focus

- A client-crafted patch must not write `content`, an undeclared path or a technical field — Task 2 and Task 4.
- An unselected related draft must not be created or leak into the final graph — Task 3 and Task 4.
- A later locale’s values must never affect the current locale’s proposal or application — Task 2 and Task 4.
- Failed related-record creation or resolution must roll back every mutation — Task 4.
- A cyclic/local graph reference or unsupported schema node must be rejected before persistence — Task 3.

---

## File Structure

```
src/types.ts                         public editorial field and patch contracts
src/plugin.ts                        configuration validation and admin registration
src/services/editorialSchema.ts      resolves allowed Payload paths/types
src/services/editorialValidation.ts  validates patches, drafts and @graph
src/services/proposals.ts            generation persistence and transactional apply extension
src/services/graph.ts                reconciles final graph from selected application set
src/ui/EditorialProposalTree.tsx     locale-scoped selectable editorial diff
src/ui/SeoPanel.tsx                  integrates tree, related drafts and graph preview
tests/unit/editorialSchema.test.ts
tests/unit/editorialValidation.test.ts
tests/int/editorial-apply.int.spec.ts
tests/e2e/editorial-proposal.spec.ts
README.md
```

### Task 1: Add the configurable editorial-field registry

**Files:**
- Modify: `src/types.ts`, `src/plugin.ts`, `README.md`
- Create: `src/services/editorialSchema.ts`, `tests/unit/editorialSchema.test.ts`

**Interfaces:**
- Produces: `EditorialFieldOptions`, `EditorialRelationOptions` and `resolveEditorialRegistry(options, collection): EditorialRegistry`.

- [ ] **Step 1: Write failing registry tests**

```ts
expect(() => resolveEditorialRegistry(optionsWithContent, 'posts')).toThrow(/content/i)
expect(resolveEditorialRegistry(validOptions, 'posts').fields).toContainEqual(expect.objectContaining({ path: 'faq.question' }))
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/unit/editorialSchema.test.ts`

Expected: FAIL because no registry exists.

- [ ] **Step 3: Implement registry resolution**

Add `editorialFields.include`, `exclude` and relation creation policy. Resolve nested groups, arrays, tabs and blocks against Payload collection fields; require explicit localization and reject `content`, unknown paths, technical fields and relation configuration mismatch.

- [ ] **Step 4: Run unit tests and typecheck**

Run: `pnpm vitest run tests/unit/editorialSchema.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/plugin.ts src/services/editorialSchema.ts tests/unit/editorialSchema.test.ts README.md
git commit -m "feat: configure AI editorial fields"
```

### Task 2: Validate structured editorial proposals

**Files:**
- Create: `src/services/editorialValidation.ts`, `tests/unit/editorialValidation.test.ts`
- Modify: `src/types.ts`, `src/services/validation.ts`, `src/services/proposals.ts`

**Interfaces:**
- Produces: `EditorialPatch`, `RelatedDraft`, `EditorialProposalPayload` and `parseEditorialProposal(value, registry, locale): EditorialProposalPayload`.

- [ ] **Step 1: Write failing validation tests**

```ts
expect(() => parseEditorialProposal({ patches: [{ path: 'content', value: 'x' }] }, registry, 'fr')).toThrow(/content/i)
expect(() => parseEditorialProposal(crossLocaleOutput, registry, 'fr')).toThrow(/locale/i)
expect(parseEditorialProposal(validOutput, registry, 'fr').patches).toHaveLength(2)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/editorialValidation.test.ts`

Expected: FAIL because editorial output is unsupported.

- [ ] **Step 3: Implement typed output parsing**

Validate operation, configured path, Payload-compatible scalar/array/relation type, locale, draft collection policy and local graph ID. Extend NIM response parsing/persistence without weakening existing SEO validation.

- [ ] **Step 4: Run validation tests**

Run: `pnpm vitest run tests/unit/editorialValidation.test.ts tests/unit/validation.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/editorialValidation.ts src/services/validation.ts src/services/proposals.ts src/types.ts tests/unit/editorialValidation.test.ts
git commit -m "feat: validate editorial field proposals"
```

### Task 3: Reconcile the semantic graph

**Files:**
- Create: `src/services/graph.ts`, `tests/unit/graph.test.ts`
- Modify: `src/services/editorialValidation.ts`

**Interfaces:**
- Produces: `buildAppliedGraph(args: AppliedGraphArgs): Record<string, unknown>`.

- [ ] **Step 1: Write failing graph tests**

```ts
expect(buildAppliedGraph({ proposal, selectedPatches: ['title'], selectedDrafts: [] })['@graph']).not.toContainEqual(expect.objectContaining({ '@id': 'draft:tag-1' }))
expect(() => buildAppliedGraph(cyclicLocalReferences)).toThrow(/graph/i)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/graph.test.ts`

Expected: FAIL because graph reconciliation is absent.

- [ ] **Step 3: Implement `buildAppliedGraph`**

Retain only selected nodes/edges, replace selected local draft IDs with resolved IDs, add root Schema.org context, reject unselected/cyclic/unresolved references and reuse existing JSON-LD safety rules.

- [ ] **Step 4: Run graph tests**

Run: `pnpm vitest run tests/unit/graph.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/graph.ts src/services/editorialValidation.ts tests/unit/graph.test.ts
git commit -m "feat: reconcile applied semantic graphs"
```

### Task 4: Apply selected editorial fields and related drafts atomically

**Files:**
- Modify: `src/services/proposals.ts`, `src/collections/proposals.ts`, `src/endpoints/apply.ts`
- Create: `tests/int/editorial-apply.int.spec.ts`

**Interfaces:**
- Produces: `applyProposal({ options, req, proposal, locale, groups, editorialPaths, relatedDraftIDs }): Promise<Document>`.

- [ ] **Step 1: Write failing integration tests**

```ts
await expect(applyProposal({ editorialPaths: ['content'], relatedDraftIDs: [] })).rejects.toThrow(/content/i)
await applyProposal({ editorialPaths: ['excerpt'], relatedDraftIDs: ['tag-1'] })
expect(createdTag).toMatchObject({ name: 'Art numérique' })
expect(updated.fr.excerpt).toBe('Proposed excerpt')
expect(updated.en.excerpt).toBe(original.en.excerpt)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/int/editorial-apply.int.spec.ts`

Expected: FAIL because apply accepts only SEO groups.

- [ ] **Step 3: Implement transactional application**

Reload/revalidate proposal and source, authorize every affected collection, create only selected drafts, resolve relations, apply only selected registered paths in the active locale, reconstruct final graph, and roll back source, related docs and proposal state together on error.

- [ ] **Step 4: Run integration tests**

Run: `pnpm vitest run tests/int/editorial-apply.int.spec.ts tests/int/application.int.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/proposals.ts src/collections/proposals.ts src/endpoints/apply.ts tests/int/editorial-apply.int.spec.ts
git commit -m "feat: apply editorial proposals transactionally"
```

### Task 5: Add bilingual editorial proposal controls to the admin

**Files:**
- Create: `src/ui/EditorialProposalTree.tsx`, `tests/e2e/editorial-proposal.spec.ts`
- Modify: `src/ui/SeoPanel.tsx`, `src/translations/index.ts`, `README.md`

**Interfaces:**
- Produces: `EditorialProposalTree({ proposal, locale, onChange }): JSX.Element`.

- [ ] **Step 1: Write failing browser workflow**

```ts
await expect(page.getByText(/Content.*conservé/i)).toBeVisible()
await page.getByLabel(/Chapô/i).check()
await page.getByLabel(/Nouveau tag.*Art numérique/i).check()
await page.getByRole('button', { name: /appliquer/i }).click()
await expect(page.getByText(/Graphe sémantique/i)).toBeVisible()
```

- [ ] **Step 2: Run E2E test to verify it fails**

Run: `pnpm playwright test tests/e2e/editorial-proposal.spec.ts`

Expected: FAIL because editorial proposal controls do not exist.

- [ ] **Step 3: Implement locale-scoped diff UI**

Render field tree, related-draft cards, graph preview, per-item selection and no-translation/content-exclusion copy in both French and English. Submit explicit selected paths/IDs only to the protected API.

- [ ] **Step 4: Run browser and full tests**

Run: `pnpm playwright test tests/e2e/editorial-proposal.spec.ts && pnpm vitest run`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui src/translations tests/e2e/editorial-proposal.spec.ts README.md
git commit -m "feat: review editorial field and graph proposals"
```

## Self-Review

- **Spec coverage:** Tasks 1–2 cover explicit field configuration and proposal validation; Task 3 covers final graph reconciliation; Task 4 owns transactional application; Task 5 owns the bilingual review flow and documentation.
- **Step scan:** Every task begins with an explicit failing test and ends with focused verification and a commit.
- **Type consistency:** `EditorialRegistry → EditorialProposalPayload → buildAppliedGraph → applyProposal → EditorialProposalTree` is defined in task order.
- **Review focus:** Each listed high-risk condition has direct coverage in Tasks 2–4.
- **Proportion:** The plan specifies interfaces and proof obligations without prescribing implementation bodies.
