drop policy if exists "Pairing image owners can upload" on storage.objects;
create policy "Pairing image owners can upload"
on storage.objects
for insert
to authenticated
with check (
    bucket_id in ('Images', 'images')
    and (storage.foldername(name))[1] = (select auth.uid()::text)
    and app_private.can_access_pairing_image(name)
);

drop policy if exists "Pairing image owners can sign and download" on storage.objects;
create policy "Pairing image owners can sign and download"
on storage.objects
for select
to authenticated
using (
    bucket_id in ('Images', 'images')
    and (storage.foldername(name))[1] = (select auth.uid()::text)
    and app_private.can_access_pairing_image(name)
);

drop policy if exists "Pairing image owners can delete" on storage.objects;
create policy "Pairing image owners can delete"
on storage.objects
for delete
to authenticated
using (
    bucket_id in ('Images', 'images')
    and (storage.foldername(name))[1] = (select auth.uid()::text)
    and app_private.can_access_pairing_image(name)
);
