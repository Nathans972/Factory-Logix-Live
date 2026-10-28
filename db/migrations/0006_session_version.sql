-- Session versions (additive, idempotent).
--
-- A session cookie carries the user's session_version from sign-in and only counts while the two
-- still match. Logging out, an admin password reset and deactivation add one, which ends every
-- session the user already has, a copied cookie included. Cookies signed before this migration
-- carry no version and count as 0, so the upgrade itself signs nobody out.
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version int NOT NULL DEFAULT 0;
