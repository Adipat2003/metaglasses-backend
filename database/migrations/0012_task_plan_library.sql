alter table app.task_plans drop constraint task_plans_token_hash_fkey;
alter table app.task_plans alter column token_hash drop not null;

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
        'expiresAt', case when plan.status = 'approved' then null else plan.created_at + interval '2 hours' end,
        'sourceSteps', version.source_steps,
        'validationStatus', version.validation_status,
        'validation', version.validation_result,
        'revisionHistory', case when plan.owner_id = p_owner_id then coalesce((
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
        ), '[]'::jsonb) else '[]'::jsonb end
    )
    from app.task_plans as plan
    join app.task_plan_versions as version
      on version.task_plan_id = plan.id
     and version.version = plan.current_version
    where plan.id = p_task_plan_id
      and (plan.owner_id = p_owner_id or plan.status = 'approved')
      and (plan.status = 'approved' or plan.created_at > statement_timestamp() - interval '2 hours');
$$;

create index task_plans_owner_library_idx on app.task_plans (owner_id, created_at desc, id desc);
create index task_plans_approved_library_idx on app.task_plans (created_at desc, id desc)
    where status = 'approved';
create index task_plans_expiry_idx on app.task_plans (created_at, id) where status <> 'approved';

drop index app.task_runs_one_active_plan_idx;
create unique index task_runs_one_active_plan_idx
    on app.task_runs (owner_id, task_plan_id, task_plan_version)
    where status in ('active', 'paused');

create or replace function app.list_task_plans(
    p_owner_id uuid,
    p_status text,
    p_limit integer,
    p_offset integer
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, app
as $$
    with page as (
        select plan.id, plan.owner_id, plan.title, plan.status, plan.current_version, plan.approved_version,
               plan.created_at, plan.updated_at
        from app.task_plans as plan
        where (plan.owner_id = p_owner_id or plan.status = 'approved')
          and (plan.status = 'approved' or plan.created_at > statement_timestamp() - interval '2 hours')
          and (p_status is null or plan.status = p_status)
        order by plan.created_at desc, plan.id desc
        limit least(greatest(p_limit, 1), 100) + 1
        offset greatest(p_offset, 0)
    ), numbered as (
        select page.*, row_number() over (order by page.created_at desc, page.id desc) as row_number
        from page
    )
    select jsonb_build_object(
        'items', coalesce(jsonb_agg(jsonb_build_object(
            'taskPlanId', id, 'title', title, 'status', status, 'isOwner', owner_id = p_owner_id,
            'currentVersion', current_version, 'approvedVersion', approved_version,
            'createdAt', created_at, 'updatedAt', updated_at,
            'expiresAt', case when status = 'approved' then null else created_at + interval '2 hours' end
        ) order by created_at desc, id desc) filter (where row_number <= p_limit), '[]'::jsonb),
        'nextOffset', case when count(*) > p_limit then p_offset + p_limit else null end
    ) from numbered;
$$;

create or replace function app.start_task_run_for_pairing(
    p_task_run_id uuid,
    p_task_plan_id uuid,
    p_owner_id uuid,
    p_client_request_id uuid,
    p_token_hash text
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
begin
    perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || p_client_request_id::text, 0));
    select run.* into prior from app.task_runs as run
    where run.owner_id = p_owner_id and run.client_request_id = p_client_request_id;
    if found then
        if prior.task_plan_id <> p_task_plan_id or prior.token_hash <> pairing_hash then
            return jsonb_build_object('outcome', 'idempotency_conflict');
        end if;
        return app.task_run_view(prior.id, p_owner_id);
    end if;

    perform 1 from app.pairings as pairing
    where pairing.token_hash = pairing_hash and pairing.owner_id = p_owner_id
      and pairing.expires_at > statement_timestamp()
    for share;
    if not found then return null; end if;

    select plan.* into selected_plan from app.task_plans as plan
    join app.task_plan_versions as version
      on version.task_plan_id = plan.id and version.version = plan.approved_version
     and version.validation_status = 'validated'
    where plan.id = p_task_plan_id and plan.status = 'approved';
    if not found then return null; end if;

    begin
        insert into app.task_runs (id, task_plan_id, task_plan_version, token_hash, owner_id, client_request_id)
        values (p_task_run_id, selected_plan.id, selected_plan.approved_version, pairing_hash, p_owner_id, p_client_request_id);
    exception when unique_violation then
        return jsonb_build_object('outcome', 'active_exists');
    end;
    return app.task_run_view(p_task_run_id, p_owner_id);
