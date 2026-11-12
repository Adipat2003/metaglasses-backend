-- Synthetic data exercises the migration without a hosted service.
insert into app.pairings (token_hash, owner_id, state, last_phone_activity, expires_at)
values
 (decode(repeat('aa', 32), 'hex'), '11111111-1111-4111-8111-111111111111', 'idle', now() - interval '2 hours', now() - interval '1 hour'),
 (decode(repeat('bb', 32), 'hex'), '22222222-2222-4222-8222-222222222222', 'idle', now(), now() + interval '1 hour'),
 (decode(repeat('cc', 32), 'hex'), '11111111-1111-4111-8111-111111111111', 'idle', now(), now() + interval '1 hour'),
 (decode(repeat('dd', 32), 'hex'), '33333333-3333-4333-8333-333333333333', 'idle', now(), now() + interval '1 hour');

insert into app.task_plans (id, token_hash, owner_id, client_request_id, title, status, current_version, approved_version, created_at)
values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', decode(repeat('aa', 32), 'hex'), '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac1', 'Shared plan', 'approved', 2, 2, now() - interval '3 hours'),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', null, '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac2', 'Private draft', 'draft', 1, null, now() - interval '1 hour'),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5', null, '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac6', 'Expired draft', 'draft', 1, null, now() - interval '3 hours'),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7', null, '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac7', 'Expired review', 'awaiting_approval', 1, null, now() - interval '3 hours');
insert into app.task_plan_versions (task_plan_id, version, source_steps, validation_status, validation_result, validated_at)
values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 1, '[{"ordinal":1,"instruction":"Place a cup."}]', 'validated', '{}', now()),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 1, '[{"ordinal":1,"instruction":"Move a cup."}]', 'not_validated', null, null),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5', 1, '[{"ordinal":1,"instruction":"Expired."}]', 'not_validated', null, null),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7', 1, '[{"ordinal":1,"instruction":"Review."}]', 'validated', '{}', now());
insert into app.task_plan_versions (task_plan_id, version, source_steps, validation_status, validation_result, validated_at, revision_request_id, revision_request, revision_summary)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 2, '[{"ordinal":1,"instruction":"Place a cup."}]', 'validated', '{}', now(),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaad1', 'Private request', 'Changed');

