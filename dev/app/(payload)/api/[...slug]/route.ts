import config from '../../../../payload.config.js'
import { REST_GET, REST_POST, REST_PATCH, REST_DELETE, REST_OPTIONS, REST_PUT } from '@payloadcms/next/routes'
export const GET = REST_GET(config)
export const POST = REST_POST(config)
export const PATCH = REST_PATCH(config)
export const DELETE = REST_DELETE(config)
export const OPTIONS = REST_OPTIONS(config)
export const PUT = REST_PUT(config)
