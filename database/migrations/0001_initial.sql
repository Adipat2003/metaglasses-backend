create schema if not exists app;

revoke all on schema app from public;

create table app.pairings (
    token_hash bytea primary key,
    owner_id uuid not null,
    state text not null,
    last_phone_activity timestamptz not null,
    expires_at timestamptz not null,
    response_id text,
    response_text text,
    response_created_at timestamptz,
    constraint pairings_token_hash_length check (octet_length(token_hash) = 32),
    constraint pairings_state check (state in ('idle', 'listening', 'thinking', 'speaking')),
    constraint pairings_response_fields check (
        (response_id is null and response_text is null and response_created_at is null)
        or (response_id is not null and response_text is not null and response_created_at is not null)
    ),
    constraint pairings_expiry_after_activity check (expires_at > last_phone_activity)
);

create index pairings_owner_id_idx on app.pairings (owner_id);
create index pairings_expires_at_idx on app.pairings (expires_at);

create table app.pairing_images (
    id uuid primary key,
    token_hash bytea not null references app.pairings (token_hash) on delete restrict,
    owner_id uuid not null,
    object_path text not null unique,
    content_type text not null,
    byte_size bigint not null,
    created_at timestamptz not null,
    expires_at timestamptz not null,
    status text not null default 'active',
    claimed_at timestamptz,
    constraint pairing_images_token_hash_length check (octet_length(token_hash) = 32),
    constraint pairing_images_content_type check (content_type in ('image/jpeg', 'image/png')),
    constraint pairing_images_byte_size check (byte_size > 0 and byte_size <= 8388608),
    constraint pairing_images_status check (status in ('active', 'deleting')),
    constraint pairing_images_claim_state check (
        (status = 'active' and claimed_at is null)
        or (status = 'deleting' and claimed_at is not null)
    ),
    constraint pairing_images_expiry_after_creation check (expires_at > created_at)
);

create index pairing_images_token_created_idx on app.pairing_images (token_hash, created_at);
create index pairing_images_owner_id_idx on app.pairing_images (owner_id);
create index pairing_images_cleanup_idx on app.pairing_images (status, expires_at, claimed_at);

create or replace function app.set_state(
    p_token_hash text,
    p_owner_id uuid,
    p_state text,
    p_ttl_seconds integer
)
returns boolean
language sql
volatile
security definer
set search_path = pg_catalog, app
as $$
    with upserted as (
        insert into app.pairings (
            token_hash,
            owner_id,
            state,
            last_phone_activity,
            expires_at
        )
        values (
            decode(p_token_hash, 'hex'),
            p_owner_id,
            p_state,
            statement_timestamp(),
            statement_timestamp() + make_interval(secs => p_ttl_seconds)
        )
        on conflict (token_hash) do update
        set owner_id = excluded.owner_id,
            state = excluded.state,
            last_phone_activity = excluded.last_phone_activity,
            expires_at = excluded.expires_at,
            response_id = case
                when app.pairings.expires_at <= statement_timestamp() then null
                else app.pairings.response_id
            end,
            response_text = case
                when app.pairings.expires_at <= statement_timestamp() then null
                else app.pairings.response_text
            end,
            response_created_at = case
                when app.pairings.expires_at <= statement_timestamp() then null
                else app.pairings.response_created_at
            end
        where app.pairings.owner_id = excluded.owner_id
           or app.pairings.expires_at <= statement_timestamp()
        returning token_hash, owner_id, expires_at
    ), refreshed_images as (
        update app.pairing_images as image
        set expires_at = upserted.expires_at
        from upserted
        where image.token_hash = upserted.token_hash
          and image.owner_id = upserted.owner_id
          and image.expires_at > statement_timestamp()
        returning image.id
    )
    select exists (select 1 from upserted);
$$;

create or replace function app.save_response(
    p_token_hash text,
    p_owner_id uuid,
    p_response_id text,
    p_response_text text,
    p_ttl_seconds integer
)
returns table (
    response_id text,
    response_text text,
    state text,
    response_created_at timestamptz
)
language sql
volatile
security definer
set search_path = pg_catalog, app
as $$
    with upserted as (
        insert into app.pairings (
            token_hash,
            owner_id,
            state,
            last_phone_activity,
            expires_at,
            response_id,
            response_text,
            response_created_at
        )
        values (
            decode(p_token_hash, 'hex'),
            p_owner_id,
            'speaking',
            statement_timestamp(),
            statement_timestamp() + make_interval(secs => p_ttl_seconds),
            p_response_id,
            p_response_text,
            statement_timestamp()
        )
        on conflict (token_hash) do update
        set owner_id = excluded.owner_id,
            state = excluded.state,
            last_phone_activity = excluded.last_phone_activity,
            expires_at = excluded.expires_at,
            response_id = excluded.response_id,
            response_text = excluded.response_text,
            response_created_at = excluded.response_created_at
        where app.pairings.owner_id = excluded.owner_id
           or app.pairings.expires_at <= statement_timestamp()
        returning
            app.pairings.token_hash,
            app.pairings.owner_id,
            app.pairings.expires_at,
            app.pairings.response_id,
            app.pairings.response_text,
            app.pairings.state,
            app.pairings.response_created_at
    ), refreshed_images as (
        update app.pairing_images as image
        set expires_at = upserted.expires_at
        from upserted
        where image.token_hash = upserted.token_hash
          and image.owner_id = upserted.owner_id
          and image.expires_at > statement_timestamp()
        returning image.id
    )
    select
        upserted.response_id,
        upserted.response_text,
        upserted.state,
        upserted.response_created_at
    from upserted;
