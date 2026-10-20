export class ApiError extends Error {
  constructor(message, status, code, fields) { super(message); this.status=status; this.code=code; this.fields=fields; }
}

export async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const isForm = options.body instanceof FormData;
  if (options.body && !isForm && typeof options.body !== 'string') {
    headers.set('Content-Type', 'application/json');
    options = { ...options, body: JSON.stringify(options.body) };
  }
  let response;
  try { response = await fetch(url.startsWith('/api') ? url : `/api${url}`, { credentials: 'include', ...options, headers }); }
  catch { throw new ApiError('Tidak dapat terhubung ke server. Periksa koneksi lalu coba lagi.', 0, 'NETWORK_ERROR'); }
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = data?.error || {};
    throw new ApiError(error.message || 'Permintaan tidak dapat diproses.', response.status, error.code, error.fields);
  }
  return data?.data;
}

export function formatDate(value, options = {}) {
  if (!value) return 'Belum ditentukan';
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric', ...options }).format(date);
}
export function formatTime(value) {
  return new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
export function formatBytes(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
