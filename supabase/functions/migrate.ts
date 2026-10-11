import { Signer } from "npm:@aws-sdk/rds-signer@3.1149.0";
import postgres from "npm:postgres@3.4.9";

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

const region = requiredEnvironment("AWS_REGION");
const signer = new Signer({
  hostname: requiredEnvironment("DATABASE_HOST"),
  port: Number(requiredEnvironment("DATABASE_PORT")),
  username: "metaglasses_api",
  region,
});
const database = postgres({
  host: requiredEnvironment("DATABASE_HOST"),
  port: Number(requiredEnvironment("DATABASE_PORT")),
  database: requiredEnvironment("DATABASE_NAME"),
  username: "metaglasses_api",
  password: () => signer.getAuthToken(),
  ssl: "require",
  max: 1,
  connect_timeout: 10,
});

try {
  const applied = await database`
    select 1 from pg_catalog.pg_tables
    where schemaname = 'app' and tablename = 'schema_migrations'
  `;
  if (applied.length > 0) {
    const migration = await database`
      select 1 from app.schema_migrations where name = '0001_initial'
    `;
    if (migration.length > 0) {
      console.info(
        JSON.stringify({ event: "database_migration_skipped", migration: "0001_initial" }),
      );
    } else {
      throw new Error("The migration ledger exists but 0001_initial is absent.");
    }
  } else {
    const sql = await Deno.readTextFile("database/migrations/0001_initial.sql");
    await database.unsafe(`
      begin;
      ${sql}
      create table app.schema_migrations (name text primary key, applied_at timestamptz not null);
      insert into app.schema_migrations (name, applied_at) values ('0001_initial', statement_timestamp());
      commit;
    `);
    console.info(
      JSON.stringify({ event: "database_migration_completed", migration: "0001_initial" }),
    );
  }
} finally {
  await database.end({ timeout: 5 });
}
