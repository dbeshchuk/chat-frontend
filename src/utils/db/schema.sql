CREATE TABLE IF NOT EXISTS users_synced (
  pub_key TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  synced  BOOLEAN DEFAULT TRUE
);


CREATE TABLE IF NOT EXISTS users_local (
  pub_key    TEXT PRIMARY KEY,
  name       TEXT,
  operation  TEXT CHECK (operation IN ('insert', 'update', 'delete')),
  synced     BOOLEAN DEFAULT FALSE
);

CREATE OR REPLACE VIEW users AS
SELECT 
  COALESCE(l.pub_key, s.pub_key)           AS pub_key,
  COALESCE(l.name,    s.name)              AS name,
  COALESCE(l.synced,  s.synced, FALSE)     AS synced
FROM users_synced s
FULL OUTER JOIN users_local l ON s.pub_key = l.pub_key
WHERE l.operation IS NULL OR l.operation != 'delete';

CREATE OR REPLACE FUNCTION cleanup_local_after_sync()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM users_local WHERE pub_key = NEW.pub_key;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_cleanup_local_users
AFTER INSERT OR UPDATE ON users_synced
FOR EACH ROW EXECUTE FUNCTION cleanup_local_after_sync();