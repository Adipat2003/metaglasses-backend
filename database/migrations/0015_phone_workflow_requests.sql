create table app.phone_requests (
    owner_id uuid not null,
    operation text not null check (operation in ('goal_plan', 'plan_approval', 'phone_chat')),
    client_request_id uuid not null,
    request_digest bytea not null check (octet_length(request_digest) = 32),
    attempt_id uuid not null,
    lease_until timestamptz not null,
    expires_at timestamptz not null,
    result jsonb check (jsonb_typeof(result) = 'object' and octet_length(result::text) <= 32768),
    primary key (owner_id, operation, client_request_id)
);
create index phone_requests_expiry_idx on app.phone_requests (expires_at, owner_id, operation, client_request_id);

create function app.begin_phone_request(
    p_owner_id uuid, p_operation text, p_client_request_id uuid, p_attempt_id uuid, p_request_digest text
)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, app
as $$
declare
    saved app.phone_requests%rowtype;
    digest bytea := decode(p_request_digest, 'hex');
    request_time timestamptz := statement_timestamp();
begin
    insert into app.phone_requests as entry (
        owner_id, operation, client_request_id, attempt_id, request_digest, lease_until, expires_at
    ) values (
        p_owner_id, p_operation, p_client_request_id, p_attempt_id, digest,
        request_time + interval '6 minutes', request_time + interval '24 hours'
    )
    on conflict (owner_id, operation, client_request_id) do update
    set attempt_id = excluded.attempt_id, request_digest = excluded.request_digest,
        lease_until = excluded.lease_until, expires_at = excluded.expires_at, result = null
    where entry.expires_at <= request_time or (
        entry.request_digest = digest and entry.result is null and entry.lease_until <= request_time
    );
    if found then return jsonb_build_object('outcome', 'claimed'); end if;

    select entry.* into saved from app.phone_requests as entry
    where entry.owner_id = p_owner_id and entry.operation = p_operation
      and entry.client_request_id = p_client_request_id;
    if saved.request_digest is distinct from digest then
        return jsonb_build_object('outcome', 'conflict');
    end if;
    if saved.result is not null then
        return jsonb_build_object('outcome', 'replay', 'result', saved.result);
    end if;
    return jsonb_build_object('outcome', 'pending');
end;
$$;

create function app.release_phone_request(
    p_owner_id uuid, p_operation text, p_client_request_id uuid, p_attempt_id uuid
)
returns void
language sql volatile security definer
set search_path = pg_catalog, app
as $$
    update app.phone_requests as entry set lease_until = statement_timestamp()
    where entry.owner_id = p_owner_id and entry.operation = p_operation
      and entry.client_request_id = p_client_request_id and entry.attempt_id = p_attempt_id
      and entry.result is null;
$$;

create function app.task_plan_owner_view(p_task_plan_id uuid, p_owner_id uuid)
returns jsonb
language sql stable security definer
set search_path = pg_catalog, app
as $$
    select app.task_plan_view(plan.id, p_owner_id)
    from app.task_plans as plan
    where plan.id = p_task_plan_id and plan.owner_id = p_owner_id;
$$;

create function app.phone_chat_context(
    p_owner_id uuid, p_task_run_id uuid, p_state_version bigint, p_observation_window_id uuid
)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, app
as $$
declare
    run_record app.task_runs%rowtype;
    step jsonb;
    last_capture text;
    capture_time timestamptz;
    observation_summary text;
    window_state_version bigint;
begin
    select run.* into run_record
    from app.task_runs as run where run.id = p_task_run_id and run.owner_id = p_owner_id;
    if not found then return jsonb_build_object('outcome', 'not_found'); end if;
    if run_record.state_version is distinct from p_state_version or run_record.status <> 'active' then
        return jsonb_build_object('outcome', 'stale', 'stateVersion', run_record.state_version);
    end if;

    if p_observation_window_id is not null then
        select inference_window.observed_state_version, inference_window.captured_at ->> -1,
               observation.observation ->> 'summary'
        into window_state_version, last_capture, observation_summary
        from app.task_inference_windows as inference_window
        left join app.task_inference_observations as observation
          on observation.task_inference_window_id = inference_window.id
         and observation.task_run_id = p_task_run_id and observation.owner_id = p_owner_id
         and inference_window.status = 'observed'
        where inference_window.id = p_observation_window_id
          and inference_window.task_run_id = p_task_run_id and inference_window.owner_id = p_owner_id;
        if not found then return jsonb_build_object('outcome', 'observation_not_found'); end if;
        if pg_input_is_valid(last_capture, 'timestamptz') then
            capture_time := last_capture::timestamptz;
        end if;
        if window_state_version is distinct from p_state_version or observation_summary is null
            or capture_time is null or capture_time < statement_timestamp() - interval '10 seconds'
            or capture_time > statement_timestamp() + interval '5 seconds'
        then
            return jsonb_build_object('outcome', 'observation_stale');
        end if;
    end if;

    select version.source_steps -> (run_record.current_step_ordinal - 1) into step
    from app.task_plan_versions as version
    where version.task_plan_id = run_record.task_plan_id and version.version = run_record.task_plan_version;
    return jsonb_strip_nulls(jsonb_build_object('outcome', 'ready',
        'stepOrdinal', run_record.current_step_ordinal, 'step', step, 'observation', observation_summary));
