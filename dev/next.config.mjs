import { withPayload } from '@payloadcms/next/withPayload'
export default withPayload({
  webpack(config) {
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, '.js': ['.ts', '.tsx', '.js'] }
    return config
  },
})
