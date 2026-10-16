const WRITE_GRANT =
  /\b(ALL(?:\s+PRIVILEGES)?|ALTER|CREATE|DELETE|DROP|EVENT|EXECUTE|FILE|GRANT\s+OPTION|INDEX|INSERT|LOCK\s+TABLES|PROCESS|REFERENCES|RELOAD|REPLICATION|SHUTDOWN|SUPER|TRIGGER|UPDATE)\b/i;

const READ_PRIVILEGES =
  /^(?:SELECT|USAGE|SHOW\s+VIEW|SHOW\s+DATABASES)(?:\s*,\s*(?:SELECT|USAGE|SHOW\s+VIEW|SHOW\s+DATABASES))*$/i;

const READ_PRIVILEGE_NAMES = new Set(["SELECT", "USAGE", "SHOW VIEW", "SHOW DATABASES"]);

export function grantsAreReadOnly(grants) {
  if (!Array.isArray(grants) || grants.length === 0) return false;
  for (const grant of grants) {
    const text = String(grant || "").trim();
    if (!text) return false;
    if (/^GRANT PROXY\b/i.test(text)) continue;
    if (/\bWITH\s+GRANT\s+OPTION\b/i.test(text)) return false;
    if (!/\sON\s/i.test(text)) return false;
    const privileges = text.replace(/^GRANT\s+/i, "").split(/\s+ON\s+/i)[0].trim();
    if (!privileges || WRITE_GRANT.test(privileges) || !READ_PRIVILEGES.test(privileges)) {
      return false;
    }
  }
  return true;
}

async function assertInformationSchemaReadOnly(connection) {
  const [privs] = await connection.query(
    `SELECT DISTINCT PRIVILEGE_TYPE AS privilege_type
     FROM (
       SELECT PRIVILEGE_TYPE, GRANTEE FROM information_schema.USER_PRIVILEGES
       UNION ALL
       SELECT PRIVILEGE_TYPE, GRANTEE FROM information_schema.SCHEMA_PRIVILEGES
       UNION ALL
       SELECT PRIVILEGE_TYPE, GRANTEE FROM information_schema.TABLE_PRIVILEGES
       UNION ALL
       SELECT PRIVILEGE_TYPE, GRANTEE FROM information_schema.COLUMN_PRIVILEGES
     ) g
     WHERE g.GRANTEE = CONCAT(
       '''', SUBSTRING_INDEX(CURRENT_USER(), '@', 1),
       '''@''',
       SUBSTRING_INDEX(CURRENT_USER(), '@', -1),
       ''''
     )`
  );
  if (privs.length === 0) {
    throw new Error("Could not verify that the MySQL user is read-only.");
  }
  for (const row of privs) {
    const privilege = String(row.privilege_type || "").toUpperCase();
    if (privilege && !READ_PRIVILEGE_NAMES.has(privilege)) {
      throw new Error("This MySQL user can write. Connect a read-only user.");
    }
  }
}

export async function assertReadOnly(connection) {
  let grants;
  try {
    const [rows] = await connection.query("SHOW GRANTS FOR CURRENT_USER()");
    grants = rows.map((row) => String(Object.values(row)[0]));
  } catch {
    throw new Error("Could not verify that the MySQL user is read-only.");
  }
  if (!grantsAreReadOnly(grants)) {
    const looksWritable = grants.some((grant) => {
      const text = String(grant || "");
      if (/^GRANT PROXY\b/i.test(text)) return false;
      return WRITE_GRANT.test(text) || /\bWITH\s+GRANT\s+OPTION\b/i.test(text) || !/\sON\s/i.test(text);
    });
    throw new Error(
      looksWritable
        ? "This MySQL user can write. Connect a read-only user."
        : "Could not verify that the MySQL user is read-only."
    );
  }
  try {
    await assertInformationSchemaReadOnly(connection);
  } catch (err) {
    if (err?.message === "This MySQL user can write. Connect a read-only user.") throw err;
    throw new Error("Could not verify that the MySQL user is read-only.");
  }
}
