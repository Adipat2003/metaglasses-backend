do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'metaglasses_migrator') then
        create role metaglasses_migrator login;
    end if;
end
$$;

grant rds_iam to metaglasses_migrator;
grant usage, create on schema app to metaglasses_migrator;
grant select, insert on table app.schema_migrations to metaglasses_migrator;
grant select, update, references on table app.pairings to metaglasses_migrator;
