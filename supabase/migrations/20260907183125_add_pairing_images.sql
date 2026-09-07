create table public.pairing_images (
    id uuid primary key,
    token_hash bytea not null references app_private.pairings (token_hash) on delete restrict,
    owner_id uuid not null references auth.users (id) on delete restrict,
    object_path text not null unique,
    content_type text not null,
    byte_size bigint not null,
    created_at timestamptz not null,
    expires_at timestamptz not null,
    status text not null default 'active',
    claimed_at timestamptz,
    constraint pairing_images_token_hash_length check (octet_length(token_hash) = 32),
    constraint pairing_images_content_type check (
        content_type in ('image/jpeg', 'image/png')
    ),
    constraint pairing_images_byte_size check (byte_size > 0 and byte_size <= 8388608),
    constraint pairing_images_status check (status in ('active', 'deleting')),
    constraint pairing_images_claim_state check (
        (status = 'active' and claimed_at is null)
        or (status = 'deleting' and claimed_at is not null)
    ),
    constraint pairing_images_expiry_after_creation check (expires_at > created_at)
);

create index pairing_images_token_created_idx
    on public.pairing_images (token_hash, created_at);
create index pairing_images_owner_id_idx on public.pairing_images (owner_id);
create index pairing_images_cleanup_idx
    on public.pairing_images (status, expires_at, claimed_at);

alter table public.pairing_images enable row level security;
alter table public.pairing_images force row level security;

revoke all on table public.pairing_images from public, anon, authenticated;
grant select, insert, update, delete on table public.pairing_images to service_role;

comment on table public.pairing_images is
    'Private metadata for temporary pairing images stored in Supabase Storage.';

drop policy if exists "Pairing image owners can upload" on storage.objects;
create policy "Pairing image owners can upload"
on storage.objects
for insert
to authenticated
with check (
    bucket_id = 'Images'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "Pairing image owners can sign and download" on storage.objects;
create policy "Pairing image owners can sign and download"
on storage.objects
for select
to authenticated
using (
    bucket_id = 'Images'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "Pairing image owners can delete" on storage.objects;
create policy "Pairing image owners can delete"
on storage.objects
for delete
to authenticated
using (
    bucket_id = 'Images'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
);

create or replace function public.claim_expired_pairing_images(p_batch_size integer default 1000)
returns table (image_id uuid, object_path text)
language sql
security invoker
set search_path = ''
as $$
    with candidates as (
        select image.id
        from public.pairing_images as image
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
    update public.pairing_images as image
    set status = 'deleting', claimed_at = statement_timestamp()
    from candidates
    where image.id = candidates.id
    returning image.id, image.object_path;
$$;

create or replace function public.finalize_expired_pairing_images(p_image_ids uuid[])
returns bigint
language sql
security invoker
set search_path = ''
as $$
    with removed as (
        delete from public.pairing_images as image
        where image.id = any(p_image_ids)
          and image.status = 'deleting'
        returning image.id
    )
    select count(*) from removed;
$$;

revoke all on function public.claim_expired_pairing_images(integer)
    from public, anon, authenticated;
revoke all on function public.finalize_expired_pairing_images(uuid[])
    from public, anon, authenticated;
grant execute on function public.claim_expired_pairing_images(integer) to service_role;
grant execute on function public.finalize_expired_pairing_images(uuid[]) to service_role;
