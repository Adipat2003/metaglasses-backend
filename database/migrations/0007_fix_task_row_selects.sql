-- A bare table alias in the select list (`select run into run_record`) returns the whole row as one
-- composite value, which PL/pgSQL tries to assign to the first field of the record. That raised
-- "invalid input syntax for type uuid" the first time a task inference window was created, and
-- the same pattern breaks task run commands. Select the alias's columns (`run.*`) instead.
-- Redefine the three functions because migrations 0003, 0004 and 0005 have already been applied.

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

    select run.*
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

create or replace function app.create_task_inference_window(
    p_window_id uuid,
    p_task_run_id uuid,
    p_owner_id uuid,
    p_client_request_id uuid,
    p_sequence_number bigint,
    p_observed_state_version bigint,
    p_image_ids uuid[],
    p_captured_at jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app
as $$
declare
    existing_window app.task_inference_windows%rowtype;
    run_record app.task_runs%rowtype;
    image_count integer;
    largest_image_bytes bigint;
    latest_sequence bigint;
begin
    perform pg_advisory_xact_lock(hashtextextended(p_task_run_id::text, 0));

    select inference_window.* into existing_window
    from app.task_inference_windows as inference_window
    where inference_window.task_run_id = p_task_run_id
      and inference_window.client_request_id = p_client_request_id;
    if found then
        return jsonb_build_object(
            'outcome', 'accepted',
            'inferenceWindowId', existing_window.id,
            'sequenceNumber', existing_window.sequence_number,
            'status', existing_window.status,
            'stateVersion', existing_window.observed_state_version,
            'createdAt', existing_window.created_at
        );
    end if;

    select run.* into run_record
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
    if run_record.status <> 'active' then
        return jsonb_build_object('outcome', 'not_active');
    end if;
    if run_record.state_version <> p_observed_state_version then
        return jsonb_build_object('outcome', 'stale', 'stateVersion', run_record.state_version);
    end if;

    select count(*), max(image.byte_size) into image_count, largest_image_bytes
    from app.pairing_images as image
    where image.id = any(p_image_ids)
      and image.token_hash = run_record.token_hash
      and image.owner_id = p_owner_id
      and image.status = 'active'
      and image.expires_at > statement_timestamp();
    if image_count <> cardinality(p_image_ids) or largest_image_bytes > 2 * 1024 * 1024 then
        return jsonb_build_object('outcome', 'invalid_media');
    end if;

    select max(inference_window.sequence_number) into latest_sequence
    from app.task_inference_windows as inference_window
    where inference_window.task_run_id = p_task_run_id;
    if latest_sequence is not null and p_sequence_number <= latest_sequence then
        return jsonb_build_object('outcome', 'out_of_order');
    end if;

    insert into app.task_inference_windows (
        id,
        task_run_id,
        owner_id,
        client_request_id,
        sequence_number,
        observed_state_version,
        image_ids,
        captured_at,
        status
    )
    values (
        p_window_id,
        p_task_run_id,
        p_owner_id,
        p_client_request_id,
        p_sequence_number,
        p_observed_state_version,
        p_image_ids,
        p_captured_at,
        'queued'
    );
    return jsonb_build_object(
        'outcome', 'accepted',
        'inferenceWindowId', p_window_id,
        'sequenceNumber', p_sequence_number,
        'status', 'queued',
        'stateVersion', p_observed_state_version,
        'createdAt', statement_timestamp()
    );
end;
$$;

create or replace function app.claim_task_inference_window()
returns table (
    inference_window_id uuid,
    task_run_id uuid,
    owner_id uuid,
    token_hash text,
    image_ids uuid[],
    observed_state_version bigint,
    current_step_ordinal integer,
    source_steps jsonb,
    validation_result jsonb
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, app
as $$
declare
    candidate app.task_inference_windows%rowtype;
    run_record app.task_runs%rowtype;
begin
    select inference_window.* into candidate
    from app.task_inference_windows as inference_window
    where inference_window.status = 'queued'
       or (
            inference_window.status = 'processing'
            and inference_window.processing_at <= statement_timestamp() - interval '30 seconds'
       )
    order by inference_window.created_at, inference_window.id
    for update skip locked
    limit 1;
    if not found then
        return;
    end if;

    select run.* into run_record
    from app.task_runs as run
    join app.pairings as pairing
      on pairing.token_hash = run.token_hash
     and pairing.owner_id = run.owner_id
     and pairing.expires_at > statement_timestamp()
    where run.id = candidate.task_run_id
    for update of run;

    if not found or run_record.status <> 'active'
       or run_record.state_version <> candidate.observed_state_version then
        update app.task_inference_windows
        set status = 'rejected'
        where id = candidate.id;
        return;
    end if;

    update app.task_inference_windows
    set status = 'processing', processing_at = statement_timestamp()
    where id = candidate.id;

    return query
    select
        candidate.id,
        run_record.id,
        run_record.owner_id,
        encode(run_record.token_hash, 'hex'),
        candidate.image_ids,
        candidate.observed_state_version,
        run_record.current_step_ordinal,
        version.source_steps,
        version.validation_result
    from app.task_plan_versions as version
    where version.task_plan_id = run_record.task_plan_id
      and version.version = run_record.task_plan_version;
end;
$$;

revoke all on function app.apply_task_run_command(uuid, uuid, uuid, uuid, text, bigint) from public;
revoke all on function app.create_task_inference_window(
    uuid, uuid, uuid, uuid, bigint, bigint, uuid[], jsonb
) from public;
revoke all on function app.claim_task_inference_window() from public;

grant execute on function app.apply_task_run_command(uuid, uuid, uuid, uuid, text, bigint)
    to metaglasses_api;
grant execute on function app.create_task_inference_window(
    uuid, uuid, uuid, uuid, bigint, bigint, uuid[], jsonb
) to metaglasses_api;
grant execute on function app.claim_task_inference_window() to metaglasses_api;
