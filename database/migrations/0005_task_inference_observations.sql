create table app.task_inference_observations (
    id uuid primary key,
    task_inference_window_id uuid not null references app.task_inference_windows (id) on delete restrict,
    task_run_id uuid not null references app.task_runs (id) on delete restrict,
    owner_id uuid not null,
    model_id text not null,
    observation jsonb not null,
    created_at timestamptz not null default statement_timestamp(),
    constraint task_inference_observations_model_id_length check (char_length(model_id) between 1 and 200),
    constraint task_inference_observations_observation check (jsonb_typeof(observation) = 'object'),
    unique (task_inference_window_id)
);

alter table app.task_inference_windows
    add column processing_at timestamptz;

create index task_inference_observations_run_created_idx
    on app.task_inference_observations (task_run_id, created_at desc);

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
    select window into candidate
    from app.task_inference_windows as window
    where window.status = 'queued'
       or (
            window.status = 'processing'
            and window.processing_at <= statement_timestamp() - interval '30 seconds'
       )
    order by window.created_at, window.id
    for update skip locked
    limit 1;
    if not found then
        return;
    end if;

    select run into run_record
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

create or replace function app.complete_task_inference_window(
    p_observation_id uuid,
    p_inference_window_id uuid,
    p_owner_id uuid,
    p_model_id text,
    p_observation jsonb
)
returns text
language sql
volatile
security definer
set search_path = pg_catalog, app
as $$
    with completed as (
        update app.task_inference_windows as window
        set status = 'observed', processing_at = null
        from app.task_runs as run
        join app.pairings as pairing
          on pairing.token_hash = run.token_hash
         and pairing.owner_id = p_owner_id
         and pairing.expires_at > statement_timestamp()
        where window.id = p_inference_window_id
          and window.task_run_id = run.id
          and window.owner_id = p_owner_id
          and window.status = 'processing'
          and run.status = 'active'
          and run.state_version = window.observed_state_version
        returning window.id, window.task_run_id
    ), inserted as (
        insert into app.task_inference_observations (
            id, task_inference_window_id, task_run_id, owner_id, model_id, observation
        )
        select p_observation_id, completed.id, completed.task_run_id, p_owner_id, p_model_id, p_observation
        from completed
        returning id
    ), display_updated as (
        update app.pairings as pairing
        set response_id = 'task_observation_' || p_inference_window_id::text,
            response_text = case p_observation ->> 'proposedTransition'
                when 'candidate_complete' then 'Step may be complete. Confirm to continue.'
                when 'blocked' then 'Progress is unclear. Reposition the camera or correct the step.'
                else version.source_steps -> (run.current_step_ordinal - 1) ->> 'instruction'
            end,
            response_created_at = statement_timestamp(),
            state = 'speaking'
        from completed
        join app.task_runs as run on run.id = completed.task_run_id
        join app.task_plan_versions as version
          on version.task_plan_id = run.task_plan_id
         and version.version = run.task_plan_version
        where pairing.token_hash = run.token_hash
          and pairing.owner_id = p_owner_id
          and pairing.expires_at > statement_timestamp()
          and exists (select 1 from inserted)
        returning pairing.token_hash
    )
    select case
        when exists (select 1 from inserted) then 'observed'
        else 'stale_or_not_processing'
    end;
$$;

create or replace function app.reject_task_inference_window(
    p_inference_window_id uuid,
    p_owner_id uuid
)
returns boolean
language sql
volatile
security definer
set search_path = pg_catalog, app
as $$
    with rejected as (
        update app.task_inference_windows as window
        set status = 'rejected', processing_at = null
        where window.id = p_inference_window_id
          and window.owner_id = p_owner_id
          and window.status = 'processing'
        returning 1
    )
    select exists (select 1 from rejected);
$$;

revoke all on app.task_inference_observations from public;
revoke all on function app.claim_task_inference_window() from public;
revoke all on function app.complete_task_inference_window(uuid, uuid, uuid, text, jsonb) from public;
revoke all on function app.reject_task_inference_window(uuid, uuid) from public;

grant execute on function app.claim_task_inference_window() to metaglasses_api;
grant execute on function app.complete_task_inference_window(uuid, uuid, uuid, text, jsonb)
    to metaglasses_api;
grant execute on function app.reject_task_inference_window(uuid, uuid) to metaglasses_api;
