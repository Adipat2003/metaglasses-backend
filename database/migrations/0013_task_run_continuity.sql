alter table app.task_runs
    alter column token_hash drop not null,
    add column start_request jsonb;

alter table app.task_run_commands add column active_run jsonb;

-- Preserve the most recently updated active run when upgrading existing owners.
with ranked as (
    select id, row_number() over (partition by owner_id order by updated_at desc, id desc) as rank
    from app.task_runs
    where status = 'active'
)
update app.task_runs as run
set status = 'paused', state_version = run.state_version + 1, updated_at = statement_timestamp()
from ranked
where run.id = ranked.id and ranked.rank > 1;

create unique index task_runs_one_active_owner_idx on app.task_runs (owner_id)
    where status = 'active';
create index task_runs_unfinished_owner_idx on app.task_runs (owner_id, status, updated_at desc, id desc)
    where status in ('active', 'paused');

create or replace function app.task_run_view(p_task_run_id uuid, p_owner_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, app
as $$
    select jsonb_build_object(
        'taskRunId', run.id,
        'taskPlanId', run.task_plan_id,
        'planVersion', run.task_plan_version,
        'status', run.status,
        'currentStepOrdinal', run.current_step_ordinal,
        'currentStepStatus', run.current_step_status,
        'stateVersion', run.state_version,
        'latestSequenceNumber', coalesce((
            select max(inference_window.sequence_number)
            from app.task_inference_windows as inference_window
            where inference_window.task_run_id = run.id
        ), 0),
        'createdAt', run.created_at,
        'updatedAt', run.updated_at,
        'stoppedAt', run.stopped_at,
        'lensInstruction', case
            when run.status = 'completed' then 'Task completed.'
            when run.status = 'stopped' then 'Task stopped.'
            else version.source_steps -> (run.current_step_ordinal - 1) ->> 'instruction'
        end
    )
    from app.task_runs as run
    join app.task_plan_versions as version
      on version.task_plan_id = run.task_plan_id
     and version.version = run.task_plan_version
    where run.id = p_task_run_id and run.owner_id = p_owner_id;
$$;

create function app.list_unfinished_task_runs(p_owner_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, app
as $$
    select jsonb_build_object('items', coalesce(
        jsonb_agg(app.task_run_view(run.id, p_owner_id) order by run.status, run.updated_at desc, run.id desc),
        '[]'::jsonb
    ))
    from app.task_runs as run
    where run.owner_id = p_owner_id and run.status in ('active', 'paused');
$$;

create function app.pause_active_task_run(
    p_owner_id uuid,
    p_active_task_run_id uuid,
    p_active_state_version bigint,
    p_switch_id uuid
)
returns jsonb
language plpgsql
volatile
set search_path = pg_catalog, app
as $$
declare
    active_run app.task_runs%rowtype;
begin
    -- Start and command callers already hold the owner run lock.
    select run.* into active_run
    from app.task_runs as run
    where run.owner_id = p_owner_id and run.status = 'active'
    for update;

    if active_run.id is distinct from p_active_task_run_id then
        return jsonb_build_object('outcome', 'active_conflict');
    end if;
    if active_run.state_version is distinct from p_active_state_version then
        return jsonb_build_object('outcome', 'active_conflict', 'stateVersion', active_run.state_version);
    end if;
    if active_run.id is null then return null; end if;

    update app.task_runs as run
    set status = 'paused', state_version = run.state_version + 1, updated_at = statement_timestamp()
    where run.id = active_run.id;

    update app.pairings as pairing
    set response_id = 'task_run_' || p_switch_id::text,
        response_text = 'Guidance paused.',
        response_created_at = statement_timestamp(),
        state = 'idle'
    where pairing.token_hash = active_run.token_hash
      and pairing.owner_id = p_owner_id
      and pairing.expires_at > statement_timestamp();

    return null;
end;
$$;

create or replace function app.publish_task_run_start(p_task_run_id uuid, p_owner_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, app
as $$
    -- Older API deployments make a second call after the start transaction.
    select exists (
        select 1
        from app.task_runs as run
        join app.pairings as pairing on pairing.token_hash = run.token_hash
        where run.id = p_task_run_id and run.owner_id = p_owner_id
          and pairing.owner_id = p_owner_id
          and pairing.expires_at > statement_timestamp()
          and pairing.response_id = 'task_run_' || run.id::text
    );
$$;

create function app.start_task_run(
    p_task_run_id uuid,
    p_task_plan_id uuid,
    p_owner_id uuid,
    p_client_request_id uuid,
    p_token_hash text,
    p_expected_plan_version integer,
    p_active_task_run_id uuid,
    p_active_state_version bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app
as $$
declare
    prior app.task_runs%rowtype;
    selected_plan app.task_plans%rowtype;
    pairing_hash bytea := decode(p_token_hash, 'hex');
    start_request jsonb := jsonb_build_array(p_token_hash is not null, p_expected_plan_version,
        p_active_task_run_id, p_active_state_version);
    switch_error jsonb;
begin
    perform pg_advisory_xact_lock(hashtextextended('task_runs:' || p_owner_id::text, 0));

    select run.* into prior from app.task_runs as run
    where run.owner_id = p_owner_id and run.client_request_id = p_client_request_id;
    if found then
        if prior.task_plan_id <> p_task_plan_id
            or (p_token_hash is not null and prior.token_hash is distinct from pairing_hash)
            or (prior.start_request is not null and prior.start_request <> start_request)
            or (prior.start_request is null and (
                (p_expected_plan_version is not null and prior.task_plan_version <> p_expected_plan_version)
                or p_active_task_run_id is not null or p_active_state_version is not null
            ))
        then
            return jsonb_build_object('outcome', 'idempotency_conflict');
        end if;
        return app.task_run_view(prior.id, p_owner_id);
    end if;

    select plan.* into selected_plan from app.task_plans as plan
    join app.task_plan_versions as version
      on version.task_plan_id = plan.id and version.version = plan.approved_version
     and version.validation_status = 'validated'
    where plan.id = p_task_plan_id and plan.status = 'approved'
    for share of plan;
    if not found then return null; end if;

    if p_expected_plan_version is not null and p_expected_plan_version <> selected_plan.approved_version then
        return jsonb_build_object('outcome', 'plan_stale', 'planVersion', selected_plan.approved_version);
    end if;

    -- Inference finishes with the run locked before it publishes to the pairing.
    perform 1 from app.task_runs as run
    where run.owner_id = p_owner_id and run.status = 'active'
    for update;

    if p_token_hash is not null then
        perform 1 from app.pairings as pairing
        where pairing.token_hash = pairing_hash and pairing.owner_id = p_owner_id
          and pairing.expires_at > statement_timestamp()
        for share;
        if not found then return null; end if;
    elsif selected_plan.owner_id = p_owner_id and p_expected_plan_version is null
        and p_active_task_run_id is null and p_active_state_version is null
    then
        -- Older callers omitted the token to use their plan's original pairing.
        select pairing.token_hash into pairing_hash from app.pairings as pairing
        where pairing.token_hash = selected_plan.token_hash and pairing.owner_id = p_owner_id
          and pairing.expires_at > statement_timestamp()
        for share;
    end if;

    if exists (
        select 1 from app.task_runs as run
        where run.owner_id = p_owner_id and run.task_plan_id = selected_plan.id
          and run.task_plan_version = selected_plan.approved_version and run.status in ('active', 'paused')
    ) then
        return jsonb_build_object('outcome', 'active_exists');
    end if;

    switch_error := app.pause_active_task_run(p_owner_id, p_active_task_run_id,
        p_active_state_version, p_task_run_id);
    if switch_error is not null then return switch_error; end if;

    insert into app.task_runs (id, task_plan_id, task_plan_version, token_hash, owner_id, client_request_id, start_request)
    values (p_task_run_id, selected_plan.id, selected_plan.approved_version, pairing_hash,
        p_owner_id, p_client_request_id, start_request);

    update app.pairings as pairing
    set response_id = 'task_run_' || p_task_run_id::text,
        response_text = version.source_steps -> 0 ->> 'instruction',
        response_created_at = statement_timestamp(),
        state = 'speaking'
    from app.task_plan_versions as version
    where version.task_plan_id = selected_plan.id and version.version = selected_plan.approved_version
      and pairing.token_hash = pairing_hash and pairing.owner_id = p_owner_id
      and pairing.expires_at > statement_timestamp();

    return app.task_run_view(p_task_run_id, p_owner_id);
end;
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
    select app.start_task_run(p_task_run_id, p_task_plan_id, p_owner_id, p_client_request_id,
        null, null, null, null);
$$;

create or replace function app.start_task_run_for_pairing(
    p_task_run_id uuid,
    p_task_plan_id uuid,
    p_owner_id uuid,
    p_client_request_id uuid,
    p_token_hash text
)
returns jsonb
language sql
volatile
security definer
set search_path = pg_catalog, app
as $$
    select app.start_task_run(p_task_run_id, p_task_plan_id, p_owner_id, p_client_request_id,
        p_token_hash, null, null, null);
$$;

create function app.apply_task_run_command(
    p_command_id uuid,
    p_task_run_id uuid,
    p_owner_id uuid,
    p_client_request_id uuid,
    p_command text,
    p_expected_state_version bigint,
    p_active_task_run_id uuid,
    p_active_state_version bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app
as $$
declare
    existing_command app.task_run_commands%rowtype;
    run_record app.task_runs%rowtype;
    source_steps jsonb;
    step_count integer;
    next_status text;
    next_step_ordinal integer;
    next_step_status text;
    next_lens_instruction text;
    result jsonb;
    switch_error jsonb;
    active_request jsonb := case when p_active_task_run_id is not null or p_active_state_version is not null
        then jsonb_build_array(p_active_task_run_id, p_active_state_version) end;
begin
    perform pg_advisory_xact_lock(hashtextextended('task_runs:' || p_owner_id::text, 0));

    select run.*
    into run_record
    from app.task_runs as run
    where run.id = p_task_run_id
      and run.owner_id = p_owner_id
    for update;

    if not found then
        return jsonb_build_object('outcome', 'not_found');
    end if;

    select command.* into existing_command
    from app.task_run_commands as command
    where command.task_run_id = p_task_run_id
      and command.owner_id = p_owner_id
      and command.client_request_id = p_client_request_id;
    if found then
        if existing_command.command <> p_command or existing_command.expected_state_version <> p_expected_state_version
            or existing_command.active_run is distinct from active_request
        then
            return jsonb_build_object('outcome', 'idempotency_conflict');
        end if;
        return existing_command.result;
    end if;
    if active_request is not null and p_command <> 'resume' then
        return jsonb_build_object('outcome', 'invalid_command');
    end if;

    select version.source_steps into source_steps
    from app.task_plan_versions as version
    where version.task_plan_id = run_record.task_plan_id
      and version.version = run_record.task_plan_version;
    if run_record.state_version <> p_expected_state_version then
        return jsonb_build_object(
            'outcome', 'stale',
            'stateVersion', run_record.state_version
        );
    end if;
    if run_record.status in ('stopped', 'completed') then
        return jsonb_build_object(
            'outcome', 'not_active',
            'stateVersion', run_record.state_version
        );
    end if;
    if (select count(*) from app.task_run_commands where task_run_id = p_task_run_id) >= 1_000 then
        return jsonb_build_object('outcome', 'command_limit');
    end if;

    step_count := jsonb_array_length(source_steps);
    next_status := run_record.status;
    next_step_ordinal := run_record.current_step_ordinal;
    next_step_status := 'in_progress';

    case p_command
        when 'pause' then
            if run_record.status <> 'active' then
                return jsonb_build_object('outcome', 'invalid_transition');
            end if;
            next_status := 'paused';
            next_step_status := run_record.current_step_status;
            next_lens_instruction := 'Guidance paused.';
        when 'resume' then
            if run_record.status <> 'paused' then
                return jsonb_build_object('outcome', 'invalid_transition');
            end if;
            switch_error := app.pause_active_task_run(p_owner_id, p_active_task_run_id,
                p_active_state_version, p_command_id);
            if switch_error is not null then return switch_error; end if;
            next_status := 'active';
            next_step_status := run_record.current_step_status;
            next_lens_instruction := source_steps -> (next_step_ordinal - 1) ->> 'instruction';
        when 'repeat', 'correct' then
            next_step_status := run_record.current_step_status;
            next_lens_instruction := source_steps -> (next_step_ordinal - 1) ->> 'instruction';
        when 'back' then
            if run_record.status <> 'active' or run_record.current_step_ordinal <= 1 then
                return jsonb_build_object('outcome', 'invalid_transition');
            end if;
            next_step_ordinal := run_record.current_step_ordinal - 1;
            next_lens_instruction := source_steps -> (next_step_ordinal - 1) ->> 'instruction';
        when 'confirm', 'skip' then
            if run_record.status <> 'active' then
                return jsonb_build_object('outcome', 'invalid_transition');
            end if;
            if run_record.current_step_ordinal >= step_count then
                next_status := 'completed';
                next_step_status := case when p_command = 'confirm' then 'confirmed' else 'skipped' end;
                next_lens_instruction := 'Task completed.';
            else
                next_step_ordinal := run_record.current_step_ordinal + 1;
                next_lens_instruction := source_steps -> (next_step_ordinal - 1) ->> 'instruction';
            end if;
        when 'stop' then
            next_status := 'stopped';
            next_step_status := run_record.current_step_status;
            next_lens_instruction := 'Task stopped.';
        else
            return jsonb_build_object('outcome', 'invalid_command');
    end case;

    update app.task_runs as run
    set status = next_status,
        current_step_ordinal = next_step_ordinal,
        current_step_status = next_step_status,
        state_version = run.state_version + 1,
        updated_at = statement_timestamp(),
        stopped_at = case
            when next_status in ('stopped', 'completed') then statement_timestamp()
            else null
        end
    where run.id = run_record.id
    returning jsonb_build_object(
        'outcome', 'applied',
        'taskRunId', run.id,
        'status', run.status,
        'currentStepOrdinal', run.current_step_ordinal,
        'currentStepStatus', run.current_step_status,
        'stateVersion', run.state_version,
        'lensInstruction', next_lens_instruction
    ) into result;

    update app.pairings as pairing
    set response_id = 'task_run_' || p_command_id::text,
        response_text = next_lens_instruction,
        response_created_at = statement_timestamp(),
        state = case when next_status = 'paused' then 'idle' else 'speaking' end
    where pairing.token_hash = run_record.token_hash
      and pairing.owner_id = p_owner_id
      and pairing.expires_at > statement_timestamp()
      and (
          run_record.status = 'active' or next_status = 'active'
          or not exists (
              select 1 from app.task_runs as active
              where active.owner_id = p_owner_id and active.status = 'active'
                and active.token_hash = run_record.token_hash
          )
      );

    insert into app.task_run_commands (
        id,
        task_run_id,
        owner_id,
        client_request_id,
        command,
        expected_state_version,
        result,
        active_run
    )
    values (
        p_command_id,
        p_task_run_id,
        p_owner_id,
        p_client_request_id,
        p_command,
        p_expected_state_version,
        result,
        active_request
    );
    return result;
end;
$$;

create or replace function app.apply_task_run_command(
    p_command_id uuid,
    p_task_run_id uuid,
    p_owner_id uuid,
    p_client_request_id uuid,
    p_command text,
    p_expected_state_version bigint
)
returns jsonb
language sql
volatile
security definer
set search_path = pg_catalog, app
as $$
    select app.apply_task_run_command(p_command_id, p_task_run_id, p_owner_id, p_client_request_id,
        p_command, p_expected_state_version, null, null);
$$;

revoke all on function app.pause_active_task_run(uuid, uuid, bigint, uuid) from public, metaglasses_api;
revoke all on function app.list_unfinished_task_runs(uuid) from public;
revoke all on function app.start_task_run(uuid, uuid, uuid, uuid, text, integer, uuid, bigint) from public;
revoke all on function app.apply_task_run_command(uuid, uuid, uuid, uuid, text, bigint, uuid, bigint) from public;
grant execute on function app.list_unfinished_task_runs(uuid) to metaglasses_api;
grant execute on function app.start_task_run(uuid, uuid, uuid, uuid, text, integer, uuid, bigint) to metaglasses_api;
grant execute on function app.apply_task_run_command(uuid, uuid, uuid, uuid, text, bigint, uuid, bigint) to metaglasses_api;
