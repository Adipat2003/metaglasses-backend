create schema if not exists app_private;

revoke all on schema app_private from public, anon, authenticated;

create table app_private.pairings (
    token_hash bytea primary key,
    owner_id uuid not null references auth.users (id) on delete cascade,
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
        or
        (response_id is not null and response_text is not null and response_created_at is not null)
    ),
    constraint pairings_expiry_after_activity check (expires_at > last_phone_activity)
);

create index pairings_owner_id_idx on app_private.pairings (owner_id);
create index pairings_expires_at_idx on app_private.pairings (expires_at);

comment on table app_private.pairings is
    'Short-lived phone-to-lens pairing state. Tokens are stored only as SHA-256 hashes.';
