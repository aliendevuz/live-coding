import { useEffect, useState } from "react";
import { Session } from "./core/session";
import { loadSettings, type Settings } from "./core/settings";
import { Lobby } from "./ui/Lobby";
import { Workspace } from "./ui/Workspace";
import { PromptHost } from "./ui/prompt";
import { editorRegistry } from "./ui/editor-registry";

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [session, setSession] = useState<Session | null>(null);

  // Automation handle for end-to-end tests (scripts/e2e.mjs drives two app
  // windows over the DevTools protocol). Harmless: it only exposes what the
  // UI itself can do.
  useEffect(() => {
    (window as unknown as { __duet: unknown }).__duet = {
      session,
      editor: editorRegistry,
      host: async (s: Settings, project: string, room: string, key: string) => setSession(await Session.host(s, project, room, key)),
      join: async (s: Settings, room: string) => setSession(await Session.join(s, room)),
    };
  }, [session]);

  return (
    <>
      {session ? (
        <Workspace
          session={session}
          onLeave={() => {
            setSession(null);
            // The lesson may have saved audio device and volumes.
            setSettings(loadSettings());
          }}
        />
      ) : (
        <Lobby settings={settings} onSettings={setSettings} onSession={setSession} />
      )}
      <PromptHost />
    </>
  );
}
