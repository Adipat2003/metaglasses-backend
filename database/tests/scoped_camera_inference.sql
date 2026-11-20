begin;

insert into app.task_plans (
    id, owner_id, client_request_id, title, status, approved_version
) values (
    '41000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000002',
    '41000000-0000-4000-8000-000000000003', 'Camera fixture', 'approved', 1
);
insert into app.task_plan_versions (
    task_plan_id, version, source_steps, validation_status, validation_result, validated_at
) values (
    '41000000-0000-4000-8000-000000000001', 1, '[{"instruction":"Place a cup."}]',
    'validated', '{}', statement_timestamp()
);
insert into app.task_runs (id, task_plan_id, task_plan_version, owner_id, client_request_id)
values (
    '41000000-0000-4000-8000-000000000004', '41000000-0000-4000-8000-000000000001', 1,
    '41000000-0000-4000-8000-000000000002', '41000000-0000-4000-8000-000000000005'
);

set local role metaglasses_api;
do $$
declare
    owner_id uuid := '41000000-0000-4000-8000-000000000002';
    other_id uuid := '41000000-0000-4000-8000-000000000006';
    run_id uuid := '41000000-0000-4000-8000-000000000004';
    image_id uuid := '41000000-0000-4000-8000-000000000007';
    client_image_id uuid := '41000000-0000-4000-8000-000000000008';
    other_image_id uuid := '41000000-0000-4000-8000-000000000009';
    window_id uuid := '41000000-0000-4000-8000-000000000010';
    request_id uuid := '41000000-0000-4000-8000-000000000011';
    lease_id uuid := '41000000-0000-4000-8000-000000000012';
    other_lease uuid := '41000000-0000-4000-8000-000000000013';
    observation_id uuid := '41000000-0000-4000-8000-000000000014';
    frames jsonb := jsonb_build_array(statement_timestamp());
    old_frames jsonb := jsonb_build_array(statement_timestamp() - interval '31 seconds');
    result jsonb;
    claim record;
