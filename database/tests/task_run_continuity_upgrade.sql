-- Insert legacy rows before the owner-wide active constraint is installed.
insert into app.pairings (token_hash, owner_id, state, last_phone_activity, expires_at)
values
 (decode(repeat('41', 32), 'hex'), '41000000-0000-4000-8000-000000000001', 'idle', now() - interval '2 hours', now() - interval '1 hour'),
 (decode(repeat('42', 32), 'hex'), '41000000-0000-4000-8000-000000000001', 'idle', now(), now() + interval '1 hour');

insert into app.task_plans (id, token_hash, owner_id, client_request_id, title, status, current_version, approved_version)
values
 ('41000000-0000-4000-8000-000000000011', decode(repeat('41', 32), 'hex'), '41000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000021', 'Older active', 'approved', 1, 1),
 ('41000000-0000-4000-8000-000000000012', decode(repeat('41', 32), 'hex'), '41000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000022', 'Retained active', 'approved', 1, 1),
 ('41000000-0000-4000-8000-000000000013', decode(repeat('42', 32), 'hex'), '41000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000023', 'Replacement', 'approved', 1, 1),
 ('41000000-0000-4000-8000-000000000014', decode(repeat('42', 32), 'hex'), '41000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000024', 'Phone replacement', 'approved', 1, 1);

insert into app.task_plan_versions (task_plan_id, version, source_steps, validation_status, validation_result, validated_at)
select plan.id, 1, '[{"instruction":"First step."},{"instruction":"Second step."}]', 'validated', '{}', now()
from app.task_plans as plan
where plan.owner_id = '41000000-0000-4000-8000-000000000001';

insert into app.task_runs (id, task_plan_id, task_plan_version, token_hash, owner_id, client_request_id, state_version, updated_at)
values
 ('41000000-0000-4000-8000-000000000031', '41000000-0000-4000-8000-000000000011', 1, decode(repeat('41', 32), 'hex'), '41000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000041', 2, now() - interval '10 minutes'),
 ('41000000-0000-4000-8000-000000000032', '41000000-0000-4000-8000-000000000012', 1, decode(repeat('41', 32), 'hex'), '41000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000042', 4, now() - interval '10 minutes');

insert into app.task_inference_windows (id, task_run_id, owner_id, client_request_id, sequence_number, observed_state_version, image_ids, captured_at, status)
values ('41000000-0000-4000-8000-000000000061', '41000000-0000-4000-8000-000000000032',
    '41000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000062', 8, 4,
    array['41000000-0000-4000-8000-000000000063']::uuid[], '["2000-01-01T00:00:00Z"]', 'rejected');
