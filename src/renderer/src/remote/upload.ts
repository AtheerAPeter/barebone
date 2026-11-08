import type { Attachment } from '../../../shared/types'

/** Send a file to the Mac, where agents can read it; its attachment, with the path there. */
export async function uploadFile(file: File): Promise<Attachment> {
  const response = await fetch(`/api/upload?name=${encodeURIComponent(file.name || 'file')}`, {
    method: 'POST',
    body: file,
    credentials: 'same-origin'
  })
  const result = (await response.json()) as { path?: string; name?: string; error?: string }
  if (!response.ok || !result.path) throw new Error(result.error ?? 'The file could not be sent.')
  return { name: result.name ?? file.name, path: result.path, mimeType: file.type || undefined }
}
