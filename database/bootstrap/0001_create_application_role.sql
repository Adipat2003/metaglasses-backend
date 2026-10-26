do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'metaglasses_api') then
        create role metaglasses_api login;
    end if;
end
$$;

grant rds_iam to metaglasses_api;
revoke create on schema public from public;
