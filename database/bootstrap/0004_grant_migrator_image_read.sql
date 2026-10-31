-- create_task_inference_window is a security-definer function owned by metaglasses_migrator and it
-- reads app.pairing_images, which the database administrator created in migration 0001. Without
-- this grant the function fails with "permission denied for table pairing_images". Only the table
-- owner can grant it, so run it once as the database administrator.
grant select on table app.pairing_images to metaglasses_migrator;
