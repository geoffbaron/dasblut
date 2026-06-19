// Thin WebSocket client for DasBlut multiplayer. Connects to the same-origin /ws
// endpoint exposed by server/index.js. If the connection fails (e.g. the plain Vite
// dev server, or no network), it simply never reports a role and the game runs as
// offline single-player — multiplayer is purely additive.

export type Role = "host" | "german" | "spectator";

export interface NetHandlers {
  onRole?: (role: Role, germanPresent: boolean) => void;
  onGermanPresent?: (present: boolean) => void;
  onSetup?: (data: unknown) => void;
  onSnapshot?: (data: unknown) => void;
  onAxisOrder?: (data: unknown) => void;
  onClose?: () => void;
}

export class Net {
  private ws: WebSocket | null = null;
  private handlers: NetHandlers = {};
  role: Role | null = null;
  connected = false;

  connect(handlers: NetHandlers): void {
    this.handlers = handlers;
    try {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    } catch {
      return; // no WS → stays offline
    }
    this.ws.onopen = () => { this.connected = true; };
    this.ws.onmessage = (ev) => {
      let m: { t: string; role?: Role; germanPresent?: boolean; value?: boolean; data?: unknown };
      try { m = JSON.parse(ev.data); } catch { return; }
      switch (m.t) {
        case "role":
          this.role = m.role!;
          this.handlers.onRole?.(m.role!, !!m.germanPresent);
          break;
        case "germanPresent":
          this.handlers.onGermanPresent?.(!!m.value);
          break;
        case "setup":
          this.handlers.onSetup?.(m.data);
          break;
        case "snapshot":
          this.handlers.onSnapshot?.(m.data);
          break;
        case "axisOrder":
          this.handlers.onAxisOrder?.(m.data);
          break;
      }
    };
    this.ws.onclose = () => { this.connected = false; this.handlers.onClose?.(); };
    this.ws.onerror = () => { /* swallow — onclose handles fallback */ };
  }

  private send(obj: unknown): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  claimGerman(): void { this.send({ t: "claimGerman" }); }
  sendSetup(data: unknown): void { this.send({ t: "setup", data }); }
  sendSnapshot(data: unknown): void { this.send({ t: "snapshot", data }); }
  sendAxisOrder(data: unknown): void { this.send({ t: "axisOrder", data }); }
}

export const net = new Net();
