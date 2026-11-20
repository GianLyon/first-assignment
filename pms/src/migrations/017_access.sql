-- Phase 17: roles kept in the database (editable), and rights given to or taken from one person

CREATE TABLE roles (
  key         TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  name        TEXT NOT NULL,
  description TEXT,
  department  TEXT,
  perms       TEXT[] NOT NULL DEFAULT '{}',
  defaults    TEXT[] NOT NULL DEFAULT '{}',   -- the built-in rights last applied, so new ones in later versions are added
  builtin     BOOLEAN NOT NULL DEFAULT FALSE,
  sort        INT NOT NULL DEFAULT 100
);

/* the built-in roles are filled in from the code on start (syncRoles); any role a user has must exist */
INSERT INTO roles (key, name, builtin) SELECT DISTINCT role, role, TRUE FROM users ON CONFLICT DO NOTHING;
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_fk FOREIGN KEY (role) REFERENCES roles(key) ON UPDATE CASCADE;

/* per person: allow = TRUE adds a right their role lacks, FALSE takes away one their role has */
CREATE TABLE user_permissions (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  perm    TEXT NOT NULL,
  allow   BOOLEAN NOT NULL,
  PRIMARY KEY (user_id, perm)
);
