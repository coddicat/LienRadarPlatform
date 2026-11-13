import { prisma } from "@lienradar/db";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({
      ok: true,
      service: "lienradar-web",
      db: "up",
      at: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        service: "lienradar-web",
        db: "down",
        error: e instanceof Error ? e.message : String(e),
        at: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}
