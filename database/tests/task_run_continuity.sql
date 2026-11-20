set role metaglasses_api;
do $$
declare
    owner_id constant uuid := '41000000-0000-4000-8000-000000000001';
    other_id constant uuid := '41000000-0000-4000-8000-000000000002';
    older_run constant uuid := '41000000-0000-4000-8000-000000000031';
    retained_run constant uuid := '41000000-0000-4000-8000-000000000032';
    replacement constant uuid := '41000000-0000-4000-8000-000000000033';
    phone_run constant uuid := '41000000-0000-4000-8000-000000000034';
    replacement_plan constant uuid := '41000000-0000-4000-8000-000000000013';
    phone_plan constant uuid := '41000000-0000-4000-8000-000000000014';
    replacement_request constant uuid := '41000000-0000-4000-8000-000000000043';
    phone_request constant uuid := '41000000-0000-4000-8000-000000000044';
    command_id constant uuid := '41000000-0000-4000-8000-000000000051';
    command_request constant uuid := '41000000-0000-4000-8000-000000000052';
    resume_request constant uuid := '41000000-0000-4000-8000-000000000053';
    replacement_pairing constant text := repeat('42', 32);
    run jsonb;
    items jsonb;
begin
    if has_table_privilege(current_user, 'app.task_runs', 'select')
       or has_function_privilege(current_user, 'app.pause_active_task_run(uuid, uuid, bigint, uuid)', 'execute') then
        raise exception 'runtime permissions bypass run operations';
    end if;

    items := app.list_unfinished_task_runs(owner_id)->'items';
    if jsonb_array_length(items) is distinct from 2
        or items->0->>'taskRunId' is distinct from retained_run::text
        or items->0->>'latestSequenceNumber' is distinct from '8'
        or items->0->>'stateVersion' is distinct from '4'
        or items->1->>'taskRunId' is distinct from older_run::text
        or items->1->>'status' is distinct from 'paused'
        or items->1->>'stateVersion' is distinct from '3'
    then
        raise exception 'upgrade did not deterministically retain one active run and preserve legacy progress: %', items;
    end if;
    if app.list_unfinished_task_runs(other_id) is distinct from '{"items":[]}'::jsonb
        or app.task_run_view(retained_run, other_id) is not null
    then
        raise exception 'foreign runs are visible';
    end if;

    run := app.start_task_run(replacement, replacement_plan, owner_id, replacement_request,
        replacement_pairing, 2, retained_run, 4);
    if run is distinct from '{"outcome":"plan_stale","planVersion":1}'::jsonb then
        raise exception 'stale plan version did not fail: %', run;
    end if;
    run := app.start_task_run(replacement, replacement_plan, owner_id, replacement_request,
        replacement_pairing, 1, retained_run, 3);
    if run is distinct from '{"outcome":"active_conflict","stateVersion":4}'::jsonb then
        raise exception 'stale active run version did not fail: %', run;
    end if;
    run := app.start_task_run(replacement, replacement_plan, owner_id, replacement_request,
        replacement_pairing, 1, null, null);
    if run is distinct from '{"outcome":"active_conflict"}'::jsonb then
        raise exception 'start switched runs without an explicit active run: %', run;
    end if;
    run := app.start_task_run(phone_run, phone_plan, other_id, phone_request, null, 1, retained_run, 4);
    if run is distinct from '{"outcome":"active_conflict"}'::jsonb then
        raise exception 'foreign switch returned unsafe details: %', run;
    end if;
    if app.task_run_view(retained_run, owner_id)->>'status' is distinct from 'active' then
        raise exception 'unsuccessful start changed the active run';
    end if;

    -- An insert failure after the pause must roll back the entire switch.
    begin
        perform app.start_task_run(older_run, replacement_plan, owner_id, replacement_request,
            replacement_pairing, 1, retained_run, 4);
        raise exception 'duplicate run ID did not fail';
    exception when unique_violation then
        if app.task_run_view(retained_run, owner_id)->>'stateVersion' is distinct from '4' then
            raise exception 'failed insert left the active run paused';
        end if;
    end;

    run := app.start_task_run(replacement, replacement_plan, owner_id, replacement_request,
        replacement_pairing, 1, retained_run, 4);
    if run->>'status' is distinct from 'active' or run->>'latestSequenceNumber' is distinct from '0'
        or app.task_run_view(retained_run, owner_id)->>'status' is distinct from 'paused'
        or app.task_run_view(retained_run, owner_id)->>'stateVersion' is distinct from '5'
    then
        raise exception 'switch start failed: %', run;
    end if;
    if (select response_text from app.get_display(replacement_pairing)) is distinct from 'First step.' then
        raise exception 'initial legacy display publication failed';
    end if;
    run := app.apply_task_run_command(command_id, replacement, owner_id, command_request, 'confirm', 1);
    if run->>'stateVersion' is distinct from '2' or run->>'currentStepOrdinal' is distinct from '2' then
        raise exception 'confirm failed: %', run;
    end if;
    run := app.start_task_run(phone_run, replacement_plan, owner_id, replacement_request,
        replacement_pairing, 1, retained_run, 4);
    perform app.publish_task_run_start(replacement, owner_id);
    if run->>'taskRunId' is distinct from replacement::text or run->>'currentStepOrdinal' is distinct from '2'
        or (select response_text from app.get_display(replacement_pairing)) is distinct from 'Second step.'
    then
        raise exception 'duplicate start reset run or display: %', run;
    end if;
    run := app.start_task_run(phone_run, replacement_plan, owner_id, replacement_request,
        null, 1, retained_run, 4);
    if run->>'outcome' is distinct from 'idempotency_conflict' then
        raise exception 'changed start retry was allowed: %', run;
    end if;
    run := app.apply_task_run_command(command_id, replacement, other_id, command_request, 'confirm', 1);
    if run is distinct from '{"outcome":"not_found"}'::jsonb then
        raise exception 'foreign command replay leaked run data: %', run;
    end if;

    run := app.apply_task_run_command(command_id, retained_run, owner_id, resume_request, 'resume', 4, replacement, 2);
    if run is distinct from '{"outcome":"stale","stateVersion":5}'::jsonb then
        raise exception 'resume failed to enforce the paused target version: %', run;
    end if;
    run := app.apply_task_run_command(command_id, retained_run, owner_id, resume_request, 'resume', 5, replacement, 1);
    if run is distinct from '{"outcome":"active_conflict","stateVersion":2}'::jsonb then
        raise exception 'resume failed to enforce the active run version: %', run;
    end if;
    run := app.apply_task_run_command('41000000-0000-4000-8000-000000000054', retained_run, owner_id,
        resume_request, 'resume', 5, replacement, 2);
    if run->>'status' is distinct from 'active' or run->>'stateVersion' is distinct from '6'
        or app.task_run_view(replacement, owner_id)->>'status' is distinct from 'paused'
        or app.task_run_view(replacement, owner_id)->>'currentStepOrdinal' is distinct from '2'
    then
        raise exception 'resume did not atomically switch despite the expired pairing: %', run;
    end if;
    if app.apply_task_run_command(command_id, retained_run, owner_id, resume_request, 'resume', 5, replacement, 2)
        is distinct from run then
        raise exception 'resume retry did not return the original result';
    end if;
    if app.apply_task_run_command(command_id, retained_run, owner_id, resume_request, 'resume', 5, replacement, 3)->>'outcome'
        is distinct from 'idempotency_conflict' then
        raise exception 'changed resume retry was allowed';
    end if;

    run := app.start_task_run(phone_run, phone_plan, owner_id, phone_request, null, 1, retained_run, 6);
    if run->>'status' is distinct from 'active' then
        raise exception 'phone-only start failed: %', run;
    end if;
    items := app.list_unfinished_task_runs(owner_id)->'items';
    if items->0->>'taskRunId' is distinct from phone_run::text
        or items->1->>'taskRunId' is distinct from replacement::text
        or items->2->>'taskRunId' is distinct from retained_run::text
        or items->3->>'taskRunId' is distinct from older_run::text
    then
        raise exception 'unfinished sort does not put active first and break paused ties by id: %', items;
    end if;
    run := app.apply_task_run_command('41000000-0000-4000-8000-000000000055', phone_run, owner_id,
        '41000000-0000-4000-8000-000000000056', 'stop', 1);
    if run->>'status' is distinct from 'stopped'
        or jsonb_array_length(app.list_unfinished_task_runs(owner_id)->'items') is distinct from 3
    then
        raise exception 'terminal run remains in unfinished list: %', run;
    end if;
