import { getChatGPTUser } from "./chatgpt-auth";
import { ArenaClient } from "./arena-client";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getChatGPTUser();
  return <ArenaClient userName={user?.displayName ?? "Local admin"} />;
}
