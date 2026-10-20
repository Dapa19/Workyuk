import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { all, get, run, transaction } from './db/database.js';
import { allowedClientOrigins, asyncRoute, checkSameOrigin, clearSessionCookie, createSession, destroySession, requireAuth, requirePasswordReady, requireRole } from './middleware.js';
import { normalizeUsername, now, safeUser, writeActivity } from './utils.js';
import { fileStorage } from './services/storage.js';

const subprojectStatuses = ['Not Started', 'In Progress', 'In Review', 'Needs Revision', 'Approved', 'Completed', 'On Hold'];
const projectStatuses = ['Planning', 'In Progress', 'In Review', 'On Hold', 'Completed'];
const priorities = ['Low', 'Normal', 'High', 'Urgent'];
const uploadDir = fileStorage.directory;
const maxUploadBytes = Math.max(1, Number(process.env.MAX_UPLOAD_MB) || 25) * 1024 * 1024;

const schemas = {
  login: z.object({ username: z.string().trim().min(1).max(60), password: z.string().min(1).max(200) }),
  password: z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(12).max(128) }),
  client: z.object({ username: z.string().trim().min(3).max(40), displayName: z.string().trim().min(1).max(100),
    companyName: z.string().trim().max(120).optional().default(''), notesInternal: z.string().max(5000).optional().default(''),
    initialPassword: z.string().min(12).max(128) }),
  clientPatch: z.object({ username: z.string().trim().min(3).max(40).optional(), displayName: z.string().trim().min(1).max(100).optional(),
    companyName: z.string().trim().max(120).optional(), notesInternal: z.string().max(5000).optional(), isActive: z.boolean().optional() }).strict().refine((v) => Object.keys(v).length > 0),
  project: z.object({ clientId: z.coerce.number().int().positive(), name: z.string().trim().min(1).max(160),
    description: z.string().max(10000).optional().default(''), status: z.enum(projectStatuses).optional().default('In Progress'),
    priority: z.enum(priorities).optional().default('Normal'), startDate: z.string().date().nullable().optional(), dueDate: z.string().date().nullable().optional(),
    notesInternal: z.string().max(10000).optional().default(''), notesClient: z.string().max(10000).optional().default('') })
    .refine((v) => !v.startDate || !v.dueDate || v.dueDate >= v.startDate, { path: ['dueDate'], message: 'Tenggat tidak boleh sebelum tanggal mulai.' }),
  projectPatch: z.object({ clientId: z.coerce.number().int().positive().optional(), name: z.string().trim().min(1).max(160).optional(), description: z.string().max(10000).optional(),
    status: z.enum(projectStatuses).optional(), priority: z.enum(priorities).optional(), startDate: z.string().date().nullable().optional(),
    dueDate: z.string().date().nullable().optional(), notesInternal: z.string().max(10000).optional(), notesClient: z.string().max(10000).optional() }).strict()
    .refine((v) => Object.keys(v).length > 0).refine((v) => !v.startDate || !v.dueDate || v.dueDate >= v.startDate, { path: ['dueDate'], message: 'Tenggat tidak boleh sebelum tanggal mulai.' }),
  subproject: z.object({ title: z.string().trim().min(1).max(160), description: z.string().max(10000).optional().default(''),
    status: z.enum(subprojectStatuses).optional().default('Not Started'), assignee: z.string().trim().max(100).nullable().optional(),
    dueDate: z.string().date().nullable().optional(), notesInternal: z.string().max(10000).optional().default(''),
    notesClient: z.string().max(10000).optional().default(''), sortOrder: z.coerce.number().int().min(0).optional().default(0) }),
  subprojectPatch: z.object({ title: z.string().trim().min(1).max(160).optional(), description: z.string().max(10000).optional(),
    status: z.enum(subprojectStatuses).optional(), assignee: z.string().trim().max(100).nullable().optional(), dueDate: z.string().date().nullable().optional(),
    notesInternal: z.string().max(10000).optional(), notesClient: z.string().max(10000).optional(), sortOrder: z.coerce.number().int().min(0).optional() })
    .strict().refine((v) => Object.keys(v).length > 0),
  comment: z.object({ body: z.string().trim().min(1).max(5000), subprojectId: z.coerce.number().int().positive().nullable().optional() }),
  link: z.object({ title: z.string().trim().min(1).max(160), url: z.string().max(2048).url().refine((v) => ['http:', 'https:'].includes(new URL(v).protocol)),
    subprojectId: z.coerce.number().int().positive().nullable().optional() }),
  review: z.object({ action: z.enum(['approve', 'revision']), comment: z.string().trim().max(5000).optional().default('') }).refine((v) => v.action !== 'revision' || v.comment.length > 0,
    { path: ['comment'], message: 'Komentar wajib diisi saat meminta revisi.' }),
};

function parse(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const error = new Error('Periksa kembali data yang diisi.');
    error.status = 400;
    error.code = 'VALIDATION_ERROR';
    error.fields = result.error.flatten().fieldErrors;
    throw error;
  }
  return result.data;
}