create extension if not exists dblink;
select dblink_connect('expiry_lock', 'dbname=postgres user=postgres');
select dblink_exec('expiry_lock', 'begin');
select * from dblink('expiry_lock', $$select id::text from app.task_plans where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5' for update$$) as locked(id text);

grant usage on schema app to metaglasses_api;
set role metaglasses_api;
do $$
declare
    owner_id uuid := '11111111-1111-4111-8111-111111111111';
    other_id uuid := '22222222-2222-4222-8222-222222222222';
    approved_id uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
    draft_id uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
    result jsonb;
begin
    if has_table_privilege(current_user, 'app.task_plans', 'select') then
        raise exception 'runtime role must not read plan tables directly';
    end if;
    result := app.list_task_plans(owner_id, null, 1, 0);
    if jsonb_array_length(result->'items') <> 1 or result->'items'->0->>'taskPlanId' <> draft_id::text
        or (result->>'nextOffset')::integer <> 1 then raise exception 'invalid first page'; end if;
    result := app.list_task_plans(owner_id, null, 1, 1);
    if result->'items'->0->>'taskPlanId' <> approved_id::text or result->'nextOffset' <> 'null'::jsonb then
        raise exception 'invalid final page';
    end if;
    result := app.list_task_plans(other_id, null, 50, 0);
    if jsonb_array_length(result->'items') <> 1 or result->'items'->0->>'taskPlanId' <> approved_id::text then
        raise exception 'shared plans or private drafts have incorrect visibility';
    end if;
    if (result->'items'->0->>'isOwner')::boolean then raise exception 'ownership label is incorrect'; end if;
    result := app.list_task_plans(other_id, 'draft', 50, 0);
    if jsonb_array_length(result->'items') <> 0 then raise exception 'private draft leaked through filter'; end if;
    if app.task_plan_view(draft_id, other_id) is not null or app.task_plan_view(approved_id, other_id) is null then
        raise exception 'plan read visibility is incorrect';
    end if;
    if jsonb_array_length(app.task_plan_view(approved_id, other_id)->'revisionHistory') <> 0
        or jsonb_array_length(app.task_plan_view(approved_id, owner_id)->'revisionHistory') <> 1 then
        raise exception 'revision history privacy failed';
    end if;
    if app.task_plan_view('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5', owner_id) is not null then
        raise exception 'expired draft remains visible';
    end if;
    result := app.create_task_plan_library('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6', owner_id,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac6', 'Expired draft', '[{"ordinal":1,"instruction":"Expired."}]');
    if result->>'access' <> 'expired' then raise exception 'expired creation retry was not rejected'; end if;
    if app.approve_task_plan_with_review('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5', owner_id, 1,
        '{"approvalReady":true,"needsUserClarification":false,"approvalBlockers":[],"unsupportedClaims":[],"guidelineChecks":{"clarity":true,"completeness":true,"observability":true,"safety":true}}') <> 'not_found' then
        raise exception 'expired draft was approvable';
    end if;
    if app.task_plan_view(approved_id, other_id)->'expiresAt' <> 'null'::jsonb then
        raise exception 'approved plan must not have an expiry';
    end if;
    if app.delete_expired_task_plans() <> 1 then raise exception 'cleanup did not delete the expired review or skipped a lock incorrectly'; end if;
    perform dblink_exec('expiry_lock', 'commit');
    if app.delete_expired_task_plans() <> 1 then raise exception 'expired draft was not deleted'; end if;
    if app.task_plan_view(approved_id, other_id) is null then raise exception 'old approved plan was deleted'; end if;
    result := app.create_task_plan_library('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', other_id,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac3', 'Own draft', '[{"instruction":"Do it."}]');
    if result->>'title' <> 'Own draft' then raise exception 'pairing-free creation failed'; end if;
    result := app.create_task_plan_library('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', other_id,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac3', 'Own draft', '[{"instruction":"Do it."}]');
    if result->>'taskPlanId' <> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3' then raise exception 'creation retry made a duplicate'; end if;
    result := app.create_task_plan_library('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', other_id,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac3', 'Different', '[{"instruction":"Do it."}]');
    if result->>'access' <> 'idempotency_conflict' then raise exception 'creation idempotency failed'; end if;
    if app.refine_task_plan(draft_id, other_id, 1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac4',
        '[{"ordinal":1,"instruction":"Move it."}]', 'Change it', 'Changed') <> 'not_found' then
        raise exception 'cross-user draft modification was allowed';
    end if;
    if app.refine_task_plan(draft_id, owner_id, 1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaac5',
        '[{"ordinal":1,"instruction":"Move it."}]', 'Change it', 'Changed') <> 'saved' then
        raise exception 'pairing-free refinement failed';
    end if;
    if app.save_task_plan_validation_for_version(draft_id, owner_id, 2,
        '{"approvalReady":true,"needsUserClarification":false,"approvalBlockers":[],"unsupportedClaims":[]}') <> 'saved' then
        raise exception 'pairing-free validation failed';
    end if;
    if app.approve_task_plan_with_review(draft_id, other_id, 2,
        '{"approvalReady":true,"needsUserClarification":false,"approvalBlockers":[],"unsupportedClaims":[],"guidelineChecks":{"clarity":true,"completeness":true,"observability":true,"safety":true}}') <> 'not_found' then
        raise exception 'cross-user approval was allowed';
    end if;
    result := app.start_task_run_for_pairing('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab1', approved_id,
        other_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaae1', repeat('bb', 32));
    if result->>'status' <> 'active' or result->>'taskPlanId' <> approved_id::text then raise exception 'shared start failed'; end if;
    result := app.start_task_run_for_pairing('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab2', approved_id,
        owner_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaae2', repeat('cc', 32));
    if result->>'status' <> 'active' then raise exception 'different users must run shared plan concurrently'; end if;
    result := app.start_task_run_for_pairing('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab3', approved_id,
        other_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaae1', repeat('bb', 32));
    if result->>'taskRunId' <> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab1' then raise exception 'retry was not idempotent'; end if;
    result := app.start_task_run_for_pairing('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab3', approved_id,
        other_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaae1', repeat('cc', 32));
    if result->>'outcome' <> 'idempotency_conflict' then raise exception 'changed retry was not rejected'; end if;
    result := app.start_task_run_for_pairing('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab3', approved_id,
        other_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaae3', repeat('bb', 32));
    if result->>'outcome' <> 'active_exists' then raise exception 'duplicate active run was not rejected'; end if;
    result := app.apply_task_run_command('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaf1',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab1', other_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaf2', 'confirm', 1);
    if result->>'status' <> 'completed' or result->>'stateVersion' <> '2' then
        raise exception 'selected plan did not follow the run state machine';
    end if;
    if app.start_task_run_for_pairing('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab3', draft_id,
        other_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaae4', repeat('bb', 32)) is not null then
        raise exception 'unapproved plan was runnable';
    end if;
    if app.start_task_run_for_pairing('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab3', approved_id,
        other_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaae4', repeat('cc', 32)) is not null then
        raise exception 'another user pairing was usable';
    end if;
    if app.approve_task_plan_with_review(draft_id, owner_id, 2,
        '{"approvalReady":true,"needsUserClarification":false,"approvalBlockers":[],"unsupportedClaims":[],"guidelineChecks":{"clarity":true,"completeness":true,"observability":true,"safety":true}}') <> 'approved' then
        raise exception 'pairing-free approval failed';
    end if;
    if app.task_plan_view(draft_id, other_id) is null then raise exception 'approved plan was not shared'; end if;
end;
$$;
reset role;
select dblink_disconnect('expiry_lock');
delete from app.pairings where token_hash = decode(repeat('aa', 32), 'hex');
do $$
begin
    if not exists (select 1 from app.task_plans where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1') then
        raise exception 'deleting a pairing must not delete its plans';
    end if;
end;
$$;
set role metaglasses_api;
do $$
begin
    if app.start_task_run_for_pairing('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab4',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '33333333-3333-4333-8333-333333333333',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaae5', repeat('dd', 32))->>'status' <> 'active' then
        raise exception 'plan could not be started after its original pairing was deleted';
    end if;
end;
$$;
reset role;
