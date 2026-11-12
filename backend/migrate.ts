import { Signer } from "npm:@aws-sdk/rds-signer@3.1149.0";
import postgres from "npm:postgres@3.4.9";

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

async function migrationNames(): Promise<string[]> {
  const migrations: string[] = [];
  for await (const entry of Deno.readDir("database/migrations")) {
    if (entry.isFile && /^\d{4}_[a-z0-9_]+\.sql$/.test(entry.name)) {
      migrations.push(entry.name.slice(0, -".sql".length));
    }
  }
  migrations.sort();
  if (migrations[0] !== "0001_initial") {
    throw new Error("database/migrations must start with 0001_initial.sql.");
  }
  return migrations;
}

const region = requiredEnvironment("AWS_REGION");
const signer = new Signer({
  hostname: requiredEnvironment("DATABASE_HOST"),
  port: Number(requiredEnvironment("DATABASE_PORT")),
  username: requiredEnvironment("DATABASE_MIGRATOR_USER"),
  region,
});
const database = postgres({
  host: requiredEnvironment("DATABASE_HOST"),
  port: Number(requiredEnvironment("DATABASE_PORT")),
  database: requiredEnvironment("DATABASE_NAME"),
  username: requiredEnvironment("DATABASE_MIGRATOR_USER"),
  password: () => signer.getAuthToken(),
  ssl: "require",
  max: 1,
  connect_timeout: 10,
});

async function applyMigration(name: string): Promise<void> {
  const sql = await Deno.readTextFile(`database/migrations/${name}.sql`);
  try {
    await database.unsafe(`
      begin;
      ${sql}
      insert into app.schema_migrations (name, applied_at)
      values ('${name}', statement_timestamp());
      commit;
    `);
  } catch (error) {
    await database.unsafe("rollback;").catch(() => undefined);
    throw error;
  }
  console.info(JSON.stringify({ event: "database_migration_completed", migration: name }));
}

try {
  const migrations = await migrationNames();
  const ledgerExists = await database`
    select 1 from pg_catalog.pg_tables
    where schemaname = 'app' and tablename = 'schema_migrations'
  `;
  if (ledgerExists.length === 0) {
    throw new Error(
      "The migration ledger is absent. Complete database bootstrap before deployment.",
    );
  }

  const appliedRows = await database`select name from app.schema_migrations order by name`;
  const applied = new Set(appliedRows.map((row) => row.name as string));
  if (!applied.has("0001_initial")) {
    throw new Error("The migration ledger exists but 0001_initial is absent.");
  }
  for (const name of migrations) {
    if (applied.has(name)) {
      console.info(JSON.stringify({ event: "database_migration_skipped", migration: name }));
      continue;
    }
    await applyMigration(name);
  }
} finally {
  await database.end({ timeout: 5 });
}
