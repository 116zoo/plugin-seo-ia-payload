import { expect, test, type Page } from '@playwright/test'

async function login(page: Page, role = 'admin') {
  const response = await page.request.post('/api/users/login', { data: { email: `${role}@example.test`, password: 'local-browser-fixture-password' } })
  expect(response.ok()).toBeTruthy()
}

test('French editor reviews and selectively applies a proposal without changing English content', async ({ page }) => {
  await login(page)
  await page.goto('/admin/collections/posts/1?locale=fr')
  const panel = page.getByRole('region', { name: /SEO IA/ })
  await expect(panel.getByRole('heading', { name: /SEO IA.*Français/ })).toBeVisible()
  await expect(panel.getByText(/aucune traduction automatique/i)).toBeVisible()
  await panel.getByRole('button', { name: /générer une proposition/i }).click()
  await expect(panel.getByText(/modifications.*meta.*OG.*JSON-LD/i)).toBeVisible()
  await expect(panel.getByText('Proposition FR', { exact: false }).first()).toBeVisible()
  await expect(panel.getByRole('button', { name: /^Appliquer/ })).toBeDisabled()
  const proposals = await (await page.request.get('/api/seo-proposals?where[locale][equals]=fr&sort=-createdAt')).json()
  expect(proposals.docs[0].sourceSnapshot.content).toBe('Contenu français enregistré.')
  await panel.getByRole('checkbox', { name: /Meta/ }).check()
  await panel.getByRole('button', { name: /^Appliquer/ }).click()
  await expect(panel.getByRole('status')).toContainText(/appliquée/i)
  const french = await (await page.request.get('/api/posts/1?locale=fr&fallback-locale=none&draft=true')).json()
  const english = await (await page.request.get('/api/posts/1?locale=en&fallback-locale=none&draft=true')).json()
  expect(french.seo.meta.title).toBe('Proposition FR')
  expect(french.seo.citability.summary).toBe('Résumé validé FR')
  expect(english.seo.meta.title).toBe('Approved EN')
  expect(french.content).toBe('Contenu français enregistré.')
})

test('English proposals stay separate, show previews and can be rejected', async ({ page }) => {
  await login(page)
  await page.goto('/admin/collections/posts/1?locale=en')
  const panel = page.getByRole('region', { name: /AI SEO/ })
  await expect(panel.getByRole('heading', { name: /AI SEO.*English/ })).toBeVisible()
  await expect(panel.getByText(/Proposition FR/)).toHaveCount(0)
  await panel.getByRole('button', { name: /Generate proposal/ }).click()
  await expect(panel.getByRole('heading', { name: /Open Graph/ })).toBeVisible()
  await expect(panel.getByRole('heading', { name: /Image attributes/ })).toBeVisible()
  await expect(panel.getByRole('heading', { name: 'JSON-LD', exact: true })).toBeVisible()
  const englishProposals = await (await page.request.get('/api/seo-proposals?where[locale][equals]=en&sort=-createdAt')).json()
  expect(englishProposals.docs[0].sourceSnapshot.content).toBe('Saved English content.')
  await panel.getByRole('button', { name: /^Reject/ }).click()
  await expect(panel.getByRole('status')).toContainText(/rejected/i)
  const proposals = await (await page.request.get('/api/seo-proposals?where[locale][equals]=en')).json()
  expect(proposals.docs[0].state).toBe('discarded')
})

test('unsaved localized content blocks generation and a stale apply gives a recoverable error', async ({ page }) => {
  await login(page, 'editor')
  await page.goto('/admin/collections/posts/1?locale=en')
  const panel = page.getByRole('region', { name: /AI SEO/ })
  const generate = panel.getByRole('button', { name: /Generate proposal/ })
  await expect(generate).toBeEnabled()
  const content = page.getByRole('textbox', { name: /^Content/ })
  await content.fill('Uncommitted English content')
  await expect(generate).toBeDisabled()
  await expect(panel.getByText(/Save this document and its localized content/)).toBeVisible()
  await content.fill('Saved English content.')
  // A full reload discards the unsaved form and reloads its recorded source locale.
  page.once('dialog', (dialog) => dialog.accept())
  await page.reload()
  await generate.click()
  await panel.getByRole('checkbox', { name: 'Meta', exact: true }).check()
  // Change the source through the real API after generation to stale the fingerprint.
  await page.request.patch('/api/posts/1?locale=en', { data: { content: 'Changed after generation' } })
  await panel.getByRole('button', { name: /^Apply/ }).click()
  await expect(panel.getByRole('alert')).toContainText(/stale or unavailable/i)
  await expect(content).toBeEditable()
  await expect(panel.getByRole('button', { name: /^Apply/ })).toBeEnabled()
  const doc = await (await page.request.get('/api/posts/1?locale=en&draft=true')).json()
  expect(doc.seo.meta.title).toBe('Approved EN')
  // Restore fixture content without changing SEO or another locale.
  await page.request.patch('/api/posts/1?locale=en', { data: { content: 'Saved English content.' } })
})

