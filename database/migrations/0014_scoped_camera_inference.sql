create table app.scoped_images (
    id uuid primary key,
    owner_id uuid not null,
    task_run_id uuid references app.task_runs (id) on delete restrict,
    token_hash bytea references app.pairings (token_hash) on delete restrict,
    client_image_id uuid not null,
    content_hash bytea not null,
    object_path text not null unique,
    content_type text not null check (content_type in ('image/jpeg', 'image/png')),
    byte_size bigint not null check (byte_size between 1 and 8388608),
    created_at timestamptz not null default statement_timestamp(),
    expires_at timestamptz not null,
    claimed_at timestamptz,
    deleted_at timestamptz,
    check (task_run_id is null or token_hash is null),
    check (task_run_id is null or byte_size <= 2097152),
    unique nulls not distinct (owner_id, task_run_id, token_hash, client_image_id)
);

create index scoped_images_expiry_idx on app.scoped_images (expires_at, id);

create function app.register_scoped_image(
    p_owner_id uuid, p_task_run_id uuid, p_token_hash text, p_client_image_id uuid,
    p_image_id uuid, p_object_path text, p_content_type text, p_byte_size bigint,
    p_content_hash text
)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, app
as $$
declare
    image app.scoped_images%rowtype;
    pairing_hash bytea := decode(p_token_hash, 'hex');
    expiry timestamptz := statement_timestamp() + interval '1 hour';
    outcome text := 'registered';
begin
    if p_task_run_id is not null then
        perform 1 from app.task_runs as run
        where run.id = p_task_run_id and run.owner_id = p_owner_id
          and run.status = 'active'
        for share;
        if not found then
            return jsonb_build_object('outcome', 'not_found');
        end if;
    elsif pairing_hash is not null then
        select pairing.expires_at into expiry from app.pairings as pairing
        where pairing.token_hash = pairing_hash and pairing.owner_id = p_owner_id
          and pairing.expires_at > statement_timestamp()
        for share;
        if not found then
            return jsonb_build_object('outcome', 'not_found');
        end if;
    end if;

    insert into app.scoped_images (
        id, owner_id, task_run_id, token_hash, client_image_id, content_hash,
        object_path, content_type, byte_size, expires_at
    ) values (
        p_image_id, p_owner_id, p_task_run_id, pairing_hash, p_client_image_id,
        decode(p_content_hash, 'hex'), p_object_path, p_content_type, p_byte_size, expiry
    )
    on conflict (owner_id, task_run_id, token_hash, client_image_id) do nothing
    returning * into image;

    if not found then
        select existing.* into image from app.scoped_images as existing
        where existing.owner_id = p_owner_id and existing.client_image_id = p_client_image_id
          and existing.task_run_id is not distinct from p_task_run_id
          and existing.token_hash is not distinct from pairing_hash
        for share;
        if not found or image.claimed_at is not null or image.deleted_at is not null
           or image.expires_at <= statement_timestamp()
           or image.content_hash <> decode(p_content_hash, 'hex')
           or image.content_type <> p_content_type or image.byte_size <> p_byte_size then
            return jsonb_build_object('outcome', 'conflict');
        end if;
        outcome := 'replayed';
    end if;
    return jsonb_build_object(
        'outcome', outcome, 'imageId', image.id, 'contentType', image.content_type,
        'byteSize', image.byte_size, 'createdAt', image.created_at
    );
end;
$$;

create function app.get_scoped_images(
    p_owner_id uuid, p_task_run_id uuid, p_token_hash text, p_image_ids uuid[]
)
returns table (image_id uuid, object_path text, content_type text, byte_size bigint, created_at timestamptz)
language sql stable security definer
set search_path = pg_catalog, app
as $$
    select image.id, image.object_path, image.content_type, image.byte_size, image.created_at
    from app.scoped_images as image
    where image.id = any(p_image_ids) and image.owner_id = p_owner_id
      and image.task_run_id is not distinct from p_task_run_id
      and image.token_hash is not distinct from decode(p_token_hash, 'hex')
      and image.claimed_at is null and image.deleted_at is null and image.expires_at > statement_timestamp()
      and (p_token_hash is null or exists (
          select 1 from app.pairings as pairing where pairing.token_hash = image.token_hash
          and pairing.owner_id = p_owner_id and pairing.expires_at > statement_timestamp()
      ));
