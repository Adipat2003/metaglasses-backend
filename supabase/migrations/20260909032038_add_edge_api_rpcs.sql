create or replace function public.edge_api_set_state(
    p_token_hash text,
    p_owner_id uuid,
    p_state text,
    p_ttl_seconds integer
)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
    with upserted as (
        insert into app_private.pairings (
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
                when pairings.expires_at <= statement_timestamp() then null
                else pairings.response_id
            end,
            response_text = case
                when pairings.expires_at <= statement_timestamp() then null
                else pairings.response_text
            end,
            response_created_at = case
                when pairings.expires_at <= statement_timestamp() then null
                else pairings.response_created_at
            end
        where pairings.owner_id = excluded.owner_id
           or pairings.expires_at <= statement_timestamp()
        returning token_hash, owner_id, expires_at
    ), refreshed_images as (
        update public.pairing_images as image
        set expires_at = upserted.expires_at
        from upserted
        where image.token_hash = upserted.token_hash
          and image.owner_id = upserted.owner_id
          and image.expires_at > statement_timestamp()
        returning image.id
    )
    select exists (select 1 from upserted);
$$;

create or replace function public.edge_api_save_response(
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
set search_path = ''
as $$
    with upserted as (
        insert into app_private.pairings (
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
        where pairings.owner_id = excluded.owner_id
           or pairings.expires_at <= statement_timestamp()
        returning
            pairings.token_hash,
            pairings.owner_id,
            pairings.expires_at,
            pairings.response_id,
            pairings.response_text,
            pairings.state,
            pairings.response_created_at
    ), refreshed_images as (
        update public.pairing_images as image
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

create or replace function public.edge_api_get_display(p_token_hash text)
returns table (
    response_id text,
    response_text text,
    state text,
    response_created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
    select
        pairing.response_id,
        pairing.response_text,
        pairing.state,
        pairing.response_created_at
    from app_private.pairings as pairing
    where pairing.token_hash = decode(p_token_hash, 'hex')
      and pairing.expires_at > statement_timestamp();
$$;

create or replace function public.edge_api_pairing_access(
    p_token_hash text,
    p_owner_id uuid
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
    select case
        when pairing.token_hash is null or pairing.expires_at <= statement_timestamp()
            then 'not_found'
        when pairing.owner_id <> p_owner_id then 'forbidden'
        else 'active'
    end
    from (select 1) as sentinel
    left join app_private.pairings as pairing
      on pairing.token_hash = decode(p_token_hash, 'hex');
$$;

create or replace function public.edge_api_register_image(
    p_token_hash text,
    p_owner_id uuid,
    p_image_id uuid,
    p_object_path text,
    p_content_type text,
    p_byte_size bigint,
    p_max_images integer
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    pairing_owner_id uuid;
    pairing_expires_at timestamptz;
    active_image_count bigint;
begin
    select pairing.owner_id, pairing.expires_at
    into pairing_owner_id, pairing_expires_at
    from app_private.pairings as pairing
    where pairing.token_hash = decode(p_token_hash, 'hex')
      and pairing.expires_at > statement_timestamp()
    for update;

    if not found then
        return 'not_found';
    end if;
    if pairing_owner_id <> p_owner_id then
        return 'forbidden';
    end if;

    select count(*)
    into active_image_count
    from public.pairing_images as image
    where image.token_hash = decode(p_token_hash, 'hex')
      and image.status = 'active';

    if active_image_count >= p_max_images then
        return 'limit';
    end if;

    insert into public.pairing_images (
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

create or replace function public.edge_api_get_images(
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
set search_path = ''
as $$
    select
        image.id,
        image.object_path,
        image.content_type,
        image.byte_size,
        image.created_at
    from public.pairing_images as image
    join app_private.pairings as pairing
      on pairing.token_hash = image.token_hash
    where image.token_hash = decode(p_token_hash, 'hex')
      and image.owner_id = p_owner_id
      and pairing.owner_id = p_owner_id
      and image.status = 'active'
      and image.expires_at > statement_timestamp()
      and pairing.expires_at > statement_timestamp()
      and image.id = any(p_image_ids);
$$;

create or replace function public.edge_api_remove_image(
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
set search_path = ''
as $$
    delete from public.pairing_images as image
    using app_private.pairings as pairing
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

revoke all on function public.edge_api_set_state(text, uuid, text, integer)
    from public, anon, authenticated;
revoke all on function public.edge_api_save_response(text, uuid, text, text, integer)
    from public, anon, authenticated;
revoke all on function public.edge_api_get_display(text)
    from public, anon, authenticated;
revoke all on function public.edge_api_pairing_access(text, uuid)
    from public, anon, authenticated;
revoke all on function public.edge_api_register_image(
    text, uuid, uuid, text, text, bigint, integer
) from public, anon, authenticated;
revoke all on function public.edge_api_get_images(text, uuid, uuid[])
    from public, anon, authenticated;
revoke all on function public.edge_api_remove_image(text, uuid, uuid)
    from public, anon, authenticated;

grant execute on function public.edge_api_set_state(text, uuid, text, integer)
    to service_role;
grant execute on function public.edge_api_save_response(text, uuid, text, text, integer)
    to service_role;
grant execute on function public.edge_api_get_display(text)
    to service_role;
grant execute on function public.edge_api_pairing_access(text, uuid)
    to service_role;
grant execute on function public.edge_api_register_image(
    text, uuid, uuid, text, text, bigint, integer
) to service_role;
grant execute on function public.edge_api_get_images(text, uuid, uuid[])
    to service_role;
grant execute on function public.edge_api_remove_image(text, uuid, uuid)
    to service_role;

comment on function public.edge_api_set_state(text, uuid, text, integer) is
    'Service-role-only pairing state mutation used by the MetaGlasses Edge API.';
