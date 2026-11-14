/**
 * Put files the user chose or dropped into a folder of the file manager. In
 * the window they are files on this computer, copied there; through the
 * remote link they are uploaded there (main/remote/server.ts), one at a time.
 */
export async function uploadInto(files: File[], folder: string): Promise<void> {
  if (!window.api.remote) {
    const paths = files.map((file) => window.api.pathForFile(file)).filter(Boolean)
    if (paths.length) await window.api.fileManager.copyInto(paths, folder)
    return
  }
  for (const file of files) {
    const query = new URLSearchParams({ dir: folder, name: file.name || 'file' })
    const response = await fetch(`/api/upload?${query}`, {
      method: 'POST',
      body: file,
      credentials: 'same-origin'
    })
    if (!response.ok) {
      const result = (await response.json().catch(() => ({}))) as { error?: string }
      throw new Error(result.error ?? `${file.name} could not be uploaded.`)
    }
  }
}
