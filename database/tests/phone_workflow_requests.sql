begin;

set local role metaglasses_api;
do $$
declare
    owner_id uuid := '42000000-0000-4000-8000-000000000001';
    other_id uuid := '42000000-0000-4000-8000-000000000002';
    client_id uuid := '42000000-0000-4000-8000-000000000003';
    plan_id uuid := '42000000-0000-4000-8000-000000000004';
    attempt_id uuid := gen_random_uuid();
    retry_id uuid := gen_random_uuid();
    digest text := repeat('ab', 32);
    plan jsonb := '{"title":"Fold laundry","steps":[{"ordinal":1,"instruction":"Fold a shirt."}]}';
    review jsonb := '{
        "approvalReady":true, "needsUserClarification":false, "approvalBlockers":[],
        "unsupportedClaims":[], "guidelineChecks":{"clarity":true,"completeness":true,"observability":true,"safety":true}
    }';
    reply jsonb := '{"responseId":"r_example","text":"Fold the sleeves inward.","createdAt":"2026-01-01T00:00:00.000Z"}';
    saved jsonb;
    value jsonb;
begin
    if has_table_privilege(current_user, 'app.phone_requests', 'select')
       or has_table_privilege(current_user, 'app.phone_requests', 'insert') then
        raise exception 'runtime can access idempotency storage directly';
    end if;
    if app.begin_phone_request(owner_id, 'goal_plan', client_id, attempt_id, digest)->>'outcome' is distinct from 'claimed'
       or app.begin_phone_request(owner_id, 'goal_plan', client_id, retry_id, digest)->>'outcome' is distinct from 'pending'
       or app.begin_phone_request(owner_id, 'goal_plan', client_id, retry_id, repeat('cd', 32))->>'outcome'
         is distinct from 'conflict'
       or app.begin_phone_request(other_id, 'goal_plan', client_id, retry_id, digest)->>'outcome'
         is distinct from 'claimed' then
        raise exception 'request claiming did not enforce the owner, digest, or active lease';
    end if;
    perform app.release_phone_request(owner_id, 'goal_plan', client_id, retry_id);
    if app.begin_phone_request(owner_id, 'goal_plan', client_id, retry_id, digest)->>'outcome' is distinct from 'pending' then
        raise exception 'wrong attempt released a lease';
    end if;
    perform app.release_phone_request(owner_id, 'goal_plan', client_id, attempt_id);
    if app.begin_phone_request(owner_id, 'goal_plan', client_id, retry_id, digest)->>'outcome' is distinct from 'claimed'
       or app.finish_phone_request(owner_id, 'goal_plan', client_id, attempt_id, plan_id, null, plan)->>'outcome'
         is distinct from 'lease_lost' then
        raise exception 'retry claim or stale attempt rejection failed';
    end if;
    saved := app.finish_phone_request(owner_id, 'goal_plan', client_id, retry_id, plan_id, null, plan);
    value := app.begin_phone_request(owner_id, 'goal_plan', client_id, attempt_id, digest);
    if saved is distinct from jsonb_build_object('taskPlanId', plan_id)
       or value->>'outcome' is distinct from 'replay' or value->'result' is distinct from saved
       or app.task_plan_owner_view(plan_id, owner_id)->>'status' is distinct from 'draft'
       or app.task_plan_owner_view(plan_id, other_id) is not null then
        raise exception 'private draft was not recoverable after replay';
    end if;

    if app.begin_phone_request(owner_id, 'plan_approval', client_id, attempt_id, digest)->>'outcome'
       is distinct from 'claimed'
       or app.finish_phone_request(owner_id, 'plan_approval', client_id, attempt_id, plan_id, 2, review)->>'outcome'
       is distinct from 'stale'
       or app.task_plan_owner_view(plan_id, owner_id)->>'status' is distinct from 'draft' then
        raise exception 'stale approval changed the plan';
    end if;
    if app.begin_phone_request(other_id, 'plan_approval', client_id, attempt_id, digest)->>'outcome'
       is distinct from 'claimed'
       or app.finish_phone_request(other_id, 'plan_approval', client_id, attempt_id, plan_id, 1, review)->>'outcome'
       is distinct from 'not_found' then
        raise exception 'foreign approval could affect the plan';
    end if;
    if app.begin_phone_request(owner_id, 'plan_approval', retry_id, attempt_id, digest)->>'outcome'
       is distinct from 'claimed' then raise exception 'blocked approval could not be claimed'; end if;
    saved := app.finish_phone_request(owner_id, 'plan_approval', retry_id, attempt_id, plan_id, 1,
        review || '{"approvalReady":false,"approvalBlockers":["Check the setup."]}');
    if saved is distinct from '{"outcome":"guidelines_failed","blockerCount":1}'::jsonb
       or app.task_plan_owner_view(plan_id, owner_id)#>>'{validation,approvalBlockers,0}'
          is distinct from 'Check the setup.'
       or app.begin_phone_request(owner_id, 'plan_approval', retry_id, gen_random_uuid(), digest)->'result'
          is distinct from saved then
        raise exception 'blocked approval did not persist or replay the review outcome';
    end if;
    if app.begin_phone_request(owner_id, 'plan_approval', attempt_id, retry_id, digest)->>'outcome'
       is distinct from 'claimed' then raise exception 'passing approval could not be claimed'; end if;
    saved := app.finish_phone_request(owner_id, 'plan_approval', attempt_id, retry_id, plan_id, 1, review);
    if saved->>'outcome' is distinct from 'approved'
       or app.task_plan_owner_view(plan_id, owner_id)->>'approvedVersion' is distinct from '1'
       or app.task_plan_owner_view(plan_id, other_id) is not null then
        raise exception 'version-matched approval did not publish exactly version one for the owner';
    end if;

    if app.begin_phone_request(owner_id, 'phone_chat', client_id, attempt_id, digest)->>'outcome'
       is distinct from 'claimed' then raise exception 'phone chat could not be claimed'; end if;
    saved := app.finish_phone_request(owner_id, 'phone_chat', client_id, attempt_id, null, null, reply);
    if saved is distinct from reply
       or app.begin_phone_request(owner_id, 'phone_chat', client_id, retry_id, digest)->'result'
       is distinct from saved then
        raise exception 'standalone chat did not replay the original answer';
    end if;
end;
$$;
reset role;

update app.phone_requests
set expires_at = statement_timestamp() - interval '1 second'
where owner_id = '42000000-0000-4000-8000-000000000002';

set local role metaglasses_api;
do $$
declare
    owner_id uuid := '42000000-0000-4000-8000-000000000001';
    other_id uuid := '42000000-0000-4000-8000-000000000002';
    client_id uuid := '42000000-0000-4000-8000-000000000003';
begin
    if app.delete_expired_phone_requests() is distinct from 2 then
        raise exception 'request cleanup did not remove exactly the expired claims';
    end if;
    if app.begin_phone_request(other_id, 'goal_plan', client_id, gen_random_uuid(), repeat('cd', 32))->>'outcome'
       is distinct from 'claimed'
       or app.begin_phone_request(owner_id, 'goal_plan', client_id, gen_random_uuid(), repeat('ab', 32))->>'outcome'
       is distinct from 'replay' then
        raise exception 'cleanup removed active results or held expired IDs';
    end if;
end;
$$;

rollback;
