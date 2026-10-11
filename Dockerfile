FROM denoland/deno:2.5.2

WORKDIR /app
COPY supabase/functions ./supabase/functions
COPY database/migrations ./database/migrations
RUN deno cache --config supabase/functions/deno.json supabase/functions/api/index.ts \
  supabase/functions/cleanup-pairing-images/index.ts \
  supabase/functions/migrate.ts

ENTRYPOINT ["deno"]
CMD ["run", "--allow-env", "--allow-net", "supabase/functions/api/index.ts"]