$$;

create function app.remove_scoped_image(
    p_owner_id uuid, p_task_run_id uuid, p_token_hash text, p_image_id uuid
)
returns text
language sql volatile security definer
set search_path = pg_catalog, app
as $$
    update app.scoped_images as image set deleted_at = coalesce(image.deleted_at, statement_timestamp())
    where image.id = p_image_id and image.owner_id = p_owner_id
      and image.task_run_id is not distinct from p_task_run_id
      and image.token_hash is not distinct from decode(p_token_hash, 'hex')
      and image.claimed_at is null and image.expires_at > statement_timestamp()
      and (p_token_hash is null or exists (
          select 1 from app.pairings as pairing where pairing.token_hash = image.token_hash
          and pairing.owner_id = p_owner_id and pairing.expires_at > statement_timestamp()
      ))
    returning image.object_path;
$$;

create function app.claim_expired_scoped_images(p_batch_size integer)
returns table (image_id uuid, object_path text)
language sql volatile security definer
set search_path = pg_catalog, app
as $$
    with candidates as (
        select image.id from app.scoped_images as image
        where image.expires_at <= statement_timestamp()
          and (image.claimed_at is null or image.claimed_at <= statement_timestamp() - interval '5 minutes')
        order by image.expires_at, image.id
        limit least(greatest(p_batch_size, 1), 1000)
        for update skip locked
    )
    update app.scoped_images as image set claimed_at = statement_timestamp()
    from candidates where image.id = candidates.id
    returning image.id, image.object_path;
$$;

create function app.finalize_expired_scoped_images(p_image_ids uuid[])
returns bigint
language sql volatile security definer
set search_path = pg_catalog, app
as $$
    with removed as (
        delete from app.scoped_images as image where image.id = any(p_image_ids)
          and image.claimed_at is not null
        returning image.id
    ) select count(*) from removed;
$$;

alter table app.task_inference_windows
    add column question text check (char_length(question) between 1 and 500),
    add column submission_request_id uuid,
    add column lease_id uuid,
    add column claim_count smallint not null default 0 check (claim_count between 0 and 2),
    add column error_code text check (
        error_code in ('window_stale', 'window_worker_timeout', 'window_media_unavailable', 'window_inference_failed')
    );

create index task_inference_windows_pending_idx on app.task_inference_windows (created_at, id)
where status in ('queued', 'processing');

create function app.task_inference_pairing_hash(p_task_run_id uuid, p_owner_id uuid)
returns text
language sql stable security definer
set search_path = pg_catalog, app
as $$
    select encode(run.token_hash, 'hex')
    from app.task_runs as run
    where run.id = p_task_run_id and run.owner_id = p_owner_id;
$$;

create function app.get_task_inference_window(
    p_task_run_id uuid, p_owner_id uuid, p_window_id uuid
)
returns jsonb
language sql stable security definer
set search_path = pg_catalog, app
as $$
    select jsonb_strip_nulls(jsonb_build_object(
        'inferenceWindowId', inference_window.id,
        'status', inference_window.status,
        'stateVersion', inference_window.observed_state_version,
        'sequenceNumber', inference_window.sequence_number,
        'createdAt', inference_window.created_at,
        'lastCapturedAt', inference_window.captured_at ->> -1,
        'observation', observation.observation,
        'errorCode', case when inference_window.status = 'rejected'
            then coalesce(inference_window.error_code, 'window_inference_failed') end
    ))
    from app.task_inference_windows as inference_window
    left join app.task_inference_observations as observation
      on observation.task_inference_window_id = inference_window.id
    where inference_window.id = p_window_id
      and inference_window.task_run_id = p_task_run_id
      and inference_window.owner_id = p_owner_id;
$$;

create function app.create_task_inference_window(
    p_window_id uuid, p_task_run_id uuid, p_owner_id uuid, p_client_request_id uuid,
    p_sequence_number bigint, p_observed_state_version bigint, p_image_ids uuid[],
    p_captured_at jsonb, p_question text, p_legacy_image_ids uuid[], p_request_id uuid default null
)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, app
as $$
declare
    existing app.task_inference_windows%rowtype;
    run_record app.task_runs%rowtype;
