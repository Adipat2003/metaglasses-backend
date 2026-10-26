alter table app.task_runs
    drop constraint task_runs_status_check,
    drop constraint task_runs_stopped_state,
    add column current_step_status text not null default 'in_progress',
    add constraint task_runs_status_check check (status in ('active', 'paused', 'stopped', 'completed')),
    add constraint task_runs_current_step_status check (current_step_status in ('in_progress', 'confirmed', 'skipped')),
    add constraint task_runs_terminal_state check (
        (status in ('stopped', 'completed') and stopped_at is not null)
        or (status not in ('stopped', 'completed') and stopped_at is null)
    );

create table app.task_run_commands (
    id uuid primary key,
    task_run_id uuid not null references app.task_runs (id) on delete restrict,
    owner_id uuid not null,
    client_request_id uuid not null,
    command text not null,
    expected_state_version bigint not null,
    result jsonb not null,
    created_at timestamptz not null default statement_timestamp(),
    constraint task_run_commands_command check (
        command in ('pause', 'resume', 'repeat', 'confirm', 'skip', 'back', 'correct', 'stop')
    ),
    constraint task_run_commands_expected_state_version check (expected_state_version > 0),
    constraint task_run_commands_result check (jsonb_typeof(result) = 'object'),
    unique (task_run_id, client_request_id)
);

create index task_run_commands_run_created_idx on app.task_run_commands (task_run_id, created_at);

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
    join app.pairings as pairing
      on pairing.token_hash = run.token_hash
     and pairing.owner_id = p_owner_id
     and pairing.expires_at > statement_timestamp()
    where run.id = p_task_run_id
      and run.owner_id = p_owner_id;
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
language plpgsql
volatile
security definer
set search_path = pg_catalog, app
as $$
declare
    existing_result jsonb;
    run_record app.task_runs%rowtype;
    source_steps jsonb;
    step_count integer;
    next_status text;
    next_step_ordinal integer;
    next_step_status text;
    next_lens_instruction text;
    result jsonb;
begin
    perform pg_advisory_xact_lock(
        hashtextextended(p_task_run_id::text || ':' || p_client_request_id::text, 0)
    );

    select command.result into existing_result
    from app.task_run_commands as command
    where command.task_run_id = p_task_run_id
      and command.client_request_id = p_client_request_id;
    if found then
        return existing_result;
    end if;

    select run
    into run_record
    from app.task_runs as run
    join app.pairings as pairing
      on pairing.token_hash = run.token_hash
     and pairing.owner_id = p_owner_id
     and pairing.expires_at > statement_timestamp()
    where run.id = p_task_run_id
      and run.owner_id = p_owner_id
    for update of run;

    if not found then
        return jsonb_build_object('outcome', 'not_found');
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
      and pairing.expires_at > statement_timestamp();

    insert into app.task_run_commands (
        id,
        task_run_id,
        owner_id,
        client_request_id,
        command,
        expected_state_version,
        result
    )
    values (
        p_command_id,
        p_task_run_id,
        p_owner_id,
        p_client_request_id,
        p_command,
        p_expected_state_version,
        result
    );
    return result;
end;
$$;

revoke all on app.task_run_commands from public;
revoke all on function app.task_run_view(uuid, uuid) from public;
revoke all on function app.apply_task_run_command(uuid, uuid, uuid, uuid, text, bigint) from public;

grant execute on function app.task_run_view(uuid, uuid) to metaglasses_api;
grant execute on function app.apply_task_run_command(uuid, uuid, uuid, uuid, text, bigint)
    to metaglasses_api;
