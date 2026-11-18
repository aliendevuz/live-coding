// A small text-input modal (window.prompt is not reliable in WebView2).
import { useEffect, useRef, useState } from "react";

type Req = { title: string; value: string; resolve: (v: string | null) => void };
let show: ((r: Req) => void) | null = null;

export function askText(title: string, value = ""): Promise<string | null> {
  return new Promise((resolve) => (show ? show({ title, value, resolve }) : resolve(null)));
}

export function PromptHost() {
  const [req, setReq] = useState<Req | null>(null);
  const [val, setVal] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    show = (r) => {
      setReq(r);
      setVal(r.value);
    };
    return () => void (show = null);
  }, []);
  useEffect(() => {
    if (req) setTimeout(() => {
      ref.current?.focus();
      const dot = req.value.lastIndexOf(".");
      ref.current?.setSelectionRange(0, dot > 0 ? dot : req.value.length);
    }, 0);
  }, [req]);
  if (!req) return null;
  const done = (v: string | null) => {
    req.resolve(v);
    setReq(null);
  };
  return (
    <div className="modal-back" onMouseDown={() => done(null)}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div>{req.title}</div>
        <input
          ref={ref}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") done(val.trim() || null);
            if (e.key === "Escape") done(null);
          }}
        />
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button onClick={() => done(null)}>Cancel</button>
          <button className="primary" onClick={() => done(val.trim() || null)}>OK</button>
        </div>
      </div>
    </div>
  );
}