$$;

create or replace function app.get_display(p_token_hash text)
returns table (
    response_id text,
    response_text text,
    state text,
    response_created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, app
as $$
    select
        pairing.response_id,
        pairing.response_text,
        pairing.state,
        pairing.response_created_at
    from app.pairings as pairing
    where pairing.token_hash = decode(p_token_hash, 'hex')
      and pairing.expires_at > statement_timestamp();
$$;

create or replace function app.pairing_access(p_token_hash text, p_owner_id uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog, app
as $$
    select case
        when pairing.token_hash is null or pairing.expires_at <= statement_timestamp()
            then 'not_found'
        when pairing.owner_id <> p_owner_id then 'forbidden'
        else 'active'
    end
    from (select 1) as sentinel
    left join app.pairings as pairing
      on pairing.token_hash = decode(p_token_hash, 'hex');
$$;

create or replace function app.register_image(
    p_token_hash text,
    p_owner_id uuid,
    p_image_id uuid,
    p_object_path text,
    p_content_type text,
    p_byte_size bigint
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, app
as $$
declare
    pairing_owner_id uuid;
    pairing_expires_at timestamptz;
begin
    select pairing.owner_id, pairing.expires_at
    into pairing_owner_id, pairing_expires_at
    from app.pairings as pairing
    where pairing.token_hash = decode(p_token_hash, 'hex')
      and pairing.expires_at > statement_timestamp()
    for update;

    if not found then
        return 'not_found';
    end if;
    if pairing_owner_id <> p_owner_id then
        return 'forbidden';
    end if;

    insert into app.pairing_images (
        id,
        token_hash,
        owner_id,
        object_path,
        content_type,
        byte_size,
        created_at,
        expires_at
    )
    values (
        p_image_id,
        decode(p_token_hash, 'hex'),
        p_owner_id,
        p_object_path,
        p_content_type,
        p_byte_size,
        statement_timestamp(),
        pairing_expires_at
    );

    return 'registered';
end;
$$;

create or replace function app.get_images(
    p_token_hash text,
    p_owner_id uuid,
    p_image_ids uuid[]
)
returns table (
    image_id uuid,
    object_path text,
    content_type text,
    byte_size bigint,
    created_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, app
as $$
    select
        image.id,
        image.object_path,
        image.content_type,
        image.byte_size,
        image.created_at
    from app.pairing_images as image
    join app.pairings as pairing
      on pairing.token_hash = image.token_hash
    where image.token_hash = decode(p_token_hash, 'hex')
      and image.owner_id = p_owner_id
      and pairing.owner_id = p_owner_id
      and image.status = 'active'
      and image.expires_at > statement_timestamp()
      and pairing.expires_at > statement_timestamp()
      and image.id = any(p_image_ids);
$$;

create or replace function app.remove_image(
    p_token_hash text,
    p_owner_id uuid,
    p_image_id uuid
)
returns table (
    image_id uuid,
    object_path text,
    content_type text,
    byte_size bigint,
    created_at timestamptz
)
language sql
volatile
security definer
set search_path = pg_catalog, app
as $$
    delete from app.pairing_images as image
    using app.pairings as pairing
    where image.id = p_image_id
      and image.token_hash = decode(p_token_hash, 'hex')
      and image.owner_id = p_owner_id
      and pairing.token_hash = image.token_hash
      and pairing.owner_id = p_owner_id
      and pairing.expires_at > statement_timestamp()
      and image.status = 'active'
    returning
        image.id,
        image.object_path,
        image.content_type,
        image.byte_size,
        image.created_at;
$$;

create or replace function app.claim_expired_pairing_images(p_batch_size integer default 1000)
returns table (image_id uuid, object_path text)
language sql
volatile
security definer
set search_path = pg_catalog, app
as $$
    with candidates as (
        select image.id
        from app.pairing_images as image
        where image.expires_at <= statement_timestamp()
          and (
              image.status = 'active'
              or (
                  image.status = 'deleting'
                  and image.claimed_at <= statement_timestamp() - interval '5 minutes'
              )
          )
        order by image.expires_at, image.id
        for update skip locked
        limit least(greatest(p_batch_size, 1), 1000)
    )
    update app.pairing_images as image
    set status = 'deleting', claimed_at = statement_timestamp()
    from candidates
    where image.id = candidates.id
    returning image.id, image.object_path;
$$;

create or replace function app.finalize_expired_pairing_images(p_image_ids uuid[])
returns bigint
language sql
volatile
security definer
set search_path = pg_catalog, app
as $$
    with removed as (
        delete from app.pairing_images as image
        where image.id = any(p_image_ids)
          and image.status = 'deleting'
        returning image.id
    )
    select count(*) from removed;
$$;

revoke all on all tables in schema app from public;
revoke all on all functions in schema app from public;
