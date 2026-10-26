create or replace function app.publish_task_run_start(
    p_task_run_id uuid,
    p_owner_id uuid
)
returns boolean
language sql
volatile
security definer
set search_path = pg_catalog, app
as $$
    with published as (
        update app.pairings as pairing
        set response_id = 'task_run_' || run.id::text,
            response_text = version.source_steps -> 0 ->> 'instruction',
            response_created_at = statement_timestamp(),
            state = 'speaking'
        from app.task_runs as run
        join app.task_plan_versions as version
          on version.task_plan_id = run.task_plan_id
         and version.version = run.task_plan_version
        where run.id = p_task_run_id
          and run.owner_id = p_owner_id
          and run.status = 'active'
          and pairing.token_hash = run.token_hash
          and pairing.owner_id = p_owner_id
          and pairing.expires_at > statement_timestamp()
        returning 1
    )
    select exists (select 1 from published);
$$;

revoke all on function app.publish_task_run_start(uuid, uuid) from public;
grant execute on function app.publish_task_run_start(uuid, uuid) to metaglasses_api;
