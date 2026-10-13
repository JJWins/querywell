const WRITE_GRANT =
  /\b(ALL(?:\s+PRIVILEGES)?|ALTER|CREATE|DELETE|DROP|EVENT|EXECUTE|FILE|GRANT\s+OPTION|INDEX|INSERT|LOCK\s+TABLES|PROCESS|REFERENCES|RELOAD|REPLICATION|SHUTDOWN|SUPER|TRIGGER|UPDATE)\b/i;

export async function assertReadOnly(connection) {
  let grants;
  try {
    const [rows] = await connection.query("SHOW GRANTS FOR CURRENT_USER()");
    grants = rows.map((row) => String(Object.values(row)[0]));
  } catch {
    throw new Error("Could not verify that the MySQL user is read-only.");
  }
  if (grants.length === 0) {
    throw new Error("Could not verify that the MySQL user is read-only.");
  }

  for (const grant of grants) {
    if (/^GRANT PROXY\b/i.test(grant)) continue;
    const privileges = grant.replace(/^GRANT\s+/i, "").split(/\s+ON\s+/i)[0];
    if (WRITE_GRANT.test(privileges)) {
      throw new Error("This MySQL user can write. Connect a read-only user.");
    }
  }
}
