import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { JDWP_HANDSHAKE, JdwpConnection, resumePacket } from "../../src/core/adb/jdwp";

interface Peer {
  port: number;
  received: Buffer[];
  close(): Promise<void>;
}

/** A fake ART JDWP peer: echoes the handshake, optionally sends an event, then replies to Resume. */
function fakePeer(opts: { badHandshake?: boolean; eventFirst?: boolean; errorCode?: number; silent?: boolean } = {}): Promise<Peer> {
  const received: Buffer[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buf = Buffer.alloc(0);
    let shaken = false;
    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!shaken && buf.length >= JDWP_HANDSHAKE.length) {
        received.push(buf.subarray(0, JDWP_HANDSHAKE.length));
        buf = buf.subarray(JDWP_HANDSHAKE.length);
        shaken = true;
        socket.write(opts.badHandshake ? "Nope-Handshake" : JDWP_HANDSHAKE);
      }
      if (shaken && buf.length >= 11) {
        const packet = buf.subarray(0, 11);
        buf = buf.subarray(11);
        received.push(Buffer.from(packet));
        if (opts.silent) return;
        if (opts.eventFirst) {
          // Composite event command (64/100) with a 5-byte payload, not a reply.
          const ev = Buffer.alloc(16);
          ev.writeUInt32BE(16, 0);
          ev.writeUInt32BE(77, 4);
          ev[8] = 0;
          ev[9] = 64;
          ev[10] = 100;
          socket.write(ev);
        }
        const reply = Buffer.alloc(11);
        reply.writeUInt32BE(11, 0);
        reply.writeUInt32BE(packet.readUInt32BE(4), 4);
        reply[8] = 0x80;
        reply.writeUInt16BE(opts.errorCode ?? 0, 9);
        socket.write(reply);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        received,
        close: () =>
          new Promise<void>((r) => {
            sockets.forEach((s) => s.destroy());
            server.close(() => r());
          }),
      });
    });
  });
}

let peer: Peer | undefined;
afterEach(async () => {
  await peer?.close();
  peer = undefined;
});

describe("resumePacket", () => {
  it("encodes VirtualMachine.Resume", () => {
    expect([...resumePacket(7)]).toEqual([0, 0, 0, 11, 0, 0, 0, 7, 0, 1, 9]);
  });
});

describe("JdwpConnection", () => {
  it("handshakes and resumes the VM", async () => {
    peer = await fakePeer();
    const conn = await JdwpConnection.connect(peer.port, "127.0.0.1", 2000);
    await conn.resume(2000);
    expect(peer.received[0]!.toString("latin1")).toBe(JDWP_HANDSHAKE);
    const packet = peer.received[1]!;
    expect(packet.readUInt32BE(0)).toBe(11);
    expect([packet[8], packet[9], packet[10]]).toEqual([0, 1, 9]);
    expect(conn.isClosed).toBe(false);
    conn.close();
    expect(conn.isClosed).toBe(true);
  });

  it("skips unrelated packets before the reply", async () => {
    peer = await fakePeer({ eventFirst: true });
    const conn = await JdwpConnection.connect(peer.port, "127.0.0.1", 2000);
    await expect(conn.resume(2000)).resolves.toBeUndefined();
    conn.close();
  });

  it("rejects a bad handshake", async () => {
    peer = await fakePeer({ badHandshake: true });
    await expect(JdwpConnection.connect(peer.port, "127.0.0.1", 2000)).rejects.toThrow(/handshake/i);
  });

  it("surfaces JDWP error codes", async () => {
    peer = await fakePeer({ errorCode: 112 });
    const conn = await JdwpConnection.connect(peer.port, "127.0.0.1", 2000);
    await expect(conn.resume(2000)).rejects.toThrow(/error 112/);
    conn.close();
  });

  it("times out when the VM never answers", async () => {
    peer = await fakePeer({ silent: true });
    const conn = await JdwpConnection.connect(peer.port, "127.0.0.1", 2000);
    await expect(conn.resume(200)).rejects.toThrow(/Timed out/);
    conn.close();
  });
});
