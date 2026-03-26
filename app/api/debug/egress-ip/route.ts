import { NextResponse } from "next/server";

export const runtime = "nodejs";

async function fetchJson(url: string) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`${url} -> ${res.status}`);
  }
  return res.json();
}

export async function GET() {
  const out: Record<string, unknown> = {
    serverTime: new Date().toISOString(),
  };

  try {
    const ipify = (await fetchJson("https://api.ipify.org?format=json")) as {
      ip?: string;
    };
    out.ipify = ipify.ip || null;
  } catch (e) {
    out.ipifyError = e instanceof Error ? e.message : "Failed";
  }

  try {
    const ipinfo = (await fetchJson("https://ipinfo.io/json")) as {
      ip?: string;
      city?: string;
      region?: string;
      country?: string;
      org?: string;
      timezone?: string;
    };
    out.ipinfo = {
      ip: ipinfo.ip || null,
      city: ipinfo.city || null,
      region: ipinfo.region || null,
      country: ipinfo.country || null,
      org: ipinfo.org || null,
      timezone: ipinfo.timezone || null,
    };
  } catch (e) {
    out.ipinfoError = e instanceof Error ? e.message : "Failed";
  }

  return NextResponse.json(out);
}