end;
$$;

revoke all on function app.list_task_plans(uuid, text, integer, integer) from public;
revoke all on function app.start_task_run_for_pairing(uuid, uuid, uuid, uuid, text) from public;
grant execute on function app.list_task_plans(uuid, text, integer, integer) to metaglasses_api;
grant execute on function app.start_task_run_for_pairing(uuid, uuid, uuid, uuid, text) to metaglasses_api;

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
    where plan.id = p_task_plan_id
      and plan.owner_id = p_owner_id
      and (plan.status = 'approved' or plan.created_at > statement_timestamp() - interval '2 hours')
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
    where plan.id = p_task_plan_id
      and plan.owner_id = p_owner_id
      and (plan.status = 'approved' or plan.created_at > statement_timestamp() - interval '2 hours')
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
        where version.task_plan_id = plan.id
          and version.version = plan.current_version
          and plan.id = p_task_plan_id
          and plan.owner_id = p_owner_id
          and plan.status = 'draft'
          and plan.created_at > statement_timestamp() - interval '2 hours'
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

create or replace function app.create_task_plan_library(
    p_task_plan_id uuid,
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
begin
    perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || p_client_request_id::text, 0));
    select plan.id into existing_plan_id from app.task_plans as plan
    where plan.owner_id = p_owner_id and plan.client_request_id = p_client_request_id;
    if found then
        if not exists (select 1 from app.task_plans as plan where plan.id = existing_plan_id
            and (plan.status = 'approved' or plan.created_at > statement_timestamp() - interval '2 hours')) then
            return jsonb_build_object('access', 'expired');
        end if;
        if not exists (
            select 1 from app.task_plans as plan
            join app.task_plan_versions as original on original.task_plan_id = plan.id and original.version = 1
            where plan.id = existing_plan_id and plan.token_hash is null
              and plan.title = p_title and original.source_steps = p_source_steps
        ) then return jsonb_build_object('access', 'idempotency_conflict'); end if;
        return app.task_plan_view(existing_plan_id, p_owner_id);
    end if;
    insert into app.task_plans (id, token_hash, owner_id, client_request_id, title, status, current_version)
    values (p_task_plan_id, null, p_owner_id, p_client_request_id, p_title, 'draft', 1);
    insert into app.task_plan_versions (task_plan_id, version, source_steps)
    values (p_task_plan_id, 1, p_source_steps);
    return app.task_plan_view(p_task_plan_id, p_owner_id);
end;
$$;
revoke all on function app.create_task_plan_library(uuid, uuid, uuid, text, jsonb) from public;
grant execute on function app.create_task_plan_library(uuid, uuid, uuid, text, jsonb) to metaglasses_api;

create or replace function app.delete_expired_task_plans()
returns integer
language sql
volatile
security definer
set search_path = pg_catalog, app
as $$
    with candidates as (
        select plan.id from app.task_plans as plan
        where plan.status <> 'approved'
          and plan.created_at <= statement_timestamp() - interval '2 hours'
          and not exists (select 1 from app.task_runs as run where run.task_plan_id = plan.id)
        order by plan.created_at, plan.id
        limit 100
        for update of plan skip locked
    ), deleted as (
        delete from app.task_plans as plan using candidates
        where plan.id = candidates.id and plan.status <> 'approved'
          and plan.created_at <= statement_timestamp() - interval '2 hours'
        returning plan.id
    )
    select count(*)::integer from deleted;
$$;
revoke all on function app.delete_expired_task_plans() from public;
grant execute on function app.delete_expired_task_plans() to metaglasses_api;

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
        if not exists (
            select 1
            from app.task_plans as plan
            join app.task_plan_versions as original
              on original.task_plan_id = plan.id and original.version = 1
            where plan.id = existing_plan_id
              and plan.token_hash = decode(p_token_hash, 'hex')
              and plan.title = p_title
              and original.source_steps = p_source_steps
        ) then
            return jsonb_build_object('access', 'idempotency_conflict');
        end if;
        return coalesce(app.task_plan_view(existing_plan_id, p_owner_id), jsonb_build_object('access', 'expired'));
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
