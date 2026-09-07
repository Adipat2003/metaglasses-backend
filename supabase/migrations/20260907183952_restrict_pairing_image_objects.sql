grant usage on schema app_private to authenticated;

create or replace function app_private.can_access_pairing_image(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.pairing_images as image
        join app_private.pairings as pairing
          on pairing.token_hash = image.token_hash
        where image.object_path = p_object_name
          and image.owner_id = (select auth.uid())
          and pairing.owner_id = (select auth.uid())
          and image.status = 'active'
          and image.expires_at > statement_timestamp()
          and pairing.expires_at > statement_timestamp()
    );
$$;

revoke all on function app_private.can_access_pairing_image(text)
    from public, anon, authenticated;
grant execute on function app_private.can_access_pairing_image(text) to authenticated;

drop policy if exists "Pairing image owners can upload" on storage.objects;
create policy "Pairing image owners can upload"
on storage.objects
for insert
to authenticated
with check (
    bucket_id = 'Images'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
    and app_private.can_access_pairing_image(name)
);

drop policy if exists "Pairing image owners can sign and download" on storage.objects;
create policy "Pairing image owners can sign and download"
on storage.objects
for select
to authenticated
using (
    bucket_id = 'Images'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
    and app_private.can_access_pairing_image(name)
);

drop policy if exists "Pairing image owners can delete" on storage.objects;
create policy "Pairing image owners can delete"
on storage.objects
for delete
to authenticated
using (
    bucket_id = 'Images'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
    and app_private.can_access_pairing_image(name)
);
