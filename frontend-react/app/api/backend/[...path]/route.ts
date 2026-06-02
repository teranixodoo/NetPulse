// app/api/backend/[...path]/route.ts
// Proxy handler — přeposílá všechny /api/backend/* požadavky na FastAPI backend
// Čte API_URL za runtime (ne při buildu) → funguje v Docker standalone

import { type NextRequest, NextResponse } from "next/server";

// Backend běží na hostu (network_mode: host), ne uvnitř docker sítě „backend“.
const BACKEND =
  process.env.API_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  "http://host.docker.internal:8000";

async function handler(
  req: NextRequest,
  { params }: { params: { path: string[] } }
) {
  const path     = params.path.join("/");
  const search   = req.nextUrl.search;
  const targetUrl = `${BACKEND}/${path}${search}`;

  // Přepošleme headers (Authorization, Content-Type)
  const headers = new Headers();
  const auth = req.headers.get("authorization");
  const ct   = req.headers.get("content-type");
  if (auth) headers.set("authorization", auth);
  if (ct)   headers.set("content-type", ct);

  // Přepošleme body pro POST/PUT/PATCH
  let body: BodyInit | undefined;
  if (!["GET", "HEAD", "DELETE"].includes(req.method)) {
    body = await req.text();
  }

  try {
    const res = await fetch(targetUrl, {
      method:  req.method,
      headers,
      body,
    });

    const data = await res.text();

    return new NextResponse(data, {
      status:  res.status,
      headers: {
        "content-type": res.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (err) {
    console.error(`Proxy chyba → ${targetUrl}:`, err);
    return NextResponse.json(
      { detail: "Backend nedostupný" },
      { status: 502 }
    );
  }
}

export const GET     = handler;
export const POST    = handler;
export const PUT     = handler;
export const DELETE  = handler;
export const PATCH   = handler;
