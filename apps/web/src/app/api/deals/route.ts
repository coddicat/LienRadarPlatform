import { prisma } from "@lienradar/db";
import { DealStatus } from "@lienradar/shared";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json();
  const lotId = String(body.lotId || "");
  const status = String(body.status || DealStatus.WATCHING);
  if (!lotId) return NextResponse.json({ error: "lotId required" }, { status: 400 });
  if (!Object.values(DealStatus).includes(status as DealStatus)) {
    return NextResponse.json({ error: "invalid status" }, { status: 400 });
  }

  const deal = await prisma.deal.upsert({
    where: { lotId_userId: { lotId, userId } },
    update: {
      status: status as DealStatus,
      maxBid: body.maxBid != null ? String(body.maxBid) : null,
      notes: body.notes ? String(body.notes) : null,
      thesis: body.thesis ? String(body.thesis) : null,
    },
    create: {
      lotId,
      userId,
      status: status as DealStatus,
      maxBid: body.maxBid != null ? String(body.maxBid) : null,
      notes: body.notes ? String(body.notes) : null,
      thesis: body.thesis ? String(body.thesis) : null,
    },
  });

  return NextResponse.json({ id: deal.id });
}
