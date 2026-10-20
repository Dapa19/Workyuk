import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeUsername } from '../src/utils.js';

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), 'workyuk-test-'));
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-that-is-long-enough-1234567890';
process.env.CLIENT_ORIGIN = 'http://localhost:5173';
process.env.DATABASE_PATH = path.join(testHome, 'test.sqlite');
process.env.UPLOAD_DIR = path.join(testHome, 'uploads');
process.env.MAX_UPLOAD_MB = '1';

const [{ createApp }, { migrateDb }, database] = await Promise.all([
  import('../src/app.js'), import('../src/db/migrate.js'), import('../src/db/database.js'),
]);
const app = createApp();
let agency; let clientA; let clientB; let projectId; let subprojectId; let attachmentId;

describe('Workyuk API end-to-end', () => {
  beforeAll(async () => {
    await migrateDb();
    await migrateDb();
    const stamp = new Date().toISOString();
    await database.run(`INSERT INTO users(username,normalized_username,display_name,password_hash,role,is_active,must_change_password,created_at,updated_at)
      VALUES(?,?,?,?, 'agency',1,0,?,?)`, ['Studio', 'studio', 'Studio Workyuk', await bcrypt.hash('Studio-Password-12!', 4), stamp, stamp]);
    agency = request.agent(app);
    const login = await agency.post('/api/auth/agency/login').send({ username: ' studio ', password: 'Studio-Password-12!' }).expect(200);
    expect(login.body.data.user.role).toBe('agency');
  });
  afterAll(async () => {
    await new Promise((resolve) => database.db.close(resolve));
    await fs.rm(testHome, { recursive: true, force: true });
  });

  it('separates login roles, provisions clients securely, and forces initial password change', async () => {
    await request(app).post('/api/auth/client/login').send({ username: 'studio', password: 'Studio-Password-12!' }).expect(401);
    await request(app).post('/api/auth/agency/login').send({ username: 'missing', password: 'wrong' }).expect(401);
    const created = await agency.post('/api/agency/clients').send({
      username: ' Client A ', displayName: 'Client A', companyName: 'A Studio', initialPassword: 'Temporary-Password-123!',
    }).expect(201);
    clientA = request.agent(app);
    await agency.post('/api/agency/clients').send({
      username: 'client a', displayName: 'Duplicate', initialPassword: 'Temporary-Password-123!',
    }).expect(409);
    const user = await database.get('SELECT password_hash,must_change_password FROM users WHERE id=?', [created.body.data.userId]);
    expect(user.password_hash).not.toBe('Temporary-Password-123!');
    expect(user.must_change_password).toBe(1);
    await clientA.post('/api/auth/client/login').send({ username: 'CLIENT A', password: 'Temporary-Password-123!' }).expect(200);
    const me = await clientA.get('/api/auth/me').expect(200);
    expect(me.body.data.user.mustChangePassword).toBe(true);
    await clientA.get('/api/dashboard/client').expect(403);
    await clientA.post('/api/auth/change-password').send({ currentPassword: 'Temporary-Password-123!', newPassword: 'Client-A-Secure-Password!' }).expect(200);
    await clientA.get('/api/auth/me').expect(401);
    await clientA.post('/api/auth/client/login').send({ username: 'client a', password: 'Client-A-Secure-Password!' }).expect(200);

    const createdB = await agency.post('/api/agency/clients').send({ username: 'client-b', displayName: 'Client B', initialPassword: 'Temporary-Password-456!' }).expect(201);
    clientB = request.agent(app);
    await clientB.post('/api/auth/client/login').send({ username: 'client-b', password: 'Temporary-Password-456!' }).expect(200);
    await clientB.post('/api/auth/change-password').send({ currentPassword: 'Temporary-Password-456!', newPassword: 'Client-B-Secure-Password!' }).expect(200);
    await clientB.post('/api/auth/client/login').send({ username: 'client-b', password: 'Client-B-Secure-Password!' }).expect(200);
    expect(createdB.body.data.id).not.toBe(created.body.data.id);
  });

  it('runs project, deliverable, comments, attachment, revision and approval with cross-client isolation', async () => {
    const client = await agency.get('/api/agency/clients').expect(200);
    const owner = client.body.data.find((row) => normalizeUsername(row.username) === 'client a');
    await agency.post('/api/projects').send({ clientId: owner.id, name: 'Bad date', startDate: '2026-11-02', dueDate: '2026-11-01' }).expect(400);
    const created = await agency.post('/api/projects').send({
      clientId: owner.id, name: 'Brand refresh', description: 'Visual identity', status: 'In Progress', priority: 'High',
      startDate: '2026-10-01', dueDate: '2026-11-01', notesInternal: 'agency secret note', notesClient: 'Mohon cek warna utama.',
    }).expect(201);
    projectId = created.body.data.id;
    await agency.patch(`/api/projects/${projectId}`).send({ clientId: owner.id, dueDate: '2026-11-05' }).expect(200);
    const sub = await agency.post(`/api/projects/${projectId}/subprojects`).send({
      title: 'Arah visual', description: 'Konsep awal', status: 'In Review', dueDate: '2026-10-28',
      notesInternal: 'internal design note', notesClient: 'Tinjau pilihan warna berikut.', assignee: 'Agency only', sortOrder: 0,
    }).expect(201);
    subprojectId = sub.body.data.id;
    await clientA.post(`/api/projects/${projectId}/comments`).send({ body: 'Wrong deliverable target', subprojectId: 999999 }).expect(400);
    const clientProject = await clientA.get(`/api/projects/${projectId}`).expect(200);
    expect(clientProject.body.data.notesClient).toBe('Mohon cek warna utama.');
    expect(clientProject.body.data).not.toHaveProperty('client_id');
    expect(clientProject.body.data).not.toHaveProperty('clientId');
    expect(clientProject.body.data).not.toHaveProperty('priority');
    expect(clientProject.body.data).not.toHaveProperty('notes_internal');
    expect(clientProject.body.data.subprojects[0]).not.toHaveProperty('assignee');
    expect(clientProject.body.data.subprojects[0]).not.toHaveProperty('project_id');
    expect(JSON.stringify(clientProject.body.data)).not.toContain('agency secret note');
    expect(JSON.stringify(clientProject.body.data)).not.toContain('internal design note');
    const badMutation = await clientA.patch(`/api/projects/${projectId}`).send({ dueDate: '2027-01-01', notesInternal: 'leak' });
    expect([403,404]).toContain(badMutation.status);
    await clientA.post(`/api/projects/${projectId}/comments`).set('Origin', 'http://127.0.0.1:5173')
      .send({ body: 'Warna biru terasa pas.', subprojectId }).expect(201);
    await agency.post(`/api/projects/${projectId}/comments`).send({ body: 'Terima kasih, kami lanjutkan.', subprojectId }).expect(201);
    const comments = await clientA.get(`/api/projects/${projectId}/comments?subproject_id=${subprojectId}`).expect(200);
    expect(comments.body.data).toHaveLength(2);
    expect(comments.body.data[0].author.role).toBe('client');
    await clientA.post(`/api/projects/${projectId}/attachments/link`).send({ title: 'Moodboard klien', url: 'https://example.com/moodboard' }).expect(201);
    const clientUpload = await clientA.post(`/api/projects/${projectId}/attachments/file`).field('subprojectId', String(subprojectId))
      .attach('file', Buffer.from('feedback from client'), { filename: 'feedback.txt', contentType: 'text/plain' }).expect(201);
    await clientA.get(clientUpload.body.data.downloadUrl).expect(200);
    await agency.post(`/api/projects/${projectId}/attachments/link`).send({ title: 'Referensi agency', url: 'https://example.com/agency-reference', subprojectId }).expect(201);
    const file = await agency.post(`/api/projects/${projectId}/attachments/file`).attach('file', Buffer.from('%PDF-1.4\nWorkyuk design'), { filename: 'arah.pdf', contentType: 'application/pdf' }).expect(201);
    attachmentId = file.body.data.id;
    await clientA.get(file.body.data.downloadUrl).expect(200);
    const projectAttachments = await clientA.get(`/api/projects/${projectId}/attachments`).expect(200);
    const deliverableAttachments = await clientA.get(`/api/projects/${projectId}/attachments?subproject_id=${subprojectId}`).expect(200);
    expect(projectAttachments.body.data).toHaveLength(2);
    expect(projectAttachments.body.data.every((item) => item.subprojectId === null)).toBe(true);
    expect(deliverableAttachments.body.data).toHaveLength(2);
    expect(deliverableAttachments.body.data.every((item) => item.subprojectId === subprojectId)).toBe(true);
    await clientA.post(`/api/projects/${projectId}/attachments/file`).attach('file', Buffer.from('MZ executable'), { filename: 'bad.exe', contentType: 'application/octet-stream' }).expect(415);
    await clientA.post(`/api/projects/${projectId}/attachments/file`).attach('file', Buffer.from('MZ executable'), { filename: 'spoof.pdf', contentType: 'application/pdf' }).expect(415);
    await clientA.post(`/api/projects/${projectId}/attachments/file`).attach('file', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1024 * 1024 + 2)]), { filename: 'large.pdf', contentType: 'application/pdf' }).expect(413);
    await clientA.post(`/api/projects/${projectId}/comments`).set('Origin','https://attacker.invalid').send({ body: 'cross-site post' }).expect(403);

    await clientA.post(`/api/subprojects/${subprojectId}/review`).send({ action: 'revision' }).expect(400);
    await clientA.post(`/api/subprojects/${subprojectId}/review`).send({ action: 'revision', comment: 'Ubah palet agar lebih hangat.' }).expect(200);
    let state = await agency.get(`/api/projects/${projectId}`).expect(200);
    expect(state.body.data.subprojects[0].status).toBe('Needs Revision');
    await agency.patch(`/api/subprojects/${subprojectId}`).send({ status: 'In Review' }).expect(200);
    await clientA.post(`/api/subprojects/${subprojectId}/review`).send({ action: 'approve', comment: 'Sudah sesuai.' }).expect(200);
    state = await agency.get(`/api/projects/${projectId}`).expect(200);
    expect(state.body.data.subprojects[0].status).toBe('Approved');
    const history = await clientA.get(`/api/projects/${projectId}/history`).expect(200);
    expect(history.body.data.map((row) => row.newStatus)).toContain('Needs Revision');
    const activity = await clientA.get(`/api/projects/${projectId}/activity`).expect(200);
    expect(activity.body.data.some((row) => row.action === 'client_approved')).toBe(true);
    expect(JSON.stringify(activity.body.data)).not.toContain('agency secret note');
    const clientDetail = await agency.get(`/api/agency/clients/${owner.id}`).expect(200);
    expect(clientDetail.body.data.recentActivity.length).toBeGreaterThan(0);

    const removable = await agency.post(`/api/projects/${projectId}/subprojects`).send({ title: 'Temporary deliverable' }).expect(201);
    const removableId = removable.body.data.id;
    await agency.post(`/api/projects/${projectId}/attachments/file`).field('subprojectId', String(removableId))
      .attach('file', Buffer.from('temporary file'), { filename: 'temporary.txt', contentType: 'text/plain' }).expect(201);
    const stored = await database.get('SELECT storage_filename FROM attachments WHERE subproject_id=?', [removableId]);
    const storedPath = path.join(process.env.UPLOAD_DIR, stored.storage_filename);
    await agency.delete(`/api/subprojects/${removableId}`).expect(200);
    expect(await database.get('SELECT id FROM attachments WHERE subproject_id=?', [removableId])).toBeUndefined();
    await expect(fs.access(storedPath)).rejects.toThrow();

    await clientB.get(`/api/projects/${projectId}`).expect(404);
    await clientB.get(`/api/projects/${projectId}/comments`).expect(404);
    await clientB.get(`/api/projects/${projectId}/attachments`).expect(404);
    await clientB.get(`/api/projects/${projectId}/activity`).expect(404);
    await clientB.get(`/api/attachments/${attachmentId}/download`).expect(404);
    await clientB.post(`/api/subprojects/${subprojectId}/review`).send({ action: 'approve' }).expect(404);
    await agency.post(`/api/projects/${projectId}/archive`).expect(200);
    await clientA.get(`/api/projects/${projectId}`).expect(404);
    expect((await agency.get('/api/projects').expect(200)).body.data.some((p) => p.id === projectId)).toBe(false);
    expect((await agency.get('/api/projects?archived=true').expect(200)).body.data.some((p) => p.id === projectId)).toBe(true);
  });

  it('invalidates inactive and reset client sessions', async () => {
    const clients = await agency.get('/api/agency/clients').expect(200);
    const row = clients.body.data.find((client) => client.username === 'client-b');
    await agency.patch(`/api/agency/clients/${row.id}`).send({ isActive: false }).expect(200);
    await clientB.get('/api/auth/me').expect(401);
    await clientB.post('/api/auth/client/login').send({ username: 'client-b', password: 'Client-B-Secure-Password!' }).expect(401);
    await agency.patch(`/api/agency/clients/${row.id}`).send({ isActive: true }).expect(200);
    await agency.post(`/api/agency/clients/${row.id}/reset-password`).send({ password: 'Reset-ClientB-Password!' }).expect(200);
    await clientB.post('/api/auth/client/login').send({ username: 'client-b', password: 'Client-B-Secure-Password!' }).expect(401);
    const reset = await clientB.post('/api/auth/client/login').send({ username: 'client-b', password: 'Reset-ClientB-Password!' }).expect(200);
    expect(reset.body.data.user.mustChangePassword).toBe(true);
    await agency.post('/api/auth/logout').expect(200);
    await agency.get('/api/auth/me').expect(401);
  });
});

describe('small shared rules', () => {
  it('normalizes case and whitespace in usernames', () => {
    expect(normalizeUsername('  CLIENT A  ')).toBe('client a');
  });
});
