import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const maxImageBytes = 8 * 1024 * 1024;

function serviceHeaders(serviceKey: string): Record<string, string> {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };
}

async function secureBucket(
  supabaseUrl: string,
  headers: Record<string, string>,
): Promise<string | null> {
  const configuredBucket = Deno.env.get("PAIRING_IMAGE_BUCKET")?.trim();
  const candidates = [
    ...new Set([configuredBucket, "Images", "images"].filter(Boolean)),
  ] as string[];

  for (const candidate of candidates) {
    const response = await fetch(
      `${supabaseUrl}/storage/v1/bucket/${encodeURIComponent(candidate)}`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          public: false,
          file_size_limit: maxImageBytes,
          allowed_mime_types: ["image/jpeg", "image/png"],
        }),
      },
    );
    if (response.ok) {
      return candidate;
    }
    const responseDetail = (await response.text()).slice(0, 200);
    if (response.status === 404 || responseDetail.includes('"code":"NoSuchBucket"')) {
      continue;
    }
    throw new Error(`Could not secure pairing image bucket: ${response.status}`);
  }

  return null;
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ error: "Supabase environment is unavailable" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const headers = serviceHeaders(serviceKey);
  let bucket: string | null;
  try {
    bucket = await secureBucket(supabaseUrl, headers);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown Storage error";
    return new Response(
      JSON.stringify({ error: "Could not secure pairing image bucket", detail }),
      {
        status: 502,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  if (!bucket) {
    return new Response(JSON.stringify({ error: "Pairing image bucket does not exist" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const claimResponse = await fetch(
    `${supabaseUrl}/rest/v1/rpc/claim_expired_pairing_images`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ p_batch_size: 1000 }),
    },
  );
  if (!claimResponse.ok) {
    return new Response(JSON.stringify({ error: "Could not claim expired images" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  const claimed = (await claimResponse.json()) as Array<{
    image_id: string;
    object_path: string;
  }>;
  if (claimed.length === 0) {
    return new Response(JSON.stringify({ deleted: 0 }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const deleteResponse = await fetch(
    `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}`,
    {
      method: "DELETE",
      headers,
      body: JSON.stringify({ prefixes: claimed.map((image) => image.object_path) }),
    },
  );
  if (!deleteResponse.ok) {
    return new Response(JSON.stringify({ error: "Could not delete expired images" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  const finalizeResponse = await fetch(
    `${supabaseUrl}/rest/v1/rpc/finalize_expired_pairing_images`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ p_image_ids: claimed.map((image) => image.image_id) }),
    },
  );
  if (!finalizeResponse.ok) {
    return new Response(JSON.stringify({ error: "Could not finalize expired images" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ deleted: claimed.length }), {
    headers: { "Content-Type": "application/json" },
  });
});