begin
    select run.* into run_record from app.task_runs as run
    where run.id = p_task_run_id and run.owner_id = p_owner_id
    for update;
    if not found then
        return jsonb_build_object('outcome', 'not_found');
    end if;

    select inference_window.* into existing from app.task_inference_windows as inference_window
    where inference_window.task_run_id = p_task_run_id
      and inference_window.client_request_id = p_client_request_id;
    if found then
        if existing.sequence_number <> p_sequence_number
           or existing.observed_state_version <> p_observed_state_version
           or existing.image_ids <> p_image_ids or existing.captured_at <> p_captured_at
           or existing.question is distinct from p_question then
            return jsonb_build_object('outcome', 'replay_conflict');
        end if;
        return jsonb_build_object('outcome', 'accepted')
            || app.get_task_inference_window(p_task_run_id, p_owner_id, existing.id)
                - 'observation' - 'errorCode' - 'lastCapturedAt';
    end if;

    if run_record.status <> 'active' or (run_record.token_hash is not null and not exists (
        select 1 from app.pairings as pairing where pairing.token_hash = run_record.token_hash
          and pairing.owner_id = p_owner_id and pairing.expires_at > statement_timestamp()
    )) then
        return jsonb_build_object('outcome', 'not_active');
    end if;
    if run_record.state_version <> p_observed_state_version then
        return jsonb_build_object('outcome', 'stale', 'stateVersion', run_record.state_version);
    end if;
    if exists (
        select 1 from jsonb_array_elements_text(p_captured_at) as capture(value)
        where capture.value::timestamptz < statement_timestamp() - interval '30 seconds'
           or capture.value::timestamptz > statement_timestamp() + interval '5 seconds'
    ) then
        return jsonb_build_object('outcome', 'frame_time_invalid');
    end if;
    if exists (
        select 1 from app.task_inference_windows as inference_window
        where inference_window.task_run_id = p_task_run_id
          and inference_window.sequence_number >= p_sequence_number
    ) then
        return jsonb_build_object('outcome', 'out_of_order');
    end if;
    if run_record.token_hash is null and exists (
        select 1 from app.task_inference_windows as inference_window
        where inference_window.task_run_id = p_task_run_id
          and inference_window.status in ('queued', 'processing')
    ) then
        return jsonb_build_object('outcome', 'in_flight');
    end if;
    if exists (
        select 1 from unnest(p_image_ids) as frame(id)
        where (run_record.token_hash is null or not (frame.id = any(p_legacy_image_ids)))
          and not exists (
              select 1 from app.scoped_images as image
              where image.id = frame.id and image.owner_id = p_owner_id
                and (image.task_run_id = p_task_run_id or image.token_hash = run_record.token_hash)
                and image.claimed_at is null and image.deleted_at is null
                and image.expires_at > statement_timestamp()
                and image.byte_size <= 2097152
          )
    ) then
        return jsonb_build_object('outcome', 'invalid_media');
    end if;

    insert into app.task_inference_windows (
        id, task_run_id, owner_id, client_request_id, sequence_number,
        observed_state_version, image_ids, captured_at, question, submission_request_id
    ) values (
        p_window_id, p_task_run_id, p_owner_id, p_client_request_id, p_sequence_number,
        p_observed_state_version, p_image_ids, p_captured_at, p_question, p_request_id
    );
    return jsonb_build_object(
        'outcome', 'accepted', 'inferenceWindowId', p_window_id,
        'sequenceNumber', p_sequence_number, 'status', 'queued',
        'stateVersion', p_observed_state_version, 'createdAt', statement_timestamp()
    );
end;
$$;

create function app.claim_task_inference_window(p_lease_id uuid)
returns table (
    inference_window_id uuid, task_run_id uuid, owner_id uuid, token_hash text,
    image_ids uuid[], observed_state_version bigint, current_step_ordinal integer,
    source_steps jsonb, validation_result jsonb, question text, lease_id uuid,
    claim_count smallint, submission_request_id uuid
)
language plpgsql volatile security definer
set search_path = pg_catalog, app
as $$
declare
    candidate_id uuid;
    candidate app.task_inference_windows%rowtype;
    run_record app.task_runs%rowtype;
    failure text;
