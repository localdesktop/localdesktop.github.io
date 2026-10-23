import type { Adb } from "./adb/adb";
import { sleep } from "./exec";

export interface ScreenState {
  awake: boolean;
  locked: boolean;
}

export const LOCKED_HINT = "The device is locked with a PIN, pattern or fingerprint, which adb can't unlock. Unlock it once.";

export async function screenState(adb: Adb): Promise<ScreenState> {
  const [power, window] = await Promise.all([
    adb.shell("dumpsys power | grep -m1 mWakefulness=", { allowFailure: true }),
    adb.shell("dumpsys window | grep -m1 isKeyguardShowing", { allowFailure: true }),
  ]);
  return { awake: /mWakefulness=Awake/.test(power), locked: /isKeyguardShowing=true/.test(window) };
}

export async function wakeAndUnlock(adb: Adb): Promise<ScreenState> {
  const before = await screenState(adb);
  if (before.awake && !before.locked) return before;
  if (!before.awake) await adb.shell("input keyevent KEYCODE_WAKEUP", { allowFailure: true });
  const secure = /lock credential/i.test(await adb.shell("cmd lock_settings verify", { allowFailure: true }));
  if (!secure) await adb.shell("wm dismiss-keyguard", { allowFailure: true });
  let state = await screenState(adb);
  for (let i = 0; i < 15 && !state.awake; i++) {
    await sleep(200);
    state = await screenState(adb);
  }
  await sleep(1000);
  return screenState(adb);
}
