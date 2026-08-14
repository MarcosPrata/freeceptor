import { getServerSession } from "@/lib/server/server-session";
import { HomeClient } from "@/app/home-client";

export default async function ServerPage() {
  const session = await getServerSession();
  return (
    <HomeClient
      initialSession={
        session.authenticated && session.serverName
          ? { authenticated: true, serverName: session.serverName }
          : null
      }
    />
  );
}