function projectForRole(row, role) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, description: row.description, status: row.status,
    priority: role === 'agency' ? row.priority : undefined,
    clientId: role === 'agency' ? row.client_id : undefined,
    notesInternal: role === 'agency' ? row.notes_internal : undefined,
    notesClient: row.notes_client, dueDate: row.due_date, startDate: row.start_date,
    createdAt: row.created_at, updatedAt: row.updated_at,
    isArchived: role === 'agency' ? Boolean(row.is_archived) : undefined,
  };
}
function subprojectForRole(row, role) {
  return {
    id: row.id, title: row.title, description: row.description, status: row.status,
    assignee: role === 'agency' ? row.assignee : undefined,
    dueDate: row.due_date, notesInternal: role === 'agency' ? row.notes_internal : undefined,
    notesClient: row.notes_client, sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function bad(status, code, message) { const error = new Error(message); error.status = status; error.code = code; return error; }
async function accessibleProject(id, user) {
  const row = await get('SELECT * FROM projects WHERE id = ? AND is_archived = 0', [id]);
  if (!row || (user.role === 'client' && Number(row.client_id) !== Number(user.clientId))) throw bad(404, 'NOT_FOUND', 'Project tidak ditemukan.');
  return row;
}
async function accessibleSubproject(id, user) {
  const row = await get(`SELECT s.*, p.client_id FROM subprojects s JOIN projects p ON p.id=s.project_id
    WHERE s.id=? AND p.is_archived=0`, [id]);
  if (!row || (user.role === 'client' && Number(row.client_id) !== Number(user.clientId))) throw bad(404, 'NOT_FOUND', 'Deliverable tidak ditemukan.');
  return row;
}
async function checkTarget(projectId, subprojectId) {
  if (subprojectId == null) return;
  const sub = await get('SELECT id FROM subprojects WHERE id=? AND project_id=?', [subprojectId, projectId]);
  if (!sub) throw bad(400, 'INVALID_TARGET', 'Deliverable tidak termasuk dalam project ini.');
}
function actorName(row) { return { id: row.author_user_id ?? row.uploader_user_id, displayName: row.display_name, role: row.role }; }
const toId = (req) => Number.parseInt(req.params.id, 10);

const storage = multer.diskStorage({
  destination: async (_req, _file, callback) => { try { await fs.mkdir(uploadDir, { recursive: true }); callback(null, uploadDir); } catch (e) { callback(e); } },
  filename: (_req, file, callback) => callback(null, fileStorage.storedName(file.originalname)),
});
const upload = multer({ storage, limits: { fileSize: maxUploadBytes, files: 1, fields: 10, fieldSize: 64 * 1024 }, fileFilter: (_req, file, callback) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const accepted = { '.pdf': ['application/pdf'], '.png': ['image/png'], '.jpg': ['image/jpeg'], '.jpeg': ['image/jpeg'], '.txt': ['text/plain'] };
  if (!accepted[ext]?.includes(file.mimetype)) return callback(bad(415, 'UNSUPPORTED_FILE', 'Jenis file tidak didukung. Gunakan PDF, PNG, JPG, atau TXT.'));
  callback(null, true);
} });

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(cors({ origin: [...allowedClientOrigins], credentials: true, methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', checkSameOrigin);
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: { code: 'LOGIN_RATE_LIMIT', message: 'Terlalu banyak percobaan. Coba lagi beberapa saat.' } } });
  const api = express.Router();

  api.get('/health', (_req, res) => res.json({ data: { status: 'ok' } }));
  api.post('/auth/agency/login', loginLimiter, asyncRoute(async (req, res) => login(req, res, 'agency')));
  api.post('/auth/client/login', loginLimiter, asyncRoute(async (req, res) => login(req, res, 'client')));
  api.post('/auth/logout', requireAuth, asyncRoute(async (req, res) => {
    await writeActivity({ run }, { actorId: req.user.id, entityType: 'user', entityId: req.user.id, action: 'logout', summary: 'Keluar dari Workyuk' });
    await destroySession(req, res); res.json({ data: { message: 'Anda telah keluar.' } });
  }));
  api.get('/auth/me', requireAuth, (req, res) => res.json({ data: { user: req.user } }));
  api.post('/auth/change-password', requireAuth, asyncRoute(async (req, res) => {
    const input = parse(schemas.password, req.body);
    const row = await get('SELECT password_hash FROM users WHERE id=?', [req.user.id]);
    if (!await bcrypt.compare(input.currentPassword, row.password_hash)) throw bad(400, 'INVALID_PASSWORD', 'Password saat ini tidak sesuai.');
    if (input.currentPassword === input.newPassword) throw bad(400, 'SAME_PASSWORD', 'Gunakan password baru yang berbeda.');
    const stamp = now();
    await transaction(async (q) => {
      await q.run('UPDATE users SET password_hash=?, must_change_password=0, updated_at=? WHERE id=?', [await bcrypt.hash(input.newPassword, 12), stamp, req.user.id]);
      await q.run('DELETE FROM sessions WHERE user_id=?', [req.user.id]);
      await writeActivity(q, { actorId: req.user.id, entityType: 'user', entityId: req.user.id, action: 'password_changed', summary: 'Password diperbarui' });
    });
    clearSessionCookie(res);
    res.json({ data: { message: 'Password berhasil diperbarui. Silakan masuk kembali.' } });
  }));

  const ready = [requireAuth, requirePasswordReady];
  api.get('/dashboard/agency', ...ready, requireRole('agency'), asyncRoute(async (_req, res) => {
    const counts = await get(`SELECT
      (SELECT COUNT(*) FROM clients c JOIN users u ON u.id=c.user_id WHERE u.is_active=1) active_clients,
      (SELECT COUNT(*) FROM projects WHERE is_archived=0) total_projects,
      (SELECT COUNT(*) FROM projects WHERE is_archived=0 AND status='In Progress') ongoing_projects,
      (SELECT COUNT(*) FROM subprojects s JOIN projects p ON p.id=s.project_id WHERE p.is_archived=0 AND s.status='In Review') waiting_feedback,
      (SELECT COUNT(*) FROM subprojects s JOIN projects p ON p.id=s.project_id WHERE p.is_archived=0 AND s.due_date < date('now') AND s.status NOT IN ('Approved','Completed')) overdue_items`);
    const activity = await activityRows('WHERE a.project_id IS NOT NULL', [] , 8);
    res.json({ data: { ...counts, recentActivity: activity } });
  }));
  api.get('/dashboard/client', ...ready, requireRole('client'), asyncRoute(async (req, res) => {
    const projects = await all('SELECT * FROM projects WHERE client_id=? AND is_archived=0 ORDER BY due_date IS NULL, due_date LIMIT 100', [req.user.clientId]);
    const review = await all(`SELECT s.id, s.title, s.status, s.due_date, p.id project_id, p.name project_name
      FROM subprojects s JOIN projects p ON p.id=s.project_id WHERE p.client_id=? AND p.is_archived=0 AND s.status='In Review' ORDER BY s.due_date LIMIT 20`, [req.user.clientId]);
    const activity = await activityRows('WHERE a.project_id IN (SELECT id FROM projects WHERE client_id=?)', [req.user.clientId], 8);
    res.json({ data: { projects: projects.map((p) => projectForRole(p, 'client')), reviewItems: review, recentActivity: activity } });
  }));

  api.get('/agency/clients', ...ready, requireRole('agency'), asyncRoute(async (_req, res) => {
    const rows = await all(`SELECT c.id client_id, c.company_name, c.created_at, u.id user_id, u.username, u.display_name, u.is_active,
      COUNT(DISTINCT p.id) project_count FROM clients c JOIN users u ON u.id=c.user_id
      LEFT JOIN projects p ON p.client_id=c.id AND p.is_archived=0 GROUP BY c.id ORDER BY u.display_name COLLATE NOCASE`);
    res.json({ data: rows.map(mapClient) });
  }));
  api.post('/agency/clients', ...ready, requireRole('agency'), asyncRoute(async (req, res) => {
    const input = parse(schemas.client, req.body);
    const normalized = normalizeUsername(input.username);
    const conflict = await get('SELECT id FROM users WHERE normalized_username=?', [normalized]);
    if (conflict) throw bad(409, 'USERNAME_TAKEN', 'Username sudah digunakan.');
    const stamp = now();
    const passwordHash = await bcrypt.hash(input.initialPassword, 12);
    const created = await transaction(async (q) => {
      const user = await q.run(`INSERT INTO users(username,normalized_username,display_name,password_hash,role,is_active,must_change_password,created_at,updated_at)
        VALUES(?,?,?,?,'client',1,1,?,?)`, [input.username.trim(), normalized, input.displayName.trim(), passwordHash, stamp, stamp]);
      const client = await q.run('INSERT INTO clients(user_id,company_name,notes_internal,created_at,updated_at) VALUES(?,?,?,?,?)',
        [user.id, input.companyName || null, input.notesInternal, stamp, stamp]);
      await writeActivity(q, { actorId: req.user.id, entityType: 'client', entityId: client.id, action: 'client_created', summary: `Akun klien ${input.displayName} dibuat` });
      return { clientId: client.id, userId: user.id };
    });
    res.status(201).json({ data: { id: created.clientId, userId: created.userId, username: input.username.trim(), displayName: input.displayName, companyName: input.companyName, isActive: true, projectCount: 0 } });
  }));
  api.get('/agency/clients/:id', ...ready, requireRole('agency'), asyncRoute(async (req, res) => {
    const row = await get(`SELECT c.*, u.username,u.display_name,u.is_active,u.id user_id FROM clients c JOIN users u ON u.id=c.user_id WHERE c.id=?`, [toId(req)]);
    if (!row) throw bad(404, 'NOT_FOUND', 'Klien tidak ditemukan.');
    const projects = await all('SELECT * FROM projects WHERE client_id=? ORDER BY is_archived,updated_at DESC', [row.id]);
    const recentActivity = await activityRows('WHERE a.project_id IN (SELECT id FROM projects WHERE client_id=?)', [row.id], 8);
    res.json({ data: { ...mapClient(row), notesInternal: row.notes_internal, projects: projects.map((p) => projectForRole(p, 'agency')), recentActivity } });
  }));
  api.patch('/agency/clients/:id', ...ready, requireRole('agency'), asyncRoute(async (req, res) => {
    const input = parse(schemas.clientPatch, req.body);
    const row = await get('SELECT c.id,c.user_id,u.username,u.display_name,u.is_active FROM clients c JOIN users u ON u.id=c.user_id WHERE c.id=?', [toId(req)]);
    if (!row) throw bad(404, 'NOT_FOUND', 'Klien tidak ditemukan.');
    if (input.username && normalizeUsername(input.username) !== normalizeUsername(row.username)) {
      const conflict = await get('SELECT id FROM users WHERE normalized_username=? AND id<>?', [normalizeUsername(input.username), row.user_id]);
      if (conflict) throw bad(409, 'USERNAME_TAKEN', 'Username sudah digunakan.');
    }
    const stamp = now();
    await transaction(async (q) => {
      const assignments = []; const values = [];
      for (const [field, column] of [['username','username'],['displayName','display_name'],['isActive','is_active']]) {
        if (input[field] !== undefined) { assignments.push(`${column}=?`); values.push(field === 'isActive' ? Number(input[field]) : input[field].trim()); }
      }
      if (input.username !== undefined) { assignments.push('normalized_username=?'); values.push(normalizeUsername(input.username)); }
      if (assignments.length) { assignments.push('updated_at=?'); values.push(stamp, row.user_id); await q.run(`UPDATE users SET ${assignments.join(',')} WHERE id=?`, values); }
      const clientFields = []; const clientValues = [];
      if (input.companyName !== undefined) { clientFields.push('company_name=?'); clientValues.push(input.companyName || null); }
      if (input.notesInternal !== undefined) { clientFields.push('notes_internal=?'); clientValues.push(input.notesInternal); }
      if (clientFields.length) { clientFields.push('updated_at=?'); clientValues.push(stamp, row.id); await q.run(`UPDATE clients SET ${clientFields.join(',')} WHERE id=?`, clientValues); }
      if (input.isActive === false) await q.run('DELETE FROM sessions WHERE user_id=?', [row.user_id]);
      await writeActivity(q, { actorId: req.user.id, entityType: 'client', entityId: row.id, action: 'client_updated', summary: `Akun klien ${row.display_name} diperbarui` });
    });
    res.json({ data: { id: row.id, username: input.username || row.username, displayName: input.displayName || row.display_name, isActive: input.isActive ?? Boolean(row.is_active) } });
  }));
  api.post('/agency/clients/:id/reset-password', ...ready, requireRole('agency'), asyncRoute(async (req, res) => {
    const password = z.object({ password: z.string().min(12).max(128) }).parse(req.body).password;
    const client = await get('SELECT user_id FROM clients WHERE id=?', [toId(req)]);
    if (!client) throw bad(404, 'NOT_FOUND', 'Klien tidak ditemukan.');
    await transaction(async (q) => {
      await q.run('UPDATE users SET password_hash=?,must_change_password=1,updated_at=? WHERE id=?', [await bcrypt.hash(password, 12), now(), client.user_id]);
      await q.run('DELETE FROM sessions WHERE user_id=?', [client.user_id]);
      await writeActivity(q, { actorId: req.user.id, entityType: 'client', entityId: toId(req), action: 'password_reset', summary: 'Password awal klien diatur ulang' });
    });
    res.json({ data: { message: 'Password awal berhasil diatur ulang.' } });
  }));

  api.get('/projects', ...ready, asyncRoute(async (req, res) => {
    const archived = req.user.role === 'agency' && req.query.archived === 'true';
    const rows = req.user.role === 'agency'
      ? await all(`SELECT p.*, c.id owner_client_id, u.display_name client_name FROM projects p JOIN clients c ON c.id=p.client_id JOIN users u ON u.id=c.user_id WHERE p.is_archived=? ORDER BY p.updated_at DESC`, [Number(archived)])
      : await all('SELECT * FROM projects WHERE client_id=? AND is_archived=0 ORDER BY updated_at DESC', [req.user.clientId]);
    res.json({ data: rows.map((r) => ({ ...projectForRole(r, req.user.role), clientName: r.client_name, clientId: req.user.role === 'agency' ? r.client_id : undefined })) });
  }));
  api.post('/projects', ...ready, requireRole('agency'), asyncRoute(async (req, res) => {
    const input = parse(schemas.project, req.body);
    const client = await get('SELECT id FROM clients WHERE id=?', [input.clientId]);
    if (!client) throw bad(400, 'INVALID_CLIENT', 'Pilih klien yang tersedia.');
    const stamp = now();
    const project = await transaction(async (q) => {
      const inserted = await q.run(`INSERT INTO projects(client_id,name,description,status,priority,start_date,due_date,notes_internal,notes_client,is_archived,created_at,updated_at,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,0,?,?,?)`, [input.clientId,input.name,input.description,input.status,input.priority,input.startDate ?? null,input.dueDate ?? null,input.notesInternal,input.notesClient,stamp,stamp,req.user.id]);
      await q.run('INSERT INTO status_history(project_id,changed_by,old_status,new_status,created_at) VALUES(?,?,?,?,?)', [inserted.id, req.user.id, '', input.status, stamp]);
      await writeActivity(q, { projectId: inserted.id, actorId: req.user.id, entityType: 'project', entityId: inserted.id, action: 'project_created', summary: `Project “${input.name}” dibuat` });
      return q.get('SELECT * FROM projects WHERE id=?', [inserted.id]);
    });
    res.status(201).json({ data: projectForRole(project, 'agency') });
  }));
  api.get('/projects/:id', ...ready, asyncRoute(async (req, res) => {
    const project = await accessibleProject(toId(req), req.user);
    const [client, rows] = await Promise.all([
      req.user.role === 'agency' ? get('SELECT u.display_name FROM clients c JOIN users u ON u.id=c.user_id WHERE c.id=?', [project.client_id]) : null,
      all('SELECT * FROM subprojects WHERE project_id=? ORDER BY sort_order,id', [project.id]),
    ]);
    res.json({ data: { ...projectForRole(project, req.user.role), clientName: client?.display_name,
      subprojects: rows.map((s) => subprojectForRole(s, req.user.role)) } });
  }));
  api.patch('/projects/:id', ...ready, requireRole('agency'), asyncRoute(async (req, res) => {
    const project = await accessibleProject(toId(req), req.user);
    const input = parse(schemas.projectPatch, req.body);
    const nextStart = input.startDate === undefined ? project.start_date : input.startDate;
    const nextDue = input.dueDate === undefined ? project.due_date : input.dueDate;
    if (nextStart && nextDue && nextDue < nextStart) throw bad(400,'VALIDATION_ERROR','Tenggat tidak boleh sebelum tanggal mulai.');
    if (input.clientId !== undefined && !await get('SELECT id FROM clients WHERE id=?',[input.clientId])) throw bad(400,'INVALID_CLIENT','Pilih klien yang tersedia.');
    const map = { clientId:'client_id',name:'name',description:'description',status:'status',priority:'priority',startDate:'start_date',dueDate:'due_date',notesInternal:'notes_internal',notesClient:'notes_client' };
    const fields = Object.entries(input); const values = fields.map(([key,value]) => value ?? null);
    const stamp = now();
    const updated = await transaction(async (q) => {
      await q.run(`UPDATE projects SET ${fields.map(([key]) => `${map[key]}=?`).join(',')},updated_at=? WHERE id=?`, [...values,stamp,project.id]);
      if (input.status && input.status !== project.status) await q.run('INSERT INTO status_history(project_id,changed_by,old_status,new_status,created_at) VALUES(?,?,?,?,?)', [project.id, req.user.id, project.status, input.status, stamp]);
      if (input.dueDate !== undefined) await writeActivity(q, { projectId: project.id, actorId: req.user.id, entityType: 'project', entityId: project.id, action: 'due_date_changed', summary: 'Tanggal project diperbarui' });
      if (input.clientId !== undefined && input.clientId !== project.client_id) await writeActivity(q, { projectId: project.id, actorId: req.user.id, entityType: 'project', entityId: project.id, action: 'project_owner_changed', summary: 'Pemilik project diperbarui' });
      const clientVisibleChange = ['name','description','status','startDate','dueDate','notesClient'].some((key) => input[key] !== undefined);
      if (clientVisibleChange) await writeActivity(q, { projectId: project.id, actorId: req.user.id, entityType: 'project', entityId: project.id, action: 'project_updated', summary: `Project “${input.name || project.name}” diperbarui` });
      return q.get('SELECT * FROM projects WHERE id=?', [project.id]);
    });
    res.json({ data: projectForRole(updated,'agency') });
  }));
  api.post('/projects/:id/archive', ...ready, requireRole('agency'), asyncRoute(async (req, res) => {
    const project = await accessibleProject(toId(req), req.user);
    await transaction(async (q) => {
      await q.run('UPDATE projects SET is_archived=1,updated_at=? WHERE id=?', [now(),project.id]);
      await writeActivity(q, { projectId: project.id, actorId: req.user.id, entityType: 'project', entityId: project.id, action: 'project_archived', summary: `Project “${project.name}” diarsipkan` });
    });
    res.json({ data: { message: 'Project diarsipkan.' } });
  }));

  api.post('/projects/:id/subprojects', ...ready, requireRole('agency'), asyncRoute(async (req,res) => {
    const project=await accessibleProject(toId(req),req.user); const input=parse(schemas.subproject,req.body); const stamp=now();
    const row=await transaction(async(q)=>{
      const result=await q.run(`INSERT INTO subprojects(project_id,title,description,status,assignee,due_date,notes_internal,notes_client,sort_order,created_at,updated_at,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,[project.id,input.title,input.description,input.status,input.assignee ?? null,input.dueDate ?? null,input.notesInternal,input.notesClient,input.sortOrder,stamp,stamp,req.user.id]);
      await q.run('INSERT INTO status_history(project_id,subproject_id,changed_by,old_status,new_status,created_at) VALUES(?,?,?,?,?,?)',[project.id,result.id,req.user.id,'',input.status,stamp]);
      await writeActivity(q,{projectId:project.id,subprojectId:result.id,actorId:req.user.id,entityType:'subproject',entityId:result.id,action:'subproject_created',summary:`Deliverable “${input.title}” dibuat`});
      return q.get('SELECT * FROM subprojects WHERE id=?',[result.id]);
    }); res.status(201).json({data:subprojectForRole(row,'agency')});
  }));
  api.patch('/subprojects/:id', ...ready, requireRole('agency'), asyncRoute(async (req,res)=>{
    const sub=await accessibleSubproject(toId(req),req.user);const input=parse(schemas.subprojectPatch,req.body);const map={title:'title',description:'description',status:'status',assignee:'assignee',dueDate:'due_date',notesInternal:'notes_internal',notesClient:'notes_client',sortOrder:'sort_order'};const fields=Object.entries(input);const stamp=now();
    const row=await transaction(async(q)=>{
      await q.run(`UPDATE subprojects SET ${fields.map(([k])=>`${map[k]}=?`).join(',')},updated_at=? WHERE id=?`,[...fields.map(([,v])=>v??null),stamp,sub.id]);
      if(input.status&&input.status!==sub.status)await q.run('INSERT INTO status_history(project_id,subproject_id,changed_by,old_status,new_status,created_at) VALUES(?,?,?,?,?,?)',[sub.project_id,sub.id,req.user.id,sub.status,input.status,stamp]);
      const clientVisibleChange=['title','description','status','dueDate','notesClient','sortOrder'].some((key)=>input[key]!==undefined);
      if(clientVisibleChange)await writeActivity(q,{projectId:sub.project_id,subprojectId:sub.id,actorId:req.user.id,entityType:'subproject',entityId:sub.id,action:'subproject_updated',summary:`Deliverable “${input.title||sub.title}” diperbarui`});
      if(input.dueDate!==undefined)await writeActivity(q,{projectId:sub.project_id,subprojectId:sub.id,actorId:req.user.id,entityType:'subproject',entityId:sub.id,action:'due_date_changed',summary:`Tenggat “${sub.title}” diperbarui`});
      return q.get('SELECT * FROM subprojects WHERE id=?',[sub.id]);
    });res.json({data:subprojectForRole(row,'agency')});
  }));
  api.delete('/subprojects/:id', ...ready, requireRole('agency'), asyncRoute(async(req,res)=>{
    const sub=await accessibleSubproject(toId(req),req.user);const files=await all('SELECT storage_filename FROM attachments WHERE subproject_id=? AND storage_filename IS NOT NULL',[sub.id]);await transaction(async(q)=>{await q.run('DELETE FROM subprojects WHERE id=?',[sub.id]);await writeActivity(q,{projectId:sub.project_id,actorId:req.user.id,entityType:'subproject',entityId:sub.id,action:'subproject_deleted',summary:`Deliverable “${sub.title}” dihapus`});});await Promise.all(files.map((f)=>fileStorage.remove(f.storage_filename).catch((e)=>console.error('Could not remove stored attachment:',e.message))));res.json({data:{message:'Deliverable dihapus.'}});
  }));

  api.get('/projects/:id/comments', ...ready, asyncRoute(async(req,res)=>{
    const project=await accessibleProject(toId(req),req.user);const sid=req.query.subproject_id?Number(req.query.subproject_id):null;await checkTarget(project.id,sid);
    const rows=await all(`SELECT cm.*,u.display_name,u.role FROM comments cm JOIN users u ON u.id=cm.author_user_id WHERE cm.project_id=? AND ${sid===null?'cm.subproject_id IS NULL':'cm.subproject_id=?'} ORDER BY cm.created_at,cm.id`,sid===null?[project.id]:[project.id,sid]);
    res.json({data:rows.map((r)=>({id:r.id,projectId:r.project_id,subprojectId:r.subproject_id,body:r.body,createdAt:r.created_at,updatedAt:r.updated_at,author:actorName(r)}))});
  }));
  api.post('/projects/:id/comments', ...ready, asyncRoute(async(req,res)=>{
    const project=await accessibleProject(toId(req),req.user);const input=parse(schemas.comment,req.body);const sid=input.subprojectId??null;await checkTarget(project.id,sid);const stamp=now();
    const row=await transaction(async(q)=>{const inserted=await q.run('INSERT INTO comments(project_id,subproject_id,author_user_id,body,created_at,updated_at) VALUES(?,?,?,?,?,?)',[project.id,sid,req.user.id,input.body,stamp,stamp]);await writeActivity(q,{projectId:project.id,subprojectId:sid,actorId:req.user.id,entityType:'comment',entityId:inserted.id,action:'comment_added',summary:`${req.user.displayName} menambahkan komentar`});return q.get('SELECT cm.*,u.display_name,u.role FROM comments cm JOIN users u ON u.id=cm.author_user_id WHERE cm.id=?',[inserted.id]);});
    res.status(201).json({data:{id:row.id,projectId:row.project_id,subprojectId:row.subproject_id,body:row.body,createdAt:row.created_at,updatedAt:row.updated_at,author:actorName(row)}});
  }));
  api.get('/projects/:id/attachments', ...ready, asyncRoute(async(req,res)=>{
    const project=await accessibleProject(toId(req),req.user);
    const subprojectId=req.query.subproject_id===undefined?null:Number(req.query.subproject_id);
    if(subprojectId!==null){if(!Number.isInteger(subprojectId)||subprojectId<=0)throw bad(400,'INVALID_TARGET','Deliverable tidak valid.');await checkTarget(project.id,subprojectId);}
    const rows=await all(`SELECT a.*,u.display_name,u.role FROM attachments a JOIN users u ON u.id=a.uploader_user_id
      WHERE a.project_id=? AND ${subprojectId===null?'a.subproject_id IS NULL':'a.subproject_id=?'} ORDER BY a.created_at DESC`,
    subprojectId===null?[project.id]:[project.id,subprojectId]);
    res.json({data:rows.map(attachmentView)});
  }));
  api.post('/projects/:id/attachments/link', ...ready, asyncRoute(async(req,res)=>{
    const project=await accessibleProject(toId(req),req.user);const input=parse(schemas.link,req.body);const sid=input.subprojectId??null;await checkTarget(project.id,sid);const stamp=now();
    const row=await transaction(async(q)=>{const inserted=await q.run(`INSERT INTO attachments(project_id,subproject_id,type,title,url,uploader_user_id,created_at) VALUES(?,?,'link',?,?,?,?)`,[project.id,sid,input.title,input.url,req.user.id,stamp]);await writeActivity(q,{projectId:project.id,subprojectId:sid,actorId:req.user.id,entityType:'attachment',entityId:inserted.id,action:'attachment_added',summary:`Tautan “${input.title}” ditambahkan`});return q.get('SELECT a.*,u.display_name,u.role FROM attachments a JOIN users u ON u.id=a.uploader_user_id WHERE a.id=?',[inserted.id]);});res.status(201).json({data:attachmentView(row)});
  }));
  api.post('/projects/:id/attachments/file', ...ready, asyncRoute(async(req,_res,next)=>{await accessibleProject(toId(req),req.user);next();}), upload.single('file'), asyncRoute(async(req,res)=>{
    if(!req.file)throw bad(400,'FILE_REQUIRED','Pilih file untuk diunggah.');
    try {
      const project=await accessibleProject(toId(req),req.user);const sid=req.body.subprojectId?Number(req.body.subprojectId):null;await checkTarget(project.id,sid);
      if(!await fileStorage.verify(req.file))throw bad(415,'INVALID_FILE_CONTENT','Isi file tidak cocok dengan jenis yang didukung.');
      const originalName=path.basename(req.file.originalname.replaceAll('\\','/')).slice(0,255);const title=String(req.body.title||originalName).trim().slice(0,160)||originalName;const stamp=now();
      const row=await transaction(async(q)=>{const inserted=await q.run(`INSERT INTO attachments(project_id,subproject_id,type,title,original_filename,storage_filename,mime_type,size_bytes,uploader_user_id,created_at) VALUES(?,?,'file',?,?,?,?,?,?,?)`,[project.id,sid,title,originalName,req.file.filename,req.file.mimetype,req.file.size,req.user.id,stamp]);await writeActivity(q,{projectId:project.id,subprojectId:sid,actorId:req.user.id,entityType:'attachment',entityId:inserted.id,action:'attachment_added',summary:`File “${title}” diunggah`});return q.get('SELECT a.*,u.display_name,u.role FROM attachments a JOIN users u ON u.id=a.uploader_user_id WHERE a.id=?',[inserted.id]);});res.status(201).json({data:attachmentView(row)});
    } catch(error) { await fs.unlink(req.file.path).catch(()=>{});throw error; }
  }));
  api.get('/attachments/:id/download', ...ready, asyncRoute(async(req,res)=>{
    const row=await get('SELECT * FROM attachments WHERE id=? AND type=\'file\'',[toId(req)]);if(!row)throw bad(404,'NOT_FOUND','File tidak ditemukan.');await accessibleProject(row.project_id,req.user);
    const filepath=fileStorage.resolve(row.storage_filename);try{await fs.access(filepath);}catch{throw bad(404,'FILE_MISSING','File sudah tidak tersedia.');}
    res.download(filepath,row.original_filename,(err)=>{if(err&&!res.headersSent)res.status(500).json({error:{code:'DOWNLOAD_ERROR',message:'File tidak dapat diunduh.'}});});
  }));
  api.delete('/attachments/:id', ...ready, requireRole('agency'), asyncRoute(async(req,res)=>{
    const row=await get('SELECT * FROM attachments WHERE id=?',[toId(req)]);if(!row)throw bad(404,'NOT_FOUND','Lampiran tidak ditemukan.');await accessibleProject(row.project_id,req.user);
    await transaction(async(q)=>{await q.run('DELETE FROM attachments WHERE id=?',[row.id]);await writeActivity(q,{projectId:row.project_id,actorId:req.user.id,entityType:'attachment',entityId:row.id,action:'attachment_deleted',summary:`Lampiran “${row.title}” dihapus`});});
    if(row.storage_filename)await fileStorage.remove(row.storage_filename).catch((e)=>console.error('Could not remove stored attachment:',e.message));res.json({data:{message:'Lampiran dihapus.'}});
  }));
  api.post('/subprojects/:id/review', ...ready, requireRole('client'), asyncRoute(async(req,res)=>{
    const sub=await accessibleSubproject(toId(req),req.user);if(sub.status!=='In Review')throw bad(409,'NOT_IN_REVIEW','Deliverable tidak sedang menunggu review.');const input=parse(schemas.review,req.body);const newStatus=input.action==='approve'?'Approved':'Needs Revision';const stamp=now();
    await transaction(async(q)=>{await q.run('UPDATE subprojects SET status=?,updated_at=? WHERE id=?',[newStatus,stamp,sub.id]);await q.run('INSERT INTO status_history(project_id,subproject_id,changed_by,old_status,new_status,note,created_at) VALUES(?,?,?,?,?,?,?)',[sub.project_id,sub.id,req.user.id,sub.status,newStatus,input.comment||null,stamp]);await writeActivity(q,{projectId:sub.project_id,subprojectId:sub.id,actorId:req.user.id,entityType:'subproject',entityId:sub.id,action:input.action==='approve'?'client_approved':'client_requested_revision',summary:input.action==='approve'?`“${sub.title}” disetujui klien`:`Klien meminta revisi untuk “${sub.title}”`});if(input.comment)await q.run('INSERT INTO comments(project_id,subproject_id,author_user_id,body,created_at,updated_at) VALUES(?,?,?,?,?,?)',[sub.project_id,sub.id,req.user.id,input.comment,stamp,stamp]);});
    res.json({data:{id:sub.id,status:newStatus,message:input.action==='approve'?'Deliverable disetujui.':'Permintaan revisi dikirim.'}});
  }));
  api.get('/projects/:id/activity', ...ready, asyncRoute(async(req,res)=>{await accessibleProject(toId(req),req.user);res.json({data:await activityRows('WHERE a.project_id=?',[toId(req)],100)});}));
  api.get('/projects/:id/history', ...ready, asyncRoute(async(req,res)=>{await accessibleProject(toId(req),req.user);const rows=await all(`SELECT h.*,u.display_name,u.role FROM status_history h JOIN users u ON u.id=h.changed_by WHERE h.project_id=? ORDER BY h.created_at DESC,h.id DESC`,[toId(req)]);res.json({data:rows.map((r)=>({id:r.id,subprojectId:r.subproject_id,oldStatus:r.old_status,newStatus:r.new_status,note:r.note,createdAt:r.created_at,actor:{id:r.changed_by,displayName:r.display_name,role:r.role}}))});}));

  app.use('/api', api);
  app.use((req,res)=>res.status(404).json({error:{code:'NOT_FOUND',message:'Halaman atau data tidak ditemukan.'}}));
  app.use((error,_req,res,_next)=>{
    if (error instanceof multer.MulterError) {
      const tooLarge=error.code==='LIMIT_FILE_SIZE';return res.status(tooLarge?413:400).json({error:{code:tooLarge?'FILE_TOO_LARGE':'UPLOAD_ERROR',message:tooLarge?`Ukuran file maksimal ${Math.floor(maxUploadBytes/1024/1024)} MB.`:'Unggahan tidak dapat diproses.'}});
    }
    if (error instanceof z.ZodError) return res.status(400).json({error:{code:'VALIDATION_ERROR',message:'Periksa kembali data yang diisi.',fields:error.flatten().fieldErrors}});
    if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') console.error(error);
    const status=error.status||500;res.status(status).json({error:{code:error.code||'INTERNAL_ERROR',message:status>=500?'Terjadi kesalahan pada server.':error.message,fields:error.fields}});
  });
  return app;
}

async function login(req,res,expectedRole){
  const input=parse(schemas.login,req.body);const user=await get(`SELECT u.*,c.id client_id FROM users u LEFT JOIN clients c ON c.user_id=u.id WHERE normalized_username=?`,[normalizeUsername(input.username)]);
  if(!user||user.role!==expectedRole||!user.is_active||!await bcrypt.compare(input.password,user.password_hash))throw bad(401,'INVALID_CREDENTIALS','Username atau password tidak sesuai.');
  const stamp=now();await run('UPDATE users SET last_login_at=?,updated_at=? WHERE id=?',[stamp,stamp,user.id]);await createSession(res,user.id);
  await writeActivity({run},{actorId:user.id,entityType:'user',entityId:user.id,action:'login',summary:'Masuk ke Workyuk'});
  res.json({data:{user:safeUser(user)}});
}
function mapClient(row){return{id:row.client_id??row.id,userId:row.user_id,username:row.username,displayName:row.display_name,companyName:row.company_name,isActive:Boolean(row.is_active),projectCount:row.project_count??0,createdAt:row.created_at};}
function attachmentView(row){return{id:row.id,projectId:row.project_id,subprojectId:row.subproject_id,type:row.type,title:row.title,url:row.url,originalFilename:row.original_filename,mimeType:row.mime_type,sizeBytes:row.size_bytes,uploader:{id:row.uploader_user_id,displayName:row.display_name,role:row.role},createdAt:row.created_at,downloadUrl:row.type==='file'?`/api/attachments/${row.id}/download`:undefined};}
async function activityRows(clause,params,limit){return all(`SELECT a.id,a.project_id,a.subproject_id,a.entity_type,a.entity_id,a.action,a.summary,a.created_at,u.id actor_id,u.display_name,u.role,p.name project_name FROM activity_logs a JOIN users u ON u.id=a.actor_user_id LEFT JOIN projects p ON p.id=a.project_id ${clause} ORDER BY a.created_at DESC,a.id DESC LIMIT ${Number(limit)}` ,params).then((rows)=>rows.map((r)=>({id:r.id,projectId:r.project_id,subprojectId:r.subproject_id,projectName:r.project_name,entityType:r.entity_type,entityId:r.entity_id,action:r.action,summary:r.summary,createdAt:r.created_at,actor:{id:r.actor_id,displayName:r.display_name,role:r.role}})));}
