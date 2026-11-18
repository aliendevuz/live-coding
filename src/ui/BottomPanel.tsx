import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowDownUp, Ban, CircleCheck, CircleX, ExternalLink, Eye, Globe, Network, Play, Plus, Share2, SquareTerminal, X } from "lucide-react";
import type { Session } from "../core/session";
import type { TermView } from "../core/terminals";
import { formatBytes } from "../core/util";
import { useEvent } from "./hooks";

type PanelTab = { kind: "term"; id: number } | { kind: "ports" } | { kind: "transfers" };

export function BottomPanel({ session, canTerm }: { session: Session; canTerm: boolean }) {
  const terms = useEvent(session.terms, "list", session.terms.list());
  const ports = useEvent(session.tunnels, "ports", session.tunnels.ports);
  const transfers = useEvent(session.files, "transfers", session.files.transfers);
  const [tab, setTab] = useState<PanelTab>({ kind: "ports" });
  const boxRef = useRef<HTMLDivElement>(null);
  const isHost = session.role === "host";

  // Follow new terminals; fall back when the shown one disappears.
  const prevIds = useRef<number[]>([]);
  useEffect(() => {
    const ids = terms.map((t) => t.id);
    const added = ids.find((id) => !prevIds.current.includes(id));
    prevIds.current = ids;
    if (added != null) setTab({ kind: "term", id: added });
    else if (tab.kind === "term" && !ids.includes(tab.id)) setTab(ids.length ? { kind: "term", id: ids[ids.length - 1] } : { kind: "ports" });
  }, [terms]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown: TermView | undefined = tab.kind === "term" ? terms.find((t) => t.id === tab.id) : undefined;

  // Mount the xterm element of the visible terminal.
  useEffect(() => {
    if (!shown || !boxRef.current) return;
    session.terms.attach(shown, boxRef.current);
    if (!isHost) return;
    const ro = new ResizeObserver(() => session.terms.fit(shown));
    ro.observe(boxRef.current);
    return () => ro.disconnect();
  }, [shown, session, isHost]);

  // Hide inactive terminal elements (they stay alive, just detached from view).
  useEffect(() => {
    for (const t of terms) t.el.style.display = t === shown ? "" : "none";
  }, [terms, shown]);

  const newTerm = () => session.terms.create().catch((e) => session.toast(String(e instanceof Error ? e.message : e)));
  const running = transfers.filter((t) => t.state === "running").length;

  return (
    <div className="bottom" data-anchor="panel" style={{ height: "100%" }}>
      <div className="panel-tabs">
        {terms.map((t) => (
          <div
            key={t.id}
            className={`ptab${shown?.id === t.id ? " active" : ""}${t.alive ? "" : " dead"}`}
            onClick={() => setTab({ kind: "term", id: t.id })}
          >
            {t.title.startsWith("Run:") ? <Play size={12} fill="currentColor" /> : t.title.startsWith("Static server") ? <Globe size={13} /> : <SquareTerminal size={13} />}
            {t.title.replace(/^Run:\s*/, "")}
            {(isHost || canTerm) && (
              <span
                className="x"
                title="Kill terminal"
                onClick={(e) => {
                  e.stopPropagation();
                  void session.terms.kill(t.id);
                }}
              >
                <X size={12} />
              </span>
            )}
          </div>
        ))}
        <button className="icon" title="New terminal" disabled={!isHost && !canTerm} onClick={newTerm}>
          <Plus size={15} />
        </button>
        <div className="grow" />
        <div className={`ptab${tab.kind === "ports" ? " active" : ""}`} onClick={() => setTab({ kind: "ports" })}>
          <Network size={13} />
          Ports {ports.length > 0 && <span className="badge">{ports.length}</span>}
        </div>
        <div className={`ptab${tab.kind === "transfers" ? " active" : ""}`} onClick={() => setTab({ kind: "transfers" })}>
          <ArrowDownUp size={13} />
          Transfers {running > 0 && <span className="badge">{running}</span>}
        </div>
      </div>
      <div className="panel-body">
        <div
          ref={boxRef}
          className={`term-box${isHost ? "" : " guest-term"}`}
          data-anchor="terminal"
          style={{ display: shown ? "" : "none" }}
        />
        {shown && !isHost && !canTerm && (
          <div className="term-lock">
            <Eye size={12} /> View only — the host controls this terminal
          </div>
        )}
        {tab.kind === "ports" && <Ports session={session} />}
        {tab.kind === "transfers" && (
          <div className="list">
            {transfers.length === 0 && <div className="dim">No file transfers yet. Images, large files and clones show up here.</div>}
            {transfers.map((t) => (
              <div key={t.id} className="xfer-row">
                <div className="grow col" style={{ gap: 4 }}>
                  <div className="row">
                    <span className="grow">{t.label}</span>
                    <span className="dim">
                      {formatBytes(t.done)} / {formatBytes(t.total)} · {t.state}
                      {t.error ? `: ${t.error}` : ""}
                    </span>
                  </div>
                  <div className="bar">
                    <div style={{ width: `${t.total ? Math.min(100, (t.done / t.total) * 100) : t.state === "done" ? 100 : 0}%` }} />
                  </div>
                </div>
                {t.state === "done" && <CircleCheck size={16} color="var(--ok)" />}
                {t.state === "error" && <CircleX size={16} color="#f48771" />}
                {t.state === "cancelled" && <Ban size={16} className="dim" />}
                {t.state === "running" && <button onClick={() => session.files.cancelTransfer(t.id)}>Cancel</button>}
              </div>
            ))}
            {session.bulk.sentRate > 0 && <div className="dim">Sending at {formatBytes(session.bulk.sentRate)}/s</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function Ports({ session }: { session: Session }) {
  const ports = useEvent(session.tunnels, "ports", session.tunnels.ports);
  const [val, setVal] = useState("");
  const isHost = session.role === "host";
  const share = () => {
    const n = Number(val);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return session.toast("Enter a port number, e.g. 5173 or 8000.");
    session.tunnels.share(n);
    setVal("");
  };
  return (
    <div className="list">
      {isHost ? (
        <>
          <div className="dim">
            Share a local server with your student: start it in a terminal (e.g. <span className="mono">npm run dev</span>,{" "}
            <span className="mono">python -m http.server 8000</span>), then share its port. It opens on their
            localhost under the same port.
          </div>
          <div className="row">
            <input style={{ width: 120 }} placeholder="Port, e.g. 5173" value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && share()} />
            <button className="primary with-icon" onClick={share}>
              <Share2 size={14} /> Share port
            </button>
          </div>
        </>
      ) : (
        ports.length === 0 && <div className="dim">The host has not shared any ports yet.</div>
      )}
      {ports.map((p) => {
        const local = p.local ?? p.port;
        return (
          <div key={p.port} className="port-row">
            <span className="live-dot" />
            <span className="mono grow">
              {isHost ? `localhost:${p.port} → shared` : `localhost:${local}${local !== p.port ? `  (host port ${p.port} was busy here)` : ""}`}
            </span>
            <button className="with-icon" onClick={() => void openUrl(`http://localhost:${local}/`)}>
              <ExternalLink size={14} /> Open
            </button>
            {isHost && <button onClick={() => session.tunnels.unshare(p.port)}>Stop</button>}
          </div>
        );
      })}
    </div>
  );
}
