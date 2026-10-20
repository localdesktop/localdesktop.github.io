export type LdErrorCode =
  | "ADB_MISSING"
  | "ADB_FAILED"
  | "NO_DEVICE"
  | "MULTIPLE_DEVICES"
  | "DEVICE_NOT_FOUND"
  | "DEVICE_UNAUTHORIZED"
  | "DEVICE_OFFLINE"
  | "DEVICE_NO_PERMISSIONS"
  | "UNSUPPORTED_ABI"
  | "NOT_INSTALLED"
  | "NOT_DEBUGGABLE"
  | "INSTALL_FAILED"
  | "SIGNATURE_MISMATCH"
  | "ANDROID_HOME_MISSING"
  | "X_MISSING"
  | "LLDB_SERVER_MISSING"
  | "CODELLDB_MISSING"
  | "SCRCPY_MISSING"
  | "WORKSPACE_NOT_FOUND"
  | "APK_NOT_FOUND"
  | "BUILD_FAILED"
  | "LAUNCH_FAILED"
  | "COMMAND_FAILED"
  | "TIMEOUT"
  | "CANCELLED"
  | "INVALID_ARGUMENT";

/** An error with a stable code and an actionable hint, shown to humans and agents alike. */
export class LdError extends Error {
  constructor(
    readonly code: LdErrorCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "LdError";
  }

  override toString(): string {
    return this.hint ? `${this.message}\nHint: ${this.hint}` : this.message;
  }
}

export function isLdError(e: unknown, code?: LdErrorCode): e is LdError {
  return e instanceof LdError && (code === undefined || e.code === code);
}

export function errorMessage(e: unknown): string {
  if (e instanceof LdError) return e.toString();
  if (e instanceof Error) return e.message;
  return String(e);
}
