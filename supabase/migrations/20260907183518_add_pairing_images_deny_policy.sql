create policy "No direct pairing image metadata access"
on public.pairing_images
for all
to anon, authenticated
using (false)
with check (false);