begin
    select inference_window.id into candidate_id
    from app.task_inference_windows as inference_window
    join app.task_runs as run on run.id = inference_window.task_run_id
    where (p_lease_id is not null or (run.token_hash is not null and inference_window.lease_id is null))
      and (inference_window.status = 'queued' or (
        inference_window.status = 'processing'
        and inference_window.processing_at <= statement_timestamp() - interval '30 seconds'
      ))
    order by inference_window.created_at, inference_window.id
    limit 1 for update of run skip locked;
    if not found then return; end if;

    select inference_window.* into candidate
    from app.task_inference_windows as inference_window
    where inference_window.id = candidate_id
    for update;
    if candidate.status not in ('queued', 'processing') or (
        candidate.status = 'processing'
        and candidate.processing_at > statement_timestamp() - interval '30 seconds'
    ) then return; end if;

    select run.* into run_record from app.task_runs as run where run.id = candidate.task_run_id;
    if run_record.status <> 'active' or run_record.state_version <> candidate.observed_state_version
       or (run_record.token_hash is not null and not exists (
            select 1 from app.pairings as pairing where pairing.token_hash = run_record.token_hash
              and pairing.owner_id = run_record.owner_id and pairing.expires_at > statement_timestamp()
       )) then
        failure := 'window_stale';
    elsif candidate.claim_count >= 2 then
        failure := 'window_worker_timeout';
    end if;
    if failure is not null then
        update app.task_inference_windows
        set status = 'rejected', processing_at = null, lease_id = null, error_code = failure
        where id = candidate.id;
        return;
    end if;

    update app.task_inference_windows as inference_window
    set status = 'processing', processing_at = statement_timestamp(),
        lease_id = p_lease_id, claim_count = inference_window.claim_count + 1
    where inference_window.id = candidate.id;

    return query
    select candidate.id, run_record.id, run_record.owner_id, encode(run_record.token_hash, 'hex'),
           candidate.image_ids, candidate.observed_state_version, run_record.current_step_ordinal,
           version.source_steps, version.validation_result, candidate.question, p_lease_id,
           (candidate.claim_count + 1)::smallint, candidate.submission_request_id
    from app.task_plan_versions as version
    where version.task_plan_id = run_record.task_plan_id and version.version = run_record.task_plan_version;
end;
$$;

create function app.finish_task_inference_window(
    p_window_id uuid, p_owner_id uuid, p_lease_id uuid,
    p_observation_id uuid, p_model_id text, p_observation jsonb, p_error_code text
)
returns text
language plpgsql volatile security definer
set search_path = pg_catalog, app
as $$
declare
    run_record app.task_runs%rowtype;
    candidate app.task_inference_windows%rowtype;
    failure text := p_error_code;
begin
    select run.* into run_record from app.task_runs as run
    join app.task_inference_windows as inference_window on inference_window.task_run_id = run.id
    where inference_window.id = p_window_id and run.owner_id = p_owner_id
    for update of run;
    if not found then return 'stale_or_not_processing'; end if;

    select inference_window.* into candidate from app.task_inference_windows as inference_window
    where inference_window.id = p_window_id and inference_window.owner_id = p_owner_id
      and inference_window.status = 'processing'
      and inference_window.lease_id is not distinct from p_lease_id
      and (p_lease_id is null or inference_window.processing_at > statement_timestamp() - interval '30 seconds')
    for update;
    if not found then return 'stale_or_not_processing'; end if;

    if run_record.status <> 'active' or run_record.state_version <> candidate.observed_state_version
       or (run_record.token_hash is not null and not exists (
            select 1 from app.pairings as pairing where pairing.token_hash = run_record.token_hash
              and pairing.owner_id = p_owner_id and pairing.expires_at > statement_timestamp()
       )) then
        failure := 'window_stale';
    end if;
    if failure is not null then
        update app.task_inference_windows
        set status = 'rejected', processing_at = null, lease_id = null, error_code = failure
        where id = p_window_id;
        return 'rejected';
    end if;

    update app.task_inference_windows set status = 'observed', processing_at = null, lease_id = null
    where id = p_window_id;
    insert into app.task_inference_observations (
        id, task_inference_window_id, task_run_id, owner_id, model_id, observation
    ) values (p_observation_id, p_window_id, run_record.id, p_owner_id, p_model_id, p_observation);

    update app.pairings as pairing
    set response_id = 'task_observation_' || p_window_id::text,
        response_text = case p_observation ->> 'proposedTransition'
            when 'candidate_complete' then 'Step may be complete. Confirm to continue.'
            when 'blocked' then 'Progress is unclear. Reposition the camera or correct the step.'
            else version.source_steps -> (run_record.current_step_ordinal - 1) ->> 'instruction'
        end,
        response_created_at = statement_timestamp(), state = 'speaking'
    from app.task_plan_versions as version
    where pairing.token_hash = run_record.token_hash and pairing.owner_id = p_owner_id
      and pairing.expires_at > statement_timestamp()
      and version.task_plan_id = run_record.task_plan_id
      and version.version = run_record.task_plan_version
      and not exists (
          select 1 from app.task_inference_windows as newer
          where newer.task_run_id = run_record.id and newer.status = 'observed'
            and newer.sequence_number > candidate.sequence_number
      );
    return 'observed';