end;
$$;
reset role;

do $$
begin
    if exists (select 1 from app.task_runs
        where id = '41000000-0000-4000-8000-000000000034' and token_hash is not null) then
        raise exception 'phone-only start inherited the legacy plan pairing';
    end if;
end;
$$;

-- The first transaction keeps its owner lock while a second start attempts another plan.
select dblink_connect('run_first', 'dbname=postgres user=postgres');
select dblink_connect('run_second', 'dbname=postgres user=postgres');
select dblink_exec('run_first', 'begin');
select dblink_exec('run_first', 'set role metaglasses_api');
select dblink_exec('run_second', 'set role metaglasses_api');
select * from dblink('run_first', $query$
    select app.start_task_run('41000000-0000-4000-8000-000000000071',
        '41000000-0000-4000-8000-000000000013', '41000000-0000-4000-8000-000000000003',
        '41000000-0000-4000-8000-000000000081', null, 1, null, null)
$query$) as result(run jsonb);
select dblink_send_query('run_second', $query$
    select app.start_task_run('41000000-0000-4000-8000-000000000072',
        '41000000-0000-4000-8000-000000000014', '41000000-0000-4000-8000-000000000003',
        '41000000-0000-4000-8000-000000000082', null, 1, null, null)
$query$);
select dblink_exec('run_first', 'commit');
do $$
declare
    result jsonb;
begin
    select run into result from dblink_get_result('run_second') as response(run jsonb);
    if result is distinct from '{"outcome":"active_conflict"}'::jsonb
        or app.list_unfinished_task_runs('41000000-0000-4000-8000-000000000003')->'items'->0->>'taskRunId'
            is distinct from '41000000-0000-4000-8000-000000000071'
    then
        raise exception 'concurrent starts did not enforce one active run: %', result;
    end if;
end;
$$;
select dblink_disconnect('run_first');
select dblink_disconnect('run_second');
