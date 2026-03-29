import { platform } from "os";

const impl =
  platform() === "win32"
    ? await import("./win32")
    : await import("./darwin");

export const scan = impl.scan;
export const killService = impl.killService;
export const restartService = impl.restartService;