end;
$$;

-- Lease-aware completion fences the previous API version during rolling deployment.
create or replace function app.claim_task_inference_window()
returns table (
    inference_window_id uuid, task_run_id uuid, owner_id uuid, token_hash text,
    image_ids uuid[], observed_state_version bigint, current_step_ordinal integer,
    source_steps jsonb, validation_result jsonb
)
language sql volatile security definer
set search_path = pg_catalog, app
as $$
    select claim.inference_window_id, claim.task_run_id, claim.owner_id, claim.token_hash,
           claim.image_ids, claim.observed_state_version, claim.current_step_ordinal,
           claim.source_steps, claim.validation_result
    from app.claim_task_inference_window(null::uuid) as claim;
$$;

create or replace function app.complete_task_inference_window(
    p_observation_id uuid, p_inference_window_id uuid, p_owner_id uuid,
    p_model_id text, p_observation jsonb
)
returns text
language sql volatile security definer
set search_path = pg_catalog, app
as $$
    select app.finish_task_inference_window(
        p_inference_window_id, p_owner_id, null, p_observation_id, p_model_id, p_observation, null
    );
$$;

create or replace function app.reject_task_inference_window(p_inference_window_id uuid, p_owner_id uuid)
returns boolean
language sql volatile security definer
set search_path = pg_catalog, app
as $$
    select app.finish_task_inference_window(
        p_inference_window_id, p_owner_id, null, null, null, null, 'window_inference_failed'
    ) = 'rejected';
$$;

revoke all on table app.scoped_images from public;
revoke all on function
    app.register_scoped_image(uuid, uuid, text, uuid, uuid, text, text, bigint, text),
    app.get_scoped_images(uuid, uuid, text, uuid[]),
    app.remove_scoped_image(uuid, uuid, text, uuid),
    app.claim_expired_scoped_images(integer),
    app.finalize_expired_scoped_images(uuid[]),
    app.task_inference_pairing_hash(uuid, uuid),
    app.get_task_inference_window(uuid, uuid, uuid),
    app.create_task_inference_window(uuid, uuid, uuid, uuid, bigint, bigint, uuid[], jsonb, text, uuid[], uuid),
    app.claim_task_inference_window(uuid),
    app.finish_task_inference_window(uuid, uuid, uuid, uuid, text, jsonb, text)
from public;
grant execute on function
    app.register_scoped_image(uuid, uuid, text, uuid, uuid, text, text, bigint, text),
    app.get_scoped_images(uuid, uuid, text, uuid[]),
    app.remove_scoped_image(uuid, uuid, text, uuid),
    app.claim_expired_scoped_images(integer),
    app.finalize_expired_scoped_images(uuid[]),
    app.task_inference_pairing_hash(uuid, uuid),
    app.get_task_inference_window(uuid, uuid, uuid),
    app.create_task_inference_window(uuid, uuid, uuid, uuid, bigint, bigint, uuid[], jsonb, text, uuid[], uuid),
    app.claim_task_inference_window(uuid),
    app.finish_task_inference_window(uuid, uuid, uuid, uuid, text, jsonb, text)
to metaglasses_api;
