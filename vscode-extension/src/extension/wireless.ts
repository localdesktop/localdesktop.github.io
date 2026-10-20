import { randomBytes } from "node:crypto";
import * as QRCode from "qrcode";
import * as vscode from "vscode";
import { appProcesses, getUid, startApp } from "../core/adb/app";
import type { Adb } from "../core/adb/adb";
import type { AdbDevice } from "../core/adb/devices";
import {
  connectDevice,
  disconnectDevice,
  isHostPort,
  mdnsAvailable,
  mdnsServices,
  pairDevice,
  pairingQrPayload,
  parseWlanIp,
  randomPairingName,
  randomPairingPassword,
  type MdnsService,
} from "../core/adb/wireless";
import { LdError } from "../core/errors";
import { sleep } from "../core/exec";
import type { Services } from "./services";
import { registerCommand, withProgress } from "./ui";

const PAIR_TIMEOUT_MS = 3 * 60_000;

/** Wi‑Fi pairing (QR / code), connect, disconnect, adb tcpip, and the attach process picker. */
export function activateWireless(s: Services): void {
  const reg = (id: string, fn: (...args: any[]) => unknown) => registerCommand(s.context, id, fn, s.output);
  reg("localdesktop.devices.pairQr", () => pairWithQr(s));
  reg("localdesktop.devices.pairCode", () => pairWithCode(s));
  reg("localdesktop.devices.connect", () => connectWifi(s));
  reg("localdesktop.devices.disconnect", (arg?: AdbDevice) => disconnect(s, arg));
  reg("localdesktop.devices.tcpip", () => usbToWifi(s));
  // Returns the pid as a string (used as ${command:localdesktop.pickAppProcess} in launch.json).
  s.context.subscriptions.push(vscode.commands.registerCommand("localdesktop.pickAppProcess", (arg?: { serial?: string }) => pickAppProcess(s, arg?.serial)));
}

/** After pairing, find the device's connect service (same host) and connect unless adb already did. */
async function connectAfterPairing(s: Services, adb: Adb, host: string, timeoutMs = 20_000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await s.devices.refresh();
    const already = s.devices.devices.find((d) => d.transport === "wifi" && d.state === "device" && (d.serial.startsWith(`${host}:`) || d.serial.includes("._adb-tls-connect._tcp")));
    if (already) return already.serial;
    const svc = (await mdnsServices(adb)).find((x) => x.type === "connect" && x.host === host);
    if (svc) {
      await connectDevice(adb, svc.address);
      await s.devices.refresh();
      return svc.address;
    }
    await sleep(1000);
  }
  return undefined;
}

async function selectNew(s: Services, serial: string | undefined): Promise<void> {
  await s.devices.refresh();
  if (serial && s.devices.devices.some((d) => d.serial === serial)) s.devices.setSelected(serial);
  void vscode.window.showInformationMessage(serial ? `Connected over Wi‑Fi: ${serial}` : "Paired. The device will show up once it's reachable.");
}

