"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LIST_ENGINE_COOKIE, LIST_ENGINE_ROUTES, parseListEngine } from "@/lib/list-engine";

// The Classic/New list switch (lib/list-engine.ts). Ungated on purpose: it only
// stores a display preference for this device, and the list pages it leads to
// gate themselves. It lands on the BARE list route — neither engine has to
// understand the other's filter params.
export async function switchListEngineAction(formData: FormData) {
  const engine = parseListEngine(formData.get("engine"));
  const list = LIST_ENGINE_ROUTES.find((route) => route === formData.get("list"));
  (await cookies()).set(LIST_ENGINE_COOKIE, engine, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  redirect(list ?? LIST_ENGINE_ROUTES[0]);
}
