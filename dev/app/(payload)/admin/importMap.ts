import { SeoPanel, AuditDashboard } from '../../../../src/exports/client.js'
import { CollectionCards } from '@payloadcms/next/rsc'
export const importMap = {
  '@scope/payload-plugin-nim-seo/client#SeoPanel': SeoPanel,
  '@scope/payload-plugin-nim-seo/client#AuditDashboard': AuditDashboard,
  '@payloadcms/next/rsc#CollectionCards': CollectionCards,
}
