import { DeleteObjectsCommand, S3Client } from "npm:@aws-sdk/client-s3@3.1149.0";
import { Signer } from "npm:@aws-sdk/rds-signer@3.1149.0";
import postgres from "npm:postgres@3.4.9";

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

const region = requiredEnvironment("AWS_REGION");
const signer = new Signer({
  hostname: requiredEnvironment("DATABASE_HOST"),
  port: Number(requiredEnvironment("DATABASE_PORT")),
  username: "metaglasses_api",
  region,
});
const database = postgres({
  host: requiredEnvironment("DATABASE_HOST"),
  port: Number(requiredEnvironment("DATABASE_PORT")),
  database: requiredEnvironment("DATABASE_NAME"),
  username: "metaglasses_api",
  password: () => signer.getAuthToken(),
  ssl: "require",
  max: 1,
  connect_timeout: 10,
  idle_timeout: 20,
});
const s3 = new S3Client({ region });
const bucket = requiredEnvironment("PAIRING_IMAGE_BUCKET");

interface CleanupImage {
  image_id: string;
  object_path: string;
}

async function cleanupImages(
  claimed: CleanupImage[],
  finalize: (imageIds: string[]) => PromiseLike<{ count: number }[]>,
): Promise<number> {
  if (claimed.length === 0) return 0;

  const result = await s3.send(
    new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: claimed.map((image) => ({ Key: image.object_path })) },
    }),
    { abortSignal: AbortSignal.timeout(15_000) },
  );
  const deleted = new Set(result.Deleted?.map((image) => image.Key));
  const removed = claimed.filter((image) => deleted.has(image.object_path));
  const count = removed.length
    ? Number((await finalize(removed.map((image) => image.image_id)))[0].count)
    : 0;
  if (removed.length !== claimed.length) {
    throw new Error("Some image objects could not be deleted.");
  }
  return count;
}

export async function runCleanup(): Promise<number> {
  const results = await Promise.allSettled([
    (async () =>
      cleanupImages(
        await database<CleanupImage[]>`select * from app.claim_expired_pairing_images(${1000})`,
        (ids) => database`select app.finalize_expired_pairing_images(${ids}) as count`,
      ))(),
    (async () =>
      cleanupImages(
        await database<CleanupImage[]>`select * from app.claim_expired_scoped_images(${1000})`,
        (ids) => database`select app.finalize_expired_scoped_images(${ids}) as count`,
      ))(),
  ]);
  let deleted = 0;
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
    deleted += result.value;
  }
  return deleted;
}

if (import.meta.main) {
  try {
    console.info(
      JSON.stringify({ event: "pairing_image_cleanup_completed", deleted: await runCleanup() }),
    );
  } catch (error) {
    console.error(JSON.stringify({
      event: "pairing_image_cleanup_failed",
      error: error instanceof Error ? error.name : "UnknownError",
    }));
    Deno.exit(1);
  } finally {
    await database.end({ timeout: 5 });
  }
}
