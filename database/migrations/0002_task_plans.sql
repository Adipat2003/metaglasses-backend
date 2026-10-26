create table app.task_plans (
    id uuid primary key,
    token_hash bytea not null references app.pairings (token_hash) on delete cascade,
    owner_id uuid not null,
    client_request_id uuid not null,
    title text not null,
    status text not null default 'draft',
    current_version integer not null default 1,
    approved_version integer,
    created_at timestamptz not null default statement_timestamp(),
    updated_at timestamptz not null default statement_timestamp(),
    constraint task_plans_token_hash_length check (octet_length(token_hash) = 32),
    constraint task_plans_title_length check (char_length(title) between 1 and 160),
    constraint task_plans_status check (
        status in ('draft', 'awaiting_approval', 'approved', 'abandoned')
    ),
    constraint task_plans_current_version check (current_version > 0),
    constraint task_plans_approved_version check (
        approved_version is null or approved_version between 1 and current_version
    ),
    unique (owner_id, client_request_id)
);

create index task_plans_owner_created_idx on app.task_plans (owner_id, created_at desc);
create index task_plans_token_hash_idx on app.task_plans (token_hash);

create table app.task_plan_versions (
    task_plan_id uuid not null references app.task_plans (id) on delete cascade,
    version integer not null,
    source_steps jsonb not null,
    validation_status text not null default 'not_validated',
    validation_result jsonb,
    created_at timestamptz not null default statement_timestamp(),
    validated_at timestamptz,
    primary key (task_plan_id, version),
    constraint task_plan_versions_version check (version > 0),
    constraint task_plan_versions_source_steps_array check (jsonb_typeof(source_steps) = 'array'),
    constraint task_plan_versions_validation_status check (
        validation_status in ('not_validated', 'validated', 'needs_clarification')
    ),
    constraint task_plan_versions_validation_result check (
        validation_result is null or jsonb_typeof(validation_result) = 'object'
    ),
    constraint task_plan_versions_validation_state check (
        (validation_status = 'not_validated' and validation_result is null and validated_at is null)
        or (validation_status <> 'not_validated' and validation_result is not null and validated_at is not null)
    )
);

create table app.task_runs (
    id uuid primary key,
    task_plan_id uuid not null,
    task_plan_version integer not null,
    token_hash bytea not null references app.pairings (token_hash) on delete restrict,
    owner_id uuid not null,
    client_request_id uuid not null,
    status text not null default 'active',
    current_step_ordinal integer not null default 1,
    state_version bigint not null default 1,
    created_at timestamptz not null default statement_timestamp(),
    updated_at timestamptz not null default statement_timestamp(),
    stopped_at timestamptz,
    foreign key (task_plan_id, task_plan_version)
        references app.task_plan_versions (task_plan_id, version) on delete restrict,
    constraint task_runs_token_hash_length check (octet_length(token_hash) = 32),
    constraint task_runs_status check (status in ('active', 'paused', 'stopped')),
    constraint task_runs_current_step check (current_step_ordinal > 0),
    constraint task_runs_state_version check (state_version > 0),
    constraint task_runs_stopped_state check (
        (status = 'stopped' and stopped_at is not null)
        or (status <> 'stopped' and stopped_at is null)
    ),
    unique (owner_id, client_request_id)
);

create index task_runs_owner_created_idx on app.task_runs (owner_id, created_at desc);
create index task_runs_plan_idx on app.task_runs (task_plan_id, task_plan_version);
create unique index task_runs_one_active_plan_idx
    on app.task_runs (task_plan_id, task_plan_version)
    where status in ('active', 'paused');

