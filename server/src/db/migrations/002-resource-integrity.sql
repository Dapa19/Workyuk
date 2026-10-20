CREATE INDEX IF NOT EXISTS idx_activity_subproject_created ON activity_logs(subproject_id, created_at);

CREATE TRIGGER IF NOT EXISTS comments_subproject_insert
BEFORE INSERT ON comments WHEN NEW.subproject_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM subprojects WHERE id=NEW.subproject_id AND project_id=NEW.project_id
  ) THEN RAISE(ABORT, 'comment subproject must belong to project') END;
END;
CREATE TRIGGER IF NOT EXISTS comments_subproject_update
BEFORE UPDATE OF project_id, subproject_id ON comments WHEN NEW.subproject_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM subprojects WHERE id=NEW.subproject_id AND project_id=NEW.project_id
  ) THEN RAISE(ABORT, 'comment subproject must belong to project') END;
END;
CREATE TRIGGER IF NOT EXISTS attachments_subproject_insert
BEFORE INSERT ON attachments WHEN NEW.subproject_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM subprojects WHERE id=NEW.subproject_id AND project_id=NEW.project_id
  ) THEN RAISE(ABORT, 'attachment subproject must belong to project') END;
END;
CREATE TRIGGER IF NOT EXISTS attachments_subproject_update
BEFORE UPDATE OF project_id, subproject_id ON attachments WHEN NEW.subproject_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM subprojects WHERE id=NEW.subproject_id AND project_id=NEW.project_id
  ) THEN RAISE(ABORT, 'attachment subproject must belong to project') END;
END;
CREATE TRIGGER IF NOT EXISTS history_subproject_insert
BEFORE INSERT ON status_history WHEN NEW.subproject_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM subprojects WHERE id=NEW.subproject_id AND project_id=NEW.project_id
  ) THEN RAISE(ABORT, 'history subproject must belong to project') END;
END;
CREATE TRIGGER IF NOT EXISTS activity_subproject_insert
BEFORE INSERT ON activity_logs WHEN NEW.subproject_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM subprojects WHERE id=NEW.subproject_id AND project_id=NEW.project_id
  ) THEN RAISE(ABORT, 'activity subproject must belong to project') END;
END;

INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, datetime('now'));