begin
    if has_table_privilege(current_user, 'app.scoped_images', 'select')
       or has_table_privilege(current_user, 'app.task_inference_windows', 'update') then
        raise exception 'runtime role has direct media access';
    end if;

    result := app.register_scoped_image(
        other_id, run_id, null, client_image_id, image_id, 'owner/run/first', 'image/jpeg', 100, 'aabb'
    );
    if result->>'outcome' is distinct from 'not_found' then raise exception 'foreign run upload allowed'; end if;
    result := app.register_scoped_image(
        owner_id, run_id, null, client_image_id, image_id, 'owner/run/first', 'image/jpeg', 100, 'aabb'
    );
    if result->>'outcome' is distinct from 'registered' then raise exception 'run upload failed'; end if;
    result := app.register_scoped_image(
        owner_id, run_id, null, client_image_id, other_image_id, 'owner/run/second', 'image/jpeg', 100, 'aabb'
    );
    if result->>'outcome' is distinct from 'replayed' or result->>'imageId' is distinct from image_id::text then
        raise exception 'identical image replay made another image';
    end if;
    result := app.register_scoped_image(
        owner_id, run_id, null, client_image_id, other_image_id, 'owner/run/second', 'image/jpeg', 100, 'ccdd'
    );
    if result->>'outcome' is distinct from 'conflict' then raise exception 'changed image replay accepted'; end if;
    result := app.register_scoped_image(
        owner_id, null, null, client_image_id, other_image_id, 'owner/talk/first', 'image/jpeg', 4194304, 'aabb'
    );
    if result->>'outcome' is distinct from 'registered' then raise exception 'Talk image rejected'; end if;

    if (select count(*) from app.get_scoped_images(owner_id, run_id, null, array[image_id, other_image_id])) <> 1
       or exists (select 1 from app.get_scoped_images(owner_id, null, null, array[image_id]))
       or exists (select 1 from app.get_scoped_images(other_id, run_id, null, array[image_id]))
       or app.remove_scoped_image(other_id, run_id, null, image_id) is not null then
        raise exception 'image scope leaked';
    end if;

    result := app.create_task_inference_window(
        window_id, run_id, owner_id, request_id, 1, 1, array[other_image_id], frames, 'What is visible?', '{}'
    );
    if result->>'outcome' is distinct from 'invalid_media' then raise exception 'Talk image accepted as a frame'; end if;
    result := app.create_task_inference_window(
        window_id, run_id, owner_id, request_id, 1, 1, array[image_id], old_frames, null, '{}'
    );
    if result->>'outcome' is distinct from 'frame_time_invalid' then raise exception 'old new frame accepted'; end if;
    result := app.create_task_inference_window(
        window_id, run_id, owner_id, request_id, 1, 1, array[image_id], frames, 'What is visible?', '{}'
    );
    if result->>'outcome' is distinct from 'accepted' or result->>'status' is distinct from 'queued' then
        raise exception 'inference window was not queued: %', result;
    end if;
    result := app.create_task_inference_window(
        gen_random_uuid(), run_id, other_id, request_id, 1, 1, array[image_id], frames, 'What is visible?', '{}'
    );
    if result->>'outcome' is distinct from 'not_found'
       or app.get_task_inference_window(run_id, other_id, window_id) is not null then
        raise exception 'foreign window replay or read leaked';
    end if;
    result := app.create_task_inference_window(
        gen_random_uuid(), run_id, owner_id, request_id, 1, 1, array[image_id], frames, 'Changed?', '{}'
    );
    if result->>'outcome' is distinct from 'replay_conflict' then raise exception 'changed question accepted'; end if;
    result := app.create_task_inference_window(
        gen_random_uuid(), run_id, owner_id, gen_random_uuid(), 2, 1, array[image_id], frames, null, '{}'
    );
    if result->>'outcome' is distinct from 'in_flight' then raise exception 'multiple phone windows queued'; end if;

    select * into claim from app.claim_task_inference_window(lease_id);
    if claim.inference_window_id is distinct from window_id
       or claim.question is distinct from 'What is visible?'
       or claim.claim_count is distinct from 1::smallint then raise exception 'worker did not claim the window'; end if;
    if app.finish_task_inference_window(window_id, owner_id, other_lease, null, null, null, 'window_inference_failed')
       is distinct from 'stale_or_not_processing' then raise exception 'other worker could reject live work'; end if;
    if app.finish_task_inference_window(
        window_id, owner_id, lease_id, observation_id, 'nova',
        '{"summary":"Cup.","proposedTransition":"candidate_complete","confidence":0.9,"evidenceFrameIndexes":[0],"answer":"A cup."}',
        null
    ) is distinct from 'observed' then raise exception 'worker did not complete the window'; end if;
    result := app.get_task_inference_window(run_id, owner_id, window_id);
    if result->>'status' is distinct from 'observed'
       or result->'observation'->>'answer' is distinct from 'A cup.'
       or result ? 'errorCode' or result ? 'leaseId' then raise exception 'unsafe observation response: %', result; end if;

    result := app.phone_chat_context(owner_id, run_id, 1, window_id);
    if result->>'outcome' is distinct from 'ready' or result->>'observation' is distinct from 'Cup.'
       or result->'step'->>'instruction' is distinct from 'Place a cup.'
       or app.phone_chat_context(other_id, run_id, 1, window_id)->>'outcome' is distinct from 'not_found'
       or app.phone_chat_context(owner_id, run_id, 1, gen_random_uuid())->>'outcome'
            is distinct from 'observation_not_found' then
        raise exception 'Talk did not enforce the run, version, and observation scope: %', result;
    end if;

    result := app.create_task_inference_window(
        gen_random_uuid(), run_id, owner_id, gen_random_uuid(), 1, 1, array[image_id], frames, null, '{}'
    );
    if result->>'outcome' is distinct from 'out_of_order' then raise exception 'old sequence accepted'; end if;
    if app.remove_scoped_image(owner_id, run_id, null, image_id) is distinct from 'owner/run/first' then
        raise exception 'image could not be deleted';
    end if;
    if app.remove_scoped_image(owner_id, run_id, null, image_id) is distinct from 'owner/run/first' then
        raise exception 'image deletion could not be retried';
    end if;
    if exists (select 1 from app.get_scoped_images(owner_id, run_id, null, array[image_id])) then
        raise exception 'deleted image remained visible or could not be retried';
    end if;
    result := app.register_scoped_image(
        owner_id, run_id, null, client_image_id, gen_random_uuid(), 'owner/run/third', 'image/jpeg', 100, 'aabb'
    );
    if result->>'outcome' is distinct from 'conflict' then raise exception 'upload replay resurrected removed image'; end if;
