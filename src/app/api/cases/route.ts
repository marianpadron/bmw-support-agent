import { createCase, listCases, type CaseSeverity } from "@/lib/cases";

const SEVERITIES: CaseSeverity[] = ["low", "medium", "high"];

export async function POST(request: Request) {
  let body: { vehicle?: unknown; summary?: unknown; severity?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body.summary !== "string" || body.summary.length === 0) {
    return Response.json({ error: "summary is required." }, { status: 400 });
  }

  const serviceCase = createCase({
    vehicle: typeof body.vehicle === "string" && body.vehicle ? body.vehicle : "unknown",
    summary: body.summary,
    severity: SEVERITIES.includes(body.severity as CaseSeverity)
      ? (body.severity as CaseSeverity)
      : "medium",
  });
  return Response.json({ case: serviceCase }, { status: 201 });
}

export async function GET() {
  return Response.json({ cases: listCases() });
}
