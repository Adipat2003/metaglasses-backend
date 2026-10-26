create table app.task_inference_windows (
    id uuid primary key,
    task_run_id uuid not null references app.task_runs (id) on delete restrict,
    owner_id uuid not null,
    client_request_id uuid not null,
    sequence_number bigint not null,
    observed_state_version bigint not null,
    image_ids uuid[] not null,
    captured_at jsonb not null,
    status text not null default 'queued',
    created_at timestamptz not null default statement_timestamp(),
    constraint task_inference_windows_sequence_number check (sequence_number > 0),
    constraint task_inference_windows_state_version check (observed_state_version > 0),
    constraint task_inference_windows_image_count check (cardinality(image_ids) between 1 and 3),
    constraint task_inference_windows_captured_at check (
        case
            when jsonb_typeof(captured_at) = 'array'
                then jsonb_array_length(captured_at) = cardinality(image_ids)
            else false
        end
    ),
    constraint task_inference_windows_status check (status in ('queued', 'processing', 'observed', 'rejected')),
    unique (task_run_id, client_request_id),
    unique (task_run_id, sequence_number)
);

create index task_inference_windows_run_status_created_idx
    on app.task_inference_windows (task_run_id, status, created_at);

create or replace function app.create_task_inference_window(
    p_window_id uuid,
    p_task_run_id uuid,
    p_owner_id uuid,
    p_client_request_id uuid,
    p_sequence_number bigint,
    p_observed_state_version bigint,
    p_image_ids uuid[],
    p_captured_at jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app
as $$
declare
    existing_window app.task_inference_windows%rowtype;
    run_record app.task_runs%rowtype;
    image_count integer;
    largest_image_bytes bigint;
    latest_sequence bigint;
begin
    perform pg_advisory_xact_lock(hashtextextended(p_task_run_id::text, 0));

    select inference_window.* into existing_window
    from app.task_inference_windows as inference_window
    where inference_window.task_run_id = p_task_run_id
      and inference_window.client_request_id = p_client_request_id;
    if found then
        return jsonb_build_object(
            'outcome', 'accepted',
            'inferenceWindowId', existing_window.id,
            'sequenceNumber', existing_window.sequence_number,
            'status', existing_window.status,
            'stateVersion', existing_window.observed_state_version,
            'createdAt', existing_window.created_at
        );
    end if;

    select run into run_record
    from app.task_runs as run
    join app.pairings as pairing
      on pairing.token_hash = run.token_hash
     and pairing.owner_id = p_owner_id
     and pairing.expires_at > statement_timestamp()
    where run.id = p_task_run_id
      and run.owner_id = p_owner_id
    for update of run;
    if not found then
        return jsonb_build_object('outcome', 'not_found');
    end if;
    if run_record.status <> 'active' then
        return jsonb_build_object('outcome', 'not_active');
    end if;
    if run_record.state_version <> p_observed_state_version then
        return jsonb_build_object('outcome', 'stale', 'stateVersion', run_record.state_version);
    end if;

    select count(*), max(image.byte_size) into image_count, largest_image_bytes
    from app.pairing_images as image
    where image.id = any(p_image_ids)
      and image.token_hash = run_record.token_hash
      and image.owner_id = p_owner_id
      and image.status = 'active'
      and image.expires_at > statement_timestamp();
    if image_count <> cardinality(p_image_ids) or largest_image_bytes > 2 * 1024 * 1024 then
        return jsonb_build_object('outcome', 'invalid_media');
    end if;

    select max(inference_window.sequence_number) into latest_sequence
    from app.task_inference_windows as inference_window
    where inference_window.task_run_id = p_task_run_id;
    if latest_sequence is not null and p_sequence_number <= latest_sequence then
        return jsonb_build_object('outcome', 'out_of_order');
    end if;

    insert into app.task_inference_windows (
        id,
        task_run_id,
        owner_id,
        client_request_id,
        sequence_number,
        observed_state_version,
        image_ids,
        captured_at,
        status
    )
    values (
        p_window_id,
        p_task_run_id,
        p_owner_id,
        p_client_request_id,
        p_sequence_number,
        p_observed_state_version,
        p_image_ids,
        p_captured_at,
        'queued'
    );
    return jsonb_build_object(
        'outcome', 'accepted',
        'inferenceWindowId', p_window_id,
        'sequenceNumber', p_sequence_number,
        'status', 'queued',
        'stateVersion', p_observed_state_version,
        'createdAt', statement_timestamp()
    );
end;
$$;

revoke all on app.task_inference_windows from public;
revoke all on function app.create_task_inference_window(
    uuid, uuid, uuid, uuid, bigint, bigint, uuid[], jsonb
) from public;

grant execute on function app.create_task_inference_window(
    uuid, uuid, uuid, uuid, bigint, bigint, uuid[], jsonb
) to metaglasses_api;