test('manager schedules only the active locale and viewers have no workflow actions', async ({ page }) => {
  await login(page)
  await page.goto('/admin?locale=en')
  const dashboard = page.getByRole('region', { name: /SEO audit/ })
  await expect(dashboard.getByRole('table')).toBeVisible()
  await expect(dashboard.getByRole('button', { name: /Schedule batch/ })).toBeDisabled()
  await dashboard.getByRole('checkbox', { name: /Select document:/ }).first().check()
  await dashboard.getByRole('combobox', { name: 'SEO status', exact: true }).selectOption('complete')
  await expect(dashboard.getByText('No accessible documents match these filters.')).toBeVisible()
  await expect(dashboard.getByRole('button', { name: /Schedule batch/ })).toBeDisabled()
  await dashboard.getByRole('combobox', { name: 'SEO status', exact: true }).selectOption('incomplete')
  await expect(dashboard.getByRole('table')).toBeVisible()
  await expect(dashboard.getByRole('checkbox', { name: /Select document:/ }).first()).not.toBeChecked()
  await dashboard.getByLabel('Minimum score', { exact: true }).fill('100')
  await expect(dashboard.getByText('No accessible documents match these filters.')).toBeVisible()
  await dashboard.getByLabel('Minimum score', { exact: true }).fill('0')
  await expect(dashboard.getByRole('table')).toBeVisible()
  await dashboard.getByRole('checkbox', { name: /Select document:/ }).first().check()
  await dashboard.getByRole('button', { name: /Schedule batch/ }).click()
  await expect(dashboard.getByRole('status')).toContainText(/queued/i)
  const runs = await (await page.request.get('/api/seo-runs')).json()
  expect(runs.docs[0].documents).toHaveLength(1)
  expect(runs.docs[0].documents[0].locale).toBe('en')
  expect(runs.docs[0].locales).toEqual(['en'])
  expect(runs.docs[0].state).toBe('queued')
  await page.request.post('/api/users/logout')
  await login(page, 'viewer')
  await page.goto('/admin/collections/posts/1?locale=en')
  await expect(page.getByRole('button', { name: /Generate proposal|Apply selected groups|Schedule batch/ })).toHaveCount(0)
})

test('audit and proposal review remain available when media cannot be listed', async ({ page }) => {
  await login(page)
  await page.route('**/api/media?**', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ errors: [{ message: 'Forbidden' }] }) }))
  await page.goto('/admin/collections/posts/1?locale=en')
  const panel = page.getByRole('region', { name: /AI SEO/ })
  await expect(panel.getByRole('meter', { name: /Approved SEO score/ })).toBeVisible()
  await panel.getByRole('button', { name: /Generate proposal/ }).click()
  await expect(panel.getByRole('heading', { name: /Proposed changes/ })).toBeVisible()
})

async function createRegressionPost(page: Page) {
  const response = await page.request.post('/api/posts?locale=en', { data: {
    title: 'Regression title', slug: 'regression-post', content: 'Regression source content.',
  } })
  expect(response.ok()).toBeTruthy()
  const { doc } = await response.json()
  return doc.id as string | number
}

test('applying SEO locks source fields until the response is synchronized, then permits new edits', async ({ page }) => {
  await login(page)
  const id = await createRegressionPost(page)
  await page.goto(`/admin/collections/posts/${id}?locale=en`)
  const panel = page.getByRole('region', { name: /AI SEO/ })
  await panel.getByRole('button', { name: /Generate proposal/ }).click()
  await panel.getByRole('checkbox', { name: 'Meta', exact: true }).check()
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let started!: () => void
  const intercepted = new Promise<void>((resolve) => { started = resolve })
  await page.route('**/api/nim-seo/apply', async (route) => {
    started()
    await held
    await route.continue()
  })
  const title = page.getByRole('textbox', { name: /^Title \* — en$/ })
  const content = page.getByRole('textbox', { name: /^Content/ })
  await panel.getByRole('button', { name: /^Apply/ }).click()
  await intercepted
  try {
    await expect(title).not.toBeEditable()
    await expect(content).not.toBeEditable()
  } finally { release() }
  await expect(panel.getByRole('status')).toContainText(/applied/i)
  await expect(title).toBeEditable()
  await expect(content).toBeEditable()
  await title.fill('Edited after SEO apply')
  await content.fill('Source edited after SEO apply.')
  const saveResponse = page.waitForResponse((response) => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/posts/${id}`)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  expect((await saveResponse).ok()).toBeTruthy()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  const saved = await (await page.request.get(`/api/posts/${id}?locale=en&draft=true`)).json()
  expect(saved.title).toBe('Edited after SEO apply')
  expect(saved.content).toBe('Source edited after SEO apply.')
  expect(saved.seo.meta.title).toBe('Proposal EN')
})

for (const action of ['Apply', 'Reject'] as const) {
  test(`${action.toLowerCase()} clears group selection when the next proposal becomes visible`, async ({ page }) => {
    await login(page)
    const id = await createRegressionPost(page)
    await page.goto(`/admin/collections/posts/${id}?locale=en`)
    const panel = page.getByRole('region', { name: /AI SEO/ })
    await panel.getByRole('button', { name: /Generate proposal/ }).click()
    await expect(panel.getByRole('heading', { name: /Proposed changes/ })).toBeVisible()
    await panel.getByRole('button', { name: /Generate proposal/ }).click()
    await expect(panel.getByRole('combobox', { name: 'Draft proposal' })).toBeVisible()
    const meta = panel.getByRole('checkbox', { name: 'Meta', exact: true })
    await meta.check()
    await panel.getByRole('button', { name: new RegExp(`^${action}`) }).click()
    await expect(panel.getByRole('status')).toContainText(action === 'Apply' ? /applied/i : /rejected/i)
    await expect(panel.getByRole('heading', { name: /Proposed changes/ })).toBeVisible()
    await expect(meta).not.toBeChecked()
    await expect(panel.getByRole('button', { name: /^Apply/ })).toBeDisabled()
  })
}
