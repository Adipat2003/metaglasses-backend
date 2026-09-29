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

comment on function public.edge_api_register_image(
    text, uuid, uuid, text, text, bigint, integer
) is
    'Registers an image for an active pairing. p_max_images is retained for RPC compatibility and is ignored.';

revoke all on function public.edge_api_register_image(
    text, uuid, uuid, text, text, bigint, integer
) from public, anon, authenticated;
grant execute on function public.edge_api_register_image(
    text, uuid, uuid, text, text, bigint, integer
) to service_role;