end;
$$;
reset role;

update app.task_inference_windows
set captured_at = jsonb_build_array(statement_timestamp() - interval '11 seconds')
where id = '41000000-0000-4000-8000-000000000010';
set local role metaglasses_api;
do $$
begin
    if app.phone_chat_context(
        '41000000-0000-4000-8000-000000000002', '41000000-0000-4000-8000-000000000004',
        1, '41000000-0000-4000-8000-000000000010'
    )->>'outcome' is distinct from 'observation_stale' then
        raise exception 'Talk reused an old capture with recently processed observation';
    end if;
end;
$$;
reset role;

update app.task_inference_windows
set captured_at = '["2020-01-01T00:00:00.000Z"]'
where id = '41000000-0000-4000-8000-000000000010';
update app.task_runs set state_version = 2 where id = '41000000-0000-4000-8000-000000000004';

insert into app.task_inference_windows (
    id, task_run_id, owner_id, client_request_id, sequence_number,
    observed_state_version, image_ids, captured_at, status, processing_at, lease_id, claim_count
) values
(
    '41000000-0000-4000-8000-000000000015', '41000000-0000-4000-8000-000000000004',
    '41000000-0000-4000-8000-000000000002', '41000000-0000-4000-8000-000000000016', 2, 1,
    array['41000000-0000-4000-8000-000000000007'::uuid], '["2020-01-01T00:00:00.000Z"]',
    'processing', statement_timestamp(), '41000000-0000-4000-8000-000000000017', 1
),
(
    '41000000-0000-4000-8000-000000000018', '41000000-0000-4000-8000-000000000004',
    '41000000-0000-4000-8000-000000000002', '41000000-0000-4000-8000-000000000019', 3, 2,
    array['41000000-0000-4000-8000-000000000007'::uuid], '["2020-01-01T00:00:00.000Z"]',
    'processing', statement_timestamp() - interval '31 seconds', '41000000-0000-4000-8000-000000000020', 1
);

set local role metaglasses_api;
do $$
declare
    owner_id uuid := '41000000-0000-4000-8000-000000000002';
    run_id uuid := '41000000-0000-4000-8000-000000000004';
    stale_id uuid := '41000000-0000-4000-8000-000000000015';
    stale_lease uuid := '41000000-0000-4000-8000-000000000017';
    reclaim_id uuid := '41000000-0000-4000-8000-000000000018';
    expired_lease uuid := '41000000-0000-4000-8000-000000000020';
    new_lease uuid := '41000000-0000-4000-8000-000000000021';
    result jsonb;
    claim record;
