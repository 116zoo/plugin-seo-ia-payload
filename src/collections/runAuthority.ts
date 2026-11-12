import type { PayloadRequest } from 'payload'

// A browser-controlled req.context flag cannot confer scheduling authority.
const schedulingRequests = new WeakSet<PayloadRequest>()
export const isSchedulingRequest = (req: PayloadRequest): boolean => schedulingRequests.has(req)
export const withSchedulingAuthority = async <T>(req: PayloadRequest, operation: () => Promise<T>): Promise<T> => {
  const alreadyAuthorized = schedulingRequests.has(req)
  schedulingRequests.add(req)
  try { return await operation() } finally { if (!alreadyAuthorized) schedulingRequests.delete(req) }
}
