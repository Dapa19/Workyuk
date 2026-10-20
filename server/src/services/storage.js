import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const directory = path.resolve(process.env.UPLOAD_DIR || 'server/uploads');
const allowedExtensions = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.txt']);

export const fileStorage = {
  directory,
  async ensureReady() { await fs.mkdir(directory, { recursive: true }); },
  storedName(originalName) { return `${crypto.randomUUID()}${path.extname(originalName).toLowerCase()}`; },
  resolve(storedName) {
    const name = path.basename(String(storedName || ''));
    if (!name || name !== storedName) throw new Error('Invalid storage name');
    return path.join(directory, name);
  },
  async remove(storedName) { await fs.unlink(this.resolve(storedName)); },
  async verify(file) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowedExtensions.has(ext)) return false;
    const handle = await fs.open(file.path, 'r');
    try {
      const head = Buffer.alloc(16);
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      const bytes = head.subarray(0, bytesRead);
      if (ext === '.pdf') return bytes.subarray(0, 5).toString() === '%PDF-';
      if (ext === '.png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      if (ext === '.jpg' || ext === '.jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (ext === '.txt') {
        const data = await fs.readFile(file.path);
        if (data.includes(0)) return false;
        try { new TextDecoder('utf-8', { fatal: true }).decode(data); return true; } catch { return false; }
      }
      return false;
    } finally { await handle.close(); }
  },
};