begin
    if app.phone_chat_context(owner_id, run_id, 1, null)->>'outcome' is distinct from 'stale' then
        raise exception 'Talk accepted a stale run version';
    end if;
    if app.phone_chat_context(owner_id, run_id, 2, stale_id)->>'outcome' is distinct from 'observation_stale' then
        raise exception 'Talk accepted a processing observation for a stale version';
    end if;

    if app.begin_phone_request(owner_id, 'phone_chat', stale_id, stale_lease, repeat('ef', 32))->>'outcome'
       is distinct from 'claimed' then raise exception 'stale reply fixture was not claimed'; end if;
    if app.finish_phone_request(owner_id, 'phone_chat', stale_id, stale_lease, run_id, 1, '{"text":"Old step."}')
       is distinct from '{"outcome":"stale","stateVersion":2}'::jsonb then
        raise exception 'Talk accepted a reply after the run advanced';
    end if;
    if app.begin_phone_request(owner_id, 'phone_chat', reclaim_id, new_lease, repeat('ef', 32))->>'outcome'
       is distinct from 'claimed' then raise exception 'current reply fixture was not claimed'; end if;
    result := app.finish_phone_request(owner_id, 'phone_chat', reclaim_id, new_lease, run_id, 2, '{"text":"Current step."}');
    if result->>'taskRunId' is distinct from run_id::text or result->>'stateVersion' is distinct from '2'
       or result->>'text' is distinct from 'Current step.' then
        raise exception 'Talk did not bind the response to the current run version: %', result;
    end if;

    result := app.create_task_inference_window(
        gen_random_uuid(), run_id, owner_id, '41000000-0000-4000-8000-000000000011', 1, 1,
        array['41000000-0000-4000-8000-000000000007'::uuid], '["2020-01-01T00:00:00.000Z"]',
        'What is visible?', '{}'
    );
    if result->>'status' is distinct from 'observed' or result ? 'observation' then
        raise exception 'identical replay was blocked by stale state, freshness or removed image';
    end if;
    if app.finish_task_inference_window(stale_id, owner_id, stale_lease, gen_random_uuid(), 'nova', '{}', null)
       is distinct from 'rejected' then raise exception 'stale worker result was accepted'; end if;
    result := app.get_task_inference_window(run_id, owner_id, stale_id);
    if result->>'errorCode' is distinct from 'window_stale' or result ? 'observation' then
        raise exception 'stale result exposed model output';
    end if;
    if app.finish_task_inference_window(reclaim_id, owner_id, expired_lease, null, null, null, 'window_inference_failed')
       is distinct from 'stale_or_not_processing' then raise exception 'expired worker completed'; end if;
    select * into claim from app.claim_task_inference_window(new_lease);
    if claim.inference_window_id is distinct from reclaim_id or claim.claim_count is distinct from 2::smallint then
        raise exception 'expired window was not reclaimed exactly once';
    end if;
    if app.finish_task_inference_window(reclaim_id, owner_id, expired_lease, null, null, null, 'window_inference_failed')
       is distinct from 'stale_or_not_processing' then raise exception 'old lease overwrote reclaimed work'; end if;
end;
$$;
reset role;

update app.task_inference_windows
set processing_at = statement_timestamp() - interval '31 seconds'
where id = '41000000-0000-4000-8000-000000000018';
update app.scoped_images set expires_at = statement_timestamp() - interval '1 second'
where id = '41000000-0000-4000-8000-000000000007';

set local role metaglasses_api;
do $$
declare
    expired_image_id uuid := '41000000-0000-4000-8000-000000000007';
    result jsonb;
begin
    if exists (select 1 from app.claim_task_inference_window(gen_random_uuid())) then
        raise exception 'a second reclaim was allowed';
    end if;
    result := app.get_task_inference_window(
        '41000000-0000-4000-8000-000000000004', '41000000-0000-4000-8000-000000000002',
        '41000000-0000-4000-8000-000000000018'
    );
    if result->>'errorCode' is distinct from 'window_worker_timeout' then raise exception 'wrong lease expiry code'; end if;
    if app.finalize_expired_scoped_images(array[expired_image_id]) <> 0 then
        raise exception 'cleanup finalized an unclaimed image';
    end if;
    if not exists (
        select 1 from app.claim_expired_scoped_images(1) as claimed
        where claimed.image_id = expired_image_id
    ) then
        raise exception 'cleanup failed to claim expired image';
    end if;
    if app.finalize_expired_scoped_images(array[expired_image_id]) <> 1 then
        raise exception 'cleanup failed to finalize an expired image';
    end if;
end;
$$;
rollback;
