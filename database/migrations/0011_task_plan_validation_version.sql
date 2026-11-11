create or replace function app.save_task_plan_validation_for_version(
    p_task_plan_id uuid,
    p_owner_id uuid,
    p_expected_version integer,
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
                when coalesce((p_validation_result ->> 'approvalReady')::boolean, false)
                 and coalesce((p_validation_result ->> 'needsUserClarification')::boolean, true) = false
                 and case
                    when jsonb_typeof(p_validation_result -> 'approvalBlockers') = 'array'
                        then jsonb_array_length(p_validation_result -> 'approvalBlockers') = 0
                    else false
                 end
                 and case
                    when jsonb_typeof(p_validation_result -> 'unsupportedClaims') = 'array'
                        then jsonb_array_length(p_validation_result -> 'unsupportedClaims') = 0
                    else false
                 end
                    then 'validated'
                else 'needs_clarification'
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
          and plan.current_version = p_expected_version
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


revoke all on function app.save_task_plan_validation_for_version(uuid, uuid, integer, jsonb) from public;
grant execute on function app.save_task_plan_validation_for_version(uuid, uuid, integer, jsonb) to metaglasses_api;
