// web3.js and Anchor expect Node's Buffer in the browser.
import { Buffer } from "buffer";

if (typeof globalThis !== "undefined" && !(globalThis as any).Buffer) {
  (globalThis as any).Buffer = Buffer;
}
