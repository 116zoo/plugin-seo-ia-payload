import config from '../../../../payload.config.js'
import { RootPage } from '@payloadcms/next/views'
import { importMap } from '../importMap.js'

export default function Page(props: { params: Promise<{ segments: string[] }>; searchParams: Promise<Record<string, string | string[]>> }) {
  return RootPage({ ...props, config, importMap })
}
