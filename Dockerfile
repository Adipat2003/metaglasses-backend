FROM denoland/deno:2.5.2

WORKDIR /app
COPY backend ./backend
COPY database/migrations ./database/migrations
# Preserve the path used by the cleanup timer installed on existing instances.
RUN mkdir -p supabase && ln -s /app/backend /app/supabase/functions
RUN deno cache --config backend/deno.json backend/api/index.ts \
  backend/cleanup-pairing-images/index.ts \
  backend/migrate.ts

ENTRYPOINT ["deno"]
CMD ["run", "--allow-env", "--allow-net", "--allow-sys=osRelease", "backend/api/index.ts"]