end;
$$;

create function app.finish_phone_request(
    p_owner_id uuid, p_operation text, p_client_request_id uuid, p_attempt_id uuid,
    p_resource_id uuid, p_expected_version bigint, p_output jsonb
)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, app
as $$
declare
    saved_result jsonb;
    approved text;
    run_record app.task_runs%rowtype;
begin
    perform 1 from app.phone_requests as entry
    where entry.owner_id = p_owner_id and entry.operation = p_operation
      and entry.client_request_id = p_client_request_id and entry.attempt_id = p_attempt_id
      and entry.result is null and entry.lease_until > statement_timestamp()
    for update;
    if not found then return jsonb_build_object('outcome', 'lease_lost'); end if;

    case p_operation
        when 'goal_plan' then
            saved_result := app.create_task_plan_library(p_resource_id, p_owner_id, p_client_request_id,
                p_output ->> 'title', p_output -> 'steps');
            saved_result := case when saved_result ? 'access' then saved_result
                else jsonb_build_object('taskPlanId', saved_result ->> 'taskPlanId') end;
        when 'plan_approval' then
            approved := app.approve_task_plan_with_review(p_resource_id, p_owner_id,
                p_expected_version::integer, p_output);
            saved_result := jsonb_build_object('outcome', approved);
            if approved = 'guidelines_failed' then
                saved_result := saved_result || jsonb_build_object('blockerCount', jsonb_array_length(p_output -> 'approvalBlockers'));
            end if;
        when 'phone_chat' then
            if p_resource_id is not null then
                select run.* into run_record from app.task_runs as run
                where run.id = p_resource_id and run.owner_id = p_owner_id
                for share;
                if not found then return jsonb_build_object('outcome', 'not_found'); end if;
                if run_record.status <> 'active' or run_record.state_version is distinct from p_expected_version then
                    return jsonb_build_object('outcome', 'stale', 'stateVersion', run_record.state_version);
                end if;
            end if;
            saved_result := p_output || jsonb_strip_nulls(jsonb_build_object(
                'taskRunId', p_resource_id, 'stateVersion', p_expected_version));
    end case;

    update app.phone_requests as entry set result = saved_result
    where entry.owner_id = p_owner_id and entry.operation = p_operation
      and entry.client_request_id = p_client_request_id;
    return saved_result;
end;
$$;

create function app.delete_expired_phone_requests()
returns integer
language sql volatile security definer
set search_path = pg_catalog, app
as $$
    with candidates as (
        select owner_id, operation, client_request_id from app.phone_requests
        where expires_at <= statement_timestamp()
        order by expires_at, owner_id, operation, client_request_id
        limit 500 for update skip locked
    ), deleted as (
        delete from app.phone_requests as entry using candidates
        where entry.owner_id = candidates.owner_id and entry.operation = candidates.operation
          and entry.client_request_id = candidates.client_request_id
        returning 1
    )
    select count(*)::integer from deleted;
$$;

revoke all on app.phone_requests from public;
revoke all on function app.begin_phone_request(uuid, text, uuid, uuid, text) from public;
revoke all on function app.release_phone_request(uuid, text, uuid, uuid) from public;
revoke all on function app.finish_phone_request(uuid, text, uuid, uuid, uuid, bigint, jsonb) from public;
revoke all on function app.delete_expired_phone_requests() from public;
revoke all on function app.task_plan_owner_view(uuid, uuid) from public;
revoke all on function app.phone_chat_context(uuid, uuid, bigint, uuid) from public;
grant execute on function app.begin_phone_request(uuid, text, uuid, uuid, text) to metaglasses_api;
grant execute on function app.release_phone_request(uuid, text, uuid, uuid) to metaglasses_api;
grant execute on function app.finish_phone_request(uuid, text, uuid, uuid, uuid, bigint, jsonb) to metaglasses_api;
grant execute on function app.delete_expired_phone_requests() to metaglasses_api;
grant execute on function app.task_plan_owner_view(uuid, uuid) to metaglasses_api;
grant execute on function app.phone_chat_context(uuid, uuid, bigint, uuid) to metaglasses_api;
