import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import {
  DEFAULT_METHOD_SETTINGS,
  getUserMethodSettings,
  normalizeMethodSettings,
  saveUserMethodSettings,
} from "@/lib/methodSettings";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const settings = await getUserMethodSettings(userId);
  return NextResponse.json({ settings, defaults: DEFAULT_METHOD_SETTINGS });
}

export async function PUT(req: Request) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const raw =
    body && typeof body === "object" && "settings" in body
      ? (body as { settings: unknown }).settings
      : body;

  if (raw === "defaults" || (body && typeof body === "object" && (body as { reset?: boolean }).reset)) {
    const settings = await saveUserMethodSettings(userId, DEFAULT_METHOD_SETTINGS);
    return NextResponse.json({ settings, defaults: DEFAULT_METHOD_SETTINGS });
  }

  const settings = await saveUserMethodSettings(userId, normalizeMethodSettings(raw));
  return NextResponse.json({ settings, defaults: DEFAULT_METHOD_SETTINGS });
}
