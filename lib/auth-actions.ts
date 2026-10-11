"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { STUDENT_MODE_COOKIE } from "./student-mode";

// Server action for the sign-out button in the (client) user menu. Keeping it in
// its own "use server" module lets a client component import and pass it to a
// <form action={...}> without pulling server-only auth code into the client bundle.
export async function signOutAction() {
  // Student mode must not outlive the session. The cookie already applies only
  // to the session that set it (lib/student-mode.ts); deleting it here keeps
  // the browser tidy.
  (await cookies()).delete(STUDENT_MODE_COOKIE);
  // Deletes the session row and clears the session cookie (the nextCookies()
  // plugin applies better-auth's Set-Cookie headers from a server action).
  await auth.api.signOut({ headers: await headers() });
  redirect("/sign-in");
}
