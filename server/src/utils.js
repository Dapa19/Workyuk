export const now = () => new Date().toISOString();
export const normalizeUsername = (username = '') => username.trim().toLocaleLowerCase('en-US');

export function safeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    isActive: Boolean(row.is_active),
    mustChangePassword: Boolean(row.must_change_password),
    clientId: row.client_id ?? null,
  };
}

export async function writeActivity(q, { projectId = null, subprojectId = null, actorId, entityType, entityId = null, action, summary }) {
  await q.run(`INSERT INTO activity_logs(project_id, subproject_id, actor_user_id, entity_type, entity_id, action, summary, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)`, [projectId, subprojectId, actorId, entityType, entityId, action, summary, now()]);
}
