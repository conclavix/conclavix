import { tokenStore } from '../api/client';

/** The file name in a `Content-Disposition` header: `filename*` (UTF-8) first, then `filename`. */
export function dispositionName(header: string | null): string | null {
  if (!header) return null;
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1]);
    } catch {
      // A malformed encoding falls back to the plain name below.
    }
  }
  return /filename="([^"]+)"/i.exec(header)?.[1] ?? null;
}

/**
 * Download an attachment from the API. A session user follows a plain navigation (the response
 * is an attachment, so the page stays); with a personal token the request needs the header, so
 * the file is fetched and saved through an object URL.
 */
export async function downloadFile(url: string, fallbackName: string): Promise<void> {
  const token = tokenStore.get();
  if (!token) {
    window.location.assign(url);
    return;
  }
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`download failed with ${response.status}`);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(await response.blob());
  link.download = dispositionName(response.headers.get('content-disposition')) ?? fallbackName;
  link.click();
  URL.revokeObjectURL(link.href);
}
