export function restoreConnection(value: string, database: string) {
  const url = new URL(value);
  if (
    !/^postgres(ql)?:$/.test(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new Error("Restore rehearsals require a loopback PostgreSQL server.");
  if (!/^papersign_restore_(?:source_)?[a-f0-9]{24}$/.test(database))
    throw new Error(
      "Restore database names must have the isolated papersign_restore_ prefix and a generated suffix.",
    );
  if (url.search || url.hash)
    throw new Error(
      "Connection query overrides are not permitted for restore rehearsals.",
    );
  url.pathname = `/${database}`;
  return url;
}
