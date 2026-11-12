import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { generateTypes } from 'payload/node'
import ts from 'typescript'
import { expect, test } from 'vitest'

import config from '../../dev/payload.config.js'

test('both helpers accept the actual Payload-generated Post SEO type without assertions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nim-seo-generated-types-'))
  try {
    const hostConfig = await config
    const generatedFile = path.join(directory, 'payload-types.ts')
    await generateTypes({
      ...hostConfig,
      typescript: { ...hostConfig.typescript, outputFile: generatedFile, declare: false },
    }, { log: false })
    const consumerFile = path.join(directory, 'consumer.ts')
    const helperPath = path.resolve('src/helpers/metadata.js')
    await writeFile(consumerFile, `
      import type { Post } from './payload-types.js'
      import { buildMetadata, buildJsonLd, type SeoFields } from ${JSON.stringify(helperPath)}
      declare const post: Post
      const approved: SeoFields = post.seo ?? {}
      buildMetadata(post.seo ?? {})
      buildJsonLd(post.seo ?? {})
      buildMetadata(approved)
    `)
    const program = ts.createProgram([consumerFile], {
      strict: true, skipLibCheck: true, noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      typeRoots: [path.resolve('node_modules/@types')],
    })
    const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    expect(diagnostics).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)
