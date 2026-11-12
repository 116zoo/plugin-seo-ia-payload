import config from '../../payload.config.js'
import { RootLayout, handleServerFunctions } from '@payloadcms/next/layouts'
import type { ServerFunctionClient } from 'payload'
import type { ReactNode } from 'react'
import { importMap } from './admin/importMap.js'
import '@payloadcms/next/css'

const serverFunction: ServerFunctionClient = async (args) => {
  'use server'
  return handleServerFunctions({ ...args, config, importMap })
}

export default function Layout({ children }: { children: ReactNode }) {
  return <RootLayout config={config} importMap={importMap} serverFunction={serverFunction}>{children}</RootLayout>
}