create or replace function app.task_plan_view(p_task_plan_id uuid, p_owner_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, app
as $$
    select jsonb_build_object(
        'taskPlanId', plan.id,
        'title', plan.title,
        'status', plan.status,
        'currentVersion', plan.current_version,
        'approvedVersion', plan.approved_version,
        'createdAt', plan.created_at,
        'updatedAt', plan.updated_at,
        'sourceSteps', version.source_steps,
        'validationStatus', version.validation_status,
        'validation', version.validation_result
    )
    from app.task_plans as plan
    join app.task_plan_versions as version
      on version.task_plan_id = plan.id
     and version.version = plan.current_version
    join app.pairings as pairing
      on pairing.token_hash = plan.token_hash
     and pairing.owner_id = p_owner_id
     and pairing.expires_at > statement_timestamp()
    where plan.id = p_task_plan_id
      and plan.owner_id = p_owner_id;
$$;

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

create or replace function app.save_task_plan_validation(
    p_task_plan_id uuid,
    p_owner_id uuid,
    p_validation_result jsonb
)
returns text
language sql
volatile
security definer
set search_path = pg_catalog, app
as $$
    with updated as (
        update app.task_plan_versions as version
        set validation_status = case
                when coalesce((p_validation_result ->> 'needsUserClarification')::boolean, true)
                    then 'needs_clarification'
                else 'validated'
            end,
            validation_result = p_validation_result,
            validated_at = statement_timestamp()
        from app.task_plans as plan
        join app.pairings as pairing
          on pairing.token_hash = plan.token_hash
         and pairing.owner_id = p_owner_id
         and pairing.expires_at > statement_timestamp()
        where version.task_plan_id = plan.id
          and version.version = plan.current_version
          and plan.id = p_task_plan_id
          and plan.owner_id = p_owner_id
          and plan.status = 'draft'
        returning plan.id as task_plan_id, version.validation_status
    ), promoted as (
        update app.task_plans as plan
        set status = 'awaiting_approval',
            updated_at = statement_timestamp()
        from updated
        where plan.id = updated.task_plan_id
          and updated.validation_status = 'validated'
        returning 1
    )
    select case when exists (select 1 from updated) then 'saved' else 'not_found_or_not_draft' end;
$$;

create or replace function app.approve_task_plan(p_task_plan_id uuid, p_owner_id uuid)
returns text
language sql
volatile
security definer
set search_path = pg_catalog, app
as $$
    with approved as (
        update app.task_plans as plan
        set status = 'approved',
            approved_version = plan.current_version,
            updated_at = statement_timestamp()
        from app.task_plan_versions as version,
             app.pairings as pairing
        where plan.id = p_task_plan_id
          and plan.owner_id = p_owner_id
          and plan.status = 'awaiting_approval'
          and version.task_plan_id = plan.id
          and version.version = plan.current_version
          and version.validation_status = 'validated'
          and pairing.token_hash = plan.token_hash
          and pairing.owner_id = p_owner_id
          and pairing.expires_at > statement_timestamp()
        returning 1
    )
    select case when exists (select 1 from approved) then 'approved' else 'not_ready_or_not_found' end;
$$;

create or replace function app.start_task_run(
    p_task_run_id uuid,
    p_task_plan_id uuid,
    p_owner_id uuid,
    p_client_request_id uuid
)
returns jsonb
language sql
volatile
security definer
set search_path = pg_catalog, app
as $$
    with eligible_plan as (
        select
            plan.id,
            plan.token_hash,
            plan.owner_id,
            plan.approved_version,
            version.source_steps,
            version.validation_result
        from app.task_plans as plan
        join app.task_plan_versions as version
          on version.task_plan_id = plan.id
         and version.version = plan.approved_version
         and version.validation_status = 'validated'
        join app.pairings as pairing
          on pairing.token_hash = plan.token_hash
         and pairing.owner_id = p_owner_id
         and pairing.expires_at > statement_timestamp()
        where plan.id = p_task_plan_id
          and plan.owner_id = p_owner_id
          and plan.status = 'approved'
    ), inserted as (
        insert into app.task_runs (
            id,
            task_plan_id,
            task_plan_version,
            token_hash,
            owner_id,
            client_request_id,
            status,
            current_step_ordinal,
            state_version
        )
        select
            p_task_run_id,
            eligible.id,
            eligible.approved_version,
            eligible.token_hash,
            eligible.owner_id,
            p_client_request_id,
            'active',
            1,
            1
        from eligible_plan as eligible
        on conflict do update
        set updated_at = excluded.updated_at
        returning id, task_plan_id, task_plan_version, status, current_step_ordinal, state_version, created_at
    )
    select jsonb_build_object(
        'taskRunId', inserted.id,
        'taskPlanId', inserted.task_plan_id,
        'planVersion', inserted.task_plan_version,
        'status', inserted.status,
        'currentStepOrdinal', inserted.current_step_ordinal,
        'stateVersion', inserted.state_version,
        'createdAt', inserted.created_at,
        'lensInstruction', coalesce(
            eligible.validation_result #>> '{steps,0,canonicalInstruction}',
            eligible.source_steps #>> '{0,instruction}'
        )
    )
    from inserted
    join eligible_plan as eligible on eligible.id = inserted.task_plan_id;
$$;

revoke all on app.task_plans, app.task_plan_versions, app.task_runs from public;
revoke all on function app.task_plan_view(uuid, uuid) from public;
revoke all on function app.create_task_plan(uuid, text, uuid, uuid, text, jsonb) from public;
revoke all on function app.save_task_plan_validation(uuid, uuid, jsonb) from public;
revoke all on function app.approve_task_plan(uuid, uuid) from public;
revoke all on function app.start_task_run(uuid, uuid, uuid, uuid) from public;

grant execute on function app.task_plan_view(uuid, uuid) to metaglasses_api;
grant execute on function app.create_task_plan(uuid, text, uuid, uuid, text, jsonb) to metaglasses_api;
grant execute on function app.save_task_plan_validation(uuid, uuid, jsonb) to metaglasses_api;
grant execute on function app.approve_task_plan(uuid, uuid) to metaglasses_api;
grant execute on function app.start_task_run(uuid, uuid, uuid, uuid) to metaglasses_api;
