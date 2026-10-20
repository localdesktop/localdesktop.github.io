import { describe, expect, it } from "vitest";
import { parseDevicesList, resolveDevice, TrackDevicesParser, transportOf } from "../../src/core/adb/devices";

const LIST = `List of devices attached
R58M12345ABC           device usb:1-1 product:beyond0ltexx model:SM_G970F device:beyond0 transport_id:3
emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1
192.168.1.5:37853      device product:panther model:Pixel_7 device:panther transport_id:5
adb-28041FDH2000LD-abcDEF._adb-tls-connect._tcp device product:husky model:Pixel_8_Pro device:husky transport_id:6
0123456789ABCDEF       unauthorized usb:1-2 transport_id:4
FEDCBA9876543210       no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html] usb:1-3 transport_id:7
deadbeef               offline transport_id:2
`;

describe("parseDevicesList", () => {
  const devices = parseDevicesList(LIST);

  it("parses every device line", () => {
    expect(devices.map((d) => d.serial)).toEqual([
      "R58M12345ABC",
      "emulator-5554",
      "192.168.1.5:37853",
      "adb-28041FDH2000LD-abcDEF._adb-tls-connect._tcp",
      "0123456789ABCDEF",
      "FEDCBA9876543210",
      "deadbeef",
    ]);
  });

  it("reads states, models and transports", () => {
    expect(devices[0]).toMatchObject({ state: "device", model: "SM G970F", transport: "usb", transportId: "3" });
    expect(devices[1]).toMatchObject({ transport: "emulator" });
    expect(devices[2]).toMatchObject({ transport: "wifi", model: "Pixel 7" });
    expect(devices[3]).toMatchObject({ transport: "wifi", model: "Pixel 8 Pro" });
    expect(devices[4]).toMatchObject({ state: "unauthorized" });
    expect(devices[6]).toMatchObject({ state: "offline" });
  });

  it("keeps 'no permissions' detail with spaces", () => {
    expect(devices[5]).toMatchObject({ state: "no permissions", transportId: "7" });
    expect(devices[5]!.detail).toContain("udev");
  });

  it("classifies transports", () => {
    expect(transportOf("10.0.2.2:5555")).toBe("wifi");
    expect(transportOf("emulator-5556")).toBe("emulator");
    expect(transportOf("HT7A1B234567")).toBe("usb");
  });
});

describe("TrackDevicesParser", () => {
  it("splits hex-length-prefixed blocks across chunks", () => {
    const p = new TrackDevicesParser();
    const payload = "abc123\tdevice usb:1-1 model:X\n";
    const block = payload.length.toString(16).padStart(4, "0") + payload;
    expect(p.push(block.slice(0, 7))).toEqual([]);
    const snaps = p.push(block.slice(7) + "0000");
    expect(snaps).toHaveLength(2);
    expect(snaps[0]![0]!.serial).toBe("abc123");
    expect(snaps[1]).toEqual([]);
  });
});

describe("resolveDevice", () => {
  const devices = parseDevicesList(LIST);
  it("prefers an explicit serial", () => {
    expect(resolveDevice(devices, { serial: "emulator-5554", selectedSerial: "R58M12345ABC" })?.serial).toBe("emulator-5554");
  });
  it("uses ANDROID_SERIAL next, then the selection", () => {
    expect(resolveDevice(devices, { envSerial: "192.168.1.5:37853", selectedSerial: "R58M12345ABC" })?.serial).toBe("192.168.1.5:37853");
    expect(resolveDevice(devices, { selectedSerial: "R58M12345ABC" })?.serial).toBe("R58M12345ABC");
  });
  it("returns undefined when ambiguous or asked to pick", () => {
    expect(resolveDevice(devices, {})).toBeUndefined();
    expect(resolveDevice(devices, { serial: "pick", selectedSerial: "R58M12345ABC" })).toBeUndefined();
  });
  it("picks the only ready device", () => {
    expect(resolveDevice(devices.filter((d) => d.serial === "deadbeef" || d.serial === "emulator-5554"), {})?.serial).toBe("emulator-5554");
  });
  it("throws for a missing explicit serial", () => {
    expect(() => resolveDevice(devices, { serial: "nope" })).toThrow(/not connected/);
  });
});