async function pairWithQr(s: Services): Promise<void> {
  const adb = s.devices.adb();
  if (!(await mdnsAvailable(adb))) {
    const choice = await vscode.window.showWarningMessage(
      "adb's mDNS discovery isn't available, so QR pairing can't find the phone. Update platform-tools (adb 30+) or pair with a code.",
      "Pair with Code",
    );
    if (choice) await pairWithCode(s);
    return;
  }
  const name = randomPairingName();
  const password = randomPairingPassword();
  const svg = await QRCode.toString(pairingQrPayload(name, password), { type: "svg", margin: 1, errorCorrectionLevel: "M" });

  const panel = vscode.window.createWebviewPanel("localdesktop.pairQr", "Pair Device over Wi‑Fi", vscode.ViewColumn.Active, { enableScripts: false });
  let closed = false;
  panel.onDidDispose(() => (closed = true));
  const render = (status: string) => {
    if (!closed) panel.webview.html = qrHtml(svg, status);
  };
  render("Waiting for the phone to scan the code…");

  try {
    const deadline = Date.now() + PAIR_TIMEOUT_MS;
    let service: MdnsService | undefined;
    while (!closed && Date.now() < deadline) {
      service = (await mdnsServices(adb)).find((x) => x.type === "pairing" && x.name === name);
      if (service) break;
      await sleep(1000);
    }
    if (closed) return;
    if (!service) throw new LdError("TIMEOUT", "The phone didn't show up for pairing.", "Make sure it's on the same Wi‑Fi network, then try again.");
    render(`Pairing with ${service.address}…`);
    await pairDevice(adb, service.address, password);
    render("Paired. Connecting…");
    const serial = await connectAfterPairing(s, adb, service.host);
    render(serial ? `Connected: ${serial}` : "Paired. Waiting for the device to connect…");
    await selectNew(s, serial);
    setTimeout(() => panel.dispose(), 1500);
  } catch (e) {
    render(`Pairing failed: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}

async function pairWithCode(s: Services): Promise<void> {
  const adb = s.devices.adb();
  const address = await vscode.window.showInputBox({
    title: "Pair with code (1/2)",
    prompt: "On the phone: Developer options → Wireless debugging → Pair device with pairing code. Enter the IP address & port shown there.",
    placeHolder: "192.168.1.23:37123",
    ignoreFocusOut: true,
    validateInput: (v) => (isHostPort(v) ? undefined : "Expected ip:port"),
  });
  if (!address) return;
  const code = await vscode.window.showInputBox({
    title: "Pair with code (2/2)",
    prompt: "Wi‑Fi pairing code",
    placeHolder: "123456",
    ignoreFocusOut: true,
    validateInput: (v) => (/^\d{6}$/.test(v.trim()) ? undefined : "Six digits"),
  });
  if (!code) return;
  const host = address.trim().replace(/:\d+$/, "");
  const serial = await withProgress(`Pairing with ${address}`, async (progress) => {
    await pairDevice(adb, address.trim(), code.trim());
    progress.report({ message: "Paired. Connecting…" });
    return connectAfterPairing(s, adb, host, 8000);
  });
  if (serial) return selectNew(s, serial);
  // No mDNS: the connect port is shown on the Wireless debugging screen (not the pairing port).
  const connectAddress = await vscode.window.showInputBox({
    title: "Connect",
    prompt: "Paired. Now enter the IP address & port shown at the top of the Wireless debugging screen.",
    value: `${host}:`,
    ignoreFocusOut: true,
    validateInput: (v) => (isHostPort(v) ? undefined : "Expected ip:port"),
  });
  if (!connectAddress) return;
  await connectDevice(adb, connectAddress.trim());
  await selectNew(s, connectAddress.trim());
}

async function connectWifi(s: Services): Promise<void> {
  const adb = s.devices.adb();
  const connected = new Set(s.devices.devices.map((d) => d.serial));
  const services = await mdnsServices(adb).catch(() => []);
  const items: (vscode.QuickPickItem & { address?: string })[] = services
    .filter((x) => x.type === "connect" && !connected.has(x.address) && !connected.has(x.name))
    .map((x) => ({ label: `$(broadcast) ${x.address}`, description: x.name, address: x.address }));
  items.push({ label: "$(edit) Enter ip:port…" });
  const pick = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { title: "Connect to a device over Wi‑Fi" });
  if (!pick) return;
  let address = pick.address;
  if (!address) {
    address = await vscode.window.showInputBox({
      title: "Connect over Wi‑Fi",
      prompt: "IP address & port from Developer options → Wireless debugging (or ip:5555 after adb tcpip).",
      placeHolder: "192.168.1.23:41234",
      ignoreFocusOut: true,
      validateInput: (v) => (isHostPort(v) ? undefined : "Expected ip:port"),
    });
  }
  if (!address) return;
  await withProgress(`Connecting to ${address}`, () => connectDevice(adb, address!.trim()));
  await selectNew(s, address.trim());
}

async function disconnect(s: Services, arg?: AdbDevice): Promise<void> {
  const device = arg?.serial ? arg : await s.devices.resolve(undefined, { forcePick: true, title: "Disconnect which device?" });
  if (device.transport !== "wifi") {
    void vscode.window.showInformationMessage("Only Wi‑Fi devices can be disconnected; unplug USB devices.");
    return;
  }
  await disconnectDevice(s.devices.adb(), device.serial);
  if (s.devices.selectedSerial === device.serial) s.devices.setSelected(undefined);
  await s.devices.refresh();
}

/** Legacy USB → Wi‑Fi switch (works before Android 11; the phone and computer must share a network). */
async function usbToWifi(s: Services): Promise<void> {
  const usb = s.devices.devices.filter((d) => d.transport === "usb" && d.state === "device");
  if (!usb.length) throw new LdError("NO_DEVICE", "Connect the phone with a USB cable first.");
  const device =
    usb.length === 1
      ? usb[0]!
      : (await vscode.window.showQuickPick(
          usb.map((d) => ({ label: s.devices.label(d), description: d.serial, device: d })),
          { title: "Switch which device to Wi‑Fi?" },
        ))?.device;
  if (!device) return;
  const adb = s.devices.adb().forDevice(device.serial);
  const address = await withProgress(`Switching ${s.devices.label(device)} to Wi‑Fi`, async (progress) => {
    const ip = parseWlanIp(await adb.shell("ip -f inet addr show wlan0", { allowFailure: true }));
    if (!ip) throw new LdError("COMMAND_FAILED", "The phone has no Wi‑Fi IPv4 address.", "Connect it to Wi‑Fi first.");
    progress.report({ message: "Restarting adbd in TCP mode…" });
    await adb.run(["tcpip", "5555"]);
    await sleep(2000);
    const target = `${ip}:5555`;
    progress.report({ message: `Connecting to ${target}…` });
    await connectDevice(s.devices.adb(), target);
    return target;
  });
  await selectNew(s, address);
}

/** QuickPick of processes running as the app's uid (the app, proot, pipewire, the AAudio sink…). */
async function pickAppProcess(s: Services, serial?: string): Promise<string | undefined> {
  const device = await s.devices.resolve(serial);
  const adb = s.devices.adb().forDevice(device.serial);
  const pkg = s.app().packageName;
  for (;;) {
    const uid = await getUid(adb, pkg);
    if (uid === undefined) throw new LdError("NOT_INSTALLED", `${pkg} is not installed on ${device.serial}.`);
    const procs = await appProcesses(adb, uid);
    if (!procs.length) {
      const start = await vscode.window.showInformationMessage(`${pkg} isn't running on ${s.devices.label(device)}.`, "Start It");
      if (!start) return undefined;
      await startApp(adb, pkg);
      await sleep(1500);
      continue;
    }
    const pick = await vscode.window.showQuickPick(
      procs.map((p) => ({
        label: p.name === pkg ? `$(device-mobile) ${p.name}` : p.name.split("/").pop() ?? p.name,
        description: `pid ${p.pid}`,
        detail: p.name === pkg ? "Main app process (Rust, compositor)" : `${p.name}${p.rssKb ? ` · ${Math.round(p.rssKb / 1024)} MB` : ""}`,
        pid: p.pid,
      })),
      { title: `Attach to which Local Desktop process on ${s.devices.label(device)}?`, matchOnDetail: true },
    );
    return pick ? String(pick.pid) : undefined;
  }
}

function qrHtml(svg: string, status: string): string {
  const nonce = randomBytes(16).toString("base64");
  const escape = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; img-src data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); display: flex; flex-direction: column; align-items: center; padding: 24px; }
  .qr { background: #fff; padding: 16px; border-radius: 8px; width: 260px; height: 260px; }
  .qr svg { width: 100%; height: 100%; }
  ol { max-width: 460px; line-height: 1.6; }
  .status { margin-top: 16px; font-weight: 600; }
</style>
</head>
<body>
  <h2>Pair a phone over Wi‑Fi</h2>
  <ol>
    <li>Connect the phone to the same network as this computer.</li>
    <li>Open <b>Settings → Developer options → Wireless debugging</b> and turn it on.</li>
    <li>Tap <b>Pair device with QR code</b> and scan this code.</li>
  </ol>
  <div class="qr">${svg}</div>
  <div class="status">${escape(status)}</div>
</body>
</html>`;
}
