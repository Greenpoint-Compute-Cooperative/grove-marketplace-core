import { publicConfiguration } from "../lib/server/config.js";
import { json } from "../lib/server/http.js";

export const GET = async () => json(publicConfiguration(), {
  headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=300" }
});
