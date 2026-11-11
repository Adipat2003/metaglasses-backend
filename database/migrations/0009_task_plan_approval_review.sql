create or replace function app.approve_task_plan_with_review(
    p_task_plan_id uuid,
    p_owner_id uuid,
    p_expected_version integer,
    p_validation_result jsonb
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, app
as $$
declare
    plan_record app.task_plans%rowtype;
    v_validation_status text;
begin
    select plan.*
    into plan_record
    from app.task_plans as plan
    join app.pairings as pairing
      on pairing.token_hash = plan.token_hash
     and pairing.owner_id = p_owner_id
     and pairing.expires_at > statement_timestamp()
    where plan.id = p_task_plan_id
      and plan.owner_id = p_owner_id
    for update of plan;

    if not found then
        return 'not_found';
    end if;
    if plan_record.current_version <> p_expected_version then
        return 'stale';
    end if;
    if plan_record.status = 'approved'
       and plan_record.approved_version = plan_record.current_version then
        return 'approved';
    end if;
    if plan_record.status not in ('draft', 'awaiting_approval') then
        return 'not_approvable';
    end if;
    if exists (
        select 1 from app.task_runs as run where run.task_plan_id = p_task_plan_id
    ) then
        return 'has_runs';
    end if;

    v_validation_status := case
        when coalesce((p_validation_result ->> 'approvalReady')::boolean, false)
         and coalesce((p_validation_result ->> 'needsUserClarification')::boolean, true) = false
         and case
            when jsonb_typeof(p_validation_result -> 'approvalBlockers') = 'array'
                then jsonb_array_length(p_validation_result -> 'approvalBlockers') = 0
            else false
         end
         and coalesce((p_validation_result #>> '{guidelineChecks,clarity}')::boolean, false)
         and coalesce((p_validation_result #>> '{guidelineChecks,completeness}')::boolean, false)
         and coalesce((p_validation_result #>> '{guidelineChecks,observability}')::boolean, false)
         and coalesce((p_validation_result #>> '{guidelineChecks,safety}')::boolean, false)
         and case
            when jsonb_typeof(p_validation_result -> 'unsupportedClaims') = 'array'
                then jsonb_array_length(p_validation_result -> 'unsupportedClaims') = 0
            else false
         end
        then 'validated'
        else 'needs_clarification'
    end;

    update app.task_plan_versions as version
    set validation_status = v_validation_status,
        validation_result = p_validation_result,
        validated_at = statement_timestamp()
    where version.task_plan_id = p_task_plan_id
      and version.version = plan_record.current_version;

    if v_validation_status = 'validated' then
        update app.task_plans
        set status = 'approved',
            approved_version = plan_record.current_version,
            updated_at = statement_timestamp()
        where id = p_task_plan_id;
        return 'approved';
    end if;

    update app.task_plans
    set status = 'draft',
        approved_version = null,
        updated_at = statement_timestamp()
    where id = p_task_plan_id;
    return 'guidelines_failed';
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

revoke all on function app.approve_task_plan(uuid, uuid) from metaglasses_api;
revoke all on function app.save_task_plan_validation(uuid, uuid, jsonb) from public;
revoke all on function app.approve_task_plan_with_review(uuid, uuid, integer, jsonb) from public;
grant execute on function app.save_task_plan_validation(uuid, uuid, jsonb) to metaglasses_api;
grant execute on function app.approve_task_plan_with_review(uuid, uuid, integer, jsonb) to metaglasses_api;
