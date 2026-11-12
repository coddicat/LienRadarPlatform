export { default } from "next-auth/middleware";

export const config = {
  matcher: ["/", "/lots/:path*", "/pipeline/:path*", "/admin/:path*", "/settings/:path*"],
};
