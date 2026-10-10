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

export async function runCleanup(): Promise<number> {
  const claimed = await database`select * from app.claim_expired_pairing_images(${1000})` as Array<{
    image_id: string;
    object_path: string;
  }>;
  if (claimed.length === 0) return 0;

  await s3.send(
    new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: claimed.map((image) => ({ Key: image.object_path })) },
    }),
  );
  const removed = await database`select app.finalize_expired_pairing_images(${
    claimed.map((image) => image.image_id)
  }) as count`;
  return Number(removed[0].count);
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
