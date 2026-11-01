alter table app.task_plan_versions
    add column revision_request_id uuid,
    add column revision_request text,
    add column revision_summary text;

alter table app.task_plan_versions
    add constraint task_plan_versions_revision_fields check (
        (version = 1 and revision_request_id is null and revision_request is null and revision_summary is null)
        or (
            version > 1
            and revision_request_id is not null
            and revision_request is not null
            and revision_summary is not null
            and char_length(revision_request) between 1 and 2_000
            and char_length(revision_summary) between 1 and 500
        )
    );

create unique index task_plan_versions_revision_request_idx
    on app.task_plan_versions (task_plan_id, revision_request_id)
    where revision_request_id is not null;

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
        'validation', version.validation_result,
        'revisionHistory', coalesce((
            select jsonb_agg(
                jsonb_build_object(
                    'clientRequestId', revision.revision_request_id,
                    'request', revision.revision_request,
                    'summary', revision.revision_summary,
                    'version', revision.version
                ) order by revision.version
            )
            from app.task_plan_versions as revision
            where revision.task_plan_id = plan.id
              and revision.version > 1
        ), '[]'::jsonb)
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

create or replace function app.refine_task_plan(
    p_task_plan_id uuid,
    p_owner_id uuid,
    p_expected_version integer,
    p_client_request_id uuid,
    p_source_steps jsonb,
    p_revision_request text,
    p_revision_summary text
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, app
as $$
declare
    plan_record app.task_plans%rowtype;
    existing_request text;
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

    select version.revision_request into existing_request
    from app.task_plan_versions as version
    where version.task_plan_id = p_task_plan_id
      and version.revision_request_id = p_client_request_id;
    if found then
        if existing_request = p_revision_request then
            return 'already_applied';
        end if;
        return 'idempotency_conflict';
    end if;

    if plan_record.status not in ('draft', 'awaiting_approval') then
        return 'not_refinable';
    end if;
    if exists (
        select 1 from app.task_runs as run where run.task_plan_id = p_task_plan_id
    ) then
        return 'has_runs';
    end if;
    if plan_record.current_version <> p_expected_version then
        return 'stale';
    end if;
    if plan_record.current_version >= 11 then
        return 'revision_limit';
    end if;

    insert into app.task_plan_versions (
        task_plan_id,
        version,
        source_steps,
        revision_request_id,
        revision_request,
        revision_summary
    )
    values (
        p_task_plan_id,
        plan_record.current_version + 1,
        p_source_steps,
        p_client_request_id,
        p_revision_request,
        p_revision_summary
    );

    update app.task_plans
    set current_version = plan_record.current_version + 1,
        status = 'draft',
        approved_version = null,
        updated_at = statement_timestamp()
    where id = p_task_plan_id;

    return 'saved';
end;
$$;

revoke all on function app.refine_task_plan(uuid, uuid, integer, uuid, jsonb, text, text) from public;
grant execute on function app.refine_task_plan(uuid, uuid, integer, uuid, jsonb, text, text) to metaglasses_api;
