import { useEffect, useRef, useState } from "react";
import { SendHorizontal, X } from "lucide-react";
import type { Session } from "../core/session";
import { useEvent } from "./hooks";

export function Chat({ session, onClose }: { session: Session; onClose: () => void }) {
  const msgs = useEvent(session, "chat", session.chat);
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const connected = useEvent(session, "state", session.state) === "connected";

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [msgs]);

  const send = () => {
    if (!connected) return;
    session.sendChat(text);
    setText("");
  };

  return (
    <div className="pane" data-anchor="chat" style={{ height: "100%" }}>
      <div className="pane-head">
        <span className="title">Chat</span>
        <button className="icon" onClick={onClose} title="Hide chat"><X size={15} /></button>
      </div>
      <div className="chat-list" ref={listRef}>
        {msgs.map((m) =>
          m.system ? (
            <div key={m.id} className="msg system">{m.text}</div>
          ) : (
            <div key={m.id} className={`msg${m.mine ? " mine" : ""}`}>
              {!m.mine && <div className="who" style={{ color: m.color }}>{m.from}</div>}
              {m.text}
            </div>
          ),
        )}
      </div>
      <div className="chat-input">
        <button className="send" disabled={!connected || !text.trim()} onClick={send} title="Send">
          <SendHorizontal size={16} />
        </button>
        <textarea
          value={text}
          placeholder={connected ? "Message…" : "Not connected"}
          disabled={!connected}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
      </div>
    </div>
  );
}
