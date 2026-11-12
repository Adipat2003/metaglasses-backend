create or replace function app.create_task_plan(
    p_task_plan_id uuid,
    p_token_hash text,
    p_owner_id uuid,
    p_client_request_id uuid,
    p_title text,
    p_source_steps jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app
as $$
declare
    existing_plan_id uuid;
    pairing_owner_id uuid;
begin
    perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || p_client_request_id::text, 0));

    select plan.id into existing_plan_id
    from app.task_plans as plan
    where plan.owner_id = p_owner_id
      and plan.client_request_id = p_client_request_id;

    if found then
        if not exists (
            select 1
            from app.task_plans as plan
            join app.task_plan_versions as original
              on original.task_plan_id = plan.id and original.version = 1
            where plan.id = existing_plan_id
              and plan.token_hash = decode(p_token_hash, 'hex')
              and plan.title = p_title
              and original.source_steps = p_source_steps
        ) then
            return jsonb_build_object('access', 'idempotency_conflict');
        end if;
        return app.task_plan_view(existing_plan_id, p_owner_id);
    end if;

    select pairing.owner_id into pairing_owner_id
    from app.pairings as pairing
    where pairing.token_hash = decode(p_token_hash, 'hex')
      and pairing.expires_at > statement_timestamp()
    for update;

    if not found then
        return null;
    end if;
    if pairing_owner_id <> p_owner_id then
        return jsonb_build_object('access', 'forbidden');
    end if;

    insert into app.task_plans (
        id, token_hash, owner_id, client_request_id, title, status, current_version
    )
    values (
        p_task_plan_id, decode(p_token_hash, 'hex'), p_owner_id, p_client_request_id, p_title, 'draft', 1
    );
    insert into app.task_plan_versions (task_plan_id, version, source_steps)
    values (p_task_plan_id, 1, p_source_steps);

    return app.task_plan_view(p_task_plan_id, p_owner_id);
end;
$$;
